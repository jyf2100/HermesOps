# Standalone WebUI Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move ops-panel from sidecar container to standalone hermes-web-ui deployment with dedicated host-based Ingress, eliminating all SPA subpath issues.

**Architecture:** Each agent gets two independent Deployments: (1) gateway pod with gateway+dashboard containers (no ops-panel), (2) standalone hermes-web-ui pod connected to gateway via K8s Service. WebUI is accessed at `agentN.172-32-153-184.nip.io` (root path `/`, no rewrite). Both deployments share the same hostPath volume and read AUTH_TOKEN/API_SERVER_KEY from the same K8s Secret.

**Tech Stack:** Python 3.11 / FastAPI / K8s Python client / React 19 / TypeScript

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `admin/backend/templates.py` | K8s resource templates | Modify: remove sidecar, add 3 new methods |
| `admin/backend/k8s_client.py` | K8s API wrapper | Modify: add webui CRUD methods |
| `admin/backend/agent_manager.py` | Agent business logic | Modify: integrate webui in create/delete |
| `admin/backend/models.py` | Pydantic models | Modify: add webui_url field |
| `admin/frontend/src/lib/admin-api.ts` | API types | Modify: add webui_url to AgentDetail |

---

### Task 1: Remove ops-panel sidecar from templates

**Files:**
- Modify: `admin/backend/templates.py:240-273` (ops-panel container block)
- Modify: `admin/backend/templates.py:296-298` (service ops port)

- [ ] **Step 1: Remove the ops-panel container definition**

In `admin/backend/templates.py`, delete lines 240-273 (the entire third container block starting with `{` after the dashboard container's closing `},` and ending before `]`).

The container list in `render_deployment()` should end with just the dashboard container. Change the closing from:

```python
                            "volumeMounts": [{"name": "hermes-data", "mountPath": "/opt/data"}],
                        }, {
                            "name": "ops-panel",
                            # ... entire ops-panel block ...
                        }],
```

to:

```python
                            "volumeMounts": [{"name": "hermes-data", "mountPath": "/opt/data"}],
                        }],
```

- [ ] **Step 2: Remove the ops port from render_service()**

In `render_service()`, remove the ops port entry. Change:

```python
                "ports": [
                    {"name": "api", "port": 8642, "targetPort": 8642},
                    {"name": "dashboard", "port": 9119, "targetPort": 9119},
                    {"name": "ops", "port": 6060, "targetPort": 6060},
                ],
```

to:

```python
                "ports": [
                    {"name": "api", "port": 8642, "targetPort": 8642},
                    {"name": "dashboard", "port": 9119, "targetPort": 9119},
                ],
```

- [ ] **Step 3: Commit**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent
git add admin/backend/templates.py
git commit -m "refactor(templates): remove ops-panel sidecar from gateway deployment"
```

---

### Task 2: Add standalone WebUI template methods

**Files:**
- Modify: `admin/backend/templates.py` (add 3 new methods at end of class)

- [ ] **Step 1: Add render_webui_deployment method**

Add this method to the `TemplateGenerator` class, after `set_template()`:

```python
    def render_webui_deployment(self, agent_number: int, secret_name: str,
                                namespace: str = "hermes-agent") -> dict:
        """Return a dict for standalone hermes-web-ui K8s Deployment."""
        gw_name = deployment_name(agent_number)
        name = f"hermes-webui-{agent_number}"
        return {
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "replicas": 1,
                "selector": {"matchLabels": {"app": name}},
                "template": {
                    "metadata": {"labels": {"app": name}},
                    "spec": {
                        "containers": [{
                            "name": "webui",
                            "image": "ekkoye8888/hermes-web-ui",
                            "imagePullPolicy": "IfNotPresent",
                            "ports": [{"containerPort": 6060}],
                            "env": [
                                {"name": "PORT", "value": "6060"},
                                {"name": "HERMES_HOME", "value": "/opt/data"},
                                {"name": "HERMES_WEB_UI_API_BASE_URL",
                                 "value": f"http://{gw_name}:8642"},
                                {"name": "HERMES_BIN", "value": "/opt/hermes/hermes"},
                                {"name": "HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN",
                                 "value": "0"},
                                {"name": "AUTH_TOKEN", "valueFrom": {
                                    "secretKeyRef": {"name": secret_name, "key": "api_key"}
                                }},
                            ],
                            "resources": {
                                "requests": {"cpu": "50m", "memory": "128Mi"},
                                "limits": {"cpu": "250m", "memory": "512Mi"},
                            },
                            "readinessProbe": {
                                "httpGet": {"path": "/health", "port": 6060},
                                "initialDelaySeconds": 15, "periodSeconds": 30,
                                "timeoutSeconds": 5, "failureThreshold": 6,
                            },
                            "livenessProbe": {
                                "httpGet": {"path": "/health", "port": 6060},
                                "initialDelaySeconds": 30, "periodSeconds": 30,
                                "timeoutSeconds": 10, "failureThreshold": 5,
                            },
                            "volumeMounts": [
                                {"name": "hermes-data", "mountPath": "/opt/data"},
                            ],
                        }],
                        "volumes": [{
                            "name": "hermes-data",
                            "hostPath": {
                                "path": f"/data/hermes/agent{agent_number}",
                                "type": "DirectoryOrCreate",
                            },
                        }],
                    },
                },
            },
        }
