# Skills Hub API 设计文档

> 日期: 2026-05-10
> 状态: 专家审核后修订 (v2)
> 范围: Admin 面板集成 Skills Hub，暴露 REST API 供前端和外部系统管理 agent pod 上的 skills

## 背景

Skills Hub（`tools/skills_hub.py`）提供完整的 skill 生命周期管理（搜索、安装、卸载、更新、审计），但只支持 CLI/聊天接口。管理员需要 SSH 到 pod 执行 `hermes skills install` 等命令，操作门槛高且无法批量管理。

目标：**Admin 原生实现** Hub 操作 — 将 `skills_hub.py` 拆分为无副作用核心层（admin 可 import）和本地文件系统层（仅 agent 用），在 admin 容器内完成网络获取和安全扫描，通过 K8s exec 写入 agent pod。

## 架构

```
Admin Frontend                Admin Backend (FastAPI)              Agent Pod
    │                              │                                │
    │  browse/search               │                                │
    ├─────────────────────────────►│ create_source_router()         │
    │                              │ unified_search()               │
    │  ← skill 列表                │ (在 admin 容器内执行)           │
    │                              │                                │
    │  install(skill, agent_id)    │                                │
    ├─────────────────────────────►│ src.fetch() → admin 缓存       │
    │                              │ scan_skill() → 安全扫描         │
    │                              │ tar 打包 → 单次 exec ─────────►│ 解压到 skills/
    │                              │ 更新 lock.json      ─────────►│ 更新 lockfile
    │  ← 安装结果                  │                                │
    │                              │                                │
    │  uninstall(skill, agent_id)  │                                │
    ├─────────────────────────────►│ 读 lock.json       ◄──────────│
    │                              │ 路径验证 + rm -rf  ───────────►│ 删除 skill 文件
    │                              │ 更新 lock.json      ─────────►│ 更新 lockfile
    │  ← 卸载结果                  │                                │
```

### 代码拆分（v2 关键修正）

原设计直接 `from tools.skills_hub import ...`，但 `skills_hub.py` 有模块级 `get_hermes_home()` 副作用，admin 容器中缺少 `tools/`、`hermes_constants`、`jwt`、`gh` CLI。**必须拆分**：

```
tools/skills_hub.py (2723行)
  ↓ 拆分为
tools/skills_hub_core.py     → 数据类 + 源适配器 + 搜索（无副作用，admin 可 import）
  包含: SkillMeta, SkillBundle, SkillSource(ABC), GitHubSource, SkillsShSource,
        ClawHubSource, ClaudeMarketplaceSource, LobeHubSource, HermesIndexSource,
        create_source_router(), unified_search(), parallel_search_sources(),
        bundle_content_hash()
  不含: get_hermes_home(), HERMES_HOME, SKILLS_DIR, HubLockFile, quarantine_bundle,
        install_from_quarantine, uninstall_skill

tools/skills_hub_local.py    → LockFile + quarantine + install（依赖 get_hermes_home，仅 agent 用）
  包含: HubLockFile, TapsManager, quarantine_bundle(), install_from_quarantine(),
        uninstall_skill(), check_for_skill_updates()
  导入: from tools.skills_hub_core import SkillBundle, ...
```

Admin 只 import `skills_hub_core` + `skills_guard`。安装/卸载逻辑在 `hub_routes.py` 中用 async K8s 客户端重新实现。

### 缓存层

Admin 在 `/opt/data/hub-cache/`（hostPath 挂载）缓存已下载的 skill bundle：

```
/opt/data/hub-cache/
  web-search/
    SKILL.md
    manifest.json  (source, hash, fetched_at, trust_level)
    files/
```

