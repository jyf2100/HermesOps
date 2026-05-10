# Kanban Profile 模板系统设计

> 日期: 2026-05-09
> 状态: 审核通过，待实现
> 审核: 产品专家 PASS / 需求专家 WARN / 架构专家 WARN

## 背景

当前 orchestrator 拆解任务时自动创建 assignee profile 名字（analyst、researcher、writer 等），但 pod 上没有对应的配置文件，导致 `on_disk=false`。临时修复是复制 default config.yaml，但所有 profile 能力完全相同，无法体现角色差异。

需要一套 profile 模板系统：预置角色模板，自动发现的 profile 关联模板配置，用户可编辑覆盖。

## 核心决策

1. **两层表**: `profile_templates`（全局模板）+ `agent_profiles`（agent 实例配置）
2. **配置存储**: JSONB 统一字段 `config_overrides`，内部按约定 key 区分维度
3. **DB 为唯一真相源**: pod 文件是派生物，agent 不直接修改 profile config
4. **工作流**: orchestrator 自动创建 → admin 发现并关联模板 → DB 存配置 → 同步下发到 pod
5. **下发机制**: DB 配置 → 合并生成完整 YAML → K8s exec 写入 pod

## 数据模型

### profile_templates 表

全局角色模板，所有 agent 共享。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | |
| name | VARCHAR(64) UNIQUE NOT NULL | 模板名，如 `researcher`、`writer`，命名规则: `^[a-z][a-z0-9_-]{0,63}$` |
| display_name | VARCHAR(100) | 显示名 i18n key，如 `profileTemplateResearcher` |
| description | TEXT | 角色描述 |
| config_overrides | JSONB DEFAULT '{}' | 配置差异（合并到 DEFAULT_CONFIG） |
| soul_md | TEXT | 角色 SOUL.md 内容 |
| is_builtin | BOOLEAN DEFAULT false | 是否系统预置（不可删除） |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

`config_overrides` JSONB 内部约定 key 与 DEFAULT_CONFIG 的映射:

```python
OVERRIDE_KEY_MAPPING = {
    "model": "model",           # model.default, model.provider, model.base_url
    "toolsets": "toolsets",     # toolsets (list), agent.disabled_toolsets (list)
    "terminal": "terminal",     # terminal.timeout, terminal.backend, etc.
    "delegation": "delegation", # delegation.model, delegation.max_iterations, etc.
}
```

示例: `{"model": {"default": "glm-4.7", "provider": "custom"}, "terminal": {"timeout": 300}}`

### agent_profiles 表

每个 agent 实例的具体 profile 配置。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL PK | |
| agent_number | INTEGER NOT NULL FK → agent_metadata(agent_number) ON DELETE CASCADE | |
| template_id | INTEGER FK → profile_templates(id) ON DELETE SET NULL NULLABLE | 关联的全局模板 |
| profile_name | VARCHAR(64) NOT NULL | profile 名字，如 `analyst`，排除 `default` |
| display_name | VARCHAR(100) | 覆盖模板的显示名 |
| config_overrides | JSONB DEFAULT '{}' | 实例级配置覆盖 |
| soul_md | TEXT NULLABLE | 实例级 SOUL.md 覆盖（NULL = 继承模板） |
| sync_status | VARCHAR(16) DEFAULT 'pending' | `pending` / `synced` / `failed` |
| sync_error | TEXT NULLABLE | 同步失败时的错误信息 |
| config_hash | VARCHAR(64) NULLABLE | 已下发配置的 SHA-256[:32]，用于幂等检查 |
| last_synced_at | TIMESTAMPTZ | 最后一次成功同步到 pod 的时间 |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

约束:
- `UNIQUE (agent_number, profile_name)`
- `CHECK (profile_name != 'default')`
- `INDEX (template_id)`

### 配置合并规则

**DB 为 single source of truth。** Pod 文件是派生物，sync 覆盖 pod 上的任何手动修改。

```
最终 config = deep_merge(DEFAULT_CONFIG, template.config_overrides, profile.config_overrides)
```

**deep_merge 语义**:
- dict: 递归合并，override 中的 key 覆盖 base
- list/str/int: 整体替换（不追加）
- override 中 key 值为 null 时: 从结果中删除该 key（用于"取消继承"）

**SOUL.md 优先级**: `profile.soul_md` (非 NULL 时) > `template.soul_md` > 不写入（agent 使用默认）

**模板删除时**: `template_id` 被置 NULL，profile 退化为仅使用 `config_overrides` + DEFAULT_CONFIG。前端提示"模板已删除，请重新指定模板或手动配置"。

## 预置模板

系统启动时自动 seed（`INSERT ON CONFLICT (name) DO NOTHING`）:

### researcher (研究员)

