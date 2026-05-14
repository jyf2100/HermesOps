# Agent Ops Panel Sidecar 集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 hermes-web-ui 以 `ops-panel` sidecar 容器部署到 gateway pod，通过 Ingress `/agent{N}/ops/` 暴露，Admin Panel 侧边栏提供入口链接。

**Architecture:** hermes-web-ui 直接读写 hermes-agent 的数据，通过共享 `hermes-data` 卷（`HERMES_HOME=/opt/data`），无需独立数据目录。改动集中在 admin 仓库：templates.py 添加 sidecar + Service 端口，agent_manager.py 添加 ops Ingress 路径，AdminLayout.tsx 接入动态 URL。

**Tech Stack:** Python/FastAPI (admin backend), React/Tailwind (admin frontend), Kubernetes manifests

**设计文档:** `docs/superpowers/specs/2026-05-13-hermes-webui-sidecar-design.md`

---

## 文件结构

### 修改

| 文件 | 改动 |
|------|------|
| `admin/backend/templates.py:176-250` | 添加 ops-panel sidecar 容器 + securityContext |
| `admin/backend/templates.py:258` | Service 添加 ops 端口 |
| `admin/backend/agent_manager.py:376` | 创建 agent 时添加 ops Ingress 路径 |
| `admin/frontend/src/components/AdminLayout.tsx:247-253` | 更新 navAgentPanel href |

---

## Task 1: templates.py 添加 ops-panel sidecar 容器

**文件:**
- Modify: `/mnt/disk01/workspaces/worksummary/hermes-agent/admin/backend/templates.py:176-250`

此任务在 `render_deployment()` 方法中：(1) 添加 `securityContext`，(2) 添加第三个容器 `ops-panel`，(3) 无需新 volume——ops-panel 共享 `hermes-data` 卷。

- [ ] **Step 1: 添加 securityContext 到 pod spec**

在 `templates.py` 的 `render_deployment()` 方法中，找到 pod template 的 `"spec": {`（约第 176 行），在 `serviceAccountName` 之前添加 `securityContext`：

当前代码（第 176-177 行）：
```python
                    "spec": {
                        "serviceAccountName": "hermes-gateway",
```

改为：
```python
                    "spec": {
                        "securityContext": {"fsGroup": 10000},
                        "serviceAccountName": "hermes-gateway",
```

- [ ] **Step 2: 在 containers 数组末尾添加 ops-panel 容器**

在 `dashboard` 容器定义之后（第 238-239 行），追加 ops-panel 容器：

当前代码：
```python
                            "volumeMounts": [{"name": "hermes-data", "mountPath": "/opt/data"}],
                        }],
```

改为：
```python
                            "volumeMounts": [{"name": "hermes-data", "mountPath": "/opt/data"}],
                        }, {
                            "name": "ops-panel",
                            "image": "ekkoye8888/hermes-web-ui",
                            "imagePullPolicy": "IfNotPresent",
                            "ports": [{"containerPort": 6060}],
                            "env": [
                                {"name": "HERMES_HOME", "value": "/opt/data"},
                                {"name": "PORT", "value": "6060"},
                                {"name": "HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN", "value": "0"},
                                {"name": "HERMES_WEB_UI_API_BASE_URL", "value": "http://localhost:8642"},
                            ],
                            "resources": {
                                "requests": {"cpu": "50m", "memory": "128Mi"},
                                "limits": {"cpu": "250m", "memory": "512Mi"},
                            },
                            "readinessProbe": {
                                "httpGet": {"path": "/api/health", "port": 6060},
                                "initialDelaySeconds": 15, "periodSeconds": 30,
                                "timeoutSeconds": 5, "failureThreshold": 6,
                            },
                            "livenessProbe": {
                                "httpGet": {"path": "/api/health", "port": 6060},
                                "initialDelaySeconds": 30, "periodSeconds": 30,
                                "timeoutSeconds": 10, "failureThreshold": 5,
                            },
                            "volumeMounts": [
                                {"name": "hermes-data", "mountPath": "/opt/data"},
                            ],
                        }],
```

关键点：
- Dockerfile 已设置 `ENTRYPOINT ["node", "dist/server/index.js"]`，不需要 K8s `command` 覆盖
- `HERMES_HOME=/opt/data` — 指向共享卷，web-ui 直接读写 hermes agent 数据
- 无 `HERMES_WEB_UI_HOME` — web-ui 自身数据（auth token、config）使用默认 `HOME/.hermes-web-ui/` 路径
- 共享同一个 `hermes-data` volume，无需额外的 `ops-data` volume

- [ ] **Step 3: 验证 Python 语法**

