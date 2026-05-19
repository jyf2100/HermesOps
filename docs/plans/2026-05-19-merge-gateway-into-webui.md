# 部署方案：合并 Gateway 到 hermes-web-ui（本地模式）

> 日期：2026-05-19
> 状态：V2（审核修订版）
> 目标：将独立的 hermes-gateway 和 hermes-web-ui 部署合并为单一 Pod，简化 K8s 运维

## 1. 背景与动机

当前每个 agent 实例需要 **2 个 Deployment + 2 个 Service + 1 个 Secret + N 个 Volume**：
- `hermes-gateway-{N}` — Python gateway 进程（端口 8642）
- `hermes-webui-{N}` — Node.js Web UI（端口 6060），通过 `HERMES_WEB_UI_API_BASE_URL` 远程代理到 gateway

hermes-web-ui 的 Docker 镜像基于 `nousresearch/hermes-agent:latest` 构建，**已包含 hermes 二进制和 Python 运行时**。其 `gateway-manager.ts` 支持在本地 spawn gateway 子进程。

**目标架构**：去掉 `HERMES_WEB_UI_API_BASE_URL`，让 webui 在本地模式下自动管理 gateway 生命周期。

## 2. 核心设计决策

### 2.1 保持部署名称不变

**关键决策：保持 `hermes-gateway-{N}` 作为 Deployment/Service 名称，仅合并部署结构。**

原因：代码库中 12+ 文件硬编码了 `hermes-gateway-{N}` 命名（参见第 10 节完整清单）。改名会导致：
- admin 面板 agent 列表为空（`list_agents()` 按 `hermes-gateway` 前缀过滤）
- 用户 API 密钥登录全部失败（`auth.py` 正则匹配 `hermes-gateway-{N}-secret`）
- K8s exec 操作全部失败（`k8s_client.py` 的 `EXEC_CONTAINER = "gateway"`）
- 前端导航、E2E 测试、orchestrator 发现全部断裂

**不修改的名称**：
- Deployment: `hermes-gateway-{N}`（不变）
- Service: `hermes-gateway-{N}`（不变，但端口变更）
- Secret: `hermes-gateway-{N}-secret`（不变）
- Container: `gateway`（不变，保留 container name）
- Label: `app.kubernetes.io/component: gateway`（不变）

**合并方式**：将 webui 的功能合并到 gateway 的 Deployment 中，使用 `hermes-web-ui` 镜像替代 `hermes-agent` 镜像（因为前者已包含后者）。webui 的 container name 设为 `gateway`。

### 2.2 触发本地模式

去掉 `HERMES_WEB_UI_API_BASE_URL` 环境变量。`gateway-manager.ts` 在启动时检测到该变量未设置，会：
1. `detectAllOnStartup()` — 扫描 PID 文件和健康检查
2. `startAll()` — 为每个 profile 启动 gateway 子进程
3. `resolvePort()` — 从 8642 开始分配空闲端口

### 2.3 进程生命周期

| 场景 | 行为 |
|------|------|
| Pod 启动 | `gateway-manager.startAll()` 自动 spawn gateway（15s 超时） |
| Gateway 崩溃 | `/health` 端点检测到 gateway 不健康 → readinessProbe 失败 → 最终 Pod 重启 |
| Web UI 重启 | `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=1` 确保先停 gateway |
| Pod 终止 | SIGTERM 触发 `stopAll()`（并行调用，每个最多 10s），gateway 优雅关闭 |
| PID 文件过期 | `detectAllOnStartup()` 检测到 stale PID，自动启动新实例 |

**Gateway 崩溃恢复机制**：Web UI 的 `/health` 端点（`controllers/health.ts:82-83`）会同时检查 gateway 的健康状态。如果 gateway 子进程崩溃，`/health` 返回 `status: 'error'`，导致 readinessProbe 持续失败。经过 `failureThreshold: 6 × periodSeconds: 10 = 60s` 后 Pod 被重启，`startAll()` 重新启动 gateway。

### 2.4 安全上下文