```

- [ ] **Step 2: Add render_webui_service method**

```python
    def render_webui_service(self, agent_number: int,
                             namespace: str = "hermes-agent") -> dict:
        """Return a dict for standalone WebUI K8s Service."""
        name = f"hermes-webui-{agent_number}"
        return {
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "type": "ClusterIP",
                "ports": [{"port": 6060, "targetPort": 6060}],
                "selector": {"app": name},
            },
        }
```

- [ ] **Step 3: Add render_webui_ingress method**

```python
    def render_webui_ingress(self, agent_number: int,
                             namespace: str = "hermes-agent",
                             cluster_ip: str = "172.32.153.184") -> dict:
        """Return a dict for standalone WebUI host-based K8s Ingress."""
        name = f"hermes-webui-{agent_number}"
        nip = cluster_ip.replace(".", "-")
        host = f"agent{agent_number}.{nip}.nip.io"
        return {
            "apiVersion": "networking.k8s.io/v1",
            "kind": "Ingress",
            "metadata": {
                "name": name, "namespace": namespace,
                "annotations": {
                    "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
                    "nginx.ingress.kubernetes.io/proxy-send-timeout": "3600",
                    "nginx.ingress.kubernetes.io/proxy-buffering": "off",
                },
            },
            "spec": {
                "ingress_class_name": "nginx",
                "rules": [{
                    "host": host,
                    "http": {
                        "paths": [{
                            "path": "/",
                            "pathType": "Prefix",
                            "backend": {
                                "service": {"name": name, "port": {"number": 6060}},
                            },
                        }],
                    },
                }],
            },
        }
```

- [ ] **Step 4: Commit**

```bash
git add admin/backend/templates.py
git commit -m "feat(templates): add standalone WebUI deployment/service/ingress renderers"
```

---

### Task 3: Add WebUI CRUD methods to k8s_client

**Files:**
- Modify: `admin/backend/k8s_client.py` (add 6 methods after existing delete methods)

- [ ] **Step 1: Add webui deployment methods**

Add after the existing `delete_deployment()` method (around line 67) in `K8sClient`:

```python
    async def create_webui_deployment(self, body: dict) -> V1Deployment:
        return await self._k8s_call(
            self.apps_api.create_namespaced_deployment,
            namespace=self.namespace, body=body,
        )

    async def delete_webui_deployment(self, name: str) -> None:
        await self._k8s_call(
            self.apps_api.delete_namespaced_deployment,
            name=name, namespace=self.namespace,
            grace_period_seconds=0, propagation_policy="Foreground",
        )
```

- [ ] **Step 2: Add webui service methods**

Add after the existing `delete_service()` method:

```python
    async def create_webui_service(self, body: dict) -> V1Service:
        return await self._k8s_call(
            self.core_api.create_namespaced_service,
            namespace=self.namespace, body=body,
        )

    async def delete_webui_service(self, name: str) -> None:
        await self._k8s_call(
            self.core_api.delete_namespaced_service,
            name=name, namespace=self.namespace,
        )
```

- [ ] **Step 3: Add webui ingress methods**

Add after the existing `remove_ingress_path()` method:

```python
    async def create_webui_ingress(self, body: dict) -> None:
        await self._k8s_call(
            self.networking_api.create_namespaced_ingress,
            namespace=self.namespace, body=body,
        )

    async def delete_webui_ingress(self, name: str) -> None:
        await self._k8s_call(
            self.networking_api.delete_namespaced_ingress,
            name=name, namespace=self.namespace,
        )
