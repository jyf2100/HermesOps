---
name: codex-responses-api-incompatibility
description: Codex v0.84+ 仅支持 Responses API（wire_api = "responses"），与 LiteLLM 的 Anthropic handler 不兼容。tools 格式差异导致 KeyError: 'function'。
metadata:
  type: reference
  originSessionId: 254891ec-767b-4cab-966f-2722082f33be
---

# Codex Responses API 与 LiteLLM 不兼容

## 问题

Codex v0.136.0（2026-06）仅支持 `wire_api = "responses"`。Responses API 的 tools 格式将 `name`/`parameters` 放在顶层：

```json
{"type": "function", "name": "exec_command", "parameters": {...}}
```

而 LiteLLM 使用 Anthropic handler 处理时，期望 Chat Completions 格式：

```json
{"type": "function", "function": {"name": "exec_command", "parameters": {...}}}
```

导致 `KeyError: 'function'` → HTTP 500 → 30s 重试延迟。

## Why

- OpenAI 于 2026-02 彻底移除了 `wire_api = "chat"`，仅保留 `"responses"`
- LiteLLM 对非 OpenAI 模型默认使用 Anthropic handler，该 handler 硬编码访问 `tool["function"]`
- 社区在 [GitHub Discussion #7782](https://github.com/openai/codex/discussions/7782) 普遍报告此问题

## How to apply

- **Codex + LiteLLM 不可用** — 需要原生支持 Responses API 的模型服务
- 兼容的服务：OpenAI 官方 API、LM Studio 0.3.39+、llama.cpp server
- 社区解决方案：[VibeAround API Bridge](https://github.com/jazzenchen/VibeAround) 可做格式转换代理

## apps MCP 修复

内置的 `codex_apps` MCP 硬编码连接 `chatgpt.com:443`（HTTPS），不受任何配置影响。
通过 K8s `hostAliases` 将 `chatgpt.com` 解析到 `127.0.0.1`，使连接在 0.092s 内失败（fast-fail），
避免了 30s 超时。7 个 deployment 都已配置：

```bash
for i in 1 2 3 4 5 6 7; do
  kubectl patch deployment "hermes-gateway-$i" -n hermes-agent --type=json -p \
    '[{"op":"add","path":"/spec/template/spec/hostAliases","value":[
      {"ip":"127.0.0.1","hostnames":["chatgpt.com","chatgpt-staging.com"]},
      {"ip":"::1","hostnames":["chatgpt.com","chatgpt-staging.com"]}
    ]}]'
done
```

## 调试关键发现

1. `chatgpt_base_url` 只影响部分功能（plugin sync），**不影响** apps MCP 的 URL
2. apps MCP 的 URL 是在 Rust 二进制中硬编码的（`codex-mcp/src/mcp/mod.rs`）
3. `rmcp::transport::worker` 错误是 apps MCP 的，"Reconnecting... 1/5" 来自 `codex_core::responses_retry`（模型 API 重试）
4. 30s 延迟实际来自模型 API 返回 HTTP 500 的重试，不是 apps MCP 超时

## 相关文件

- `scripts/init-coding-tools.sh` — Codex config.toml 生成
- `packages/server/src/routes/health.ts` — MCP mock 端点