```yaml
securityContext:
  runAsUser: 10000
  runAsGroup: 10000
  fsGroup: 10000
```

- Container 以 UID 10000 运行（与当前 gateway/webui 一致）
- Gateway 绑定到 `0.0.0.0:8642`（与现有部署一致），Service 暴露 8642 端口供 admin/orchestrator 访问
- `HERMES_ALLOW_ROOT_GATEWAY=1` 保留作为防御性配置（UID 10000 下实际不需要，但防止调试时改 runAsUser 为 0 导致启动失败）

### 2.5 健康检查

Web UI 的 `/health` 端点**已内置 gateway 健康检查**（`controllers/health.ts:82-83`）：

```yaml
readinessProbe:
  httpGet:
    path: /health
    port: 6060
  initialDelaySeconds: 30    # 等待 gateway 子进程启动（startAll 最多 15s）
  periodSeconds: 10
  failureThreshold: 6        # 60s 内持续失败后标记为不健康
livenessProbe:
  httpGet:
    path: /health
    port: 6060
  initialDelaySeconds: 60
  periodSeconds: 30
  failureThreshold: 5
```

## 3. 合并后的 Deployment YAML

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hermes-gateway-1              # 保持原名
  namespace: hermes-agent
  labels:
    app: hermes-gateway-1             # 保持原名
    app.kubernetes.io/component: gateway  # 保持原 label
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: hermes-gateway-1
  template:
    metadata:
      annotations:
        hermes-agent.io/capabilities: "code,python,debugging,testing,code-review"
        hermes-agent.io/role: "coder"
      labels:
        app: hermes-gateway-1
        app.kubernetes.io/component: gateway
    spec:
      serviceAccountName: hermes-gateway
      terminationGracePeriodSeconds: 60
      securityContext:
        runAsUser: 10000
        runAsGroup: 10000
        fsGroup: 10000
      initContainers:
        - name: fix-permissions
          image: docker.io/ekkoye8888/hermes-web-ui:latest   # 用主容器镜像，避免额外拉取
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c"]
          args:
            - |
              mkdir -p /opt/data/{cron,sessions,logs,hooks,memories,skills,skins,plans,workspace,home,cache}
              mkdir -p /opt/data/.webui/upload
              mkdir -p /app/dist/data
              chown -R 10000:10000 /opt/data 2>/dev/null || true
              chown -R 10000:10000 /app/dist/data 2>/dev/null || true
          securityContext:
            runAsUser: 0
            runAsNonRoot: false
          volumeMounts:
            - name: hermes-data
              mountPath: /opt/data
            - name: webui-data
              mountPath: /app/dist/data
      containers:
        - name: gateway               # 保持原 container name（k8s_client.py EXEC_CONTAINER）
          image: docker.io/ekkoye8888/hermes-web-ui:latest
          imagePullPolicy: IfNotPresent
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          ports:
            - containerPort: 6060
              name: webui
              protocol: TCP
            - containerPort: 8642
              name: gateway-api
              protocol: TCP
          env:
            # ---- Web UI 服务 ----
            - name: PORT
              value: "6060"
            - name: CORS_ORIGINS
              value: "*"
            - name: LOGIN_MAX_FAILURES
              value: "0"
            # ---- Hermes 路径 ----
            - name: HERMES_HOME
              value: "/opt/data"
            - name: HERMES_BIN
              value: "/opt/hermes/hermes"       # 注意：与 Docker Compose 的 .venv 路径不同
            - name: HERMES_WEB_UI_HOME
              value: "/opt/data/.webui"
            # ---- 关键：不设置 HERMES_WEB_UI_API_BASE_URL，触发本地模式 ----
            # ---- Gateway 生命周期 ----
            - name: HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN
              value: "1"
            - name: HERMES_ALLOW_ROOT_GATEWAY
              value: "1"
            # ---- 认证 ----
            - name: AUTH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: hermes-gateway-1-secret  # 保持原 secret 名称
                  key: api_key
            # ---- Gateway 运行时环境（子进程通过 process.env 继承）----
            - name: API_SERVER_ENABLED
              value: "true"
            - name: API_SERVER_HOST
              value: "0.0.0.0"                  # 与现有部署一致，admin/orchestrator 通过 Service 访问
            - name: API_SERVER_PORT
              value: "8642"
            - name: API_SERVER_KEY
              valueFrom:
                secretKeyRef:
                  name: hermes-gateway-1-secret
                  key: api_key
            - name: API_SERVER_CORS_ORIGINS
              value: "*"
            - name: GATEWAY_ALLOW_ALL_USERS
              value: "true"
            - name: GATEWAY_HOST
              value: "127.0.0.1"                # startAll() 用此判断是否为 local profile
            - name: K8S_NAMESPACE
              value: "hermes-agent"
            - name: K8S_DEPLOYMENT
              value: "hermes-gateway-1"
            - name: HERMES_AGENT_NUMBER
              value: "1"
            - name: SANDBOX_POOL_NAME
              value: "hermes-sandbox-pool"
            - name: SANDBOX_TTL_MINUTES
              value: "30"
            # ---- Redis（带密码）----
            - name: SWARM_REDIS_URL
              value: "redis://:$(REDIS_PASSWORD)@hermes-redis:6379/0"
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: hermes-redis-secret
                  key: redis-password
            # ---- Node.js 调优 ----
            - name: NODE_OPTIONS
              value: "--max-old-space-size=768"
          volumeMounts:
            - name: hermes-data
              mountPath: /opt/data
            - name: webui-data
              mountPath: /app/dist/data
          readinessProbe:
            httpGet:
              path: /health
              port: 6060
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 6
          livenessProbe:
            httpGet:
              path: /health
              port: 6060
            initialDelaySeconds: 60
            periodSeconds: 30
            timeoutSeconds: 10
            failureThreshold: 5
          resources:
            requests:
              cpu: 500m
              memory: 768Mi
            limits:
              cpu: 2000m
              memory: 2Gi
      volumes:
        - name: hermes-data
          hostPath:
            path: /data/hermes/agent1     # 复用现有数据目录，无需迁移
            type: DirectoryOrCreate
        - name: webui-data
          hostPath:
            path: /data/hermes/agent1/webui-data
            type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: hermes-gateway-1              # 保持原名
  namespace: hermes-agent
