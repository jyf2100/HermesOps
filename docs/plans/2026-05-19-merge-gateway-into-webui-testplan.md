# Test Plan: Gateway-into-WebUI Merge

> Date: 2026-05-19
> Plan Reference: `docs/plans/2026-05-19-merge-gateway-into-webui.md`
> Target: Merge hermes-gateway-1 + hermes-webui-1 into a single Pod
> Cluster: 184 (dev) first, then 183 (test)

---

## 1. Pre-Implementation Acceptance Criteria

These conditions MUST all be true BEFORE starting any merge work. If any fails, block the implementation.

| # | Criterion | Verification Command | Pass Condition |
|---|-----------|---------------------|----------------|
| P1 | HERMES_BIN path exists in webui container image | `sudo kubectl exec -n hermes-agent deploy/hermes-webui-1 -- test -f /opt/hermes/hermes && echo OK` | Prints `OK` |
| P2 | `/opt/hermes/hermes` is executable in webui container | `sudo kubectl exec -n hermes-agent deploy/hermes-webui-1 -- /opt/hermes/hermes --version 2>&1 | head -1` | Returns version string or runs without error |
| P3 | Gateway-1 data directory exists and has content | `ls /data/hermes/agent1/config.yaml` | File exists on 184 host |
| P4 | WebUI-1 data directory exists and has DB | `ls /data/hermes/webui-1/.webui/hermes-web-ui.db` | File exists on 184 host |
| P5 | Secret `hermes-gateway-1-secret` exists | `sudo kubectl get secret hermes-gateway-1-secret -n hermes-agent -o jsonpath='{.data.api_key}' | base64 -d | wc -c` | Non-zero length |
| P6 | Redis secret exists with password key | `sudo kubectl get secret hermes-redis-secret -n hermes-agent -o jsonpath='{.data.redis-password}' | base64 -d | wc -c` | Non-zero length |
| P7 | Current gateway-1 is healthy (baseline) | `sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -- curl -sf http://localhost:8642/health` | `{"status":"ok"}` |
| P8 | Current webui-1 is healthy (baseline) | `sudo kubectl exec -n hermes-agent deploy/hermes-webui-1 -- curl -sf http://localhost:6060/health` | `{"status":"ok"}` |
| P9 | Data backup completed | `ls -d /data/hermes/agent1.bak.* /data/hermes/webui-1.bak.*` | Two backup directories exist |
| P10 | WebUI data merged to agent1 directory | `test -f /data/hermes/agent1/.webui/hermes-web-ui.db && echo OK` | Prints `OK` |
| P11 | Admin panel is accessible | `curl -sf http://172.32.153.184:48082/admin/ -o /dev/null -w '%{http_code}'` | Returns `200` |
| P12 | No critical pods in CrashLoopBackOff | `sudo kubectl get pods -n hermes-agent --no-headers | grep -v Running | grep -v Completed` | Empty output |

### Pre-Implementation Data Integrity Snapshot

Record these before the merge for post-merge comparison:

```bash
# Record gateway state.db size and session count
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -- ls -la /opt/data/state.db
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -- ls /opt/data/sessions/ | wc -l

# Record webui DB size
sudo kubectl exec -n hermes-agent deploy/hermes-webui-1 -- ls -la /opt/data/.webui/hermes-web-ui.db

# Record config.yaml checksum
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -- md5sum /opt/data/config.yaml
```

---

## 2. Post-Implementation Acceptance Criteria

### 2.1 End User (Chat User)

| # | Criterion | Priority | Verification |
|---|-----------|----------|-------------|
| EU1 | WebUI loads at `http://172.32.153.184/agent1/` | P0 | Browser opens page, sees chat UI |
| EU2 | Can send a text chat message and receive a response | P0 | Send "Hello" via chat, get AI reply |
| EU3 | Streaming (SSE) works — response tokens appear incrementally | P0 | Send message, observe tokens streaming in UI (not waiting for full response) |
| EU4 | Tool execution works (code execution) | P0 | Send "Run `print('hello world')` in Python", observe tool call + result |
| EU5 | File upload works | P1 | Upload a .txt file via chat attachment, verify it appears in conversation |
| EU6 | File download works | P1 | Ask agent to create a file, verify download link works |
| EU7 | Session history preserved from before migration | P0 | Open existing conversation, see prior messages intact |
| EU8 | New session can be created | P1 | Create new chat, send message, verify it persists after page reload |
| EU9 | `/v1/chat/completions` works through Ingress | P0 | See test case TC-01 |
| EU10 | `/v1/responses` works through Ingress | P1 | See test case TC-02 |
| EU11 | API key login via WebUI works | P0 | Enter API key on login screen, get access |
| EU12 | Direct Connection model discovery works | P2 | Configure DC in WebUI settings, models appear |

