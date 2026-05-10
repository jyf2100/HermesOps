# P2: Profile 配置管理进阶功能

> 继 P0/P1（模板 CRUD + Profile 同步）后的进阶阶段。

## 概览

| 编号 | 功能 | 复杂度 |
|------|------|--------|
| P2.9 | 自动重试失败同步 | 中 |
| P2.10 | 模板更新传播 | 中 |
| P2.11 | 更多预设模板 + 模板控制技能 | 低 |
| P2.12 | 配置变更审计日志 | 中 |

---

## P2.9 — 自动重试失败同步

### 机制

FastAPI `lifespan()` 启动后台 asyncio Task，每 5 分钟扫描 `sync_status='error'` 的 profiles，尝试重新同步。

### 实现

**文件：`admin/backend/profile_routes.py`**（或新文件 `admin/backend/sync_scheduler.py`）

```python
async def _retry_failed_syncs():
    """Background task: retry profiles stuck in error state."""
    while True:
        await asyncio.sleep(300)  # 5 min
        try:
            async with AsyncSessionLocal() as session:
                result = await session.execute(
                    select(AgentProfile).where(
                        AgentProfile.sync_status == "error"
                    )
                )
                profiles = result.scalars().all()

            for p in profiles:
                lock = get_sync_lock(p.agent_number, p.profile_name)
                async with lock:
                    async with AsyncSessionLocal() as session:
                        fresh = await session.get(AgentProfile, p.id)
                        if fresh is None or fresh.sync_status != "error":
                            continue
                        template = None
                        if fresh.template_id:
                            template = await session.get(ProfileTemplate, fresh.template_id)
                        await sync_profile_to_pod(
                            fresh.agent_number, fresh, template, session
                        )
        except Exception as exc:
            logger.warning("Sync retry loop error: %s", exc)
```

**文件：`admin/backend/main.py`**

在 `lifespan()` 中启动：

```python
async def lifespan(app: FastAPI):
    # ... existing startup ...
    sync_task = asyncio.create_task(_retry_failed_syncs())
    yield
    sync_task.cancel()
    # ... existing shutdown ...
```

### 要点

- 复用 `get_sync_lock()` 防止与手动同步冲突
- 失败 profiles 保持 `error` 状态，下次轮询再试
- 成功则 `sync_status` 改为 `synced`，更新 `last_synced_at`
- 无新表、无新 API 端点

---

## P2.10 — 模板更新传播

### 机制

模板 `config_overrides` 或 `soul_md` 变更后，重算所有关联 profiles 的 `config_hash`。hash 变化的 profile 标记为 `pending`，由 P2.9 轮询或手动同步处理。

### 实现

**文件：`admin/backend/profile_routes.py` — `update_template` 端点**

在 commit 成功后追加传播逻辑：

```python
# After session.commit() in update_template:
# Propagate changes to linked profiles
linked = await session.execute(
    select(AgentProfile).where(AgentProfile.template_id == tmpl.id)
)
for profile in linked.scalars().all():
    resolved = build_resolved_config(profile, tmpl)
    soul_md = get_resolved_soul_md(profile, tmpl)
    new_hash = compute_config_hash(resolved, soul_md)
    if new_hash != profile.config_hash:
        profile.config_hash = new_hash
        profile.sync_status = "pending"
        profile.sync_error = None
await session.commit()
```

### 要点

- 不立即同步 K8s — 交给 P2.9 或用户手动
- 仅 hash 变化才标记 `pending`（幂等）
- 前端无需改动 — ProfileList 已显示 `pending` 状态

---

## P2.11 — 更多预设模板 + 技能控制

### 新增预设模板

**文件：`admin/backend/database.py`** — 扩展种子数据

添加三个模板，每个有独特的 `config_overrides` 和 `soul_md`：

| 模板名 | 定位 | 关键配置 |
|--------|------|----------|
| `reviewer` | 代码审查 | 高精度模型、tools 限制为 read-only |
| `tester` | 测试工程 | 支持 exec 工具、focus on coverage |
| `frontend-eng` | 前端开发 | 支持 file+exec 工具、UI 专长 |

### 模板控制技能启用

模板的 `config_overrides` 支持 `skills` 字段：

```yaml
# template.config_overrides 示例
skills:
  enabled:
    - web-search
    - code-exec
  disabled:
    - file-upload
```

配置合并链：`DEFAULT → template.skills → profile.skills`

`sync_profile_to_pod` 写入的 `config.yaml` 已包含完整合并结果，agent/gateway 读取此配置决定哪些技能可用。

---

## P2.12 — 配置变更审计日志

### 新表

```sql
CREATE TABLE IF NOT EXISTS profile_audit_log (
    id SERIAL PRIMARY KEY,
    entity_type VARCHAR(16) NOT NULL,   -- 'template' | 'profile'
    entity_id INTEGER NOT NULL,
    action VARCHAR(16) NOT NULL,         -- 'create' | 'update' | 'delete'
    old_values JSONB,                    -- null for create
    new_values JSONB,                    -- null for delete
    changed_by VARCHAR(64) DEFAULT 'admin-ui',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON profile_audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON profile_audit_log(created_at DESC);
```

### DB Model

**文件：`admin/backend/db_models.py`**

```python
class ProfileAuditLog(Base):
    __tablename__ = "profile_audit_log"
    id = Column(Integer, primary_key=True)
    entity_type = Column(String(16), nullable=False)
    entity_id = Column(Integer, nullable=False)
    action = Column(String(16), nullable=False)
    old_values = Column(JSONB)
    new_values = Column(JSONB)
    changed_by = Column(String(64), default="admin-ui")
    created_at = Column(DateTime, default=func.now())
```

### 审计写入

**文件：`admin/backend/profile_routes.py`**

在模板和 profile 的 CUD 端点中，成功操作后插入审计记录：

```python
async def _audit(
    session, entity_type: str, entity_id: int,
    action: str, old_values: dict | None, new_values: dict | None,
):
    session.add(ProfileAuditLog(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        old_values=old_values,
        new_values=new_values,
    ))
```

### 查询端点

```
GET /profile-audit-log?entity_type=template&limit=50&offset=0
```

### 范围

- **记录**：模板和 profile 的 create/update/delete
- **不记录**：sync 操作（sync 是运维行为，非配置变更）

---

## 实现顺序

1. **P2.12** — 审计日志（基础表 + 写入逻辑，为后续操作提供追踪）
2. **P2.10** — 模板更新传播（审计日志可追踪传播事件）
3. **P2.11** — 更多预设模板 + 技能控制字段（纯数据）
4. **P2.9** — 自动重试（最后，依赖以上功能稳定后启用）

## 涉及文件

| 文件 | 操作 |
|------|------|
| `admin/backend/db_models.py` | 新增 `ProfileAuditLog` 模型 |
| `admin/backend/database.py` | 新增建表 migration + 3 个种子模板 |
| `admin/backend/profile_routes.py` | 审计写入 + 模板传播 + 重试循环 + 审计查询端点 |
| `admin/backend/profile_utils.py` | 无需改动（已支持完整功能） |
| `admin/backend/main.py` | 启动重试后台任务 |
| 前端 | 无需改动（P2.9/P2.10 自动生效，P2.12 查询可选） |

## 已知 MEDIUM 问题（来自 P1 review）

- `ProfileUpdate` 无法清除 `template_id`（需要 sentinel 模式）
- `_sync_locks` 字典无限增长（需要 LRU 或定期清理）
- 后端未返回 joined `template_name`/`template_display_name` 字段