- **TTL**: 24h（可配置，环境变量 `HUB_CACHE_TTL_HOURS`）
- **清理**: LRU，最多 50MB 或 100 个 skill（取先到者）
- **多 agent 复用**: 同一 skill 安装到多个 agent 只下载一次
- **离线降级**: Hub 不可用时从缓存安装
- **完整性校验**: manifest.json 中的 hash 在每次从缓存加载时重新验证，hash 存入 DB（非同目录）防篡改
- **trust_level 防篡改**: trust_level 写入 admin SQLite/PostgreSQL，不从 manifest.json 读取

### K8s 写入安全（v2 关键修正）

原设计逐文件 `write_file_to_pod` 存在超时和安全风险。修正为：

**1. 路径白名单**

`write_file_to_pod` 和 `delete_file_from_pod` 缺少路径验证（`read_file_from_pod` 有）。添加：

```python
# k8s_client.py — 提取共享的路径验证函数
async def _validate_pod_path(self, pod_name: str, path: str, mode: str = "read") -> str:
    """验证 pod 路径在白名单内，返回 realpath。"""
    ALLOWED_READ_PREFIXES = ("/home", "/tmp", "/var/log", "/opt/hermes", "/opt/data")
    ALLOWED_WRITE_PREFIXES = ("/opt/data/skills/",)  # Hub 写入只允许这个前缀
    prefixes = ALLOWED_WRITE_PREFIXES if mode == "write" else ALLOWED_READ_PREFIXES
    resolved = await self._realpath(pod_name, path)
    if not any(resolved.startswith(p) for p in prefixes):
        raise ValueError(f"Path {resolved} outside allowed {mode} prefixes")
    return resolved
```

**2. tar 管道批量写入**

替代逐文件 exec 调用（20 文件 × 30s timeout = 600s），改为：

```python
async def install_skill_to_pod(self, k8s: K8sClient, pod_name: str,
                                skill_name: str, files: dict[str, bytes]) -> int:
    """打包 skill 文件并通过单次 K8s exec 写入 pod。"""
    import tarfile, io, base64
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        for fname, content in files.items():
            info = tarfile.TarInfo(name=f"{skill_name}/{fname}")
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
    b64 = base64.b64encode(buf.getvalue()).decode()
    # 单次 exec：解压到 /opt/data/skills/
    stdout, stderr = await k8s.run_command(
        pod_name,
        ["sh", "-c", f"echo '{b64}' | base64 -d | tar -xzf - -C /opt/data/skills/"]
    )
    return len(files)
```

**3. Per-pod 异步锁**

防止并发操作同一 pod 的 lock.json：

```python
# hub_routes.py
_pod_locks: dict[str, asyncio.Lock] = {}
def _get_pod_lock(pod_name: str) -> asyncio.Lock:
    return _pod_locks.setdefault(pod_name, asyncio.Lock())

# 所有 hub 操作加锁
async with _get_pod_lock(pod_name):
    # install / uninstall / update 操作
```

**4. Lockfile 原子更新**

使用 pod 内 `flock` 确保 lock.json 的 read-modify-write 原子性：

```python
# 整个 lockfile 更新作为单个 shell 脚本在 pod 内执行
lock_script = """
flock /opt/data/skills/.hub/lock.lockfile -c "
  cat /opt/data/skills/.hub/lock.json
  # ... python json update ...
  echo '{new_lock_content}' > /opt/data/skills/.hub/lock.json
"
"""
await k8s.run_command(pod_name, ["sh", "-c", lock_script])
```

### GitHub Token 配置（v2 新增）

- 环境变量 `GITHUB_TOKEN` 通过 Kubernetes Secret 注入 admin 容器
- Token 范围：`public_repo` only
- `httpx` 调用设置 `follow_redirects=False`，防止 token 通过 3xx 重定向泄露
- 日志中过滤 `Authorization` header

### Pod 重建与状态协调（v2 新增）

Skills 目录使用 hostPath（`/data/hermes/agent{N}/skills/`），pod 重建后文件保留（同节点）。但 lockfile 可能丢失。

**协调机制**：`GET /agents/{agent_id}/hub/skills` 同时读 scan_skills 结果和 lock.json，合并后返回：