### 2.2 Admin Panel Operator

| # | Criterion | Priority | Verification |
|---|-----------|----------|-------------|
| AO1 | Agent list shows agent-1 (and all agents) | P0 | See test case TC-05 |
| AO2 | Health check shows green for merged agent | P0 | See test case TC-06 |
| AO3 | Can view agent logs | P1 | See test case TC-07 |
| AO4 | Can exec into container (terminal) | P0 | See test case TC-08 |
| AO5 | Can browse files | P1 | See test case TC-09 |
| AO6 | Can view agent detail page | P1 | Navigate to agent detail, see config/status |
| AO7 | Can edit config.yaml and save | P1 | Edit a config field, save, verify it persisted |
| AO8 | Can restart agent | P2 | Click restart, verify pod restarts and comes back healthy |
| AO9 | Admin login with admin key works | P0 | Access admin panel with ADMIN_KEY |

### 2.3 Orchestrator

| # | Criterion | Priority | Verification |
|---|-----------|----------|-------------|
| OC1 | Can discover agent-1 via K8s labels | P0 | See test case TC-10 |
| OC2 | Can dispatch task to agent-1 via `/v1/chat/completions` | P0 | See test case TC-11 |
| OC3 | Can read response from agent-1 | P1 | See test case TC-12 |
| OC4 | Redis connectivity works (with password) | P0 | See test case TC-13 |

### 2.4 System

| # | Criterion | Priority | Verification |
|---|-----------|----------|-------------|
| SY1 | No OOMKilled events in 24 hours | P0 | `sudo kubectl get events -n hermes-agent --field-selector reason=OOMKilling` returns empty |
| SY2 | Gateway subprocess auto-recovers after crash | P0 | See test case TC-14 |
| SY3 | Redis connection works from merged container | P0 | See test case TC-13 |
| SY4 | No data loss from migration (state.db intact) | P0 | Compare md5sum of config.yaml and size of state.db with pre-merge snapshot |
| SY5 | Pod memory stays under 2Gi limit under load | P1 | Send 5 concurrent chat requests, check `kubectl top pod` |
| SY6 | Readiness probe passes (Pod becomes Ready) | P0 | `kubectl get pods -l app=hermes-gateway-1` shows 1/1 Ready |
| SY7 | Both ports (6060, 8642) accessible via Service | P0 | See test case TC-03 and TC-04 |
| SY8 | Init container runs successfully | P0 | `kubectl logs` for init container shows no errors |
| SY9 | No CrashLoopBackOff after deployment | P0 | `kubectl get pods -l app=hermes-gateway-1` shows Running, not CrashLoopBackOff |
| SY10 | Old hermes-webui-1 deployment deleted after verification | P2 | `kubectl get deploy hermes-webui-1` returns NotFound |

---

## 3. Test Cases

### TC-01: Chat Completions through Ingress (P0)

```bash
# Get the API key
API_KEY=$(sudo kubectl get secret hermes-gateway-1-secret -n hermes-agent \
  -o jsonpath='{.data.api_key}' | base64 -d)

# Test /v1/chat/completions through Ingress path rewrite
curl -sS -X POST "http://172.32.153.184/agent1/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Say hello in one word"}],
    "stream": false,
    "max_tokens": 50
  }' --max-time 30 | python3 -m json.tool
```

**Pass**: Returns valid JSON with `choices[0].message.content` containing a response.

### TC-02: Responses API through Ingress (P1)

```bash
API_KEY=$(sudo kubectl get secret hermes-gateway-1-secret -n hermes-agent \
  -o jsonpath='{.data.api_key}' | base64 -d)

curl -sS -X POST "http://172.32.153.184/agent1/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "auto",
    "input": "What is 2+2? Answer with just the number."
  }' --max-time 30 | python3 -m json.tool
```

**Pass**: Returns valid JSON with response output containing "4".

### TC-03: Gateway Direct Access via Service DNS (P0)

```bash
# From within the cluster (any pod or via admin)
sudo kubectl exec -n hermes-agent deploy/hermes-admin -- \
  curl -sf http://hermes-gateway-1.hermes-agent.svc.cluster.local:8642/health
```