spec:
  type: ClusterIP
  ports:
    - name: webui
      port: 6060
      targetPort: 6060
    # 保留 8642 端口，admin check_health() 和 orchestrator 通过此端口访问
    - name: gateway-api
      port: 8642
      targetPort: 8642
  selector:
    app: hermes-gateway-1
```

## 4. Ingress 变更

### 4.1 静态 Ingress（手动管理的 agent1~3）

将 `/agentN` 路径从 `hermes-gateway-N:8642` 改为 `hermes-gateway-N:6060`：

```yaml
# 之前：
# /agent1 → hermes-gateway-1:8642
# 之后：
# /agent1 → hermes-gateway-1:6060 （webui 代理到 localhost:8642）
```

Web UI 的 `proxy-handler.ts` 注册了 `/v1/{*any}` 和 `/api/hermes/{*any}` 路由（`proxy.ts:8-9`），会将这些请求代理到本地 gateway。

Ingress 使用 `nginx.ingress.kubernetes.io/rewrite-target: /$2` 剥离 `/agentN` 前缀后，到达 webui 的路径是 `/v1/chat/completions`，匹配 `/v1/{*any}` 路由，正确代理。

### 4.2 动态 Ingress（admin 面板创建的 agent4+）

需要修改 `templates.py`：
- `render_webui_deployment()`：去掉 `HERMES_WEB_UI_API_BASE_URL`，加入 gateway 环境变量
- `render_deployment()`：不再调用（原 gateway deployment 被合并的 webui deployment 替代）
- `render_service()`：调整端口（增加 6060，保留 8642）
- `k8s_client.py.add_ingress_path()`：Service 端口从 8642 改为 6060

### 4.3 路由验证路径

```
外部请求 → Ingress (/agent1/v1/chat/completions)
         → rewrite-target: /$2 → /v1/chat/completions
         → hermes-gateway-1:6060
         → proxy-handler.ts 识别 /v1/* 路径
         → 代理到 127.0.0.1:8642/v1/chat/completions
         → gateway 处理
```

## 5. Volume 布局

复用现有 `/data/hermes/agent1` 数据目录，新增 webui 子目录：

```
/data/hermes/agent1/           ← hostPath（复用现有）
  挂载到 /opt/data             ← HERMES_HOME
  config.yaml                  ← gateway 配置（webui 读写）
  .env                         ← API 密钥
  state.db                     ← gateway SQLite（主写入者）
  active_profile               ← profile 标记
  sessions/, logs/, skills/, home/, cache/, workspace/
  .webui/                      ← HERMES_WEB_UI_HOME
    hermes-web-ui.db           ← WebUI SQLite（独立）
    upload/                    ← 上传文件

/data/hermes/agent1/webui-data/ ← hostPath（新增）
  挂载到 /app/dist/data         ← WebUI 内部数据
```

## 6. 资源对比

| 指标 | 当前（分离） | 合并后 | 节省 |
|------|-------------|--------|------|
| Deployment/实例 | 2 | 1 | 50% |
| Service/实例 | 2 | 1 | 50% |
| InitContainer/实例 | 2 | 1 | 50% |
| Volume/实例 | 2 hostPath | 2 hostPath | 0（但共享父目录） |
| CPU request | 500m (250m+250m) | 500m | - |
| 内存 request | 1Gi (512Mi+512Mi) | 768Mi | 23% |
| CPU limit | 2000m (1+1) | 2000m | - |
| 内存 limit | 2Gi (1+1) | 2Gi | - |
| Pod 总数（3实例） | 6 | 3 | 50% |
| 预估停机时间 | N/A | 80-120s（Recreate 策略） |

## 7. 迁移策略

按照「先 dev 后 test」原则（参见 feedback_deploy_workflow）：

### Phase 0：准备（开发机 184）

1. 缩容现有 gateway-1 和 webui-1，确保数据一致：
   ```bash
   sudo kubectl scale deployment hermes-gateway-1 --replicas=0 -n hermes-agent
   sudo kubectl scale deployment hermes-webui-1 --replicas=0 -n hermes-agent
   # 等待 Pod 终止
   sudo kubectl wait --for=delete pod -l app=hermes-gateway-1 -n hermes-agent --timeout=120s
   sudo kubectl wait --for=delete pod -l app=hermes-webui-1 -n hermes-agent --timeout=120s
   ```

2. 备份数据：
   ```bash
   cp -r /data/hermes/agent1 /data/hermes/agent1.bak.$(date +%Y%m%d%H%M)
   cp -r /data/hermes/webui-1 /data/hermes/webui-1.bak.$(date +%Y%m%d%H%M)
   ```

3. 合并 webui 数据到 agent1 目录（复用现有 agent1 数据，无需迁移 gateway 数据）：
   ```bash
   mkdir -p /data/hermes/agent1/.webui
   cp -r /data/hermes/webui-1/.webui/* /data/hermes/agent1/.webui/ 2>/dev/null || true
   mkdir -p /data/hermes/agent1/webui-data
   # 验证 webui 数据库存在
   test -f /data/hermes/agent1/.webui/hermes-web-ui.db && echo "OK: webui DB present" || echo "WARN: webui DB missing"
   ```

4. Secret 已存在（`hermes-gateway-1-secret`），无需创建。

### Phase 1：创建合并部署（开发机 184）

1. 替换 `kubernetes/gateway/deployment.yaml` 为合并后的 YAML（第 3 节）
2. 替换 `kubernetes/gateway/service.yaml`，增加 6060 端口
3. 更新 Ingress：`/agent1` 路由到 `hermes-gateway-1:6060`（service 名不变，端口变）
4. 应用：
   ```bash
   sudo kubectl apply -k kubernetes/gateway/
   ```

### Phase 2：验证（开发机 184）

验证清单：
- [ ] Pod 正常启动（`kubectl get pods -n hermes-agent -l app=hermes-gateway-1`）
- [ ] Web UI 可访问（`http://184:port/agent1/`）
- [ ] Gateway 子进程运行（`kubectl exec -n hermes-agent deploy/hermes-gateway-1 -- ps aux | grep hermes`）
- [ ] 聊天功能正常（发送测试消息）
- [ ] 流式响应正常（SSE）
- [ ] 工具调用正常（code execution）
- [ ] 会话历史保留（state.db 数据完整）
- [ ] 日志正常（`kubectl logs -n hermes-agent deploy/hermes-gateway-1`）
- [ ] Admin 面板能看到该 agent（验证命名兼容性）
- [ ] API 密钥登录正常（验证 auth.py 兼容性）

**Go/No-Go 标准**：所有验证项通过则继续；任一项失败则执行回滚。

### Phase 3：清理旧资源（开发机 184）

验证通过后：
```bash
# 删除独立的 webui deployment（gateway deployment 已被合并版本替代）
sudo kubectl delete deployment hermes-webui-1 -n hermes-agent
sudo kubectl delete service hermes-webui-1 -n hermes-agent
```

### Phase 4：推广到测试集群 183

1. 在 184 验证通过
2. SSH 到 183 执行相同步骤

### 回滚计划

如果验证失败：
```bash
# 1. 删除合并后的 deployment
sudo kubectl delete deployment hermes-gateway-1 -n hermes-agent
sudo kubectl delete service hermes-gateway-1 -n hermes-agent

# 2. 恢复原 deployment（从 git checkout）
sudo kubectl apply -k kubernetes/gateway/  # 恢复原 gateway
# 恢复独立 webui
sudo kubectl apply -f kubernetes/webui/deployment-hermes-web-ui.yaml
sudo kubectl apply -f kubernetes/webui/service-hermes-web-ui.yaml

# 3. 恢复 Ingress（git checkout 原版本）
git checkout -- kubernetes/gateway/ingress.yaml
sudo kubectl apply -f kubernetes/gateway/ingress.yaml

# 4. 数据无需恢复（agent1 目录未被修改，仅新增了 .webui 子目录）
```

## 8. 风险与缓解

| 风险 | 级别 | 缓解措施 |
|------|------|----------|
| Gateway 崩溃不自动重启 | 高 | `/health` 端点内置 gateway 检查 → readinessProbe 失败 → Pod 重启 → startAll() |
| 迁移停机 80-120s | 中 | Recreate 策略导致；提前通知用户 |
| Ingress 路由错误 | 中 | 先在 184 验证，确认路由正确后再推 183 |
| `NODE_OPTIONS=768` + Python 内存可能超 2Gi | 中 | 监控 OOMKilled；必要时调整 limit 到 3Gi |
| HERMES_BIN 路径不一致 | 高 | 验证镜像内实际路径：`kubectl exec -- which hermes` |
| Dashboard sidecar（端口 9119）被移除 | 低 | 确认 kanban 功能是否仍需要 dashboard |
| `GATEWAY_HOST` 未设置时 startAll() 的跳过逻辑依赖默认值 | 低 | 显式设置 `GATEWAY_HOST=127.0.0.1`（见 YAML） |
| SQLite 并发写入冲突 | 低 | Gateway 写 state.db（主），WebUI 只读；WebUI 写自己的 .webui/hermes-web-ui.db |

## 9. 需要修改的代码文件

### 9.1 必须修改

| 文件 | 函数/行 | 变更 |
|------|---------|------|
| `admin/backend/templates.py` | `render_webui_deployment()` (~L298) | 去掉 `HERMES_WEB_UI_API_BASE_URL`，加入 gateway 环境变量 |
| `admin/backend/templates.py` | `render_deployment()` (~L143) | 不再被调用或改为调用 render_webui_deployment() |
| `admin/backend/templates.py` | `render_service()` (~L253) | 增加 6060 端口 |
| `admin/backend/k8s_client.py` | `add_ingress_path()` (~L232) | Service 端口从 8642 改为 6060 |

### 9.2 需验证但可能无需修改（命名保持不变）

以下文件硬编码了 `hermes-gateway-{N}` 但由于我们保持命名不变，**无需修改**：

| 文件 | 硬编码位置 | 为什么不需要改 |
|------|-----------|---------------|
| `admin/backend/auth.py` L166 | `re.match(r"^hermes-gateway-(\d+)-secret$")` | Secret 名称不变 |
| `admin/backend/file_browser.py` L29 | `f"hermes-gateway-{agent_id}"` | Deployment 名称不变 |
| `admin/backend/terminal.py` L87,165 | `f"hermes-gateway-{effective_id}"` | Deployment 名称不变 |
| `admin/backend/user_routes.py` L135 | `f"hermes-gateway-{agent_id}"` | Deployment 名称不变 |
| `admin/backend/webui_provision.py` L166 | `f"hermes-gateway-{agent_id}-secret"` | Secret 名称不变 |
| `admin/backend/main.py` L983 | `f"hermes-gateway-{agent_id}"` | Deployment 名称不变 |
| `admin/backend/k8s_client.py` L20 | `EXEC_CONTAINER = "gateway"` | Container 名称保持 `gateway` |
| `admin/backend/k8s_client.py` L147 | `s.metadata.name.startswith("hermes-gateway")` | 名称不变 |
| `admin/backend/agent_manager.py` L142 | `name.startswith("hermes-gateway")` | 名称不变 |
| `admin/backend/agent_manager.py` L617,644 | `c.name == "gateway"` | Container 名称保持 `gateway` |
| `admin/backend/agent_manager.py` L687 | `http://{svc}:8642/health` | Service 仍暴露 8642 端口 |
| `admin/backend/agent_manager.py` L809 | `container="gateway"` | Container 名称保持 `gateway` |
| `admin/backend/agent_manager.py` L1137 | `d.metadata.name.startswith("hermes-gateway")` | 名称不变 |
| `admin/frontend/src/pages/AgentDetailPage.tsx` L41 | `startsWith("hermes-gateway-")` | 名称不变 |
| `admin/frontend/src/pages/CreateAgentPage.tsx` L273,379 | `hermes-gateway-` 前缀 | 名称不变 |

### 9.3 E2E 测试

测试数据中的 `hermes-gateway-{N}` 名称无需修改（命名不变）。但需要新增测试：
- 验证合并部署后 chat 功能正常
- 验证 admin 面板 agent 列表正常
- 验证 Ingress 路由正常

## 10. HERMES_BIN 路径验证

不同环境下 hermes 二进制路径不同：

| 环境 | 路径 | 来源 |
|------|------|------|
| Docker Compose（webui 镜像） | `/opt/hermes/.venv/bin/hermes` | Dockerfile ENV PATH |
| 当前 K8s webui-1 deployment | `/opt/hermes/hermes` | deployment-hermes-web-ui.yaml L71 |
| 当前 K8s gateway deployment | args: `["gateway"]` | 无需 HERMES_BIN |

**操作前必须验证**：
```bash
# 在 hermes-web-ui 容器内检查
kubectl run test-webui --image=docker.io/ekkoye8888/hermes-web-ui:latest --rm -it --restart=Never -- which hermes
kubectl run test-webui --image=docker.io/ekkoye8888/hermes-web-ui:latest --rm -it --restart=Never -- ls -la /opt/hermes/hermes /opt/hermes/.venv/bin/hermes
```

根据 `Dockerfile:36` 设置了 `PATH=/opt/hermes/.venv/bin:$PATH`，所以 `HERMES_BIN=hermes`（不带路径）也可能工作。建议优先使用 `/opt/hermes/hermes`（与现有 K8s 配置一致），如果不存在则用 `/opt/hermes/.venv/bin/hermes`。
