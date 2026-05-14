# Agent Ops Panel Sidecar 集成设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 hermes-web-ui 以 sidecar 容器方式部署到每个 agent gateway pod 中，通过 Ingress 暴露 `/agent{N}/ops/` 路径，Admin Panel 用户模式侧边栏提供入口链接。

**Architecture:** hermes-web-ui（代码仓库 `hermes-web-ui/`，K8s 容器名 `ops-panel`）作为第三个容器加入 gateway pod，与 gateway 共享网络命名空间和 hermes 数据卷（读写）。ops-panel 通过 `HERMES_HOME=/opt/data` 直接读写 hermes-agent 数据，无需独立数据目录或代码变更。Ingress 添加 ops 路径规则，前端侧边栏构建动态 URL。

**Tech Stack:** Kubernetes (sidecar pattern), FastAPI (admin backend), React + Tailwind (admin frontend), Node.js (hermes-web-ui), Nginx Ingress

---

## 0. 命名规范（重要）

项目中存在两个名称相近的 web-ui 系统，必须严格区分：

| 属性 | Open WebUI（聊天界面） | Agent Ops Panel（运营面板） |
|------|----------------------|--------------------------|
| **代码仓库** | 无（第三方开源项目） | `hermes-web-ui/` |
| **K8s 资源名** | `hermes-webui` | 容器名 `ops-panel`，Service 端口名 `ops` |
| **K8s namespace** | `kubernetes/webui/` | 动态创建（附属于 gateway pod） |
| **Docker 镜像** | `open-webui:nl-v0.9.2-nh` | `ekkoye8888/hermes-web-ui` |
| **端口** | 8080（NodePort 48080） | 6060（sidecar） |
| **功能** | 用户聊天界面，对话 | 运营面板，日志/文件/任务/会话 |
| **Ingress 路径** | `/`（独立服务） | `/agent{N}/ops/` |
| **后端引用** | `webui_provision.py`, `WEBUI_*` 环境变量 | `HERMES_HOME=/opt/data` 共享卷 |
| **前端入口** | 用户模式 Chat 按钮 | 用户模式 Agent Panel 菜单 |

**命名规则：**
- 代码/配置中引用 **Open WebUI** 时用 `webui`（小写无连字符），与现有 `webui_provision.py`、`hermes-webui` K8s 资源一致
- 代码/配置中引用 **Agent Ops Panel** 时用 `ops-panel`（容器名）或 `ops`（端口名/路径名），通过 `HERMES_HOME` 共享 hermes 数据
- Ingress 路径用 `/agent{N}/ops/`（而非 `/agent{N}/webui/`），避免与 Open WebUI 路径混淆
- 前端 i18n key 用 `navAgentPanel`，不使用 "webui" 字样

---

## 1. 产品定义

### 1.1 定位

Agent Ops Panel = **Agent 控制台**（Agent Console），区别于：
- **Admin Panel** (管理面板) — 管理 agent 生命周期（创建/删除/配置）
- **Open WebUI** (聊天界面) — 直接与 agent 对话，`kubernetes/webui/`，端口 48080
- **Agent 控制台** (运营面板) — 查看 agent 日志、任务状态、会话历史、数据文件等运营数据

### 1.2 URL 格式

```
https://{ingress-host}/agent{N}/ops/
```

通过 Nginx Ingress rewrite 规则路由到 sidecar 容器的 6060 端口。

### 1.3 入口位置

Admin Panel 用户模式侧边栏：
- 排列顺序：Dashboard → Files → Chat → **Agent 控制台**
- 标签：`navAgentPanel` → "Agent Console" (en) / "Agent 控制台" (zh)
- 图标：终端图标 (IconTerminal)
- 行为：`<a>` 外链，新窗口打开
- 不可用状态（ops-panel 未部署）：灰色 + `cursor-not-allowed` + tooltip 提示
- Agent ID 获取：从 `localStorage.getItem("admin_user_agent_id")` 读取，未绑定 agent 时隐藏该导航项

---

## 2. K8s 部署设计

