#!/bin/sh
# init-claude-code.sh
# 容器启动时从 hermes config.yaml 读取 custom_providers 配置，
# 动态生成 Claude Code (~/.claude/settings.json) 配置文件。
# 这样用户在终端直接运行 claude 时能自动使用正确的 API key 和 base URL。

# 不要用 set -e，初始化脚本失败不应阻止服务启动
set +e

# 确保 TERM 有值（Claude Code 等编程工具需要终端类型标识才能正常输出）
export TERM="${TERM:-xterm-256color}"
# 禁用 Claude Code 遥测，防止 --version 等命令因 Statsig 初始化失败而退出
export DISABLE_TELEMETRY="${DISABLE_TELEMETRY:-1}"
export DISABLE_ERROR_REPORTING="${DISABLE_ERROR_REPORTING:-1}"

HERMES_HOME="${HERMES_HOME:-/home/agent/.hermes}"
CLAUDE_DIR="${HOME}/.claude"

# 确保目录存在且属主正确（init container 以 root 运行，主容器以 hermes 运行）
mkdir -p "$CLAUDE_DIR" 2>/dev/null || true

# 查找 hermes config.yaml：优先 active profile，其次 default
find_config() {
  # 1. active profile 链接
  if [ -L "${HERMES_HOME}/profiles/active" ]; then
    _active=$(readlink -f "${HERMES_HOME}/profiles/active" 2>/dev/null || true)
    if [ -f "${_active}/config.yaml" ]; then
      echo "${_active}/config.yaml"
      return
    fi
  fi

  # 2. developer profile
  if [ -f "${HERMES_HOME}/profiles/developer/config.yaml" ]; then
    echo "${HERMES_HOME}/profiles/developer/config.yaml"
    return
  fi

  # 3. default profile
  if [ -f "${HERMES_HOME}/profiles/default/config.yaml" ]; then
    echo "${HERMES_HOME}/profiles/default/config.yaml"
    return
  fi

  # 4. 根目录 config.yaml
  if [ -f "${HERMES_HOME}/config.yaml" ]; then
    echo "${HERMES_HOME}/config.yaml"
    return
  fi
}

CONFIG_FILE=$(find_config)

if [ -z "$CONFIG_FILE" ]; then
  echo "[init-claude-code] No hermes config.yaml found, skipping Claude Code init"
  exit 0
fi

echo "[init-claude-code] Reading config from: $CONFIG_FILE"

# 用 python3 解析 YAML，提取第一个 custom_provider 的信息
RESULT=$(python3 -c "
import yaml, sys, json
try:
    with open('$CONFIG_FILE') as f:
        cfg = yaml.safe_load(f) or {}
    providers = cfg.get('custom_providers', [])
    if not providers:
        model_cfg = cfg.get('model', {})
        provider_str = model_cfg.get('provider', '')
        print(json.dumps({'found': False}))
        sys.exit(0)
    p = providers[0]
    print(json.dumps({
        'found': True,
        'api_key': p.get('api_key', ''),
        'base_url': p.get('base_url', ''),
        'model': cfg.get('model', {}).get('default', '') or p.get('model', 'gpt-4'),
    }))
except Exception as e:
    print(json.dumps({'found': False, 'error': str(e)}))
" 2>/dev/null)

if [ -z "$RESULT" ]; then
  echo "[init-claude-code] Failed to parse config.yaml"
  exit 0
fi

FOUND=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('found', False))")

if [ "$FOUND" != "True" ]; then
  echo "[init-claude-code] No custom_providers found in config, skipping"
  exit 0
fi

API_KEY=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('api_key', ''))")
BASE_URL=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('base_url', ''))")
MODEL=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('model', ''))")

if [ -z "$API_KEY" ] || [ -z "$BASE_URL" ]; then
  echo "[init-claude-code] Missing api_key or base_url, skipping"
  exit 0
fi

# 生成 Claude Code settings.json
DISPLAY_MODEL=$(echo "$MODEL" | sed 's/^./\U&/' | sed 's/-/ /g')
cat > "${CLAUDE_DIR}/settings.json" <<SETTINGS_EOF
{
  "model": "${MODEL}",
  "env": {
    "ANTHROPIC_API_KEY": "${API_KEY}",
    "ANTHROPIC_BASE_URL": "${BASE_URL}",
    "ANTHROPIC_MODEL": "${MODEL}",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "${MODEL}",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "${DISPLAY_MODEL}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${MODEL}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "${DISPLAY_MODEL}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${MODEL}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "${DISPLAY_MODEL}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${MODEL}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "${DISPLAY_MODEL}"
  }
}
SETTINGS_EOF

# 生成 Claude credentials（跳过 OAuth）
echo '{}' > "${CLAUDE_DIR}/.credentials.json"

# 生成空 MCP 配置（写到 .claude 目录内，/home/agent 可能不可写）
echo '{"mcpServers":{}}' > "${CLAUDE_DIR}/mcp.json" 2>/dev/null || true

# 将 primaryApiKey 写入 ~/.claude.json，使 Claude Code 交互模式也能识别 API key
# Claude Code v1.x 的 KX() 函数在交互模式下会跳过 ANTHROPIC_API_KEY 环境变量，
# 转而读取 vJ1() → X0() → ~/.claude.json 的 primaryApiKey 字段。
# 虽然我们已通过 Dockerfile sed patch 修复了 KX()，但这里是双保险。
CLAUDE_JSON="${HOME}/.claude.json"
python3 -c "
import json, os
path = '$CLAUDE_JSON'
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception:
        data = {}
data['primaryApiKey'] = '$API_KEY'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
" 2>/dev/null || true

echo "[init-claude-code] Claude Code configured: model=${MODEL}, base_url=${BASE_URL}"
