---
name: claude-code-container-localization
description: |
  将 Claude Code v1.x 部署到受限网络/Docker/K8s 环境的完整本地化方案。
  解决三大核心问题：(1) 硬编码连通性检查 URL 导致启动失败，
  (2) 交互模式下 ANTHROPIC_API_KEY 被忽略要求 login，
  (3) 运行时配置（API key、base URL、模型）动态注入。
  Use when: 在无法直连 api.anthropic.com 的环境中部署 Claude Code，
  或 Claude Code 在容器中要求 login 但已配置 API key。
author: Claude Code
version: 1.0.0
date: 2026-06-02
---

# Claude Code v1.x 容器化本地化指南

## Problem

Claude Code v1.x（Node.js 脚本版）在受限网络容器中有三个致命问题：

1. **启动连通性检查硬编码 `api.anthropic.com`** — 请求失败后 100ms 调用 `process.exit(1)`
2. **交互模式忽略 `ANTHROPIC_API_KEY` 环境变量** — 弹出 "Please run /login"
3. **配置文件路径混乱** — `settings.json` vs `.claude.json` vs `.credentials.json` 用途各异

## Architecture: Claude Code v1.x 关键函数

### API Key 解析链 (`KX()` 函数)

```
KX() → Ga0() [isNonInteractiveSession]
  if Ga0() && ANTHROPIC_API_KEY → 仅 --print 模式走这条路
  ↓ (交互模式跳过)
  customApiKeyResponses.approved → 需要 last-20-chars 匹配
  ↓ (通常为空)
  OT0() [file descriptor key] → null
  ↓
  vJ1() → X0() → ~/.claude.json → primaryApiKey
  ↓ (通常为空)
  {key:null, source:"none"} → 触发 "Please run /login"
```

**关键发现**: `Ga0()` 返回 `rA.isNonInteractiveSession && rA.clientType !== "claude-vscode"`，
交互模式下为 `false`，导致 `ANTHROPIC_API_KEY` 环境变量被完全跳过。

### 连通性检查 (`qv6()` 函数)

```
qv6() → GET https://api.anthropic.com/api/hello
      → GET https://console.anthropic.com/v1/oauth/hello
      → 任一失败 → setTimeout(() => process.exit(1), 100)
```

这两个 URL **完全忽略** `ANTHROPIC_BASE_URL`、`CLAUDE_CODE_USE_BEDROCK` 等环境变量。

### 配置文件路径映射

| 文件 | 路径 | 读取函数 | 内容 |
|------|------|----------|------|
| `settings.json` | `~/.claude/settings.json` | `--settings` 参数 | model, env (API key, base URL) |
| `.claude.json` | `~/.claude.json` | `X0()` via `sJ()` | primaryApiKey, installMethod, theme |
| `.credentials.json` | `~/.claude/.credentials.json` | OAuth 流程 | OAuth token |
| `mcp.json` | `~/.claude/mcp.json` | `--mcp-config` | MCP 服务器配置 |

**陷阱**: `--settings` 指定的 `settings.json` 和 `X0()` 读取的 `.claude.json` 是**完全不同的文件**。
Web UI 通过 `--settings` 传入 model 和 env，但 `KX()` 函数根本不看 `settings.json`，它看的是 `.claude.json`。

## Solution: 三层修复

### 修复 1: Dockerfile sed patch — 连通性检查重定向

**服务端**: 添加 `/api/hello` 公开端点（在 auth 中间件之前注册）：

```typescript
// packages/server/src/routes/health.ts
healthRoutes.get('/api/hello', (ctx: any) => {
  ctx.body = { status: 'ok' }
})
```

**Dockerfile**: 在构建阶段 sed 替换硬编码 URL：

```dockerfile
RUN CLI_JS="$(npm root -g)/@anthropic-ai/claude-code/cli.js" \
    && sed -i 's|https://api.anthropic.com/api/hello|http://127.0.0.1:6060/api/hello|g' "$CLI_JS" \
    && sed -i 's|https://console.anthropic.com/v1/oauth/hello|http://127.0.0.1:6060/api/hello|g' "$CLI_JS" \
    && echo "[patch] Claude Code connectivity check redirected to localhost"
```

### 修复 2: Dockerfile sed patch — KX() Ga0() 守卫移除

```dockerfile
# 移除 Ga0() 交互模式守卫，让 ANTHROPIC_API_KEY 在所有模式下直接生效
RUN CLI_JS="$(npm root -g)/@anthropic-ai/claude-code/cli.js" \
    && sed -i 's|if(Ga0()&&process.env.ANTHROPIC_API_KEY)|if(process.env.ANTHROPIC_API_KEY)|g' "$CLI_JS" \
    && echo "[patch] Claude Code interactive mode uses ANTHROPIC_API_KEY directly"
```

### 修复 3: init-coding-tools.sh — 运行时配置注入

容器启动时从 hermes `config.yaml` 读取 API key 和 base URL，写入三个位置：