**Pass**: Returns `{"status":"ok"}`.

### TC-04: WebUI Direct Access via Service DNS (P0)

```bash
sudo kubectl exec -n hermes-agent deploy/hermes-admin -- \
  curl -sf http://hermes-gateway-1.hermes-agent.svc.cluster.local:6060/health
```

**Pass**: Returns `{"status":"ok"}` (webui /health includes gateway sub-health).

### TC-05: Admin API — Agent List (P0)

```bash
ADMIN_KEY=$(sudo kubectl get secret hermes-admin-secret -n hermes-agent \
  -o jsonpath='{.data.admin_key}' | base64 -d)

curl -sS "http://172.32.153.184:48082/admin/api/agents" \
  -H "Authorization: Bearer $ADMIN_KEY" | python3 -m json.tool
```

**Pass**: Response includes agent with `deployment_name: "hermes-gateway-1"`. Agent list is NOT empty (proves naming compatibility).

### TC-06: Admin API — Health Check (P0)

```bash
ADMIN_KEY=$(sudo kubectl get secret hermes-admin-secret -n hermes-agent \
  -o jsonpath='{.data.admin_key}' | base64 -d)

curl -sS "http://172.32.153.184:48082/admin/api/agents/1/health" \
  -H "Authorization: Bearer $ADMIN_KEY" | python3 -m json.tool
```

**Pass**: Returns `{"status": "ok", ...}`. The admin's `check_health()` hits `hermes-gateway-1:8642/health` which still works because the Service still exposes port 8642.

### TC-07: Admin API — View Logs (P1)

```bash
ADMIN_KEY=$(sudo kubectl get secret hermes-admin-secret -n hermes-agent \
  -o jsonpath='{.data.admin_key}' | base64 -d)

# Get log token
TOKEN=$(curl -sS -X POST "http://172.32.153.184:48082/admin/api/agents/1/logs/token" \
  -H "Authorization: Bearer $ADMIN_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Stream logs (first 5 lines)
curl -sS -N "http://172.32.153.184:48082/admin/api/agents/1/logs?token=$TOKEN" \
  -H "Authorization: Bearer $ADMIN_KEY" --max-time 10 | head -5
```

**Pass**: Returns log lines from the merged container (should show both Node.js and gateway logs).

### TC-08: Admin API — Exec Terminal (P0)

```bash
ADMIN_KEY=$(sudo kubectl get secret hermes-admin-secret -n hermes-agent \
  -o jsonpath='{.data.admin_key}' | base64 -d)

# Verify exec works through admin API (WebSocket terminal)
# Check container name matches "gateway"
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- ps aux
```

**Pass**: Shows both the Node.js webui process AND the gateway Python subprocess. The `-c gateway` flag must work (proves container name preserved).

### TC-09: Admin API — File Browser (P1)

```bash
ADMIN_KEY=$(sudo kubectl get secret hermes-admin-secret -n hermes-agent \
  -o jsonpath='{.data.admin_key}' | base64 -d)

curl -sS "http://172.32.153.184:48082/admin/api/agents/1/files?path=/opt/data" \
  -H "Authorization: Bearer $ADMIN_KEY" | python3 -m json.tool
```

**Pass**: Returns file listing including `config.yaml`, `state.db`, `sessions/`, etc.

### TC-10: Orchestrator — Agent Discovery (P0)

```bash
# Verify the pod has the correct labels for orchestrator discovery
sudo kubectl get pods -n hermes-agent -l app.kubernetes.io/component=gateway \
  -o jsonpath='{.items[?(@.metadata.labels.app=="hermes-gateway-1")].metadata.name}'
```

**Pass**: Returns `hermes-gateway-1-*` pod name.

### TC-11: Orchestrator — Task Dispatch (P0)

```bash
# Get the gateway API key (same key used by orchestrator)
API_KEY=$(sudo kubectl get secret hermes-gateway-1-secret -n hermes-agent \
  -o jsonpath='{.data.api_key}' | base64 -d)

# Dispatch via Service DNS (how orchestrator reaches agents)
sudo kubectl exec -n hermes-agent deploy/hermes-orchestrator -- \
  curl -sf -X POST http://hermes-gateway-1.hermes-agent.svc.cluster.local:8642/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"auto","messages":[{"role":"user","content":"ping"}],"max_tokens":10}' \
  --max-time 30
```