```json
[
  {
    "name": "web-search",
    "source": "hub",
    "trust_level": "trusted",
    "installed_at": "2026-05-10T12:00:00Z",
    "content_hash": "abc123",
    "orphan": false
  },
  {
    "name": "my-local-skill",
    "source": "unknown",
    "trust_level": null,
    "installed_at": null,
    "content_hash": "def456",
    "orphan": true
  }
]
```

`orphan: true` 表示 skill 文件存在但 lock.json 无记录（可能是 pod 重建后丢失）。

## API 端点

### 认证要求（v2 新增）

所有 Hub 端点遵循现有 admin auth 模式：

| 端点类型 | 认证 | 说明 |
|----------|------|------|
| `GET /hub/*` | `auth` | 只读操作，用户模式可访问 |
| `GET /agents/{id}/hub/audit/*` | `auth` + `admin_only` | 暴露安全细节 |
| `POST /agents/{id}/hub/install` | `auth` + `admin_only` | 变更操作 |
| `DELETE /agents/{id}/hub/skills/*` | `auth` + `admin_only` | 变更操作 |
| `POST /agents/{id}/hub/update/*` | `auth` + `admin_only` | 变更操作 |

### 搜索 & 浏览（全局，不需要 agent_id）

```
GET    /hub/search?q=<query>&source=<filter>&limit=<n>
GET    /hub/browse?offset=<n>&limit=<n>&source=<filter>    # 分页统一用 offset/limit
GET    /hub/inspect/<identifier>
```

响应格式（与现有 admin API 一致）：
```json
// browse/search
{ "total": 42, "items": [...], "limit": 20, "offset": 0 }

// inspect
{ "name": "web-search", "description": "...", "source": "github", "trust_level": "trusted", "skill_md_preview": "..." }
```

### Agent 级操作

```
GET    /agents/{agent_id}/hub/skills          # 已安装列表（合并 scan_skills + lock.json）
POST   /agents/{agent_id}/hub/install         # { identifier, force? }
DELETE /agents/{agent_id}/hub/skills/<name>    # 卸载（幂等，已不存在返回 404）
POST   /agents/{agent_id}/hub/check           # 检查更新
POST   /agents/{agent_id}/hub/update/<name>   # 执行更新
GET    /agents/{agent_id}/hub/audit/<name>     # 安全审计
GET    /agents/{agent_id}/hub/tasks/<task_id>  # 异步任务状态
```

### 异步 Task 模型（v2 新增）

Install 操作耗时较长，使用异步任务：

```python
class HubTask:
    task_id: str            # "install-abc123"
    status: str             # pending | fetching | scanning | writing | verifying | completed | failed
    progress: float         # 0.0 - 1.0
    phase: str              # 当前阶段描述
    result: dict | None     # 成功时返回安装结果
    error: str | None       # 失败时返回错误信息
    created_at: float       # unix timestamp
    ttl: int                # 任务保留时间（秒），默认 3600
```

前端轮询 `GET /agents/{agent_id}/hub/tasks/<task_id>`，间隔 1s，总超时 120s。

### Install 流程（v2 修订）

