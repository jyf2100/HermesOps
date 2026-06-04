---
name: claude-code-connectivity-fix
description: Claude Code v1.x 在受限网络中因硬编码连通性检查 URL 无法启动的修复方案，以及 K8s 部署时镜像标签不匹配的排障经验
metadata: 
  node_type: memory
  type: reference
  originSessionId: 254891ec-767b-4cab-966f-2722082f33be
---

# Claude Code 连通性检查修复

## 问题

Claude Code v1.x（Node.js 脚本）启动时 `qv6()` 函数会 GET 两个硬编码 URL：
- `https://api.anthropic.com/api/hello`
- `https://console.anthropic.com/v1/oauth/hello`

这些 URL **完全忽略** `ANTHROPIC_BASE_URL`、`CLAUDE_CODE_USE_BEDROCK` 等环境变量。在受限网络中请求失败后 100ms 调用 `process.exit(1)`。

## 修复方案（两处改动）

### 1. 服务端添加 /api/hello 端点（`packages/server/src/routes/health.ts`）

```typescript
healthRoutes.get('/api/hello', (ctx: any) => {
  ctx.body = { status: 'ok' }
})
```

这个路由注册在 `healthRoutes` 中，而 `healthRoutes` 在 `index.ts` 中位于 auth 中间件之前（公开路由），所以不需要认证。

### 2. Dockerfile 中 sed 替换 cli.js 硬编码 URL

```dockerfile
RUN CLI_JS="$(npm root -g)/@anthropic-ai/claude-code/cli.js" \
    && sed -i 's|https://api.anthropic.com/api/hello|http://127.0.0.1:6060/api/hello|g' "$CLI_JS" \
    && sed -i 's|https://console.anthropic.com/v1/oauth/hello|http://127.0.0.1:6060/api/hello|g' "$CLI_JS"
```

## K8s 部署排障经验

**根因**：deployment 使用镜像标签 `20260601l`（4.8 GiB），而包含改动的镜像是 `latest`/`20260601`（4.9 GiB）。Pod 的 imageID 与两者都不匹配。

**教训**：
- `kubectl set image deployment/... gateway=ekkoye8888/hermes-web-ui:latest` 确保所有 deployment 使用同一标签
- containerd 导入前必须先 `ctr -n k8s.io images rm` 旧标签
- 验证时要在容器内确认：`grep -c "api/hello" dist/server/index.js` 和 `grep -c "127.0.0.1:6060" cli.js`
- `$(npm root -g)` 在 `kubectl exec` 中会被本地 shell 解析，必须用 `sh -c 'npm root -g'` 避免本地展开

## 验证

```bash
# 容器内验证 /api/hello 端点
kubectl exec -n hermes-agent deployment/hermes-gateway-1 -- sh -c 'wget -qO- http://127.0.0.1:6060/api/hello'
# 预期: {"status":"ok"}

# Claude Code 启动测试
kubectl exec -n hermes-agent deployment/hermes-gateway-1 -- sh -c 'TERM=xterm-256color DISABLE_TELEMETRY=1 claude --version'
# 预期: 1.0.128 (Claude Code)  — 之前会因连通性检查失败而退出
```

## 交互模式登录问题（KX() 函数）

### 问题

Claude Code v1.x 的 `KX()` 函数（API key 解析器）在交互模式下行为：
1. `if(Ga0()&&process.env.ANTHROPIC_API_KEY)` — `Ga0()` 在交互模式返回 false，跳过环境变量
2. 依次检查 approved list → file descriptor → API key helper → OAuth
3. `vJ1()` 读取 `~/.claude.json` 的 `primaryApiKey` 字段
4. 全部为空时返回 `{key:null, source:"none"}` → 触发 "Please run /login"

### 修复方案（两处改动）

#### 1. Dockerfile sed patch（主要修复）

```dockerfile
# 移除 Ga0() 守卫，让 ANTHROPIC_API_KEY 在所有模式下都生效
RUN CLI_JS="$(npm root -g)/@anthropic-ai/claude-code/cli.js" \
    && sed -i 's|if(Ga0()&&process.env.ANTHROPIC_API_KEY)|if(process.env.ANTHROPIC_API_KEY)|g' "$CLI_JS"
```

#### 2. init-coding-tools.sh 双保险

在 `~/.claude.json` 中写入 `primaryApiKey`，即使 sed patch 失效也能通过 vJ1() 路径找到 key：

```bash
python3 -c "
import json, os
path = os.path.expanduser('~/.claude.json')
data = {}
if os.path.exists(path):
    with open(path) as f: data = json.load(f)
data['primaryApiKey'] = '${API_KEY}'
with open(path, 'w') as f: json.dump(data, f, indent=2)
"
```

### 关键函数调用链

```
KX() → Ga0() [isNonInteractiveSession] → false in interactive
     → customApiKeyResponses.approved [空]
     → OT0() [file descriptor] → null
     → vJ1() → X0() → ~/.claude.json → primaryApiKey [空/有值]
     → {key:null} → "Please run /login"
```

## 相关文件

- `packages/server/src/routes/health.ts` — /api/hello 端点
- `packages/server/src/routes/index.ts` — 路由注册顺序（healthRoutes 在 auth 之前）
- `Dockerfile` — 两处 sed patch（连通性检查 + KX() Ga0() 守卫）
- `scripts/init-coding-tools.sh` — ~/.claude.json primaryApiKey 写入