Run: `cd /mnt/disk01/workspaces/worksummary/hermes-agent && python3 -c "from admin.backend.templates import TemplateGenerator; t = TemplateGenerator(); d = t.render_deployment(99, 'test-secret', t.ResourceSpec()); print('containers:', len(d['spec']['template']['spec']['containers'])); print('volumes:', len(d['spec']['template']['spec']['volumes'])); print('fsGroup:', d['spec']['template']['spec'].get('securityContext'))"`
Expected: `containers: 3`, `volumes: 1`, `fsGroup: {'fsGroup': 10000}`

- [ ] **Step 4: Commit**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent
git add admin/backend/templates.py
git commit -m "feat(admin): add ops-panel sidecar container to gateway pod template"
```

---

## Task 2: templates.py Service 添加 ops 端口

**文件:**
- Modify: `/mnt/disk01/workspaces/worksummary/hermes-agent/admin/backend/templates.py:252-266`

- [ ] **Step 1: 在 render_service() 的 ports 数组添加 ops 端口**

当前代码（约第 258-263 行）：
```python
                "ports": [
                    {"name": "api", "port": 8642, "targetPort": 8642},
                    {"name": "dashboard", "port": 9119, "targetPort": 9119},
                ],
```

改为：
```python
                "ports": [
                    {"name": "api", "port": 8642, "targetPort": 8642},
                    {"name": "dashboard", "port": 9119, "targetPort": 9119},
                    {"name": "ops", "port": 6060, "targetPort": 6060},
                ],
```

- [ ] **Step 2: 验证**

Run: `cd /mnt/disk01/workspaces/worksummary/hermes-agent && python3 -c "from admin.backend.templates import TemplateGenerator; t = TemplateGenerator(); s = t.render_service(99); print('ports:', s['spec']['ports'])"`
Expected: 包含 3 个端口（api:8642, dashboard:9119, ops:6060）

- [ ] **Step 3: Commit**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent
git add admin/backend/templates.py
git commit -m "feat(admin): add ops port 6060 to gateway service template"
```

---

## Task 3: agent_manager.py 添加 ops Ingress 路径

**文件:**
- Modify: `/mnt/disk01/workspaces/worksummary/hermes-agent/admin/backend/agent_manager.py`

`remove_ingress_path("/agent{N}")` 已通过 `startswith` 匹配自动清理 `/agent{N}/ops` 路径，所以只需在创建时添加 ops 路径。

**重要顺序**：必须先添加 gateway 路径 `/agent{N}`，再添加 ops 路径 `/agent{N}/ops`。因为 `add_ingress_path` 的重复检测使用 `startswith` 匹配，如果 ops 路径先添加，后续添加 gateway 路径时 `"/agent{N}/ops".startswith("/agent{N}/")` 为 True，会报重复错误。

- [ ] **Step 1: 在 create_agent() 中添加 ops Ingress 路径**

找到 `add_ingress_path` 调用（约第 376 行），当前代码：
```python
                await self.k8s.add_ingress_path(
                    path=f"/agent{agent_num}", service_name=name, service_port=8642,
                )
```

在其后添加 ops 路径：
```python
                await self.k8s.add_ingress_path(
                    path=f"/agent{agent_num}", service_name=name, service_port=8642,
                )
                await self.k8s.add_ingress_path(
                    path=f"/agent{agent_num}/ops", service_name=name, service_port=6060,
                )
```

Nginx Ingress 按最长路径优先匹配，`/agent{N}/ops` 比 `/agent{N}` 更具体，会优先匹配到 ops-panel 的 6060 端口。

- [ ] **Step 2: Commit**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent
git add admin/backend/agent_manager.py
git commit -m "feat(admin): add ops-panel ingress path on agent creation"
```

---

## Task 4: AdminLayout.tsx 侧边栏更新 Agent 控制台 URL

**文件:**
- Modify: `/mnt/disk01/workspaces/worksummary/hermes-agent/admin/frontend/src/components/AdminLayout.tsx:247-253`
- Modify: `/mnt/disk01/workspaces/worksummary/hermes-agent/admin/frontend/src/i18n/en.ts`
- Modify: `/mnt/disk01/workspaces/worksummary/hermes-agent/admin/frontend/src/i18n/zh.ts`

- [ ] **Step 1: 更新 i18n 翻译**

`admin/frontend/src/i18n/en.ts`:
```typescript
navAgentPanel: "Agent Console",
```

`admin/frontend/src/i18n/zh.ts`:
```typescript
navAgentPanel: "Agent 控制台",
```

- [ ] **Step 2: 更新 navAgentPanel 的 href 为动态 URL**

当前代码（约第 247-253 行）：
```typescript
const navItems: NavItem[] = isUser
  ? [
      { to: "/", label: t.navDashboard, icon: IconDashboard },
      { to: "/files", label: t.fileBrowser, icon: IconFolder },
      { to: "/chat", label: t.startChat, icon: IconChat },
      { to: "#", label: t.navAgentPanel, icon: IconTerminal, href: "#" },
    ]