```
POST /agents/{agent_id}/hub/install
Body: { "identifier": "github:user/repo/web-search", "force": false }

1. 参数校验
   └── agent 存在且有 running pod
   └── identifier 格式合法（防止注入）
   └── 创建 HubTask，状态 = pending

2. 查找源适配器 (asyncio.to_thread)
   └── create_source_router() → 遍历适配器找匹配 identifier
   └── 未找到 → task.status = failed

3. 检查缓存
   └── /opt/data/hub-cache/<name>/manifest.json
   ├── 命中 + hash 验证通过 + 未过期 → 跳到步骤 5
   └── 未命中 → 继续
   └── task.status = fetching

4. 下载到缓存 (asyncio.to_thread)
   └── src.fetch(identifier) → SkillBundle
   └── 写入缓存目录 + DB 记录 hash + trust_level
   └── task.status = scanning

5. 安全扫描 (asyncio.to_thread)
   └── scan_skill(cache_path) 在 admin 容器内执行
   └── trust_level 从 DB 读取（非 manifest.json）
   ├── community skill 有 CRITICAL finding → task.status = failed
   └── 通过 → 继续

6. 获取 pod 锁 + 读 lock.json
   └── async with _get_pod_lock(pod_name):
   ├── 已存在 + force=false → task.status = failed (409)
   └── 已存在 + force=true → 先卸载旧版
   └── task.status = writing

7. tar 管道写入 agent pod（单次 exec）
   └── 将 bundle.files 打包为 tar.gz
   └── base64 编码后通过 run_command 解压到 /opt/data/skills/
   └── 验证写入：k8s.list_dir(pod, "/opt/data/skills/<name>")

8. 原子更新 lock.json（flock）
   └── 更新 skill 条目 → 写回 pod

9. 刷新 DB 缓存
   └── scan_skills(k8s, pod) → 更新 agent_skills 表
   └── task.status = completed

10. 返回 HubTask 结果
   └── { skill, status, files_written, scan_result, duration_ms }
```

### Uninstall 流程（v2 修订）

```
DELETE /agents/{agent_id}/hub/skills/<name>

1. 参数校验
   └── name 格式校验（拒绝 ..、/ 等路径穿越字符）
   └── realpath 验证解析后路径以 /opt/data/skills/ 开头

2. 获取 pod 锁 + 读 lock.json
   └── async with _get_pod_lock(pod_name):
   └── 查找 skill 条目
   └── 未找到 → 404（幂等，不报错）

3. 删除文件
   └── 验证路径后执行: k8s.run_command(pod, ["rm", "-rf", validated_path])

4. 原子更新 lock.json（flock）

5. 刷新 DB 缓存

6. 返回 { skill, status: "uninstalled" }
```

### Check Updates 流程

```
POST /agents/{agent_id}/hub/check
Body: { "name": "web-search" }   # 可选，不传则检查全部

1. 获取 pod 锁 + 读 lock.json → 获取已安装 skills 的 content_hash
2. create_source_router() → 查找每个 skill 的上游源
3. src.fetch() 到 admin 缓存 → 比较 hash
4. 返回 { "total": N, "items": [{ name, current_hash, upstream_hash, has_update }] }
```

### Update 流程

```
POST /agents/{agent_id}/hub/update/<name>

逻辑 = uninstall(旧版) + install(新版, force=true)，在同一 pod 锁内串行执行。
```

### Audit 流程

```
GET /agents/{agent_id}/hub/audit/<name>

1. 获取 pod 锁 + 读 lock.json → 验证 skill 存在
2. 从 admin 缓存获取 bundle（缓存未命中则从 pod 读取文件）
3. admin 容器内 scan_skill()
4. 返回 {
     trust_level, findings: [{severity, message, file}],
     structural_checks: {file_count, total_size, ...},
     scan_context: "admin-cache"  // 标注扫描上下文
   }
```

## 错误处理

| 场景 | 错误码 | 处理 |
|------|--------|------|
| Pod 未运行 | 409 | 前端禁用所有操作按钮 + 显示"请先启动 Agent"提示 |
| Skill 已安装 (force=false) | 409 | 前端显示"已安装，是否覆盖？" + force=true 选项 |
| Hub 源不可达 | 502 | 依次尝试源适配器，全部失败返回错误 + 缓存降级提示 |
| 安全扫描 CRITICAL (community) | 403 | 返回扫描报告，前端展示 findings，**不允许 force 绕过** |
| K8s exec 超时 | 504 | task.status = failed，前端提示重试 |
| Skill 名非法/不存在 | 400 | 参数校验前置拦截 |
| 安装中间失败（部分写入） | 500 | 回滚：删除已写入文件，保持 lockfile 不变 |