**Pass**: Returns valid chat completion response.

### TC-12: Orchestrator — Read Response (P1)

```bash
API_KEY=$(sudo kubectl get secret hermes-gateway-1-secret -n hermes-agent \
  -o jsonpath='{.data.api_key}' | base64 -d)

# Test responses API from within cluster
sudo kubectl exec -n hermes-agent deploy/hermes-orchestrator -- \
  curl -sf -X POST http://hermes-gateway-1.hermes-agent.svc.cluster.local:8642/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"auto","input":"echo test"}' --max-time 30
```

**Pass**: Returns valid response object.

### TC-13: Redis Connectivity from Merged Container (P0)

```bash
# Verify Redis URL works with password
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -- \
  sh -c 'echo "PING" | redis-cli -h hermes-redis -p 6379 -a "$(cat /dev/stdin <<< $REDIS_PASSWORD)" 2>/dev/null' \
  || echo "redis-cli not available, testing via gateway health"

# Alternative: check gateway logs for Redis connection errors
sudo kubectl logs -n hermes-agent deploy/hermes-gateway-1 --tail=100 | grep -i "redis\|connection.*refused" || echo "No Redis errors found"
```

**Pass**: No Redis connection errors in logs. Gateway health check passes (Redis is required for gateway health).

### TC-14: Gateway Subprocess Crash Recovery (P0)

```bash
# Step 1: Find the gateway subprocess PID
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- \
  ps aux | grep hermes

# Step 2: Kill the gateway subprocess (simulate crash)
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- \
  sh -c 'kill $(pgrep -f "hermes gateway" | head -1)'

# Step 3: Wait and check if /health reflects the crash
sleep 5
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- \
  curl -sf http://localhost:6060/health 2>/dev/null || echo "Health check failed (expected after crash)"

# Step 4: Wait for readiness probe failures to trigger Pod restart (up to 90s)
echo "Waiting for Pod restart..."
sudo kubectl rollout status deployment/hermes-gateway-1 -n hermes-agent --timeout=120s

# Step 5: Verify Pod recovers
sudo kubectl get pods -n hermes-agent -l app=hermes-gateway-1
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- \
  curl -sf http://localhost:6060/health
```

**Pass**: After crash, `/health` returns error, readiness probe fails, Pod restarts, and `startAll()` spawns a new gateway subprocess. Final `/health` returns `{"status":"ok"}`.

### TC-15: Streaming SSE through Ingress (P0)

```bash
API_KEY=$(sudo kubectl get secret hermes-gateway-1-secret -n hermes-agent \
  -o jsonpath='{.data.api_key}' | base64 -d)

# Test streaming response
curl -sS -N -X POST "http://172.32.153.184/agent1/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "Count from 1 to 5"}],
    "stream": true,
    "max_tokens": 100
  }' --max-time 30 | head -20
```

**Pass**: Returns multiple `data: {...}` SSE chunks, ending with `data: [DONE]`. NOT a single bulk response.

### TC-16: Ingress Path Rewrite Verification (P0)

```bash
# Verify /agent1/ strips prefix correctly and hits webui
curl -sS -o /dev/null -w '%{http_code}' "http://172.32.153.184/agent1/"

# Verify /agent1/v1/ proxies to gateway via webui
API_KEY=$(sudo kubectl get secret hermes-gateway-1-secret -n hermes-agent \
  -o jsonpath='{.data.api_key}' | base64 -d)
curl -sS -o /dev/null -w '%{http_code}' "http://172.32.153.184/agent1/v1/models" \
  -H "Authorization: Bearer $API_KEY"
```

**Pass**: First returns `200` (webui page). Second returns `200` (models list proxied to gateway).

### TC-17: WebUI Nip.io Domain Access (P1)

```bash
# Verify the nip.io domain still works for WebUI access
curl -sS -o /dev/null -w '%{http_code}' "http://agent1.172-32-153-184.nip.io/"
```

**Pass**: Returns `200`. Note: This Ingress currently routes to `hermes-webui-1:6060`. Post-merge, this Ingress needs updating to point to `hermes-gateway-1:6060` OR be deleted in favor of the path-based Ingress.

### TC-18: Container Process Verification (P0)

```bash
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- ps aux
```

**Pass**: Output shows:
- PID 1: Node.js process (webui)
- Another PID: Python gateway subprocess (`/opt/hermes/.venv/bin/python3 ... hermes gateway` or similar)
- No `tini` process (webui manages its own lifecycle)

