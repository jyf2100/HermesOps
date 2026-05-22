# 183 测试集群升级计划

> 目标：将 183 集群从旧的三容器分离部署迁移到与 184 一致的合并部署架构
> 原则：**数据绝对不丢失**；可停服 4 小时
> 方案：与 184 一致，用 Python 脚本直接生成 YAML（不走 admin API）

## 183 当前实际状态

| 项目 | 183 当前 |
|------|---------|
| Agent 数量 | 13 (hermes-gateway-1 ~ 13) |
| Agent 架构 | 三容器：hermes-agent + dashboard + ops-panel |
| Agent 镜像 | `nousresearch/hermes-agent:latest` |
| hostPath | `/data/hermes/agent{N}` (与 184 相同) |
| 容器内 mountPath | `/opt/data` (不对齐，hermes 默认是 `~/.hermes`) |
| Secret 命名 | `hermes-gateway-{N}-secret` (与 admin API 生成格式一致) |
| WebUI 部署 | 14 个独立 `hermes-webui-{N}` deployment |
| Ingress | `hermes-agents-ingress`(统一) + 13 个 `hermes-webui-{N}`(nip.io) + `hermes-admin-ingress` + `hermes-webui-ingress` |
| Redis | `hermes-redis` deployment，有密码 |

## 184 迁移经验

184 的 7 个 agent 已通过 `/tmp/migrate_agents.py` 脚本成功迁移。脚本逻辑：
1. 备份旧 deployment YAML
2. 删除旧 deployment
3. 确保 hostPath 目录权限
4. 直接 apply 新合并部署 YAML（复用旧 secret）
5. 等待 Pod ready
6. 验证

**183 采用完全相同方案**，只需把 agent 数量从 5 扩展到 13。

## Phase 0: 全量备份（~10 分钟）

```bash
ssh root@172.32.153.183
mkdir -p /tmp/183-upgrade-backup

# 1. 备份所有 deployment YAML
for i in $(seq 1 13); do
  kubectl get deployment hermes-gateway-$i -n hermes-agent -o yaml > /tmp/183-upgrade-backup/gateway-$i.yaml
  kubectl get deployment hermes-webui-$i -n hermes-agent -o yaml > /tmp/183-upgrade-backup/webui-$i.yaml 2>/dev/null
done
kubectl get deployment hermes-admin -n hermes-agent -o yaml > /tmp/183-upgrade-backup/admin.yaml

# 2. 备份所有 secret（含 API key）
for i in $(seq 1 13); do
  kubectl get secret hermes-gateway-$i-secret -n hermes-agent -o yaml > /tmp/183-upgrade-backup/secret-$i.yaml
done

# 3. 备份所有 ingress
kubectl get ingress -n hermes-agent -o yaml > /tmp/183-upgrade-backup/all-ingress.yaml

# 4. 备份数据目录快照列表（不复制数据，只记录状态）
ls -la /data/hermes/ > /tmp/183-upgrade-backup/data-dir-snapshot.txt
for i in $(seq 1 13); do
  echo "=== agent$i ===" >> /tmp/183-upgrade-backup/data-dir-snapshot.txt
  ls -la /data/hermes/agent$i/ >> /tmp/183-upgrade-backup/data-dir-snapshot.txt
done

echo "Backup done at $(date)"
```

## Phase 1: 镜像准备（~20 分钟）

```bash
# 在 184 上导出（镜像已在 184 构建）
docker save ekkoye8888/hermes-web-ui:20260519 | gzip > /ssd2/hermes-web-ui-20260519.tar.gz

# 传输到 183
scp /ssd2/hermes-web-ui-20260519.tar.gz root@172.32.153.183:/ssd2/

# 在 183 上导入并打标签
ssh root@172.32.153.183
CTR="/opt/containerd/bin/ctr -a /run/containerd/containerd.sock -n k8s.io"
$CTR images import /ssd2/hermes-web-ui-20260519.tar.gz

# 删旧 latest 标签再重新打（避免 tag 静默失败）
$CTR images rm docker.io/ekkoye8888/hermes-web-ui:latest 2>/dev/null
$CTR images tag ekkoye8888/hermes-web-ui:20260519 docker.io/ekkoye8888/hermes-web-ui:latest

# 验证
$CTR images ls | grep hermes-web-ui
```

## Phase 2: 迁移 Agent（~2 小时，每个 agent ~10 分钟）

### 2.1 迁移脚本

与 184 相同逻辑，复用旧 secret（保留 API key），直接生成合并部署 YAML。