**force 标志策略（v2 修订）**：
- `force=true` 跳过 WARNING 级别的 findings，仍阻止 CRITICAL findings
- 所有 force 操作记录审计日志
- `force=true` 需要 `admin_only` 权限

## 前端设计

### 页面布局（v2 修订）

在 AgentDetailPage 新增 **Skills Tab**（现有页面没有 Skills Tab，skills 信息在 Overview 的 MetadataCard 中）：

```
AgentDetailPage
├── 概览 Tab
├── 配置 Tab
├── Skills Tab (新增)
│   ├── 子 Tab: "已安装" | "浏览 Hub"
│   │
│   ├── 已安装 子 Tab
│   │   ├── Agent 状态横幅（未运行时显示警告 + 启动按钮）
│   │   └── InstalledSkillRow 列表
│   │       └── [名称] [版本] [来源标签] [信任徽章] [审计▼] [更新] [卸载]
│   │       └── 来源标签: Hub(绿) / 内置(蓝) / 未知(灰)
│   │       └── 孤儿标记: "⚠ 来源未知" (lock.json 无记录)
│   │
│   └── 浏览 Hub 子 Tab
│       ├── 搜索栏 + 源过滤下拉
│       ├── HubSkillCard 卡片网格 (grid-cols-1 md:2 lg:3)
│       │   └── [名称] [描述(1行截断)] [来源] [信任徽章] [安装→]
│       ├── 分页器 (使用 offset/limit)
│       └── InstallDialog 安装弹窗
│           ├── 多阶段进度: Fetching → Scanning → Writing → Verifying
│           ├── 扫描结果（信任级别 + findings 列表）
│           └── [确认安装] / [取消]
│
├── 日志 Tab
└── ...
```

全局 Hub 浏览页面（可选，Phase 2）：`/admin/hub` — 独立于 agent 的 Hub 发现页面。

### 信任级别可视化

```
Official (builtin)    → bg-success/10 text-success border-success/20   (绿)
Trusted (verified)    → bg-accent-cyan/10 text-accent-cyan border-accent-cyan/20 (青)
Community (unverified)→ bg-warning/10 text-warning border-warning/20   (黄)
```

### 错误状态映射

| API 错误 | 前端处理 |
|----------|----------|
| 403 扫描失败 | ScanReportView 内联展示 findings，安装按钮禁用 |
| 409 Pod 未运行 | 顶部警告横幅 + "启动 Agent" 按钮，所有操作禁用 |
| 409 已安装冲突 | 按钮变为"重新安装"，弹出 force 确认 |
| 504 exec 超时 | Toast 提示 + "重试" 按钮 |
| 502 Hub 不可达 | 离线横幅 + "重试" + "查看缓存" 降级 |

### 新增组件

| 组件 | 功能 |
|------|------|
| `AgentSkillsTab` | Skills Tab 容器，管理子 Tab 切换 |
| `InstalledSkillList` | 已安装 skills 列表 + Agent 状态横幅 |
| `InstalledSkillRow` | 单行：来源标签、信任徽章、操作按钮 |
| `HubBrowser` | Hub 浏览器：搜索 + 卡片网格 + 分页 |
| `HubSkillCard` | Hub skill 卡片：名称、描述、来源、信任、安装按钮 |
| `InstallDialog` | 安装弹窗：多阶段进度条 + 扫描报告 |
| `ScanReportView` | 安全扫描报告展示（复用于 audit） |

### i18n 新增（约 40-50 key）

```typescript
// zh 示例
hubInstalled: "已安装",
hubBrowse: "浏览 Hub",
hubSearchPlaceholder: "搜索 Hub skills...",
hubInstall: "安装到此 Agent",
hubInstalling: "安装中...",
hubUninstall: "卸载",
hubUninstallConfirm: "确认卸载 {name}？",
hubUpdateAvailable: "有更新",
hubAuditReport: "安全审计报告",
hubTrustOfficial: "官方",
hubTrustTrusted: "可信",
hubTrustCommunity: "社区",
hubSourceHub: "Hub",
hubSourceBuiltin: "内置",
hubSourceUnknown: "未知",
hubOrphanWarning: "来源未知",
hubPodNotRunning: "Agent 未运行，无法管理 Skills",
hubStartAgent: "启动 Agent",
hubScanFindings: "{count} 个安全发现",
hubPhaseFetching: "获取中...",
hubPhaseScanning: "扫描中...",
hubPhaseWriting: "写入中...",
hubPhaseVerifying: "验证中...",
hubForceWarning: "覆盖安装将跳过安全警告",
```

