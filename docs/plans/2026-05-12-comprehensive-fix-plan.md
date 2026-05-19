# 全面修复方案 — 停止反复出问题

> 三组专家并行审计结果汇总：K8s manifests（10个问题）、后端代码（15个问题）、183集群
> 日期：2026-05-12

## 必须立即修复（CRITICAL — 会导致功能崩溃或安全问题）

### C1. Ingress path 序列化崩溃
**文件**: `admin/backend/k8s_client.py:252`
**症状**: 创建代理时 `add_ingress_path` 会以 `AttributeError: 'dict' object has no attribute 'to_dict'` 崩溃
**原因**: `paths` 是 `V1HTTPIngressPath` 强类型对象列表，但 `new_path_rule` 是普通 dict。append 混合类型后 K8s client 序列化失败。
**修复**:
```python
# 将 new_path_rule 改为强类型对象
from kubernetes.client import V1HTTPIngressPath, V1HTTPIngressRuleValue, V1HTTPIngressBackend, V1IngressServiceBackendPort, V1IngressBackend

new_path_rule = V1HTTPIngressPath(
    path=f"{path}(/|$)(.*)",
    path_type="Prefix",
    backend=V1IngressBackend(
        service=V1IngressServiceBackend(
            name=service_name,
            port=V1IngressServiceBackendPort(number=service_port),
        )
    ),
)
```

### C2. `_config_mgr` 属性名不匹配
**文件**: `admin/backend/agent_manager.py:656`
**症状**: `test_agent_api` 方法中 model 始终默认为 "test"，静默错误
**原因**: 构造函数第44行存为 `self.config_mgr`（无下划线），第656行引用 `self._config_mgr`（有下划线）
**修复**:
```python
# 第656行: 改为正确的属性名
cfg = self.config_mgr.read_config(agent_id)
```

### C3. `generate-soul-from-agent` 只查两个 API key 环境变量
**文件**: `admin/backend/profile_routes.py:925`
**症状**: 使用 Gemini/ZhipuAI/Kimi/OpenRouter 的 Agent 无法生成 soul.md，报 422 "no API key"
**原因**: 只检查 `OPENAI_API_KEY` 和 `ANTHROPIC_API_KEY`，遗漏了其他 provider 的 key
**修复**: 复用 `templates.py` 中的 `PROVIDER_KEY_MAP`
```python
from templates import PROVIDER_KEY_MAP

env_key = PROVIDER_KEY_MAP.get(provider)
if not env_key:
    raise HTTPException(422, f"Unsupported provider: {provider}")
api_key = env_raw.get(env_key) or ""
if not api_key:
    raise HTTPException(422, f"Agent {req.agent_number} has no {env_key} in .env")
```

### C4. admin key 总是明文写入磁盘
**文件**: `admin/backend/main.py:883-896`
**症状**: 即使 K8s Secret 更新成功，密钥也总是被写入 `/data/hermes/_admin/admin_key` 明文文件
**原因**: 文件回退逻辑不在 except 块内，无论 Secret 是否成功都执行
**修复**:
```python
# 将文件回退移到 except 块内
secret_ok = False
try:
    await k8s.replace_secret("hermes-admin-secret", {"admin_key": req.new_key})
    secret_ok = True
except Exception:
    try:
        await k8s.create_secret(name="hermes-admin-secret", data={"admin_key": req.new_key})
        secret_ok = True
    except Exception:
        pass

if not secret_ok:
    logger.warning("K8s Secret update failed, falling back to plaintext file")
    admin_dir = os.path.join(HERMES_DATA_ROOT, "_admin")
    os.makedirs(admin_dir, exist_ok=True)
    key_path = os.path.join(admin_dir, "admin_key")
    tmp_path = key_path + ".tmp"
    with open(tmp_path, "w") as f:
        f.write(req.new_key)
    os.replace(tmp_path, key_path)
    os.chmod(key_path, 0o600)
```

### C5. Legacy deployment.yaml 以 root 运行
**文件**: `admin/kubernetes/deployment.yaml`（根目录）
**症状**: 如果有人 `kubectl apply -f deployment.yaml`，pod 以 root 运行，无任何安全限制
**原因**: 旧版清单文件没有 securityContext
**修复**: 在文件顶部添加弃用注释，或直接删除（推荐删除）

---

## 应该修复（HIGH — 会导致间歇性问题）

### H1. Ingress 路径冲突检查误判
**文件**: `admin/backend/k8s_client.py:250`
**症状**: 创建 agent50 会因 "path already exists" 失败（因为 agent5 的路径 `/agent5(/|$)(.*)` 匹配了 `startswith("/agent50")`...不对，反过来说 `/agent50` 不匹配 `/agent5(`，但实际检查是 `p.path.startswith(path)`，即 `/agent5(/|$)(.*).startswith("/agent5")` = True，这是正确的匹配。但问题是反过来：创建 agent5 时，如果 agent50 已存在，`/agent50(/|$)(.*).startswith("/agent5")` 也是 True，会误报冲突。
**修复**:
```python
# 用更精确的前缀匹配
base_prefix = path.rstrip("/")
if p.path and (p.path == base_prefix or p.path.startswith(base_prefix + "(")):
    raise ValueError(f"Path {path} already exists in ingress")
```

