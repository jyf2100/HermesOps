# 184 开发集群部署验证计划（V2）

> 日期：2026-05-19
> 目标：将合并后的 gateway+webui 部署应用到 184 开发集群
> 前置：代码已通过 5 轮专家审核，0 CRITICAL，所有 MEDIUM 已修复

## 环境信息

| 项目 | 值 |
|------|-----|
| 集群 | 172.32.153.184（本地 kubectl，需 sudo） |
| Ingress 端口 | 40080 |
| 镜像 | `docker.io/ekkoye8888/hermes-web-ui:latest` |
| 命名空间 | `hermes-agent` |
| 访问方式 | `http://172.32.153.184:40080/agent{N}/`（路径路由）或 `http://agent{N}.172-32-153-184.nip.io:40080/`（nip.io 域名路由） |

---

## Phase 0：前置检查（2 分钟）

```bash
# 0.1 确认镜像存在
sudo ctr -n k8s.io images ls | grep hermes-web-ui
# 如果不存在：
# sudo https_proxy=http://172.32.147.190:7890 ctr -n k8s.io images pull docker.io/ekkoye8888/hermes-web-ui:latest

# 0.2 记录当前状态
sudo kubectl get deployments,pods,svc,ingress -n hermes-agent

# 0.3 确认 Redis Secret 存在
sudo kubectl get secret hermes-redis-secret -n hermes-agent
# 不存在则创建：
# sudo kubectl create secret generic hermes-redis-secret --namespace=hermes-agent --from-literal=redis-password="$(openssl rand -hex 32)" --dry-run=client -o yaml | sudo kubectl apply -f -

# 0.4 确认 RBAC 存在
sudo kubectl get serviceaccount hermes-gateway -n hermes-agent
# 不存在则创建：
# sudo kubectl apply -f kubernetes/gateway/rbac.yaml
```

---

## Phase 1：agent-1 缩容 + 备份（3 分钟）

> 先只操作 agent-1，验证通过后再推广到 2/3

```bash
# 1.1 缩容
sudo kubectl scale deployment hermes-gateway-1 --replicas=0 -n hermes-agent
sudo kubectl scale deployment hermes-webui-1 --replicas=0 -n hermes-agent
sudo kubectl wait --for=delete pod -l app=hermes-gateway-1 -n hermes-agent --timeout=120s

# 1.2 确认 Pod 已终止
sudo kubectl get pods -n hermes-agent | grep -E "gateway-1|webui-1"
# 预期：无输出

# 1.3 备份数据
sudo cp -r /data/hermes/agent1 /data/hermes/agent1.bak.$(date +%Y%m%d%H%M)
sudo test -d /data/hermes/webui-1 && sudo cp -r /data/hermes/webui-1 /data/hermes/webui-1.bak.$(date +%Y%m%d%H%M) || true

# 1.4 准备 webui 数据目录
sudo mkdir -p /data/hermes/agent1/.webui /data/hermes/agent1/webui-data
sudo test -d /data/hermes/webui-1/.webui && sudo cp -r /data/hermes/webui-1/.webui/* /data/hermes/agent1/.webui/ 2>/dev/null || true
sudo ls -la /data/hermes/agent1/.webui/
```

---

## Phase 2：应用 agent-1 合并部署（2 分钟）

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent

# 2.1 应用合并后的 deployment + service
sudo kubectl apply -f kubernetes/gateway/deployment.yaml
sudo kubectl apply -f kubernetes/gateway/service.yaml

# 2.2 应用 ingress（路径路由 + nip.io 域名路由）
sudo kubectl apply -f kubernetes/gateway/ingress.yaml
```

**关于 agent-2/3 的影响**：ingress.yaml 包含所有 3 个 agent 的路由规则。agent-2/3 的 deployment 还没更新，Service 没有暴露 6060 端口。但这不会立即破坏 agent-2/3，因为：
- 路径路由 `/agent{N}` 指向 `hermes-gateway-{N}:6060`
- 如果 agent-2/3 的 Service 没有 6060 端口，请求会失败
- **需要先验证 agent-1，然后尽快更新 agent-2/3**

> ⚠️ agent-2/3 在 ingress 更新后到 deployment 更新前这段时间会不可用。这是预期的短暂中断。

---

## Phase 3：验证 agent-1（5-10 分钟）

### 3.1 Pod 启动

```bash
sudo kubectl rollout status deployment/hermes-gateway-1 -n hermes-agent --timeout=180s
# 预期：successfully rolled out
```

失败排查：
```bash
sudo kubectl describe pod -n hermes-agent -l app=hermes-gateway-1
sudo kubectl logs -n hermes-agent deployment/hermes-gateway-1 --tail=100
```

### 3.2 双端口 + 子进程

```bash
# 检查端口
sudo kubectl get pods -n hermes-agent -l app=hermes-gateway-1 \
  -o jsonpath='{.items[0].spec.containers[0].ports}' | python3 -m json.tool