```python
#!/usr/bin/env python3
"""Migrate 183 agents from 3-container to merged deployment.
Preserves: API keys (reuse existing secrets), data directories (hostPath unchanged).
"""
import subprocess, json, sys, time

def kubectl(args, input_data=None):
    r = subprocess.run(
        ["kubectl"] + args, capture_output=True, text=True, input=input_data
    )
    return r

def make_deployment(agent_num, resources):
    name = f"hermes-gateway-{agent_num}"
    secret_name = f"{name}-secret"
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": name, "namespace": "hermes-agent"},
        "spec": {
            "replicas": 1,
            "strategy": {"type": "Recreate"},
            "selector": {"matchLabels": {"app": name}},
            "template": {
                "metadata": {"labels": {"app": name, "app.kubernetes.io/component": "gateway"}},
                "spec": {
                    "serviceAccountName": "hermes-gateway",
                    "terminationGracePeriodSeconds": 60,
                    "securityContext": {"runAsUser": 10000, "runAsGroup": 10000, "fsGroup": 10000},
                    "initContainers": [{
                        "name": "fix-permissions",
                        "image": "docker.io/ekkoye8888/hermes-web-ui:latest",
                        "imagePullPolicy": "IfNotPresent",
                        "command": ["sh", "-c"],
                        "args": [
                            "mkdir -p /home/agent/.hermes/{cron,sessions,logs,hooks,memories,skills,skins,plans,workspace,home,cache} "
                            "&& mkdir -p /home/agent/.hermes/webui-data "
                            "&& { chown -R 10000:10000 /home/agent/.hermes 2>/dev/null || true; }"
                        ],
                        "securityContext": {"runAsUser": 0, "runAsNonRoot": False},
                        "volumeMounts": [{"name": "hermes-data", "mountPath": "/home/agent/.hermes"}],
                    }],
                    "containers": [{
                        "name": "gateway",
                        "image": "docker.io/ekkoye8888/hermes-web-ui:latest",
                        "imagePullPolicy": "IfNotPresent",
                        "securityContext": {"allowPrivilegeEscalation": False, "capabilities": {"drop": ["ALL"]}},
                        "ports": [
                            {"containerPort": 6060, "name": "webui", "protocol": "TCP"},
                            {"containerPort": 8642, "name": "gateway-api", "protocol": "TCP"},
                        ],
                        "env": [
                            {"name": "PORT", "value": "6060"},
                            {"name": "CORS_ORIGINS", "value": "*"},
                            {"name": "LOGIN_MAX_FAILURES", "value": "0"},
                            {"name": "HERMES_BIN", "value": "/opt/hermes/.venv/bin/hermes"},
                            {"name": "HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN", "value": "1"},
                            {"name": "HERMES_ALLOW_ROOT_GATEWAY", "value": "1"},
                            {"name": "AUTH_TOKEN", "valueFrom": {"secretKeyRef": {"name": secret_name, "key": "api_key"}}},
                            {"name": "API_SERVER_ENABLED", "value": "true"},
                            {"name": "API_SERVER_HOST", "value": "0.0.0.0"},
                            {"name": "API_SERVER_PORT", "value": "8642"},
                            {"name": "API_SERVER_KEY", "valueFrom": {"secretKeyRef": {"name": secret_name, "key": "api_key"}}},
                        ],
                        "volumeMounts": [
                            {"name": "hermes-data", "mountPath": "/home/agent/.hermes"},
                            {"name": "webui-home", "mountPath": "/home/agent/.hermes/webui-data", "subPath": "webui-data"},
                        ],
                        "readinessProbe": {
                            "httpGet": {"path": "/health", "port": 6060},
                            "initialDelaySeconds": 15, "periodSeconds": 10, "timeoutSeconds": 5,
                        },
                        "livenessProbe": {
                            "httpGet": {"path": "/health", "port": 6060},
                            "initialDelaySeconds": 30, "periodSeconds": 30, "timeoutSeconds": 5,
                        },
                        **({"resources": resources} if resources else {}),
                    }],
                    "volumes": [
                        {"name": "hermes-data", "hostPath": {"path": f"/data/hermes/agent{agent_num}", "type": "DirectoryOrCreate"}},
                        {"name": "webui-home", "hostPath": {"path": f"/data/hermes/agent{agent_num}", "type": "DirectoryOrCreate"}},
                    ],
                },
            },
        },
    }

AGENTS = {
    # (agent_num, cpu_request, cpu_limit, mem_request, mem_limit)
    1:  {"requests": {"cpu": "500m", "memory": "768Mi"}, "limits": {"cpu": "2", "memory": "2Gi"}},
    2:  {"requests": {"cpu": "500m", "memory": "768Mi"}, "limits": {"cpu": "2", "memory": "2Gi"}},
    3:  {"requests": {"cpu": "500m", "memory": "768Mi"}, "limits": {"cpu": "2", "memory": "2Gi"}},
    4:  {"requests": {"cpu": "200m", "memory": "512Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
    5:  {"requests": {"cpu": "200m", "memory": "512Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
    6:  {"requests": {"cpu": "200m", "memory": "512Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
    7:  {"requests": {"cpu": "200m", "memory": "512Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
    8:  {"requests": {"cpu": "200m", "memory": "512Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
    9:  {"requests": {"cpu": "200m", "memory": "512Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
    10: {"requests": {"cpu": "200m", "memory": "512Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
    11: {"requests": {"cpu": "200m", "memory": "512Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
    12: {"requests": {"cpu": "200m", "memory": "512Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
    13: {"requests": {"cpu": "200m", "memory": "512Mi"}, "limits": {"cpu": "1", "memory": "2Gi"}},
}

def migrate_one(agent_num):
    name = f"hermes-gateway-{agent_num}"
    ns = "hermes-agent"
    resources = AGENTS[agent_num]

    print(f"\n{'='*60}")
    print(f"Migrating agent {agent_num} ({name})")
    print(f"{'='*60}")

    # 1. Verify secret exists (preserve API key)
    r = kubectl(["get", "secret", f"{name}-secret", "-n", ns, "-o", "jsonpath={.data.api_key}"])
    if r.returncode != 0:
        print(f"  ERROR: Secret {name}-secret not found, skipping")
        return False
    print(f"  Secret exists (API key preserved)")

    # 2. Verify data directory exists
    r = subprocess.run(["ls", f"/data/hermes/agent{agent_num}/"], capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  WARNING: Data dir /data/hermes/agent{agent_num}/ not found, creating")
        subprocess.run(["mkdir", "-p", f"/data/hermes/agent{agent_num}"])
    else:
        print(f"  Data dir /data/hermes/agent{agent_num}/ exists ({len(r.stdout.splitlines())} entries)")

    # 3. Ensure .webui directory with correct ownership
    subprocess.run(["mkdir", "-p", f"/data/hermes/agent{agent_num}/webui-data"], check=True)
    subprocess.run(["chown", "10000:10000", f"/data/hermes/agent{agent_num}/webui-data"], check=False)

    # 4. Delete old 3-container deployment
    print(f"  Deleting old deployment {name}...")
    kubectl(["delete", "deployment", name, "-n", ns, "--timeout=60s"])
    print(f"  Old deployment deleted")

    # 5. Delete associated webui deployment
    webui_name = f"hermes-webui-{agent_num}"
    r = kubectl(["delete", "deployment", webui_name, "-n", ns, "--timeout=60s", "--ignore-not-found=true"])
    print(f"  WebUI deployment {webui_name}: {'deleted' if 'deleted' in r.stdout else 'not found'}")

    # 6. Apply new merged deployment
    dep = make_deployment(agent_num, resources)
    dep_json = json.dumps(dep, indent=2)
    r = kubectl(["apply", "-f", "-"], input_data=dep_json)
    if r.returncode != 0:
        print(f"  ERROR applying deployment: {r.stderr}")
        return False
    print(f"  New deployment applied")

    # 7. Wait for pod ready
    print(f"  Waiting for pod to be ready...")
    r = kubectl(["rollout", "status", f"deployment/{name}", "-n", ns, "--timeout=180s"])
    if r.returncode != 0:
        print(f"  ERROR: Pod not ready: {r.stderr}")
        kubectl(["logs", f"deployment/{name}", "-n", ns, "--tail=30"])
        return False
    print(f"  Pod is ready!")

    # 8. Quick verification
    r = kubectl(["get", "pods", "-n", ns, "-l", f"app={name}", "--no-headers"])
    print(f"  Pod status: {r.stdout.strip()}")

    return True

def main():
    failed = []
    for agent_num in sorted(AGENTS.keys()):
        if not migrate_one(agent_num):
            failed.append(agent_num)
            print(f"  Agent {agent_num} FAILED - stopping migration")
            break  # Stop on first failure

    print(f"\n{'='*60}")
    if not failed:
        print("All 13 agents migrated successfully!")
    else:
        print(f"MIGRATION STOPPED at agent {failed[0]}")
        print(f"Agents 1-{failed[0]-1} migrated, agents {failed[0]}-13 need attention")
    print(f"{'='*60}")

if __name__ == "__main__":
    main()
```

