# 模板关联 Skills 自动安装 — 功能设计

日期：2026-05-11
状态：设计修订 v2（根据 4 位专家审核意见修订）

---

## 1. 背景

当前 Hermes Admin 面板中，ProfileTemplate（配置模板）和 Skills Hub（技能市场）是两个独立系统：
- 模板只管理 agent 的 config.yaml 和 SOUL.md，可以通过 `skills.enabled`/`skills.disabled` 开关已有技能
- Skills Hub 负责搜索、下载、安装社区技能到 agent pod
- **两者没有关联**：创建 agent 时无法根据模板自动安装所需技能

用户需要手动：创建 agent → 进详情页 → 浏览 Hub → 逐个安装技能。对于团队标准化场景（如"测试工程师"模板需要 systematic-debugging），这个流程效率低且容易遗漏。

## 2. 目标

在 ProfileTemplate 的 `config_overrides` 中声明需要安装的 Hub skills，在 profile 同步到 pod 成功后自动安装，减少手动操作。

## 3. 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 触发时机 | `sync_profile_to_pod` 成功后 + `create_agent` 末尾 | 避免在 pod 未就绪时触发；sync 是实际写 config.yaml 到 pod 的时机 |
| 数据存储 | 复用 config_overrides.skills.install | 不改表结构 |
| 列表合并语义 | **追加去重**（template ∪ profile） | 避免 profile 层意外丢失模板声明的 skills |
| 冲突处理 | 只装不管（幂等，force=True） | 不破坏用户手动安装的技能 |
| 安装模式 | 异步 post-hook + 串行队列 | 不阻塞主流程；串行避免 pod lock 竞争 |
| 模块放置 | 独立 `hub_installer.py` | 避免 hub_routes.py 膨胀和循环依赖 |
| 权限 | 后台 admin 权限触发 | 无需检查 agent ownership |

## 4. 数据结构

### 4.1 config_overrides 扩展

在现有 `skills` 子对象中新增 `install` 字段：

```json
{
  "skills": {
    "enabled": ["web-search", "code-exec"],
    "disabled": ["file-upload"],
    "install": [
      "skills-sh/obra/superpowers/skills/brainstorming",
      "skills-sh/obra/superpowers/skills/systematic-debugging"
    ]
  }
}
```

- `install` 是 Hub skill identifier 列表（与 Hub browse API 返回的 `identifier` 字段一致）
- 可以为空或不存在（向后兼容）
- **合并语义**：`skills.install` 是**追加去重**，不是替换。解析最终列表时取 template 和 profile 的并集。这是对 `deep_merge` "列表=替换"行为的显式覆盖。
- **identifier 格式校验**：必须匹配 `^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$`，在模板创建/更新时校验

### 4.2 内置模板示例

```
tester → skills.install: ["skills-sh/obra/superpowers/skills/systematic-debugging"]
frontend-eng → skills.install: ["skills-sh/obra/superpowers/skills/writing-plans"]
reviewer → skills.install: []
researcher → skills.install: ["skills-sh/obra/superpowers/skills/brainstorming"]
```

### 4.3 seed 函数修复

`database.py` 的 `_seed_builtin_templates` 改为 `ON CONFLICT DO UPDATE`，确保重新部署后内置模板的 `skills.install` 被更新：

```sql
INSERT INTO profile_templates (...)
VALUES (...)
ON CONFLICT (name) DO UPDATE SET
    config_overrides = EXCLUDED.config_overrides,
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    soul_md = EXCLUDED.soul_md
WHERE profile_templates.is_builtin = true
```

## 5. 触发流程

### 5.1 核心触发点：`sync_profile_to_pod` 成功后

这是最安全、最自然的触发点——config.yaml 已经成功写入 pod，pod 确认可用。

```
sync_profile_to_pod（profile_utils.py）：
  1. 获取 pod name                                       [现有]
  2. 构建 resolved config（三层合并）                     [现有]
  3. 写 config.yaml 到 pod                               [现有]
  4. 写 SOUL.md 到 pod（如有）                           [现有]
  5. 更新 sync_status = "synced"                         [现有]
  6. 从 resolved config 提取 skills.install 列表          [新增]
  7. 如果非空，调用 install_skills_for_template()          [新增]
```