# 预期：containerPort 6060 和 8642

# 检查 gateway 子进程
sudo kubectl exec -n hermes-agent deployment/hermes-gateway-1 -c gateway -- ps aux | grep hermes
# 预期：能看到 hermes 进程
```

### 3.3 健康检查

```bash
# WebUI health（包含 gateway 健康检查）
sudo kubectl exec -n hermes-agent deployment/hermes-gateway-1 -c gateway -- curl -s http://localhost:6060/health
# 预期：{"status":"ok",...}

# Gateway API health
sudo kubectl exec -n hermes-agent deployment/hermes-gateway-1 -c gateway -- curl -s http://localhost:8642/health
# 预期：{"status":"ok"}
```

### 3.4 日志确认 gateway-manager 启动

```bash
sudo kubectl logs -n hermes-agent deployment/hermes-gateway-1 --tail=50 | grep -i "gateway\|spawn\|local\|child"
```

### 3.5 Ingress 路由验证

```bash
BASE=http://172.32.153.184:40080

# 路径路由 — WebUI 页面
curl -s -o /dev/null -w "%{http_code}" $BASE/agent1/
# 预期：200

# 路径路由 — Gateway API（通过 webui 代理）
curl -s $BASE/agent1/v1/models | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[]))), 'models'"
# 预期：显示模型数量

# nip.io 域名路由 — WebUI 页面
curl -s -o /dev/null -w "%{http_code}" http://agent1.172-32-153-184.nip.io:40080/
# 预期：200

# nip.io 域名路由 — Gateway API
curl -s http://agent1.172-32-153-184.nip.io:40080/v1/models | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[]))), 'models'"
# 预期：显示模型数量
```

### 3.6 Admin 面板兼容性

```bash
ADMIN_KEY=$(sudo kubectl get secret hermes-admin-secret -n hermes-agent -o jsonpath="{.data.admin_key}" | base64 -d)
curl -s $BASE/admin/api/agents -H "X-Admin-Key: $ADMIN_KEY" | python3 -c "import sys,json; agents=json.load(sys.stdin).get('agents',[]); print(f'Agents: {len(agents)}'); [print(f'  - {a[\"name\"]}') for a in agents]"
# 预期：列表中包含 hermes-gateway-1
```

### 3.7 端到端聊天验证

```bash
API_KEY=$(sudo kubectl get secret hermes-gateway-1-secret -n hermes-agent -o jsonpath="{.data.api_key}" | base64 -d)

# 通过路径路由测试
curl -s $BASE/agent1/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4-20250514","messages":[{"role":"user","content":"say hi in 3 words"}],"stream":false}' \
  --max-time 30 | python3 -m json.tool | head -20
# 预期：正常 chat completion 响应

# 通过 nip.io 路由测试
curl -s http://agent1.172-32-153-184.nip.io:40080/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4-20250514","messages":[{"role":"user","content":"say hi in 3 words"}],"stream":false}' \
  --max-time 30 | python3 -m json.tool | head -20