## 优先级排序（v2 修订）

基于产品专家建议，调整 MVP 优先级：

| 优先级 | 操作 | 说明 |
|--------|------|------|
| **P0** | search + browse | 发现是前提，没有发现就没有安装 |
| **P0** | install | 核心价值主张 |
| **P0** | 已安装列表（增强） | 合并 scan_skills + lock.json，含来源信息 |
| **P1** | uninstall | 完整生命周期必需 |
| **P1** | audit | 安全扫描是差异化优势，管理员信任关键 |
| **P2** | check + update | 版本管理，MVP 阶段可接受卸载重装替代 |
| **P3** | inspect (SKILL.md 预览) | 锦上添花 |

## 实现计划

### Phase 0 — 前置工作（blocking）

1. **拆分 `skills_hub.py`** 为 `skills_hub_core.py`（无副作用）和 `skills_hub_local.py`
2. **`k8s_client.py` 路径白名单** — 为 `write_file_to_pod` 和 `delete_file_from_pod` 添加路径验证
3. **Admin Dockerfile 更新** — 添加 `tools/skills_hub_core.py` + `tools/skills_guard.py` + `hermes_constants.py`
4. **GitHub Token Secret** — 创建 K8s Secret，注入 admin 容器

### Phase 1 — 核心 API（后端）

5. 新增 `admin/backend/hub_cache.py` — 缓存管理（fetch/check/store/clean + DB hash 存储）
6. 新增 `admin/backend/hub_routes.py` — browse/search/install/uninstall/audit
7. Per-pod 异步锁 + lockfile flock 原子更新
8. tar 管道批量写入（替代逐文件 exec）
9. 异步 HubTask 管理
10. 结构化日志（安装耗时、扫描结果、缓存命中率）

### Phase 2 — 前端 Hub 浏览器

11. AgentDetailPage 新增 Skills Tab
12. `InstalledSkillList` + `InstalledSkillRow`（含来源信息）
13. `HubBrowser` + `HubSkillCard` + `InstallDialog`
14. `ScanReportView` 组件
15. i18n（中英文，约 40-50 key）

### Phase 3 — 完善

16. check + update 端点（P2 优先级）
17. E2E 测试（Playwright mock）
18. 全局 Hub 浏览页面 `/admin/hub`（可选）
19. 缓存 LRU 清理 + TTL 过期
20. 批量安装端点（可选）

### 不做的（YAGNI）

- **publish** — 管理员不需要从 admin 面板发布 skill 到 Hub
- **snapshot import/export** — 属于 CLI 批量操作场景
- **tap 管理** — 添加/移除 Hub 源，低频操作，CLI 足够
- **reset** — 恢复内置 skill，罕见操作
- **skill 启用/禁用** — 与安装/卸载正交，推迟
- **模板 hub_skills 字段** — 自动安装，推迟到 Phase 3+

## 已知限制

- **hostPath 单节点**: Skills 使用 hostPath 挂载，仅在单节点集群持久化。多节点部署需迁移到 PVC
- **扫描器是最佳努力**: 基于正则的静态分析无法捕获所有混淆，定位为深度防御而非保证
- **Agent CLI 并发**: Admin 和 Agent 内的 `/skills` 命令可能同时操作 lock.json。flock 缓解但不完全消除
- **大型 skill**: tar 管道有 2MB ARG_MAX 限制（base64 后约 1.5MB 原始数据），超大 skill 需要分块