```

- [ ] **Step 4: Commit**

```bash
git add admin/backend/k8s_client.py
git commit -m "feat(k8s): add WebUI deployment/service/ingress CRUD methods"
```

---

### Task 4: Add webui_url to models

**Files:**
- Modify: `admin/backend/models.py:160-177` (AgentDetailResponse)

- [ ] **Step 1: Add webui_url field**

In `AgentDetailResponse`, add after `ingress_path`:

```python
    webui_url: Optional[str] = None
```

- [ ] **Step 2: Commit**

```bash
git add admin/backend/models.py
git commit -m "feat(models): add webui_url to AgentDetailResponse"
```

---

### Task 5: Integrate WebUI creation in agent_manager

**Files:**
- Modify: `admin/backend/agent_manager.py:369-381` (ingress step — remove /ops path)
- Modify: `admin/backend/agent_manager.py:390-398` (add webui creation step)

- [ ] **Step 1: Remove /agentN/ops ingress path from create**

In `create_agent()`, find the Step 4 Ingress block (around line 376-381). Remove the second `add_ingress_path` call for ops:

```python
            # Remove this line:
            await self.k8s.add_ingress_path(
                path=f"/agent{agent_num}/ops", service_name=name, service_port=6060,
            )
```

Only keep the gateway path:
```python
            await self.k8s.add_ingress_path(
                path=f"/agent{agent_num}", service_name=name, service_port=8642,
            )
```

- [ ] **Step 2: Add WebUI creation step after Ingress step**

After the Ingress step (after the try/except block for Step 4), before the "Wait for ready" step, add:

```python
        # Step 4b: Create standalone WebUI
        step_webui = CreateStepStatus(step=5, label="Creating WebUI", status="running")
        steps.append(step_webui)
        webui_name = f"hermes-webui-{agent_num}"
        try:
            webui_deploy = self.templates.render_webui_deployment(agent_num, secret_name)
            webui_svc = self.templates.render_webui_service(agent_num)
            webui_ing = self.templates.render_webui_ingress(agent_num)
            await self.k8s.create_webui_deployment(webui_deploy)
            await self.k8s.create_webui_service(webui_svc)
            await self.k8s.create_webui_ingress(webui_ing)
            step_webui.status = "done"
        except Exception as e:
            step_webui.status = "failed"
            step_webui.message = str(e)
            logger.warning("WebUI creation failed for agent %s: %s", agent_num, e)
```

Note: WebUI failure is non-fatal — the gateway still works without it.

- [ ] **Step 3: Update step numbering**

The existing "Wait for ready" step has `step=6`. Renumber it to `step=6` (it comes after webui step 5). No code change needed if step numbers are sequential labels.

- [ ] **Step 4: Commit**

```bash
git add admin/backend/agent_manager.py
git commit -m "feat(agent_manager): integrate standalone WebUI creation"
```

---

### Task 6: Integrate WebUI cleanup in delete_agent

**Files:**
- Modify: `admin/backend/agent_manager.py:464-493` (delete_agent)

- [ ] **Step 1: Add WebUI resource cleanup**

In `delete_agent()`, after removing the gateway ingress path (line 477), add webui cleanup:

```python
        # Clean up standalone WebUI resources (best-effort)
        webui_name = f"hermes-webui-{agent_id}"
        for cleanup_fn, resource in [
            (self.k8s.delete_webui_ingress, webui_name),
            (self.k8s.delete_webui_service, webui_name),
            (self.k8s.delete_webui_deployment, webui_name),
        ]:
            try:
                await cleanup_fn(resource)
            except Exception as e:
                logger.warning("Failed to delete WebUI %s %s: %s", resource, cleanup_fn.__name__, e)
```

- [ ] **Step 2: Commit**

```bash
git add admin/backend/agent_manager.py
git commit -m "feat(agent_manager): clean up standalone WebUI on agent delete"
```

---

### Task 7: Populate webui_url in agent responses

**Files:**
- Modify: `admin/backend/agent_manager.py` (find where AgentDetailResponse is constructed)

- [ ] **Step 1: Find AgentDetailResponse construction**

Search for where `AgentDetailResponse` is instantiated (likely in a `_build_detail_response` or similar helper). Add:

```python
        cluster_ip = os.environ.get("CLUSTER_IP", "172.32.153.184")
        nip = cluster_ip.replace(".", "-")
        webui_url = f"http://agent{agent_number}.{nip}.nip.io"