### H2. deploy.sh Step 7 破坏 regex ingress
**文件**: `admin/kubernetes/deploy.sh:126-162`
**症状**: Step 7 用 `pathType: Prefix`（非 regex）的路径 patch ingress，会与 base ingress 的 `use-regex: true` 冲突
**修复**: 删除 Step 7 的整个 ingress patch 逻辑（kustomize 已在 Step 6 处理 ingress）

### H3. postgres.yaml 不在 kustomize 中
**文件**: `admin/kubernetes/base/kustomization.yaml`
**症状**: `kubectl apply -k` 不会创建数据库
**修复**: 如果需要通过 kustomize 管理，将 `postgres.yaml` 移到 `base/` 并加入 kustomization。如果由 deploy.sh 单独处理，则在 postgres.yaml 中添加注释说明

### H4. Secret 名称不匹配
**文件**: `admin/kubernetes/postgres.yaml:78` vs `admin/kubernetes/base/deployment.yaml:77`
**症状**: postgres.yaml 创建 `postgres-secret`，deployment 引用 `hermes-database-secret`
**修复**: 统一为一个名称，或明确文档说明两个 secret 的不同用途

### H5. test183 $(REDIS_PASSWORD) 变量展开顺序问题
**文件**: `admin/kubernetes/overlays/test183/patch.yaml:36`
**症状**: `$(REDIS_PASSWORD)` 引用在最终 manifest 中可能在 `REDIS_PASSWORD` env var 之前，导致展开为空
**修复**: 改用 initContainer 或在 patch 中确保 REDIS_PASSWORD 在 SWARM_REDIS_URL 之前定义

### H6. 183集群 admin 以 root 运行
**症状**: 183 上的 admin pod 没有 securityContext，以 root 运行，_admin/ 目录 root 所有
**修复**: 重新部署 base/deployment.yaml（已有 UID 10000 配置）

---

## 建议修复（MEDIUM — 改善可靠性）

### M1. hub_cache.py 默认路径过期
**文件**: `admin/backend/hub_cache.py:35`
**修复**: 默认值从 `/opt/data/hub-cache` 改为 `/data/hermes/hub-cache`

### M2. weixin.py 硬编码 UID 10000
**文件**: `admin/backend/weixin.py:195,210`
**修复**: 改为 `os.getuid()` 或从环境变量读取

### M3. create_agent 失败响应双重嵌套
**文件**: `admin/backend/main.py:405`
**修复**: `HTTPException(500, {"detail": ...})` → `HTTPException(status_code=500, detail={...})`

### M4. config_manager.py 并发写无锁
**文件**: `admin/backend/config_manager.py:38-70`
**修复**: 对同一 agent 的 .env 写操作添加 asyncio.Lock（每个 agent 一个锁）

### M5. generate-soul-from-agent 不验证 provider 是否受支持
**文件**: `admin/backend/profile_routes.py:916-921`
**修复**: 添加 `if provider not in PROVIDER_KEY_MAP: raise HTTPException(422, ...)`

### M6. K8s Secret 更新失败静默吞掉
**文件**: `admin/backend/main.py:876-881`
**修复**: 记录日志而不是 pass

---

## 修复优先级排序

1. **C1** — Ingress 序列化崩溃（每次创建 Agent 必崩）
2. **C2** — `_config_mgr` 属性名错误（测试 Agent API 静默失败）
3. **C3** — soul 生成只支持 2 个 provider（多 provider 用户受阻）
4. **C4** — admin key 明文泄露（安全问题）
5. **C5** — 删除 legacy deployment.yaml（防误用）
6. **H6** — 183 集群重新部署（安全加固）
7. **H1** — 路径冲突误判（agent 编号前缀重叠）
8. **H2-H5** — deploy.sh/manifests 清理
9. **M1-M6** — 代码质量改善

## 183 集群部署检查清单

部署到 183 前：
- [ ] 确认 184 上所有 CRITICAL 和 HIGH 修复已验证
- [ ] 构建新镜像并导入 183 containerd
- [ ] 清理 183 上的旧 hermes-admin deployment（kubectl delete deployment hermes-admin -n hermes-agent）
- [ ] 清理旧 ingress（kubectl delete ingress hermes-ingress hermes-webui -n hermes-agent 2>/dev/null）
- [ ] 应用 kustomize: `kubectl apply -k kubernetes/overlays/test183/`
- [ ] 验证 admin pod 以 UID 10000 运行
- [ ] 验证 initContainer 修复了目录权限
- [ ] 验证 hermes-agents-ingress 由代码自动创建
- [ ] 创建测试 Agent 并验证对话正常