### 2.2 执行迁移

```bash
# 在 183 上执行
ssh root@172.32.153.183
python3 /tmp/migrate_agents_183.py
```

**关键安全点**：
- **数据不丢失**：hostPath `/data/hermes/agentN/` 不变，只是容器内从 `/opt/data` 改挂到 `/home/agent/.hermes`
- **API key 不变**：复用现有 `hermes-gateway-{N}-secret`，外部客户端不断连
- **首遇失败即停**：任何 agent 迁移失败立即暂停，保留现场排查

## Phase 3: Ingress 更新（~15 分钟）

### 3.1 删除旧 webui ingress（每个 agent 迁移后自动由 admin 管理）

```bash
ssh root@172.32.153.183

# 删除旧的 webui nip.io ingress
for i in $(seq 1 13); do
  kubectl delete ingress hermes-webui-$i -n hermes-agent --ignore-not-found=true
done

# 删除旧的统一 ingress（路由已由 admin 动态管理）
kubectl delete ingress hermes-agents-ingress -n hermes-agent --ignore-not-found=true
kubectl delete ingress hermes-webui-ingress -n hermes-agent --ignore-not-found=true
```

### 3.2 通过 admin API 重新注册 ingress 路由

```bash
# 获取 admin key
ADMIN_KEY=$(kubectl get secret hermes-admin-internal-secret -n hermes-agent -o jsonpath='{.data.admin_internal_token}' | base64 -d)

# 对每个 agent 重新 provision（会自动创建 nip.io ingress + 主 ingress path）
for i in $(seq 1 13); do
  curl -s -X POST "http://172.32.153.183:40080/admin/api/agents/$i/retry-provision" \
    -H "X-Admin-Key: $ADMIN_KEY" | jq .
  echo "agent$i provisioned"
done
```