```bash
#!/bin/sh
# 1. settings.json — Web UI --settings 参数使用
cat > "${CLAUDE_DIR}/settings.json" <<EOF
{
  "model": "${MODEL}",
  "env": {
    "ANTHROPIC_API_KEY": "${API_KEY}",
    "ANTHROPIC_BASE_URL": "${BASE_URL}",
    "ANTHROPIC_MODEL": "${MODEL}",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "${MODEL}"
  }
}
EOF

# 2. .credentials.json — 空 JSON 跳过 OAuth
echo '{}' > "${CLAUDE_DIR}/.credentials.json"

# 3. ~/.claude.json — primaryApiKey（KX() 的 vJ1() 路径）
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

### 修复 4: init-coding-tools.sh — Codex model-catalog.json 生成

`config.toml` 中 `model_catalog_json` 引用的文件必须存在，否则 Codex 报错
`"Error loading configuration: No such file or directory (os error 2)"`：

```bash
# 生成 Codex model-catalog.json（格式与 TypeScript buildCodexModelCatalog() 兼容）
python3 -c "
import json
model = '${MODEL}'
catalog = {
    'models': [{
        'slug': model,
        'display_name': model[0].upper() + model[1:].replace('-', ' '),
        'description': model,
        'default_reasoning_level': 'medium',
        'supported_reasoning_levels': [
            {'effort': 'low', 'description': 'Fast responses with lighter reasoning'},
            {'effort': 'medium', 'description': 'Balances speed and reasoning depth'},
            {'effort': 'high', 'description': 'Greater reasoning depth for complex problems'},
            {'effort': 'xhigh', 'description': 'Extra high reasoning depth'},
        ],
        'context_window': 256000,
        'max_context_window': 256000,
        'base_instructions': 'You are Codex, a coding agent. Be precise, safe, and helpful.',
        # ... 完整字段见 init-coding-tools.sh
    }]
}
with open('${CODEX_DIR}/model-catalog.json', 'w') as f:
    json.dump(catalog, f, indent=2)
"
```

### 环境变量设置

```dockerfile
# Dockerfile 中必须设置的环境变量
ENV TERM=xterm-256color                    # Claude Code 需要终端类型
ENV DISABLE_TELEMETRY=1                    # 防止 Statsig 初始化失败
ENV DISABLE_ERROR_REPORTING=1              # 防止错误上报阻塞启动
ENV HOME=/home/agent                       # 明确 HOME 路径
```

## Verification Checklist

### 容器内验证

```bash
# 1. 版本号（不应因连通性检查失败而退出）
kubectl exec -n NS deployment/DEPLOY -- sh -c \
  'TERM=xterm-256color DISABLE_TELEMETRY=1 claude --version'
# 预期: 1.0.128 (Claude Code)

# 2. 连通性检查端点
kubectl exec -n NS deployment/DEPLOY -- \
  wget -qO- http://127.0.0.1:6060/api/hello
# 预期: {"status":"ok"}

# 3. sed patch 验证
kubectl exec -n NS deployment/DEPLOY -- sh -c \
  'grep -c "127.0.0.1:6060" "$(npm root -g)/@anthropic-ai/claude-code/cli.js"'
# 预期: >= 2

# 4. Ga0() 守卫已移除
kubectl exec -n NS deployment/DEPLOY -- sh -c \
  'grep -c "if(Ga0()&&process.env.ANTHROPIC_API_KEY)" "$(npm root -g)/@anthropic-ai/claude-code/cli.js"'
# 预期: 0

# 5. primaryApiKey 已写入
kubectl exec -n NS deployment/DEPLOY -- python3 -c "
import json
with open('/home/agent/.claude.json') as f:
    print('primaryApiKey' in json.load(f))
"
# 预期: True

# 6. --print 模式测试
kubectl exec -n NS deployment/DEPLOY -- sh -c \
  'DISABLE_TELEMETRY=1 claude --print "say hi"'
# 预期: 返回 AI 回复，不是 "Please run /login"
```

### 注意事项

- `$(npm root -g)` 在 `kubectl exec` 中会被**本地 shell** 解析，必须用 `sh -c '...'`
- containerd 导入前必须先 `ctr -n k8s.io images rm` 旧标签
- 验证时对比 image digest 而非版本号（镜像可能已更新但版本号不变）
- `npm install -g` 以 root 执行，运行时用户需要读权限

## Troubleshooting

| 症状 | 根因 | 解决 |
|------|------|------|
| `claude --version` 无输出或退出码 1 | 连通性检查失败 | 确认 sed patch 1 + /api/hello 端点 |
| "Please run /login" | KX() 未找到 API key | 确认 sed patch 2 + primaryApiKey |
| Statsig 初始化失败 | 网络不通 + 遥测未禁用 | 设置 DISABLE_TELEMETRY=1 |
| `EACCES: permission denied` | npm global 目录权限 | 以 root 构建，或 chown |
| 环境变量不生效 | `--settings` vs `.claude.json` 混淆 | 两者都要写入 |
| containerd 不更新镜像 | 旧标签未删除 | 先 `ctr images rm` 再 `import` |
| `$(npm root -g)` 解析错误 | 本地 shell 展开 | 用 `sh -c 'npm root -g'` |
| Codex "Error loading configuration: No such file or directory" | config.toml 引用的 model-catalog.json 未生成 | init-coding-tools.sh 添加 model-catalog.json 生成 |

## 版本适配

此方案针对 **Claude Code v1.x**（Node.js 脚本，通过 `npm install -g` 安装）。
v2.x 是编译二进制，在容器 PTY 环境下可能无法正常运行。

锁定版本：
```dockerfile
RUN npm install -g @anthropic-ai/claude-code@^1.0.0
```

如果上游更新了 minified 代码中的函数名（如 `KX`、`Ga0`、`qv6`、`vJ1`），
sed patch 需要相应更新。建议升级后重新执行验证清单。

## References

- Claude Code v1.x cli.js — minified, 函数名可能随版本变化
- `packages/server/src/routes/health.ts` — /api/hello 端点
- `Dockerfile` — 两处 sed patch
- `scripts/init-coding-tools.sh` — 运行时配置注入

## See Also

- `minified-js-deploy-verification` — 验证 minified JS 中的代码修改
- `k8s-containerd-image-sync` — containerd 镜像同步问题
- `k8s-container-patch-ephemeral` — 运行时 patch 会在重启后丢失