```json
{
  "config_overrides": {
    "model": {"default": "glm-4.7", "provider": "custom"}
  },
  "soul_md": "你是一个专业的调研分析师。你的职责是：\n1. 深入研究问题并收集相关信息\n2. 分析数据并得出洞察\n3. 输出结构化的调研报告\n\n保持客观、严谨，引用来源。"
}
```

### writer (写作者)

```json
{
  "config_overrides": {
    "model": {"default": "glm-4.7", "provider": "custom"}
  },
  "soul_md": "你是一个专业的内容写作者。你的职责是：\n1. 根据大纲或调研结果撰写内容\n2. 确保文字流畅、逻辑清晰\n3. 遵循指定的格式和风格要求\n\n注重可读性和表达力。"
}
```

### analyst (分析师)

```json
{
  "config_overrides": {
    "model": {"default": "glm-4.7", "provider": "custom"}
  },
  "soul_md": "你是一个数据与业务分析师。你的职责是：\n1. 解读数据趋势和异常\n2. 提供数据驱动的建议\n3. 输出清晰的分析报告和可视化建议\n\n关注指标、数据质量和可操作性。"
}
```

### backend-eng (后端工程师)

```json
{
  "config_overrides": {
    "model": {"default": "glm-4.7", "provider": "custom"},
    "terminal": {"timeout": 300}
  },
  "soul_md": "你是一个后端开发工程师。你的职责是：\n1. 实现功能代码\n2. 编写测试\n3. 修复 bug\n4. 优化性能\n\n遵循项目代码规范，写清晰的提交信息。"
}
```

> 注: 当前环境所有 profile 使用同一模型 (`glm-4.7`)，模板的价值主要在 SOUL.md 差异化。后续可按角色配置不同模型。

## API 设计

### 模板管理

```
GET    /admin/api/profile-templates              # 列出所有模板 (?is_builtin=&search=)
POST   /admin/api/profile-templates              # 创建自定义模板
GET    /admin/api/profile-templates/{id}         # 获取模板详情
PUT    /admin/api/profile-templates/{id}         # 更新模板（内置不可改 config_overrides）
DELETE /admin/api/profile-templates/{id}         # 删除（内置不可删，有关联时警告）
POST   /admin/api/profile-templates/{id}/clone   # 复制为自定义模板
```

### Agent Profile 管理

```
GET    /admin/api/agents/{id}/profiles             # 列出 (?sync_status=)
POST   /admin/api/agents/{id}/profiles             # 创建 profile（指定模板或自定义）
GET    /admin/api/agents/{id}/profiles/{name}      # 详情
PUT    /admin/api/agents/{id}/profiles/{name}      # 更新配置
DELETE /admin/api/agents/{id}/profiles/{name}      # 删除（有未完成任务时拒绝）
POST   /admin/api/agents/{id}/profiles/sync        # 批量同步所有 profile
POST   /admin/api/agents/{id}/profiles/{name}/sync # 同步单个 profile
GET    /admin/api/agents/{id}/profiles/{name}/resolved-config  # 预览合并后完整配置
```

### 自动发现

修改现有 `GET /agents/{id}/kanban/assignees` 逻辑:

1. 从 sidecar 获取 assignees 列表
2. 对每个 assignee:
   - `on_disk=false` 且 DB 无记录 → 匹配模板名 → 创建 DB 记录 → 同步下发
   - `on_disk=false` 但 DB 有记录 → 用 DB 配置重新下发
   - `on_disk=true` 但 DB 无记录 → 从 pod 读取 config.yaml 创建 DB 记录（迁移）
   - `on_disk=true` 且 DB 有记录 → 正常
3. 返回合并后的 assignees 列表（含 DB 元数据: display_name, template, sync_status）

### 删除保护

`DELETE /agents/{id}/profiles/{name}`:
- 查询该 agent 的 kanban tasks 中 assignee = name 且 status NOT IN ('done', 'archived') 的数量
- 有未完成任务: 返回 409 + 任务列表
- 无未完成任务: 删除 DB 记录 + 删除 pod 上 profile 目录

## 同步机制

### 核心原则

- **幂等**: `config_hash` 比对，相同内容不重复写入
- **原子**: 所有文件写完后才更新 `sync_status` 为 `synced`
- **并发安全**: 每个 `(agent_number, profile_name)` 加 async lock

