---
name: hermes-agent-v0-15-api-key-migration
description: hermes-agent v0.15.x 使用 custom provider 时 API key 配置方式变更
metadata: 
  node_type: memory
  type: reference
  originSessionId: 254891ec-767b-4cab-966f-2722082f33be
---

# hermes-agent v0.15.x API Key 配置变更

## 问题

hermes-agent 从 v0.13.0 升级到 v0.15.1 后，`provider: custom` 的模型调用返回 401：
```
Authentication Error, LiteLLM Virtual Key expected. Received=no-k****ired
```

## 原因

v0.15.x 不再从 `.env` 文件的 `OPENAI_API_KEY` 读取 custom provider 的 key。即使设置了 `model.api_key_env: OPENAI_API_KEY` 也不生效。

## 修复

在每个 profile 的 `config.yaml` 中添加 `custom_providers` 列表，直接嵌入 `api_key`：

```yaml
model:
  default: glm-4.7
  provider: custom
  base_url: http://100.105.228.5:4000

custom_providers:
- name: 100.105.228.5:4000
  base_url: http://100.105.228.5:4000
  api_key: sk-xxxxx
  model: glm-4.7
```

## 注意

- `hermes config set custom_providers` 会把值存成字符串而非 YAML 列表，不生效
- 必须用 python3 + yaml 模块直接编辑 config.yaml，确保 `custom_providers` 是 list 类型
- 每个有模型的 profile 都需要单独设置（default、developer、pm、tester）
- gateway 6-7 没有 key，跳过

## 相关

- [[upgrade-requirements]] — 升级需求清单
- 发现日期：2026-05-29