### TC-19: Environment Variable Verification (P0)

```bash
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- env | sort
```

**Pass**: Confirms:
- `HERMES_WEB_UI_API_BASE_URL` is NOT set (triggers local mode)
- `HERMES_BIN=/opt/hermes/hermes` is set
- `HERMES_HOME=/opt/data` is set
- `HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN=1` is set
- `API_SERVER_ENABLED=true`
- `API_SERVER_HOST=0.0.0.0`
- `API_SERVER_PORT=8642`
- `GATEWAY_HOST=127.0.0.1` is set
- `AUTH_TOKEN` is set (from secret)
- `REDIS_PASSWORD` is set (from secret)

### TC-20: Resource Usage Under Load (P1)

```bash
# Send concurrent requests and check memory
API_KEY=$(sudo kubectl get secret hermes-gateway-1-secret -n hermes-agent \
  -o jsonpath='{.data.api_key}' | base64 -d)

for i in $(seq 1 5); do
  curl -sS -X POST "http://172.32.153.184/agent1/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"Tell me a joke number $i\"}],\"max_tokens\":100}" \
    --max-time 30 > /dev/null &
done
wait

# Check memory usage
sudo kubectl top pod -n hermes-agent -l app=hermes-gateway-1
```

**Pass**: Memory usage stays under 2Gi (the limit). If approaching limit, increase to 3Gi.

### TC-21: Data Integrity Post-Migration (P0)

```bash
# Compare with pre-implementation snapshot
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- \
  md5sum /opt/data/config.yaml

sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- \
  ls -la /opt/data/state.db

sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- \
  ls /opt/data/sessions/ | wc -l

# Verify webui DB is accessible
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- \
  ls -la /opt/data/.webui/hermes-web-ui.db
```

**Pass**: config.yaml md5 matches pre-merge snapshot. state.db size is >= pre-merge size. Session count is >= pre-merge count. webui DB exists and is non-empty.

### TC-22: Volume Mount Verification (P0)

```bash
# Verify hostPath mounts are correct
sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- \
  ls -la /opt/data/config.yaml /opt/data/.webui/hermes-web-ui.db

sudo kubectl exec -n hermes-agent deploy/hermes-gateway-1 -c gateway -- \
  df -h /opt/data /app/dist/data
```

**Pass**: Both paths accessible. `/opt/data` maps to `/data/hermes/agent1` on host. `/app/dist/data` maps to `/data/hermes/agent1/webui-data` on host.

---

## 4. Test Execution Sequence

### Phase A: Immediate Post-Deploy (within 5 minutes)

Run in this order. All must pass before proceeding.

```
1. TC-18  Container Process Verification
2. TC-19  Environment Variable Verification
3. TC-22  Volume Mount Verification
4. TC-03  Gateway Direct Access (Service DNS :8642)
5. TC-04  WebUI Direct Access (Service DNS :6060)
6. SY6    Readiness probe (Pod Ready)
```

### Phase B: Ingress Routing (within 10 minutes)

```
7. TC-16  Ingress Path Rewrite
8. TC-01  Chat Completions through Ingress
9. TC-15  Streaming SSE through Ingress
```

### Phase C: Admin Panel (within 15 minutes)

```
10. TC-05  Admin Agent List
11. TC-06  Admin Health Check
12. TC-07  Admin Logs
13. TC-08  Admin Exec Terminal
14. TC-09  Admin File Browser
```

### Phase D: Orchestrator (within 20 minutes)

```
15. TC-10  Orchestrator Agent Discovery
16. TC-11  Orchestrator Task Dispatch
17. TC-13  Redis Connectivity
```

### Phase E: Data and Resilience (within 30 minutes)

```
18. TC-21  Data Integrity
19. TC-14  Gateway Crash Recovery (destructive test — do last)
20. TC-20  Resource Usage Under Load
```

### Phase F: Cleanup Verification (after all above pass)

```
21. TC-02  Responses API
22. TC-17  Nip.io Domain Access
23. SY1    No OOMKilled events (check after 1 hour)
```

---

## 5. Rollback Triggers

### Immediate Rollback (BLOCK — do not proceed with verification)