```

And pass `webui_url=webui_url` to the `AgentDetailResponse()` constructor.

- [ ] **Step 2: Commit**

```bash
git add admin/backend/agent_manager.py
git commit -m "feat(agent_manager): populate webui_url in agent detail response"
```

---

### Task 8: Update frontend to use webui_url

**Files:**
- Modify: `admin/frontend/src/lib/admin-api.ts` (add webui_url to type)
- Modify: `admin/frontend/src/pages/AgentDetailPage.tsx` (update ops-panel link)

- [ ] **Step 1: Add webui_url to API type**

In `admin-api.ts`, find the `AgentDetail` interface (or equivalent type) and add:

```typescript
  webui_url?: string;
```

- [ ] **Step 2: Update AgentDetailPage ops-panel link**

In `AgentDetailPage.tsx`, find where the ops-panel/WebUI link is constructed. It likely uses something like `${agent.url_path}/ops/`. Change it to use `agent.webui_url` when available, with a fallback:

```typescript
const webuiUrl = agent.webui_url || `${window.location.origin}${agent.url_path}/ops/`;
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent/admin/frontend
npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent
git add admin/frontend/src/lib/admin-api.ts admin/frontend/src/pages/AgentDetailPage.tsx
git commit -m "feat(frontend): use webui_url for standalone ops-panel link"
```

---

### Task 9: Build, deploy, and verify

- [ ] **Step 1: Build admin Docker image**

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-agent/admin
DOCKER_BUILDKIT=1 docker build -f backend/Dockerfile --build-context tools=../tools --build-context optional-skills=../optional-skills -t hermes-admin:latest .
```

Expected: Build succeeds

- [ ] **Step 2: Import image and restart admin**

```bash
docker save hermes-admin:latest | sudo ctr -n k8s.io images import -
kubectl rollout restart deployment/hermes-admin -n hermes-agent
kubectl rollout status deployment/hermes-admin -n hermes-agent --timeout=60s
```

Expected: Admin deployment ready

- [ ] **Step 3: Test create agent with standalone WebUI**

```bash
# Create a test agent (agent 6)
curl -s -X POST -H "X-Admin-Key: Abcd@123" -H "Content-Type: application/json" \
  http://172.32.153.184:40080/admin/api/agents \
  -d '{"display_name":"test-webui","llm_config":{"provider":"openrouter","api_key":"test-key"}}' | python3 -m json.tool
```

Expected: Agent created with `webui_url` in response

- [ ] **Step 4: Verify K8s resources**

```bash
# Check gateway deployment has only 2 containers
kubectl get deployment hermes-gateway-6 -n hermes-agent -o jsonpath='{.spec.template.spec.containers[*].name}'
# Expected: gateway dashboard

# Check standalone webui deployment exists
kubectl get deployment hermes-webui-6 -n hermes-agent
# Expected: 1/1 ready

# Check webui ingress
kubectl get ingress hermes-webui-6 -n hermes-agent
# Expected: host=agent6.172-32-153-184.nip.io
```

- [ ] **Step 5: Test WebUI access**

```bash
# Test WebUI health
curl -s -o /dev/null -w "%{http_code}" http://agent6.172-32-153-184.nip.io/health
# Expected: 200

# Test root page loads
curl -s -o /dev/null -w "%{http_code}" http://agent6.172-32-153-184.nip.io/
# Expected: 200

# Verify no 404 on assets
curl -s -o /dev/null -w "%{http_code}" http://agent6.172-32-153-184.nip.io/assets/js/index-BZaYumI9.js
# Expected: 200 (or 404 if filename changed — any JS file should return 200)
```

- [ ] **Step 6: Test delete agent cleans up WebUI**

```bash
curl -s -X DELETE -H "X-Admin-Key: Abcd@123" "http://172.32.153.184:40080/admin/api/agents/6?backup=false"
# Then verify:
kubectl get deployment,svc,ingress -l app=hermes-webui-6 -n hermes-agent
# Expected: No resources found
```

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: standalone WebUI deployment with host-based Ingress"
```