### 2.1 Pod 结构

```
┌─────────────────────────────────────────────────────┐
│  Pod: gateway-{N}                                   │
│  securityContext:                                   │
│    fsGroup: 10000                                   │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐│
│  │  gateway    │  │  dashboard  │  │  ops-panel   ││
│  │  :8642      │  │  :9119      │  │  :6060       ││
│  │  (RW data)  │  │  (RW data)  │  │  (RW data)   ││
│  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘│
│         │                │                │         │
│  ┌──────┴────────────────┴────────────────┘        │
│  │  hermes-data → /opt/data (hostPath)              │
│  │  所有容器共享读写，ops-panel 通过 HERMES_HOME   │
│  └───────────────────────────────────────────────── │
└─────────────────────────────────────────────────────┘
```

### 2.2 关键决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 数据卷 | 共享 `hermes-data` | ops-panel 直接读写 hermes-agent 数据，无需独立卷 |
| 基础镜像 | `ekkoye8888/hermes-web-ui` | 独立构建的 web-ui 镜像 |
| entrypoint | Dockerfile 已设置 `ENTRYPOINT` | 无需 K8s command 覆盖 |
| fsGroup | `10000` | 解决跨容器文件权限竞争 |
| hermes-web-ui 代码 | 无需修改 | `HERMES_HOME=/opt/data` 指向共享卷，web-ui 自动读取 |

### 2.3 容器规格

**ops-panel sidecar 容器：**

```yaml
- name: ops-panel
  image: ekkoye8888/hermes-web-ui
  imagePullPolicy: IfNotPresent
  ports:
    - containerPort: 6060
  env:
    - name: HERMES_HOME
      value: "/opt/data"
    - name: PORT
      value: "6060"
    - name: HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN
      value: "0"
    - name: HERMES_WEB_UI_API_BASE_URL
      value: "http://localhost:8642"
  resources:
    requests:
      cpu: "50m"
      memory: "128Mi"
    limits:
      cpu: "250m"
      memory: "512Mi"
  readinessProbe:
    httpGet:
      path: /api/health
      port: 6060
    initialDelaySeconds: 15
    periodSeconds: 30
  livenessProbe:
    httpGet:
      path: /api/health
      port: 6060
    initialDelaySeconds: 30
    periodSeconds: 30
  volumeMounts:
    - name: hermes-data
      mountPath: /opt/data
```

### 2.4 Volume 定义

无需新增 volume。ops-panel 共享现有 `hermes-data` 卷，通过 `HERMES_HOME=/opt/data` 直接读写 hermes-agent 数据。

```yaml
volumes:
  - name: hermes-data
    hostPath:
      path: /data/hermes/agent{N}
      type: DirectoryOrCreate
```

---

## 3. 后端变更

### 3.1 templates.py — 添加 ops-panel sidecar 容器

**文件**: `admin/backend/templates.py:239`

在 `containers` 数组的 dashboard 容器之后追加 `ops-panel` 容器定义。同时：
- `pod.spec` 添加 `securityContext: { fsGroup: 10000 }`
- 无需新增 volume，ops-panel 共享现有 `hermes-data` 卷

### 3.2 Service — 添加 ops 端口

**文件**: `admin/backend/k8s_client.py` 或 `templates.py:render_service()`

Service 的 `ports` 数组追加：
```python
{"name": "ops", "port": 6060, "targetPort": 6060}
```

### 3.3 Ingress — 添加 ops 路径规则

**文件**: `admin/backend/k8s_client.py:add_ingress_path()`

创建 agent 时，除了添加 `/agent{N}(/|$)(.*)` → gateway:8642 路径外，还需要添加：
```
/agent{N}/ops(/|$)(.*) → gateway-{N}:6060
```

注意：ops 路径与 gateway 路径在同一 Ingress 中，利用 Nginx 最长匹配优先。
**添加顺序**：必须先添加 gateway 路径 `/agent{N}`，再添加 ops 路径 `/agent{N}/ops`。`add_ingress_path` 的重复检测使用 `startswith` 匹配，如果 ops 路径先添加会阻止 gateway 路径的添加。