| # | Trigger | Detection |
|---|---------|-----------|
| R1 | Pod fails to start (ImagePullBackOff, CrashLoopBackOff) | `kubectl get pods -l app=hermes-gateway-1` shows non-Running status after 3 minutes |
| R2 | Init container fails | `kubectl describe pod` shows init container error |
| R3 | HERMES_BIN not found in container | TC-18 shows no gateway subprocess after initialDelaySeconds |
| R4 | Both ports not listening | TC-03 and TC-04 both fail |

### Rollback After Partial Verification

| # | Trigger | Detection |
|---|---------|-----------|
| R5 | Ingress routing broken (neither WebUI nor API accessible) | TC-16 fails with 502/503/504 |
| R6 | Admin panel cannot see agent (naming breakage) | TC-05 returns empty list |
| R7 | Health check always shows error | TC-06 returns `status: "error"` after 2 minutes |
| R8 | Data loss detected (state.db missing or corrupt) | TC-21 shows missing/corrupted files |
| R9 | Gateway subprocess not spawned | TC-18 shows only Node.js, no Python process |
| R10 | Redis connection fails (gateway cannot start) | Logs show Redis connection refused |

### Delayed Rollback (within 24 hours)

| # | Trigger | Detection |
|---|---------|-----------|
| R11 | OOMKilled within first 24h | `kubectl get events` shows OOMKilling |
| R12 | Repeated Pod restarts (>3 in 1 hour) | `kubectl get pods` shows high restart count |
| R13 | Gateway crash not auto-recovered | TC-14 fails — Pod does not recover after kill |
| R14 | Chat quality degraded (timeouts, errors > 10%) | User reports or monitoring |

### Rollback Procedure

```bash
# 1. Scale down merged deployment
sudo kubectl scale deployment hermes-gateway-1 --replicas=0 -n hermes-agent

# 2. Restore original gateway deployment (from git)
cd /mnt/disk01/workspaces/worksummary/hermes-agent
git stash  # stash merge changes
sudo kubectl apply -f kubernetes/gateway/deployment.yaml
sudo kubectl apply -f kubernetes/gateway/service.yaml

# 3. Restore original webui deployment
sudo kubectl apply -f kubernetes/webui/deployment-hermes-web-ui.yaml
sudo kubectl apply -f kubernetes/webui/service-hermes-web-ui.yaml

# 4. Restore Ingress (revert to port 8642)
git checkout -- kubernetes/gateway/ingress.yaml
sudo kubectl apply -f kubernetes/gateway/ingress.yaml

# 5. Wait for pods to come up
sudo kubectl rollout status deployment/hermes-gateway-1 -n hermes-agent --timeout=120s
sudo kubectl rollout status deployment/hermes-webui-1 -n hermes-agent --timeout=120s

# 6. Verify rollback
curl -sf http://172.32.153.184/agent1/v1/models -H "Authorization: Bearer $API_KEY"
```

**Data safety**: Rollback does NOT lose data. The hostPath `/data/hermes/agent1` is unchanged (gateway data untouched, only `.webui/` subdirectory was added).

---

## 6. Post-Merge Checklist for Dynamic Agents (agent4+)

After the static agent1 merge is verified, the following code changes must also be validated for dynamic agent creation:

| # | Check | Verification |
|---|-------|-------------|
| D1 | `templates.py:render_webui_deployment()` no longer sets `HERMES_WEB_UI_API_BASE_URL` | Code review + create test agent via admin panel |
| D2 | `templates.py:render_deployment()` is no longer called (or calls merged version) | Code review |
| D3 | `templates.py:render_service()` includes both port 6060 and 8642 | Code review + `kubectl get svc` on new agent |
| D4 | `k8s_client.py:add_ingress_path()` uses port 6060 instead of 8642 | Code review + create agent, check Ingress |
| D5 | Dynamic agent creation end-to-end works | Create agent via admin panel, verify health + chat |
| D6 | Dynamic agent deletion cleans up properly | Delete test agent, verify deployment+svc+secret removed |

---

## 7. Success Criteria Summary

**GO for Phase 3 (cleanup) and Phase 4 (183 rollout) requires ALL of the following:**

- [x] Phase A (6/6 tests pass)
- [x] Phase B (3/3 tests pass)
- [x] Phase C (5/5 tests pass)
- [x] Phase D (3/3 tests pass)
- [x] Phase E (3/3 tests pass)
- [x] No R1-R10 rollback triggers hit
- [x] Data integrity confirmed (TC-21)

**24-hour monitoring review before 183 rollout:**

- [ ] No R11-R14 delayed rollback triggers hit
- [ ] TC-20 resource usage stable