```

改为（注意顺序调整：Chat 在 Agent 控制台之前）：
```typescript
const storedAgentId = parseInt(localStorage.getItem("admin_user_agent_id") || "0", 10)
const opsPanelUrl = storedAgentId > 0 ? `${window.location.origin}/agent${storedAgentId}/ops/` : "#"

const navItems: NavItem[] = isUser
  ? [
      { to: "/", label: t.navDashboard, icon: IconDashboard },
      { to: "/files", label: t.fileBrowser, icon: IconFolder },
      { to: "/chat", label: t.startChat, icon: IconChat },
      ...(storedAgentId > 0 ? [{ to: "#", label: t.navAgentPanel, icon: IconTerminal, href: opsPanelUrl }] : []),
    ]
```

关键点：
- 使用 `localStorage.getItem("admin_user_agent_id")` 获取 agent ID，与 DashboardPage/FileBrowserPage 复用同一模式
- `storedAgentId > 0` 判断用户是否绑定了 agent，未绑定时完全隐藏该导航项
- Chat 排在 Agent 控制台之前（Dashboard → Files → Chat → Agent 控制台）

- [ ] **Step 3: TypeScript 编译检查**

Run: `cd /mnt/disk01/workspaces/worksummary/hermes-agent/admin/frontend && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent
git add admin/frontend/src/components/AdminLayout.tsx admin/frontend/src/i18n/en.ts admin/frontend/src/i18n/zh.ts
git commit -m "feat(admin): wire Agent Console sidebar link to ops-panel URL"
```

---

## Task 5: 构建和部署验证

- [ ] **Step 1: 前端构建**

Run: `cd /mnt/disk01/workspaces/worksummary/hermes-agent/admin/frontend && npm run build`
Expected: 构建成功

- [ ] **Step 2: Docker 构建 admin 镜像**

Run: `cd /mnt/disk01/workspaces/worksummary/hermes-agent/admin && docker build -f backend/Dockerfile --build-context tools=../tools -t hermes-admin:latest .`
Expected: 构建成功

- [ ] **Step 3: 导入镜像到 K8s containerd**

Run: `docker save hermes-admin:latest | sudo ctr -n k8s.io images import -`
Expected: 导入成功

- [ ] **Step 4: 重启 admin deployment**

Run: `kubectl rollout restart deployment/hermes-admin -n hermes-agent`
Expected: rollout started

- [ ] **Step 5: 端到端验证**

1. Admin Panel → 创建新 agent → `kubectl get pods -n hermes-agent` — 确认 3/3 running（gateway + dashboard + ops-panel）
2. `kubectl describe svc gateway-{N}` — 确认 3 个端口（8642, 9119, 6060）
3. `kubectl describe ingress hermes-agents-ingress` — 确认有 `/agent{N}/ops` 路径
4. 浏览器访问 `http://{host}:32570/agent{N}/ops/` — 确认显示 ops-panel 界面
5. **SPA 路由验证**: 在 ops-panel 页面内点击导航，刷新页面，确认 JS/CSS 资源正常加载（验证 rewrite-target 对 SPA 的影响）
6. Admin Panel 用户模式 → Agent 控制台 链接可点击 → 跳转到 ops-panel
7. **删除验证**: 删除 agent → `kubectl describe ingress hermes-agents-ingress` — 确认 ops 路径已清理
8. **重建验证**: 重新创建 agent → 确认 ops 路径正确重新添加

---

## 自查结果

### Spec Coverage Check
- [x] K8s sidecar 容器部署 — Task 1
- [x] Service 端口添加 — Task 2
- [x] Ingress 路径规则 — Task 3
- [x] Admin 前端侧边栏 — Task 4
- [x] 数据共享（hermes-data 卷，非独立卷）— Task 1
- [x] 命名区分 (ops-panel vs hermes-webui) — 全文统一

### Placeholder Scan
- 无 TBD/TODO/implement later
- 所有代码块包含完整实现
- 无占位符描述

### Type Consistency
- ops-panel 容器名、端口名全文统一：`ops-panel` / `ops`
- Ingress 路径统一：`/agent{N}/ops`
- Volume：复用 `hermes-data`，无新增 volume
- 类名：`TemplateGenerator`（不是 `DeploymentTemplate`）
- Agent ID：使用 `localStorage.getItem("admin_user_agent_id")`（不是 `useParams`）
- 侧边栏名称：Agent Console / Agent 控制台（不是 Agent Panel）
- 侧边栏顺序：Dashboard → Files → Chat → Agent 控制台