这覆盖了所有 profile 相关场景：create_profile → sync、update_profile → sync、模板变更触发的批量 sync。

### 5.2 辅助触发点：创建 Agent 时（可选 template_id）

在 `create_agent` 末尾新增可选步骤：

**前提**：`CreateAgentRequest` 新增 `template_id: Optional[int]` 字段，`CreateAgentResponse` 新增 `install_tasks: list[str]` 字段。

```
create_agent（agent_manager.py）：
  1. 创建 K8s Secret/Deployment/Service/Ingress          [现有]
  2. 等待 pod ready                                        [现有]
  3. 写 AgentMetadata                                      [现有]
  4. 如果指定了 template_id：                               [新增]
     a. 从 DB 加载模板，提取 skills.install
     b. 调用 install_skills_for_template()
     c. 将 task_ids 附加到响应
```

注意：由于 pod 刚 ready，安装 task 内部需延迟解析 pod（见 6.1 节）。

### 5.3 安装逻辑（独立模块）

新增 `admin/backend/hub_installer.py`：

```python
async def install_skills_for_template(
    agent_id: int,
    identifiers: list[str],
    k8s: K8sClient,
) -> list[str]:
    """批量安装模板声明的 skills。

    - 内部调用 _resolve_pod（延迟解析，支持 pod 启动等待）
    - 串行安装（避免 pod lock 竞争）
    - force=True 跳过 existing check（幂等）
    - 返回 task_id 列表
    """
```

关键设计：
- **串行安装**：逐个创建 HubTask 并等待完成，而非并发 N 个 task 争抢 pod lock。对 2-5 个 skill 场景延迟可接受。
- **延迟 pod 解析**：不在调用方解析 pod，在 task 内部解析。支持 pod 尚在启动的情况（重试 120 秒）。
- **force=True**：跳过 existing check，避免"已安装"报错中断流程。
- **总超时**：300 秒上限，超时后未开始的 task 标记为 failed。

从 `hub_routes.py` 中提取 `_run_install` 核心逻辑到 `hub_installer.py`，`hub_routes.py` 的路由处理器改为调用 `hub_installer`。

## 6. 错误处理

### 6.1 Pod 就绪等待

`install_skills_for_template` 内部使用 `_resolve_pod`，但加重试循环：

```python
for attempt in range(24):  # 24 × 5s = 120s
    pod = await _resolve_pod(k8s, agent_id)
    if pod:
        break
    await asyncio.sleep(5)
```

### 6.2 错误处理表

| 场景 | 处理方式 |
|------|---------|
| 单个 skill 安装失败 | task 标记 `failed`，继续安装下一个 |
| Pod 120 秒内未就绪 | 所有 task 标记 `failed`，error 说明 pod 超时 |
| Identifier 无效 | task `failed`，error 说明哪个 identifier 无效 |
| Hub 源不可达 | 同现有 Hub install 行为，task `failed` |
| Admin pod 重启 | 内存 HubTask 丢失。前端展示"安装状态未知"，用户可刷新 skills 列表确认 |
| 总超时（300s） | 未开始的 task 标记 `failed` |

**核心原则：安装失败不阻塞主流程。** agent 创建和 profile 同步始终成功。

### 6.3 差集计算

使用 **DB 缓存**（AgentSkill 表）而非实时 pod 扫描：

```python
async def _get_installed_names(agent_id: int) -> set[str]:
    from db_models import AgentSkill
    async with AsyncSessionLocal() as session:
        rows = (await session.execute(
            select(AgentSkill.skill_name).where(AgentSkill.agent_number == agent_id)
        )).scalars().all()
        return set(rows)
```

只安装 DB 中未记录的 skills，减少不必要的网络操作。

## 7. API 变更

### 后端