```python
_sync_locks: dict[tuple[int, str], asyncio.Lock] = {}

def _get_sync_lock(agent_number: int, profile_name: str) -> asyncio.Lock:
    key = (agent_number, profile_name)
    if key not in _sync_locks:
        _sync_locks[key] = asyncio.Lock()
    return _sync_locks[key]

async def sync_profile_to_pod(k8s, pod_name, profile, template):
    lock = _get_sync_lock(profile.agent_number, profile.profile_name)
    async with lock:
        # 1. 合并配置
        config = deep_merge(DEFAULT_CONFIG,
                           template.config_overrides if template else {},
                           profile.config_overrides)

        # 2. 生成 YAML
        yaml_content = yaml.dump(_sanitize_for_yaml(config),
                                 default_flow_style=False,
                                 Dumper=yaml.SafeDumper)
        new_hash = hashlib.sha256(yaml_content.encode()).hexdigest()[:32]

        # 3. 幂等检查
        if profile.config_hash == new_hash and profile.sync_status == "synced":
            return  # 无变化

        # 4. 写入 config.yaml
        cfg_path = f"/opt/data/profiles/{profile.profile_name}/config.yaml"
        await k8s.write_file_to_pod(pod_name, cfg_path, yaml_content.encode())

        # 5. 写入 SOUL.md（先写 config 成功后再写）
        soul = profile.soul_md or (template.soul_md if template else None)
        if soul:
            soul_path = f"/opt/data/profiles/{profile.profile_name}/SOUL.md"
            await k8s.write_file_to_pod(pod_name, soul_path, soul.encode())

        # 6. 更新 DB 状态（全部成功后才更新）
        profile.sync_status = "synced"
        profile.sync_error = None
        profile.config_hash = new_hash
        profile.on_disk = True
        profile.last_synced_at = datetime.utcnow()

def _sanitize_for_yaml(config: dict) -> dict:
    """确保所有值可被 yaml.SafeDumper 序列化。"""
    result = {}
    for k, v in config.items():
        if isinstance(v, dict):
            result[k] = _sanitize_for_yaml(v)
        elif hasattr(v, 'value'):  # enum
            result[k] = v.value
        else:
            result[k] = v
    return result
```

### Pod 不在线

`get_first_pod_name` 返回 None 时:
- 同步端点返回 503 `{"detail": "Agent pod is not running"}`
- 自动发现时跳过同步，但仍然创建 DB 记录（`sync_status=pending`）

### 批量同步

`POST /agents/{id}/profiles/sync` 并发执行（`asyncio.gather` + `Semaphore(3)` 限制并发数）。

## 前端设计

### 看板 Profile 标签 (P0)

CreateTaskModal assignee 选择器:
- 显示 `display_name`（有则用，无则 fallback 到 name）
- 同步状态: synced（绿点）/ pending（灰点）/ failed（红点 + 错误提示）

### Agent 详情页 Profiles Tab (P0)

- 列表: profile 名、关联模板、同步状态、配置摘要
- 编辑: config_overrides JSON 编辑器 + SOUL.md textarea
- 操作: "同步到 Pod" 按钮（loading → 成功/失败反馈）
- "预览完整配置" 展开区域（调用 resolved-config API）

### 模板管理 (P1)

Settings 页或 Agent 详情页子 tab:
- 内置模板只读 + "复制为自定义模板"
- 自定义模板 CRUD
- 模板编辑器同 profile 编辑器

## 实现优先级

### P0 — MVP

1. DB 模型 + 迁移 + 内置模板 seed
2. 自动发现 + 模板关联（修改 kanban_routes.py）
3. 单个 profile 同步到 pod
4. CreateTaskModal assignee 显示 display_name + 同步状态

### P1 — 体验提升

5. Profile CRUD API + Agent 详情页 Profiles tab
6. 配置预览（resolved-config API）
7. 模板管理 API + 前端
8. 批量同步

### P2 — 进阶

9. 同步失败重试 + 定时 health-check 同步
10. 模板更新传播到已关联的 profiles
11. 更多预置角色模板（reviewer, tester, frontend-eng）
12. 配置变更审计日志

## 修改文件清单

| 文件 | 变更 |
|------|------|
| `admin/backend/db_models.py` | 新增 `ProfileTemplate`、`AgentProfile` 模型 |
| `admin/backend/database.py` | `init_db()` 中 seed 内置模板 |
| `admin/backend/kanban_routes.py` | assignees 端点增加自动发现+关联模板逻辑 |
| `admin/backend/profile_routes.py` | 新增模板和 profile CRUD 端点 |
| `admin/backend/main.py` | include `profile_router` |
| `admin/frontend/src/components/kanban/CreateTaskModal.tsx` | assignee 选择器显示 display_name + 状态 |
| `admin/frontend/src/pages/AgentDetailPage.tsx` | 新增 Profiles tab |
| `admin/frontend/src/components/profile/` | ProfileList、ProfileEditor 组件 |
| `admin/frontend/src/i18n/zh.ts` + `en.ts` | 新增 profile 相关 i18n 键 |

## 不需要修改的文件

- 上游 gateway/kanban 代码 — profile 发现和 worker 派发逻辑不变
- kanban SQLite — 任务存储不受影响
