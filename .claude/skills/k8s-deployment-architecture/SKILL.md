---
name: k8s-deployment-architecture
description: K8s 部署架构：共享/独立 WebUI 模式、卷挂载方式、状态持久化问题
metadata: 
  node_type: memory
  type: reference
  originSessionId: 254891ec-767b-4cab-966f-2722082f33be
---

## K8s 部署架构

### 三种部署模式

1. **共享 WebUI** (`hermes-open-webui`)
   - 宿主机 `/data/hermes/webui` → 容器 `/app/backend/data`
   - hostNetwork 模式，端口 48080
   - 额外挂载 ConfigMap token-login.html

2. **独立 WebUI** (`hermes-webui-{1..5}`)
   - 宿主机 `/data/hermes/agent{n}` → 容器 `/opt/data` (`HERMES_HOME`)
   - 与对应 Gateway 共享同一宿主机目录
   - `HERMES_WEB_UI_API_BASE_URL=http://hermes-gateway-{n}:8642`
   - `AUTH_TOKEN` 从 secret 读取

3. **Admin 面板** (`hermes-admin`)
   - 宿主机 `/data/hermes` → 容器 `/data/hermes` (`HERMES_DATA_ROOT`)
   - 管理所有 webui/gateway 实例的生命周期

### 已知问题：独立 WebUI 状态不持久

独立 WebUI 的状态库默认存到 `/home/agent/.hermes-web-ui/hermes-web-ui.db`（容器临时文件系统），Pod 重启后丢失。

**原因**：`templates.py:render_webui_deployment()` 未设置 `HERMES_WEBUI_STATE_DIR`。

**修复**：在 env 列表中添加 `HERMES_WEBUI_STATE_DIR=/opt/data/webui-state`。

### 部署流程

```
Admin (templates.py) → 创建 K8s Deployment/Service/Ingress
                    → 独立 WebUI 镜像: ekkoye8888/hermes-web-ui
                    → Gateway 镜像: nousresearch/hermes-agent
```

### 镜像更新流程

```bash
docker build -t ekkoye8888/hermes-web-ui:YYYYMMDD .
docker save ... | sudo ctr -n k8s.io images import -
sudo ctr -n k8s.io images tag ... --force
kubectl rollout restart deployment/hermes-webui-{1..5} -n hermes-agent
```

### 相关文件

- Admin 模板: `/mnt/disk01/workspaces/worksummary/hermes-agent/admin/backend/templates.py`
- WebUI 配置: `packages/server/src/config.ts` (`HERMES_WEBUI_STATE_DIR`)
- K8s 部署文件: `/mnt/disk01/workspaces/worksummary/hermes-agent/admin/kubernetes/`