# 预期：正常 chat completion 响应
```

---

## Phase 4：推广到 agent-2/3（Phase 3 全部通过后）

```bash
# === Agent 2 ===
sudo kubectl scale deployment hermes-gateway-2 --replicas=0 -n hermes-agent
sudo kubectl scale deployment hermes-webui-2 --replicas=0 -n hermes-agent
sudo kubectl wait --for=delete pod -l app=hermes-gateway-2 -n hermes-agent --timeout=120s
sudo mkdir -p /data/hermes/agent2/.webui /data/hermes/agent2/webui-data
sudo test -d /data/hermes/webui-2/.webui && sudo cp -r /data/hermes/webui-2/.webui/* /data/hermes/agent2/.webui/ 2>/dev/null || true
sudo kubectl apply -f kubernetes/gateway2/deployment.yaml
sudo kubectl rollout status deployment/hermes-gateway-2 -n hermes-agent --timeout=180s

# === Agent 3 ===
sudo kubectl scale deployment hermes-gateway-3 --replicas=0 -n hermes-agent
sudo kubectl scale deployment hermes-webui-3 --replicas=0 -n hermes-agent
sudo kubectl wait --for=delete pod -l app=hermes-gateway-3 -n hermes-agent --timeout=120s
sudo mkdir -p /data/hermes/agent3/.webui /data/hermes/agent3/webui-data
sudo test -d /data/hermes/webui-3/.webui && sudo cp -r /data/hermes/webui-3/.webui/* /data/hermes/agent3/.webui/ 2>/dev/null || true
sudo kubectl apply -f kubernetes/gateway3/deployment.yaml
sudo kubectl rollout status deployment/hermes-gateway-3 -n hermes-agent --timeout=180s
```

### 清理旧 webui 部署

```bash
sudo kubectl delete deployment hermes-webui-1 hermes-webui-2 hermes-webui-3 -n hermes-agent 2>/dev/null || true
sudo kubectl delete service hermes-webui-1 hermes-webui-2 hermes-webui-3 -n hermes-agent 2>/dev/null || true
```

---

## Phase 5：最终验证

```bash
BASE=http://172.32.153.184:40080

# 5.1 Pod 总数（应该是 3 个 gateway，不再是 6 个）
sudo kubectl get pods -n hermes-agent -o wide | grep gateway

# 5.2 所有 agent 的路径路由 + nip.io 路由
for i in 1 2 3; do
  echo "=== Agent $i ==="
  # 路径路由
  echo -n "  Path /agent$i/ → "
  curl -s -o /dev/null -w "%{http_code}" $BASE/agent$i/
  echo ""
  echo -n "  Path /agent$i/v1/models → "
  curl -s $BASE/agent$i/v1/models | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d.get(\"data\",[]))} models')" 2>/dev/null || echo "FAILED"
  # nip.io 路由
  echo -n "  nip.io agent$i → "
  curl -s -o /dev/null -w "%{http_code}" http://agent$i.172-32-153-184.nip.io:40080/
  echo ""
done

# 5.3 Admin 面板
ADMIN_KEY=$(sudo kubectl get secret hermes-admin-secret -n hermes-agent -o jsonpath="{.data.admin_key}" | base64 -d)
curl -s $BASE/admin/api/health -H "X-Admin-Key: $ADMIN_KEY"
# 预期：{"status":"ok"}
```

---

## Go/No-Go 标准

| 检查项 | 标准 |
|--------|------|
| Pod 启动 | 3 个 gateway Pod 全部 Running |
| WebUI 访问 | 所有 agent 的路径路由和 nip.io 路由都返回 200 |
| Gateway 子进程 | `ps aux` 能看到 hermes 进程 |
| 聊天功能 | 能正常发送消息并收到响应 |
| Admin 面板 | 能看到所有 3 个 agent |
| 流式响应 | SSE 正常工作（浏览器测试） |

---

## 回滚计划

```bash
# 1. 删除合并后的 deployments + services
sudo kubectl delete deployment hermes-gateway-1 hermes-gateway-2 hermes-gateway-3 -n hermes-agent
sudo kubectl delete service hermes-gateway-1 hermes-gateway-2 hermes-gateway-3 -n hermes-agent
sudo kubectl delete ingress hermes-gateway-1-nip hermes-gateway-2-nip hermes-gateway-3-nip -n hermes-agent 2>/dev/null || true

# 2. 恢复原 deployment（从 git stash）
git stash
sudo kubectl apply -f kubernetes/gateway/deployment.yaml
sudo kubectl apply -f kubernetes/gateway/service.yaml
sudo kubectl apply -f kubernetes/gateway2/deployment.yaml
sudo kubectl apply -f kubernetes/gateway3/deployment.yaml
sudo kubectl apply -f kubernetes/gateway/ingress.yaml
git stash pop

# 3. 恢复独立 webui
sudo kubectl scale deployment hermes-webui-1 hermes-webui-2 hermes-webui-3 --replicas=1 -n hermes-agent

# 4. 数据无需恢复（agent 目录未被修改，仅新增了 .webui 子目录）
```

---

## 常见问题排查

### ImagePullBackOff
```bash
sudo ctr -n k8s.io images ls | grep hermes-web-ui
# 不存在则拉取：
sudo https_proxy=http://172.32.147.190:7890 ctr -n k8s.io images pull docker.io/ekkoye8888/hermes-web-ui:latest
```

### CrashLoopBackOff
```bash
sudo kubectl logs -n hermes-agent deployment/hermes-gateway-1 --tail=100
sudo kubectl describe pod -n hermes-agent -l app=hermes-gateway-1
```

### Gateway 子进程未启动
```bash
# 检查 HERMES_BIN 路径
sudo kubectl exec -n hermes-agent deployment/hermes-gateway-1 -c gateway -- which hermes
sudo kubectl exec -n hermes-agent deployment/hermes-gateway-1 -c gateway -- ls -la /opt/hermes/hermes /opt/hermes/.venv/bin/hermes
# 如果 /opt/hermes/hermes 不存在，需要改 HERMES_BIN 为 /opt/hermes/.venv/bin/hermes
```

### readinessProbe 失败
```bash
sudo kubectl exec -n hermes-agent deployment/hermes-gateway-1 -c gateway -- curl -s http://localhost:6060/health
# 如果返回 error，gateway 子进程未启动成功
```

### nip.io 路由 404
```bash
# 检查 nip.io ingress 是否创建
sudo kubectl get ingress -n hermes-agent | grep nip
# 检查 ingress controller 版本（需 v1.12+）
sudo kubectl get deployment -n ingress-nginx ingress-nginx-controller -o jsonpath='{.spec.template.spec.containers[0].image}'
```