### 3.4 删除 agent 时清理

`remove_ingress_path()` 同时移除 gateway 和 ops 两条路径规则。

---

## 4. hermes-web-ui 代码变更

**无需修改 hermes-web-ui 代码。** ops-panel 通过 `HERMES_HOME=/opt/data` 直接读写 hermes-agent 数据（共享卷），web-ui 自身的临时数据（auth token、config）使用 Dockerfile 中默认的 `HOME=/home/agent` 路径。Dockerfile 已设置 `ENTRYPOINT ["node", "dist/server/index.js"]`，无需 K8s command 覆盖。

关键环境变量：

| 变量 | 值 | 用途 |
|------|-----|------|
| `HERMES_HOME` | `/opt/data` | 读写 agent 数据（共享卷） |
| `PORT` | `6060` | 服务端口 |
| `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN` | `0` | 防止 web-ui 关闭时停掉 gateway |
| `HERMES_WEB_UI_API_BASE_URL` | `http://localhost:8642` | 同 pod 内访问 gateway API |

---

## 5. 前端变更

### 5.1 AdminLayout.tsx — Agent 控制台导航项

当前用户模式侧边栏已有 `navAgentPanel` 导航项（`href: "#"` 占位符），需要：

1. 替换 `href: "#"` 为动态 URL 构建逻辑
2. 从 `localStorage.getItem("admin_user_agent_id")` 获取 agent ID（与 DashboardPage/FileBrowserPage 复用同一模式）
3. 未绑定 agent 时（agentId 为空或 "0"），隐藏该导航项而非显示禁用状态

**URL 构建逻辑**：
```typescript
const storedAgentId = parseInt(localStorage.getItem("admin_user_agent_id") || "0", 10)
const opsUrl = storedAgentId > 0 ? `${window.location.origin}/agent${storedAgentId}/ops/` : "#"
```

### 5.2 i18n

更新翻译 key：
- `en.ts`: `navAgentPanel: "Agent Console"`
- `zh.ts`: `navAgentPanel: "Agent 控制台"`

---

## 6. 不在本方案范围

- **web-ui 认证集成** — 首期不做 SSO，依赖 Ingress 层面的访问控制
- **Admin 模式侧边栏** — web-ui 入口仅在用户模式显示
- **SPA 子路径路由** — 首期通过部署验证确认 rewrite-target 是否影响 SPA 资源加载。如出现问题，后续通过 BASE_URL 环境变量或 iframe 嵌入解决
- **现有 agent 迁移** — 现有 agent 的 Deployment 不可变，需重新创建才能获得 ops-panel sidecar

---

## 7. 实施顺序

```
Phase 1: Admin 后端变更（templates.py sidecar + Service + agent_manager.py Ingress）
Phase 2: Admin 前端变更（侧边栏 URL）
Phase 3: 集成测试 + 部署验证
```

每个 phase 独立可测试，不依赖后续 phase 完成。

---

## 8. 验证

1. **TypeScript 编译**: `cd admin/frontend && npx tsc --noEmit`
2. **Pod 验证**: `kubectl get pods -n hermes-agent` — 3/3 running（gateway + dashboard + ops-panel）
3. **Service 验证**: `kubectl describe svc gateway-{N}` — 包含 3 个端口（8642, 9119, 6060）
4. **Ingress 验证**: `kubectl describe ingress hermes-agents-ingress` — 包含 ops 路径（`/agent{N}/ops/`）
5. **功能验证**: 浏览器访问 `http://{host}:32570/agent{N}/ops/` — 显示 ops-panel 界面，JS/CSS 资源正常加载
6. **侧边栏验证**: Admin Panel 用户模式 → Agent 控制台 链接可点击，跳转到 ops-panel
7. **SPA 验证**: ops-panel 页面内点击导航是否正常，刷新页面是否正常（验证 rewrite-target 对 SPA 的影响）
8. **删除验证**: 删除 agent 后确认 ops Ingress 路径也被清理