| 文件 | 变更 | 行数估计 |
|------|------|---------|
| **新增** `hub_installer.py` | 提取安装核心逻辑 + `install_skills_for_template()` | ~80 行 |
| `hub_routes.py` | 路由处理器改为调用 hub_installer；删除内联逻辑 | 净减 ~30 行 |
| `profile_utils.py` | `sync_profile_to_pod` 成功后调用 installer | ~20 行 |
| `agent_manager.py` | `create_agent` 可选 template_id + post-hook | ~30 行 |
| `models.py` | `CreateAgentRequest` 加 `template_id`；`CreateAgentResponse` 加 `install_tasks` | ~5 行 |
| `database.py` | seed 改 DO UPDATE；内置模板加 skills.install | ~15 行 |

### 前端

| 组件 | 变更 |
|------|------|
| 模板编辑页 | 新增 "Skills to Install" 子组件：Hub 搜索 + 添加/删除，复用 `hubSearch` API |
| Agent 创建页 | 新增 template_id 选择器；Review 步骤预览 skills |
| Agent 详情页 | 安装 task 进度展示；"状态未知"回退展示 |
| i18n | 新增 ~15 个 key 到 en.ts / zh.ts |

### API 契约变更

**`POST /admin/api/agents`（CreateAgentRequest）**：
```diff
  name: str
  display_name: str = ""
+ template_id: Optional[int] = None
```

**`CreateAgentResponse`**：
```diff
  agent_number: int
  name: str
  created: bool
  steps: list[dict]
+ install_tasks: list[str] = []
```

## 8. 审计和安全

### 8.1 审计日志

在 `install_skills_for_template` 中记录 `ProfileAuditLog`：
- `entity_type = "profile"`
- `action = "auto-install"`
- `new_values = {"identifiers": [...], "task_ids": [...], "trigger": "template-sync"}`
- `changed_by = "system:auto-install"`

### 8.2 identifier 格式校验

应用层（Pydantic model）+ 安装入口双重校验：

```python
IDENTIFIER_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$')
```

## 9. 不做的事情（YAGNI）

- **不做卸载同步**：模板变更时不会自动卸载不在列表中的 skills
- **不做版本锁定**：安装时总是获取最新版本
- **不做批量重试**：单个 failed task 可以通过现有 Hub UI 手动重试
- **不做安装确认**：后台自动执行，不弹确认对话框
- **不做 task 持久化**：HubTask 保持内存态，admin 重启后丢失，前端降级展示
- **不做 identifier 反查 API**：前端编辑器缓存已选 skill 的 meta 信息

## 10. 测试策略

- **单元测试**：
  - `skills.install` 的提取和追加去重逻辑
  - identifier 格式校验
  - deep_merge 后提取 install 列表
- **E2E 测试**：mock Hub API，验证创建 agent → sync profile → 触发安装任务
- **集成验证**：184 开发环境，创建带 skills.install 的模板，创建 agent 后确认 skills 自动安装

## 11. 实施顺序

1. 后端：`database.py` seed 改 DO UPDATE + 内置模板加 skills.install
2. 后端：`models.py` CreateAgentRequest/Response 扩展
3. 后端：新建 `hub_installer.py`，从 hub_routes.py 提取安装核心逻辑
4. 后端：`profile_utils.py` sync_profile_to_pod 加 post-hook
5. 后端：`agent_manager.py` create_agent 加可选 template_id post-hook
6. 后端：identifier 校验 + 审计日志
7. 前端：i18n key 新增
8. 前端：模板编辑页 skills.install 编辑器
9. 前端：agent 创建页 template_id 选择 + skills 预览
10. 前端：agent 详情页安装进度展示
11. 测试 + 仅部署 184 验证

## 12. 专家审核记录

| 专家 | 结论 | 关键修订 |
|------|------|---------|
| 后端/API | REQUEST_CHANGES | 触发点改为 sync 后；模块独立为 hub_installer.py |
| 前端 | APPROVE_WITH_NOTES | 补充 i18n；多 task 轮询改为串行；状态未知回退 |
| K8s/Infra | APPROVE_WITH_NOTES | 安装 task 延迟解析 pod + 重试；串行安装 |
| 数据库 | APPROVE_WITH_NOTES | seed 改 DO UPDATE；identifier 校验；追加去重语义 |
