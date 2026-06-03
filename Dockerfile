ARG BASE_IMAGE=nousresearch/hermes-agent:latest
FROM ${BASE_IMAGE}

ARG NODE_VERSION=24.15.0

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "amd64" ]; then NODE_ARCH="x64"; else NODE_ARCH="$ARCH"; fi \
    && echo "Downloading Node.js v${NODE_VERSION} for ${NODE_ARCH}" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz" \
       -o /tmp/node.tar.gz \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 \
    && rm -f /tmp/node.tar.gz \
    && node --version \
    && npm --version

WORKDIR /app

COPY package*.json ./
# Increase Node.js memory limit to prevent OOM during build
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN npm ci --ignore-scripts && npm rebuild node-pty

COPY . .

RUN npm run build && npm prune --omit=dev

# 预装 Claude Code（构建阶段以 root 运行，避免运行时 npm install -g 的 EACCES 问题）
# 锁定 v1.x（Node.js 脚本），v2.x 是编译二进制在容器 PTY 环境下无法正常运行
RUN npm install -g @anthropic-ai/claude-code@^1.0.0

# Patch Claude Code v1.x startup connectivity check: the check hardcodes
# api.anthropic.com URLs and ignores ANTHROPIC_BASE_URL.  In restricted
# networks the check fails and Claude Code exits immediately.
# Redirect both URLs to the local server which has a /api/hello stub.
RUN CLI_JS="$(npm root -g)/@anthropic-ai/claude-code/cli.js" \
    && sed -i 's|https://api.anthropic.com/api/hello|http://127.0.0.1:6060/api/hello|g' "$CLI_JS" \
    && sed -i 's|https://console.anthropic.com/v1/oauth/hello|http://127.0.0.1:6060/api/hello|g' "$CLI_JS" \
    && echo "[patch] Claude Code connectivity check redirected to localhost"

# Patch Claude Code KX() auth function: in interactive mode, Ga0() returns false
# causing KX() to skip ANTHROPIC_API_KEY and fall through to OAuth checks.
# Remove the Ga0() guard so ANTHROPIC_API_KEY is always used when set.
RUN CLI_JS="$(npm root -g)/@anthropic-ai/claude-code/cli.js" \
    && sed -i 's|if(Ga0()&&process.env.ANTHROPIC_API_KEY)|if(process.env.ANTHROPIC_API_KEY)|g' "$CLI_JS" \
    && echo "[patch] Claude Code interactive mode uses ANTHROPIC_API_KEY directly"

# 安装 python3-yaml 用于解析 hermes config.yaml（动态注入编程工具配置）
RUN apt-get update && apt-get install -y --no-install-recommends python3-yaml \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOME=/home/agent
ENV HERMES_HOME=/home/agent/.hermes
ENV HERMES_WEB_UI_MANAGED_GATEWAY=1
ENV PATH=/opt/hermes/.venv/bin:$PATH
# Claude Code 等编程工具需要 TERM 终端类型标识才能正常输出
ENV TERM=xterm-256color
# 禁用 Claude Code 遥测和错误上报，防止 --version 检查因 Statsig 初始化失败而返回非零退出码
ENV DISABLE_TELEMETRY=1
ENV DISABLE_ERROR_REPORTING=1

# 预创建编程工具配置目录（运行时用户 uid=10000）
# 同时确保 /home/agent 本身可写，否则 claude --version 无法创建 .claude.json
RUN mkdir -p /home/agent/.claude \
    && chown -R 10000:10000 /home/agent/.claude \
    && chown 10000:10000 /home/agent

# 启动脚本：从 hermes config.yaml 动态读取 provider 配置，注入到 claude 配置文件
COPY scripts/init-claude-code.sh /app/scripts/init-claude-code.sh
RUN chmod +x /app/scripts/init-claude-code.sh

EXPOSE 6060

# 启动时先初始化 Claude Code 配置，再启动服务
ENTRYPOINT ["/bin/sh", "-c", "/app/scripts/init-claude-code.sh && exec node dist/server/index.js"]
CMD []