### 3.3 验证所有路由

```bash
for i in $(seq 1 13); do
  echo -n "agent$i: "
  curl -s -o /dev/null -w "%{http_code}" http://agent${i}.172-32-153-183.nip.io:40080/v1/models
  echo ""
done
```

## Phase 4: 清理（~10 分钟）

```bash
ssh root@172.32.153.183

# 删除独立的 webui Service（deployment 已在 Phase 2 删除）
for i in $(seq 1 13); do
  kubectl delete svc hermes-webui-$i -n hermes-agent --ignore-not-found=true
done

# 删除独立的 webui deployment（如有遗漏）
for i in $(seq 1 13); do
  kubectl delete deployment hermes-webui-$i -n hermes-agent --ignore-not-found=true
done

# 删除旧的 webui 共用 deployment
kubectl delete deployment hermes-webui -n hermes-agent --ignore-not-found=true

# 清理旧镜像（确认稳定 48 小时后再执行）
# /opt/containerd/bin/ctr -a /run/containerd/containerd.sock -n k8s.io images rm nousresearch/hermes-agent:latest
```

## Phase 5: 验证（~15 分钟）

```bash
# 1. 所有 Pod 运行正常
kubectl get pods -n hermes-agent -o wide
# 预期: 13 gateway + admin + orchestrator + redis + postgres = ~17 pods

# 2. Admin 面板
curl -s http://172.32.153.183:40080/admin/api/health -H "X-Admin-Key: $ADMIN_KEY"

# 3. 每个 agent 的 WebUI 和 Gateway
for i in $(seq 1 13); do
  echo "=== agent$i ==="
  echo -n "  WebUI: "; curl -s -o /dev/null -w "%{http_code}" http://agent${i}.172-32-153-183.nip.io:40080/
  echo -n "  Gateway: "; curl -s -o /dev/null -w "%{http_code}" http://agent${i}.172-32-153-183.nip.io:40080/v1/models
  echo ""
done

# 4. 数据完整性（每个 agent 数据目录应有内容）
for i in $(seq 1 13); do
  echo -n "agent$i data: "; ls /data/hermes/agent$i/ | wc -l
done
```

## 回滚方案

每个 agent 可独立回滚（Phase 0 已备份）：

```bash
AGENT_NUM=1
# 恢复旧 deployment
kubectl apply -f /tmp/183-upgrade-backup/gateway-$AGENT_NUM.yaml
# 恢复旧 secret（如果被改了）
kubectl apply -f /tmp/183-upgrade-backup/secret-$AGENT_NUM.yaml
# 恢复旧 ingress
kubectl apply -f /tmp/183-upgrade-backup/all-ingress.yaml
```

全量回滚：

```bash
for i in $(seq 1 13); do
  kubectl apply -f /tmp/183-upgrade-backup/gateway-$i.yaml
  kubectl apply -f /tmp/183-upgrade-backup/secret-$i.yaml
done
# 删除新 ingress（如果有）
kubectl get ingress -n hermes-agent --no-headers | awk '{print $1}' | while read ing; do
  kubectl delete ingress "$ing" -n hermes-agent
done
# 恢复全部旧 ingress
kubectl apply -f /tmp/183-upgrade-backup/all-ingress.yaml
```

## 时间估算

| Phase | 预估 | 累计 |
|-------|------|------|
| Phase 0: 全量备份 | 10 min | 10 min |
| Phase 1: 镜像准备 | 20 min | 30 min |
| Phase 2: 迁移 13 个 Agent | 2 hr | 2.5 hr |
| Phase 3: Ingress 更新 | 15 min | 2.75 hr |
| Phase 4: 清理 | 10 min | 2.9 hr |
| Phase 5: 验证 | 15 min | **~3 hr** |

在 4 小时停服窗口内完成。
