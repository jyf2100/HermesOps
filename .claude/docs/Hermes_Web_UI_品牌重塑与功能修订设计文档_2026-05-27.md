# Hermes Web UI — 品牌重塑与 UI 优化设计文档

> 版本：v0.6.4 | 日期：2026-05-29 | 作者：jyf2100

---

## 1. 概述

### 1.1 项目背景

Hermes Web UI 是一个多平台 AI 聊天系统的 Web 管理面板。基于 `/mnt/disk01/workspaces/worksummary/hermes-agent/admin` 管理面板的视觉风格参考，完成了品牌从 "Hermes" 到 "NewHermes" 的重塑、UI 清理、登录增强、硬编码颜色修复等多项改进。

> **注**：赛博朋克（Cyberpunk）主题曾在 v0.6.0 中实施，后在 v0.6.1 中移除，保留所有其他改动。本文档记录了全部变更历史。

### 1.2 需求目标

| 编号 | 目标 | 优先级 | 状态 |
|------|------|--------|------|
| R-02 | 品牌名称从 Hermes 更名为 NewHermes | P0 | ✅ 已完成 |
| R-03 | 替换品牌 Logo 和浏览器图标 | P0 | ✅ 已完成 |
| R-04 | 清理不必要的外部链接和 UI 元素 | P1 | ✅ 已完成 |
| R-05 | 确保 WCAG 2.2 AA 无障碍合规 | P1 | ✅ 已完成 |
| R-06 | Docker 镜像构建与 K8s 部署 | P0 | ✅ 已完成 |
| R-07 | K8s 远程网关模式（连接外部 gateway） | P0 | ✅ 已完成 |
| R-08 | 登录限制器可配置化 | P2 | ✅ 已完成 |
| R-09 | URL Token 自动登录 | P2 | ✅ 已完成 |
| R-10 | 硬编码暗色模式颜色修复 | P1 | ✅ 已完成 |
| R-14 | 服务端自动登录（AUTO_LOGIN） | P0 | ✅ 已完成 |
| R-11 | 侧边栏导航标签重命名 | P1 | ✅ 已完成 |
| R-12 | 移除首次登录改密提示与手动改密功能 | P1 | ✅ 已完成 |
| R-13 | 登录页密码/令牌双模式 | P2 | ✅ 已完成 |
| R-15 | 多 Profile 网关端口冲突修复 | P0 | ✅ 已完成 |
| R-16 | 新建 Profile 自动启动 Gateway | P0 | ✅ 已完成 |

### 1.3 约束条件

- 不得影响现有水墨（Ink）和漫画（Comic）主题
- 使用 CSS 自定义属性 + Naive UI GlobalThemeOverrides 架构（方案 A）
- 字体文件自托管，不依赖外部 CDN
- 构建产物体积增长不超过 5MB

---

## 2. 架构设计

### 2.1 双轴主题系统

系统采用亮度 × 风格的双轴矩阵：

```
              │  Ink   │  Comic
──────────────┼────────┼────────
Light         │   ✅   │   ❌
Dark          │   ✅   │   ✅
System(auto)  │   ✅   │   ✅
```

**核心规则：**
- 所有风格共享同一套亮度切换机制
- Comic 风格应用手绘字体和粗边框
- ThemeSwitch 在 Ink/Comic 之间切换

### 2.2 CSS 变量分层架构

```
variables.scss
│
├── :root { ... }                    ← 默认值（Ink Light）
├── .dark { ... }                    ← Ink Dark 覆盖
├── .comic { ... }                   ← Comic 特有 Token（边框、阴影、字体）
└── .dark.comic { ... }              ← Comic Dark 覆盖
    │
    ├── 基础颜色变量（~25 个）
    │   --bg-primary, --bg-secondary, --bg-card,
    │   --text-primary, --text-secondary, --text-muted,
    │   --accent-primary, ...
    │
    └── RGB 变体变量（~10 个）
        --accent-primary-rgb,
        --text-primary-rgb, ...
```

### 2.3 Naive UI 主题覆盖层

```
theme.ts
├── getThemeOverrides(isDark, isComic?)
│   ├── isDark && !isComic → 默认 dark 覆盖
│   ├── isDark && isComic  → comic 字体覆盖
│   └── !isDark            → light 覆盖
│
└── darkThemeOverrides / lightThemeOverrides
    ├── common（全局：颜色、字体、圆角）
    ├── Button（颜色）
    ├── Card（背景、边框）
    ├── Input（焦点）
    ├── Modal（背景）
    ├── DataTable（行高亮）
    ├── Tabs（指示器颜色）
    └── Tag, Switch, Tooltip, Select, Dropdown
```

### 2.4 状态管理

```
useTheme.ts
│
├── State
│   ├── brightness: 'light' | 'dark' | 'system'
│   └── style: 'ink' | 'comic'
│
├── Computed
│   ├── isDark: boolean
│   └── isComic: boolean
│
├── Persistence
│   ├── localStorage('hermes_brightness') → brightness
│   └── localStorage('hermes_style') → style
│
└── Side Effects
    ├── applyClasses() → document.documentElement.classList
    │   ├── dark class toggled by brightness
    │   └── comic class toggled by style === 'comic'
    │
    └── toggleStyle() → 'ink' | 'comic' 切换
```

---

## 3. 功能设计

### 3.1 主题切换交互

#### ThemeSwitch 组件

```
点击切换：Ink ↔ Comic

图标变化：
  Ink   → 月亮/太阳（亮度切换）
  Comic → 调色板图标
```

#### DisplaySettings 下拉选择

```
视觉风格：[水墨 ▾]
  ├── 水墨（Ink）   — 默认极简风格
  └── 漫画（Comic） — 手绘漫画风格
```

### 3.2 FOUC 防闪烁

**双重预防机制：**

```
浏览器加载流程：
  1. index.html 解析
     └── 行内 <script>（同步执行，Vue 之前）
         ├── 读取 localStorage('hermes_style')
         ├── 读取 localStorage('hermes_brightness')
         ├── 计算 isDark（system → matchMedia）
         └── 立即设置 document.documentElement.classList
             (避免白屏闪烁)
  2. main.ts 执行
     └── createApp() 之前
         └── useTheme() 初始化 → 再次确认 classList 正确
  3. Vue 挂载
     └── App 组件渲染，主题完整生效
```

---

## 4. 文件变更清单

### 4.1 修改文件

| 文件路径 | 变更类型 | 变更内容 |
|----------|----------|----------|
| `composables/useTheme.ts` | 修改 | ink/comic 两态切换 |
| `styles/variables.scss` | 修改 | CSS 变量体系（Ink/Comic） |
| `styles/theme.ts` | 修改 | Ink/Comic Naive UI 覆盖 |
| `styles/global.scss` | 修改 | Comic 字体 @font-face、全局样式 |
| `styles/code-block.scss` | 修改 | 代码块语法高亮 |
| `main.ts` | 修改 | FOUC 预防脚本 |
| `index.html` | 修改 | FOUC 脚本 + 标题改为 NewHermes |
| `components/layout/ThemeSwitch.vue` | 修改 | 两态切换 |
| `components/hermes/settings/DisplaySettings.vue` | 修改 | NSelect 下拉选择器（水墨/漫画） |
| `App.vue` | 修改 | 移除 DefaultCredentialPrompt |
| `components/layout/AppSidebar.vue` | 修改 | NewHermes 品牌名、移除中转站链接、隐藏 version-info、修复硬编码颜色、移除退出登录按钮 |
| `components/hermes/chat/ChatInput.vue` | 修改 | 硬编码颜色 → CSS 变量 |
| `components/hermes/chat/MessageList.vue` | 修改 | 硬编码颜色 → CSS 变量 |
| `components/hermes/chat/HistoryMessageList.vue` | 修改 | 硬编码颜色 → CSS 变量 |
| `components/hermes/group-chat/GroupChatInput.vue` | 修改 | 硬编码颜色 → CSS 变量 |
| `components/hermes/group-chat/GroupMessageList.vue` | 修改 | 硬编码颜色 → CSS 变量 |
| `components/hermes/chat/MessageItem.vue` | 修改 | 硬编码颜色 → CSS 变量 |
| `components/hermes/group-chat/GroupMessageItem.vue` | 修改 | 硬编码颜色 → CSS 变量 |
| `i18n/locales/*.ts`（9 个语言文件） | 追加 | styleLabel/styleInk/styleComic + 侧边栏标签重命名 |
| `public/logo.png` | 替换 | 新品牌 Logo（人物头像风格） |
| `public/favicon.ico` | 替换 | 新浏览器图标 |
| `server/services/login-limiter.ts` | 修改 | 参数可配置化 |
| `views/LoginView.vue` | 修改 | 密码/令牌双模式登录 + URL Token 自动登录 |

---

## 5. 品牌重塑规格

| 位置 | 属性 | 旧值 | 新值 |
|------|------|------|------|
| 侧边栏 Logo 文字 | AppSidebar.vue `.logo-text` | `Hermes` | `NewHermes` |
| 浏览器标签标题 | index.html `<title>` | `Hermes` | `NewHermes` |
| 浏览器标签图标 | `public/favicon.ico` | 旧 Logo | 新 Logo |
| 侧边栏 Logo 图片 | `public/logo.png` | 旧 Logo (1.8MB) | 新 Logo (72KB，人物头像风格) |

### 5.1 品牌图标更新记录

**2026-05-18 更新**：品牌图标从用户提供的微信图片重新生成。

| 文件 | 尺寸 | 来源 |
|------|------|------|
| `public/logo.png` | 256×256, 91KB | `微信图片_2026-05-15_111943_355.jpg` → ImageMagick 转换 |
| `public/favicon.ico` | 64×64 (多尺寸), 32KB | 同上源图 → ImageMagick 生成 ico |

转换命令：
```bash
SRC="微信图片_2026-05-15_111943_355.jpg"
convert "$SRC" -resize 256x256 -quality 90 public/logo.png
convert "$SRC" -resize 64x64 -define icon:auto-resize=64,48,32,16 public/favicon.ico
```

**2026-05-25 更新**：使用新的人物头像风格图片替换 logo：

```bash
convert images.jpeg -resize 256x256 -background none packages/client/public/logo.png
```

**2026-05-26 更新**：favicon 使用 ImageMagick 从 logo.png 重新生成（多尺寸 64/48/32/16）：

```bash
convert packages/client/public/logo.png -resize 64x64 \
  -define icon:auto-resize=64,48,32,16 packages/client/public/favicon.ico
```

---

## 6. UI 清理规格

### 6.1 移除"中转站"外部链接

**移除原因**：该链接指向第三方 API 中转服务（apikey.fun），不属于产品核心功能。

**移除位置**：`AppSidebar.vue`

```html
<!-- 已移除 -->
<a class="nav-item fun-link" href="https://apikey.fun/register?aff=LIBAPI" target="_blank" rel="noopener noreferrer">
  <svg>...</svg>
  <span>{{ t('sidebar.apiRelay') }}</span>
</a>
```

**保留**：`sidebar.apiRelay` i18n key 不删除（保持翻译文件完整性）。

### 6.2 隐藏左下角版本信息区域

**移除原因**：版本信息、GitHub 链接、网站链接等低频访问内容占用侧边栏空间。

**处理方式**：
- `<ThemeSwitch />` 组件移出 `<div class="version-info">` 容器
- `<div class="version-info">` 添加 `style="display:none"` 隐藏

---

## 7. 后端功能变更

### 7.1 K8s 远程网关模式（N-07）

**优先级**：P0 | **状态**：已完成

支持 WebUI 作为独立服务部署到 K8s，连接外部 gateway 而非本地启动。

#### 7.1.1 远程网关 URL

通过环境变量 `HERMES_WEB_UI_API_BASE_URL` 指定远程 gateway 地址：

```bash
HERMES_WEB_UI_API_BASE_URL=http://hermes-gateway-1:8642
```

核心实现（`gateway-manager.ts`）：

1. **`getRemoteEndpoint()`** — 解析 `HERMES_WEB_UI_API_BASE_URL` 为 `{ url, host, port }`，供多处复用
2. **`getUpstream()`** — 远程模式下直接返回远程 URL（原有逻辑，代理和健康检查均使用）
3. **`detectStatus()`** — 远程模式下对远程 URL 做 health check，返回正确的 host/port（非 127.0.0.1:8642）
4. **`listAll()`** — 远程模式下返回单个远程网关条目，跳过本地 profile 扫描

远程模式下，以下功能自动适配：
- 健康检查（`/health`）使用远程 URL
- 代理路由（`/api/hermes/v1/*`）转发到远程 gateway
- 网关状态页面（系统→网关）显示远程 gateway 的实际地址和运行状态
- Profile 网关状态（系统→用户→配置）覆盖 CLI 报告的 "stopped" 为 GatewayManager 实际远程网关状态

#### 7.1.2 认证 Token

通过环境变量 `AUTH_TOKEN` 指定 gateway API key，优先于 `.env` 文件读取：

```bash
AUTH_TOKEN=sk-xxx
```

**涉及文件**：
- `server/services/hermes/gateway-manager.ts`（+25 行）
- `server/controllers/hermes/profiles.ts`（+15 行）

### 7.2 登录限制器可配置化（N-08）

**优先级**：P2 | **状态**：已完成

将登录限速参数从硬编码改为环境变量可配置：

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| 单 IP 最大失败次数 | `LOGIN_MAX_FAILURES` | 3 | 设为 0 禁用限速 |
| 失败窗口 | `LOGIN_FAILURE_WINDOW_MIN` | 15 | 分钟 |
| 锁定时长 | `LOGIN_LOCK_MINUTES` | 60 | 分钟 |
| 全局最大失败次数 | `LOGIN_GLOBAL_MAX_FAILURES` | 50 | |
| 全局锁定时长 | `LOGIN_GLOBAL_LOCK_MINUTES` | 30 | 分钟 |

当 `LOGIN_MAX_FAILURES=0` 时，`checkPassword()` 和 `checkToken()` 直接返回 `{ allowed: true }`，跳过所有检查。

**涉及文件**：`server/services/login-limiter.ts` (+20 行)

### 7.3 服务端自动登录（N-13）

**优先级**：P0 | **状态**：已完成

通过环境变量 `AUTO_LOGIN` 启用无密码自动登录。启用后，前端访问 WebUI 时自动获取 JWT，无需手动登录。

**端点**：`GET /api/auth/auto-login`（公开，无需认证）

**行为**：
- `AUTO_LOGIN` 未设置 → `404 { error: 'Auto-login is not enabled' }`
- `AUTO_LOGIN` 已设置 → 查找第一个 active 的 super_admin 用户，签发 JWT 返回 `200 { token }`
- 无活跃用户 → `401 { error: 'No active user found' }`

**前端逻辑**（LoginView.vue setup 块）：

```
优先级：URL token 参数 > localStorage JWT > auto-login 端点
```

当 URL 无 token 且 localStorage 无 JWT 时，调用 `autoLogin()` 获取 JWT 并自动跳转聊天页面。

### 7.4 URL Token 自动登录（N-09）

**优先级**：P2 | **状态**：已完成

`LoginView.vue` 新增两种 token 登录方式：

1. **URL 参数自动登录**：当 URL 包含 `token` 参数时（如 `/login?token=sk-xxx`），页面加载后自动设置 API key 并跳转到聊天页面。自动登录后使用 `window.history.replaceState` 清除 URL 中的 token，防止泄露到浏览器历史记录。
2. **令牌登录 UI**：登录页面添加密码/令牌双模式切换标签，用户可直接粘贴 API Token 登录。

```typescript
// URL 参数自动登录（onMounted）
const tokenParam = route.query.token as string
if (tokenParam) {
  setApiKey(tokenParam)
  // 清除 URL 中的 token 参数，防止泄露
  const cleanUrl = new URL(window.location.href)
  cleanUrl.searchParams.delete('token')
  window.history.replaceState({}, '', cleanUrl.toString())
  router.replace("/hermes/chat")
}

// 令牌登录表单提交
async function handleTokenLogin() {
  if (!token.value.trim()) { errorMsg.value = t("login.tokenRequired"); return }
  setApiKey(token.value.trim())
  router.replace("/hermes/chat")
}
```

**涉及文件**：`packages/client/src/views/LoginView.vue`

### 7.5 多 Profile 网关端口冲突修复（N-14）

**优先级**：P0 | **状态**：已完成

#### 7.5.1 问题描述

WebUI 本地模式启动多个 profile 的 gateway 时，所有 profile 的 gateway 默认使用 8642 端口，导致第二个及后续 profile 的 gateway 启动失败（端口被占用）。

#### 7.5.2 解决方案

新增 `gateway-port-resolver.ts`，为每个非 default profile 自动分配独立端口并持久化。

**端口分配规则**：
- `default` profile 固定使用 8642
- 其他 profile 从 8643 起自动扫描空闲端口（范围 8642-8741）
- 分配的端口持久化到 profile 目录下的 `gateway_port.json`
- 使用内存锁（`assignmentLock`）防止并发分配冲突

**集成路径**：
- `gateway-runner.ts`：`startGatewayRunManaged()` 增加 `port` 参数，通过 `API_SERVER_PORT` 环境变量传递给 hermes gateway 进程
- `gateway-autostart.ts`：`ensureProfileGatewaysRunning()`、`restartGatewayForProfile()` 在启动前调用 `resolveAndAssignPort()` 获取端口
- `gateway-manager.ts`：`startResolved()` 在 env 中设置 `API_SERVER_PORT`

**涉及文件**：
- `packages/server/src/services/hermes/gateway-port-resolver.ts`（新增，~100 行）
- `packages/server/src/services/hermes/gateway-runner.ts`（+5 行 port 参数和验证）
- `packages/server/src/services/hermes/gateway-autostart.ts`（+3 行 import，3 处调用 resolveAndAssignPort）
- `packages/server/src/services/hermes/gateway-manager.ts`（+1 行 env.API_SERVER_PORT）

### 7.6 新建 Profile 自动启动 Gateway（N-15）

**优先级**：P0 | **状态**：已完成

#### 7.6.1 问题描述

创建新 profile 后，gateway 不会自动启动。`ensureProfileGatewaysRunning()` 仅在服务启动时执行，新建 profile 需要手动重启 gateway。

#### 7.6.2 解决方案

在 `gateway-autostart.ts` 新增 `startGatewayForNewProfile()` 函数，并在 `profiles.ts` 的 `create()` 中调用。

**流程**：
1. 检查 gateway 是否已运行（避免重复启动）
2. 解析端口（调用 `resolveAndAssignPort`）
3. 清理旧 api_server 配置（`clearApiServerForProfile`）
4. 启动 gateway（`startGatewayForProfile`）
5. 等待 gateway 就绪（`waitForGatewayRunning`，超时 15 秒）
6. 返回 `{ running, profile }` 状态

**前端响应**：
`create()` 返回增加 `gatewayStarted` 字段，方便前端显示 gateway 启动状态。

**涉及文件**：
- `packages/server/src/services/hermes/gateway-autostart.ts`（+25 行 startGatewayForNewProfile 函数）
- `packages/server/src/controllers/hermes/profiles.ts`（+1 行 import，+8 行 create 中调用）

---

### 8.1 Docker 镜像构建

```dockerfile
# 基于 hermes-agent 基础镜像
ARG BASE_IMAGE=nousresearch/hermes-agent:latest
FROM ${BASE_IMAGE}

# 安装 Node.js 23.11.0
# npm install → npm run build → npm prune --omit=dev

ENTRYPOINT ["node", "dist/server/index.js"]
EXPOSE 6060
```

### 8.2 镜像标签

| 标签 | 说明 |
|------|------|
| `ekkoye8888/hermes-web-ui:latest` | 最新版本 |
| `ekkoye8888/hermes-web-ui:20260526` | 日期标签（v0.6.1，移除赛博朋克） |
| `ekkoye8888/hermes-web-ui:20260525` | 日期标签（v0.6.0，含赛博朋克） |

### 8.3 K8s 部署

```yaml
# hermes-agent namespace
# 7 个 deployment: hermes-gateway-{1..7}
# 每个 1 副本，运行在 roc-epyc 节点
# image: docker.io/ekkoye8888/hermes-web-ui:latest
# imagePullPolicy: IfNotPresent
```

**更新流程**：

```bash
# 1. 构建镜像
docker build -t hermes-web-ui:latest .

# 2. 打标签
docker tag hermes-web-ui:latest ekkoye8888/hermes-web-ui:20260526

# 3. 导入 containerd（单节点集群）
docker save hermes-web-ui:latest | gzip > /ssd2/hermes-web-ui.tar.gz
scp /ssd2/hermes-web-ui.tar.gz root@172.32.153.184:/ssd2/
ssh root@172.32.153.184

# 在目标节点上：
# 删除旧 tag（关键步骤！）
sudo ctr -a /run/containerd/containerd.sock -n k8s.io images rm \
  docker.io/ekkoye8888/hermes-web-ui:latest
sudo ctr -a /run/containerd/containerd.sock -n k8s.io images rm \
  docker.io/ekkoye8888/hermes-web-ui:20260526

# 导入新镜像
gunzip -c /ssd2/hermes-web-ui.tar.gz | sudo ctr -a /run/containerd/containerd.sock -n k8s.io images import -

# 重新打 tag
sudo ctr -a /run/containerd/containerd.sock -n k8s.io images tag \
  docker.io/ekkoye8888/hermes-web-ui:20260526 \
  docker.io/ekkoye8888/hermes-web-ui:latest --force

# 4. 滚动重启
kubectl rollout restart deployment/hermes-gateway-{1..7} -n hermes-agent

# 5. 验证
kubectl rollout status deployment/hermes-gateway-{1..7} -n hermes-agent
```

---

## 9. 测试验证

### 9.1 功能测试

| 测试项 | 预期结果 |
|--------|----------|
| 切换到漫画主题 | 页面应用手绘字体和粗边框 |
| 刷新页面 | 无白屏闪烁（FOUC 预防） |
| 设置页下拉选择 | 两种风格可选（水墨/漫画） |
| 中转站链接 | 不显示 |
| 左下角版本信息 | 不显示 |
| ThemeSwitch | 正常显示在侧边栏底部 |
| 品牌名称 | 显示 NewHermes |
| Logo 和 favicon | 显示新图标 |
| 密码/令牌双模式登录 | 切换标签正常工作 |
| URL Token 自动登录 | 自动登录并清除 URL 中的 token |
| 登录限制器可配置 | LOGIN_MAX_FAILURES=0 跳过检查 |
| 硬编码颜色修复 | 暗色模式下聊天区域颜色跟随主题 |

### 9.2 构建验证

```bash
npm run build    # 类型检查 + Vite 构建 + 服务端构建
docker build -t hermes-web-ui:latest .   # Docker 镜像构建
```

---

## 10. 已知问题与后续计划

| 编号 | 描述 | 状态 |
|------|------|------|
| K-02 | `apiRelay` i18n key 保留在各语言文件中未清理 | 低优先级 |
| K-03 | Docker Hub 推送需手动登录后执行 | 待推送 |
| K-04 | `node-pty` rebuild 警告（平台兼容性） | 已知限制 |
| K-05 | 独立 WebUI 状态库未持久化到共享卷，Pod 重启后会话丢失 | 待修复（admin 侧加 `HERMES_WEBUI_STATE_DIR`） |
| K-06 | K8s 远程网关模式下（`HERMES_WEB_UI_API_BASE_URL` 已设置），WebUI 不启动本地 gateway，`startGatewayForNewProfile` 仅在本地模式有效 | 已知限制 |

---

## 11. 变更历史

### 11.0 2026-05-18 变更记录

#### 赛博朋克主题首次实施

从设计文档实施了赛博朋克（Cyberpunk/Synthwave）主题作为第三套可选风格。

#### 品牌图标首次更新

从用户提供的微信图片重新生成 favicon.ico 和 logo.png：

```bash
convert "微信图片_2026-05-15_111943_355.jpg" -resize 256x256 -quality 90 public/logo.png
convert "微信图片_2026-05-15_111943_355.jpg" -resize 64x64 -define icon:auto-resize=64,48,32,16 public/favicon.ico
```

#### 插件发现 shebang 解析修复

**问题**：`hermesBinPython()` 解析 hermes 二进制的 shebang 行时，`#!/usr/bin/env python3` 被错误地解析为 `/usr/bin/env`，导致执行 `/usr/bin/env -c "python code"` 报错 `invalid option -- 'c'`。

**根因**：`.split(/\s+/)[0]` 只取了第一个空格前的部分（`/usr/bin/env`），没有处理 `/usr/bin/env X` 模式。

**修复**：`packages/server/src/services/hermes/agent-bridge/manager.ts` 的 `hermesBinPython()` 函数：

```typescript
// 修复后
const parts = match[1].trim().split(/\s+/)
if (parts[0].endsWith('/env') && parts.length > 1) {
  const resolved = resolveExecutable(parts[1])
  return resolved && existsSync(resolved) ? resolved : undefined
}
```

#### WebUI 数据库持久化（N-10）

**优先级**：P0 | **状态**：已完成（184 集群）

独立 WebUI deployment 的聊天数据库默认存储在容器内路径，Pod 重建后数据丢失。

**修复**：在 `render_webui_deployment()` 的 env 列表中添加：

```python
{"name": "HERMES_WEB_UI_HOME", "value": "/opt/data/.webui"},
```

将 WebUI 的数据库、上传文件、日志全部重定向到 `/opt/data/.webui`（已挂载持久卷的子目录）。

#### 历史记录 api_server 过滤移除（N-11）

**优先级**：P0 | **状态**：已完成

History View 的 `listHermesSessions` 和 `getHermesSession` 硬编码过滤掉了 `api_server` source，导致 K8s standalone 部署中 History 页面完全为空。

**修复**：移除 `sessions.ts` 控制器中的三处 `api_server` 过滤。

#### 渠道配置自动启用平台

通过 hermes-web-ui 渠道配置页面保存平台凭据时，自动在 `config.yaml` 中设置 `platforms.<name>.enabled: true`。

**涉及文件**：
- `packages/server/src/controllers/hermes/config.ts`（+14 行自动启用逻辑）
- `admin/backend/weixin.py`（+20 行 `_save_credentials` 中自动设 `weixin.enabled: true`）

---

### 11.1 2026-05-25 变更记录

#### 基于 v0.6.0 重新实施全部改动

从 v0.6.0 tag 创建 `local-v0.6.0` 分支，重新实施全部变更（25 个文件），包括赛博朋克主题、品牌重塑、UI 清理等。

**版本基础**：`v0.6.0`

#### 品牌图标再次更新

使用新的人物头像风格图片替换 logo：

```bash
convert images.jpeg -resize 256x256 -background none packages/client/public/logo.png
```

#### 登录页面增强

- 添加**密码/令牌双模式登录**切换 UI
- 保留 URL `?token=xxx` 自动登录功能
- 自动登录后清除 URL 中的 token（防止泄露到浏览器历史记录）

#### 硬编码颜色全面修复

计划原文仅覆盖 4 个聊天组件的 `#333333` 替换。复盘后做了全局扫描，修复了所有 `.dark &` 块中的硬编码颜色值。

**修复原则**：所有 `.dark &` 块中的硬编码颜色值改为 CSS 变量（`var(--xxx)`）或 SCSS 变量（`$text-muted`），确保主题自定义配色正确生效。

| 文件 | 原值 | 新值 | 位置 |
|------|------|------|------|
| `AppSidebar.vue` | `#393939` | `var(--bg-card-hover)` | logo 区域背景 |
| `GroupMessageList.vue` | `#333333` | `var(--bg-card-hover)` | 消息列表背景 |
| `ChatInput.vue` | `#333333` | `var(--bg-input)` | 输入框背景 |
| `ChatInput.vue` | `#2a2a2a` | `var(--bg-card-hover)` | 斜杠命令面板背景 |
| `ChatInput.vue` | `#999999`（×4） | `$text-muted` / `$text-secondary` | 开关标签、工具追踪按钮 |
| `MessageList.vue` | `#333333` | `var(--bg-card-hover)` | 消息列表背景 |
| `MessageList.vue` | `#262626` | `var(--bg-card)` | 浮动面板背景 |
| `HistoryMessageList.vue` | `#333333` | `var(--bg-card-hover)` | 消息列表背景 |
| `MessageItem.vue` | `#999999`（×2） | `var(--text-muted)` | 工具按钮、时间戳文字 |
| `MessageItem.vue` | `#cccccc` | `var(--text-secondary)` | 工具按钮悬停态 |
| `GroupMessageItem.vue` | `#999999` | `var(--text-muted)` | 工具按钮 |
| `GroupMessageItem.vue` | `#cccccc` | `var(--text-secondary)` | 工具按钮悬停态 |
| `GroupChatInput.vue` | `#333333` | `var(--bg-input)` | 输入框背景 |
| `GroupChatInput.vue` | `#999999`（×2） | `$text-muted` | 开关标签、工具追踪按钮 |

**仍未修复（低优先级）**：

| 文件 | 值 | 说明 |
|------|-----|------|
| `ChatInput.vue:607,610` | `color: #999`（内联 style） | 模型选择弹窗文字 |
| `VoiceSettings.vue:484,513` | `color: #888/#999` | 语音设置页辅助文字 |
| `SkillList.vue:281` | `background: #888` | 技能列表图标 |
| `SkillsView.vue:250` | `background: #888` | 技能视图图例点 |

#### 多 Profile 网关端口修复（N-12）

**优先级**：P0 | **状态**：已完成

gateway-1 部署中有两个 profile（default + pm），各自运行独立的 gateway 实例。pm profile 配置了 `api_server.extra.port: 8643`，但 `stripLegacyApiServerGatewayConfig()` 无条件删除了整个 `platforms.api_server` 配置，导致两个 gateway 竞争同一端口。

**修复**：改为只删除遗留的顶层字段（`enabled`、`key` 等），保留 `extra` 子对象。

**涉及文件**：`packages/server/src/services/config-helpers.ts`

#### 侧边栏导航标签重命名

| 原标签 | 新标签 | 键名 |
|--------|--------|------|
| 任务 | 定时任务 | `sidebar.jobs` |
| 看板 | 我的任务 | `sidebar.kanban` |

#### Containerd 镜像部署经验

`ctr -n k8s.io images import` 导入镜像时，如果目标 tag 已存在，**不会覆盖**旧镜像。正确流程：

1. 先 `ctr images rm` 清除旧 tag
2. 再 `ctr images import` 导入新镜像
3. `ctr images tag` 重新打 latest 标签
4. `kubectl rollout restart` 滚动重启

#### 移除首次登录改密提示与手动改密功能

1. **移除首次登录修改密码提示框**：删除 `DefaultCredentialPrompt.vue` 在 `App.vue` 中的引用
2. **移除账户设置页的手动修改密码功能**：从 `AccountSettings.vue` 中删除修改密码按钮、弹窗、相关 state 和函数
3. **移除登录页默认密码提示文字**：从 `LoginView.vue` 中删除 `defaultCredentialsHint` 段落及其 CSS

#### 代码审核修复

- **Token URL 泄露修复**：自动登录后用 `window.history.replaceState` 清除 URL 中的 token
- **i18n 键位置修复**：删除 8 个 locale 文件根级的重复键
- **zh-TW.ts 缺失键补全**：添加 settings.display 下的风格键和侧边栏标签

---

### 11.2 2026-05-26 变更记录

#### 移除赛博朋克主题

从 `local-v0.6.0` 分支创建 `local-v0.6.1` 分支，移除赛博朋克主题，保留所有其他改动。

**移除内容**：

| 文件 | 移除内容 |
|------|----------|
| `composables/useTheme.ts` | `isCyberpunk` ref、cyberpunk class toggle、STYLE_ORDER 数组 |
| `styles/variables.scss` | `.dark.cyberpunk { ... }` 块（~60 CSS 变量）和 SCSS 桥接变量 |
| `styles/theme.ts` | `cyberpunkThemeOverrides` 对象（~100 行），getThemeOverrides 恢复 2 参数 |
| `styles/global.scss` | 6 个 @font-face（Orbitron/Exo 2）、.dark.cyberpunk 全局覆盖块 |
| `styles/code-block.scss` | `.dark.cyberpunk .hljs-code-block` 语法颜色覆盖 |
| `main.ts` | isCyberpunk 检查和强制 dark 逻辑 |
| `index.html` | FOUC 脚本中的 cyberpunk 检查 |
| `App.vue` | isCyberpunk 解构和传参 |
| `ThemeSwitch.vue` | 闪电图标、styleLabel 函数，恢复两态 |
| `DisplaySettings.vue` | styleOptions 中的 cyberpunk 选项和 toast |
| 9 个 i18n 文件 | styleCyberpunk 和 cyberpunkRequiresDark 键 |
| `public/fonts/` | orbitron-latin-*.woff2、exo-2-latin-*.woff2 字体文件 |

**保留内容**（所有非赛博朋克改动仍有效）：

- NewHermes 品牌名称（AppSidebar + index.html）
- 新 logo.png 和 favicon.ico
- 移除中转站链接
- 隐藏版本信息区域
- 密码/令牌双模式登录
- URL Token 自动登录 + history 清理
- 移除 DefaultCredentialPrompt
- 移除修改密码功能
- 登录限制器可配置化
- 7 个聊天组件硬编码颜色修复
- 侧边栏标签重命名（定时任务/我的任务）
- DisplaySettings 视觉风格下拉（水墨/漫画）

#### stripLegacyApiServerGatewayConfig 修复补回

创建 `local-v0.6.1` 分支时遗漏了 2026-05-25 对 `stripLegacyApiServerGatewayConfig` 的修复，导致部署后 pm profile 的 `api_server.extra.port: 8643` 仍被无条件删除，gateway 启动失败。

**修复**：重新应用 2026-05-25 的同一修复 — 保留 `extra` 子对象：

```typescript
// config-helpers.ts — stripLegacyApiServerGatewayConfig
const apiServer = config.platforms.api_server
const extra = apiServer?.extra
if (extra && typeof extra === 'object' && Object.keys(extra).length > 0) {
  config.platforms.api_server = { extra }
} else {
  delete config.platforms.api_server
}
```

**涉及文件**：`packages/server/src/services/config-helpers.ts`

#### 移除退出登录按钮

从侧边栏底部移除退出登录按钮，包括 `handleLogout()` 函数、按钮模板和 `.logout-item` 样式（基础 + 移动端响应式）。`sidebar.logout` i18n key 保留在各语言文件中。

**涉及文件**：`packages/client/src/components/layout/AppSidebar.vue`

---

### 11.3 2026-05-27 变更记录

#### 基于 v0.6.3 重新应用自定义修改

从 v0.6.3 tag 创建 `local-v0.6.3` 分支，使用 `git diff` + `git apply` 将 v0.6.1 上的 25 个文件改动重新应用到 v0.6.3 基础上。二进制文件（logo.png、favicon.ico）通过 `git checkout local-v0.6.1 -- <file>` 恢复。

**版本基础**：`v0.6.3`（origin/main @ `6a9cb245`）

**新增上游提交**（v0.6.1 → v0.6.3，共 18 个）：

| 提交 | 说明 |
|------|------|
| `6a9cb245` | docs: update 0.6.3 changelog (#1060) |
| `a43ead594` | fix bridge surrogate json encoding (#1059) |
| `1ec956850` | feat(dingtalk): add AI card template ID input (#1056) |
| `6647dc9bc` | fix(auth): remove username leak from public /api/auth/status endpoint (#1055) |
| `eca06faaa` | add web ui openrouter attribution (#1057) |
| `07c4c1ddd` | fix provider base URL env handling (#1054) |
| `a10e17108` | Add history import controls (#1053) |
| `3cede6fb7` | fix(bridge): block thinking spinner kaomoji (#1051) |
| `42f7b64ff` | update changelog and context default (#1045) |
| `82680f5c0` | fix clarify replay and compression timeout (#1044) |
| `e926a8e2f` | fix chat queue promotion (#1042) |
| `b0000b4c3` | fix context compressor summary prompt (#1041) |
| `ad1cab277` | fix context token resume (#1039) |
| `e686f0277` | scope bridge terminal env refresh to worker startup (#1031) |
| `689237f0f` | fix job deliver target options (#1026) |
| `badb17cf8` | integrate goal command workflow (#1025) |
| `0eab6a112` | Fix plan command support in web bridge (#1018) |
| `6e2e502a` | fix: clean stale pid on stop (#1015) |

#### 代码审核修复（3 项）

**1. Token 自动登录重复修复**

setup 块和 onMounted 都处理 URL token，setup 没有 URL 清理逻辑，onMounted 可能不会执行。

**修复**：移除 onMounted 重复逻辑，URL 清理合并到 setup 块。

**2. Token 登录服务端验证**

`handleTokenLogin` 直接存入 localStorage 无验证，无效 token 导致用户先看到聊天页再被踢回登录页。

**修复**：存入 token 后调用 `fetchAuthStatus()` 验证，失败时清除 token 并显示错误。

```typescript
// LoginView.vue — handleTokenLogin
try {
  setApiKey(token.value.trim());
  await fetchAuthStatus();  // 验证 token 有效性
  router.replace("/hermes/chat");
} catch (err: any) {
  setApiKey("");  // 清除无效 token
  errorMsg.value = err.message || t("login.invalidCredentials");
}
```

**3. login-limiter 环境变量 NaN 防护**

`parseInt(process.env.LOGIN_MAX_FAILURES || '10', 10)` 对非数字字符串（如 `"ten"`）返回 `NaN`，导致限速完全失效。

**修复**：所有 parseInt 后加 `|| defaultValue` 回退。

```typescript
const IP_MAX_FAILURES = parseInt(process.env.LOGIN_MAX_FAILURES || '10', 10) || 10
const IP_FAILURE_WINDOW_MS = (parseInt(process.env.LOGIN_FAILURE_WINDOW_MIN || '15', 10) || 15) * 60_000
const IP_LOCK_DURATION_MS = (parseInt(process.env.LOGIN_LOCK_MINUTES || '60', 10) || 60) * 60_000
const GLOBAL_MAX_TOTAL_FAILURES = parseInt(process.env.LOGIN_GLOBAL_MAX_FAILURES || '50', 10) || 50
const GLOBAL_LOCK_DURATION_MS = (parseInt(process.env.LOGIN_GLOBAL_LOCK_MINUTES || '30', 10) || 30) * 60_000
```

**涉及文件**：
- `packages/client/src/views/LoginView.vue`
- `packages/server/src/services/login-limiter.ts`

#### 部署信息

- **镜像**：`ekkoye8888/hermes-web-ui:20260527`
- **K8s 集群**：roc-epyc 节点（172.32.153.184），namespace `hermes-agent`
- **Deployment**：7 个 `hermes-gateway-{1..7}`
- **滚动更新**：全部成功，所有 Pod 1/1 Running
- **Profile 状态**：gateway-1 default + pm 均 running

#### 服务端自动登录（N-13, R-14）

**优先级**：P0 | **状态**：已完成

访问 WebUI 时自动登录，无需手动输入密码或令牌。

**实现方案**：

1. 服务端新增环境变量 `AUTO_LOGIN`（默认未设置）
2. 新增公开端点 `GET /api/auth/auto-login`：
   - `AUTO_LOGIN` 未设置 → 返回 404
   - `AUTO_LOGIN` 已设置 → 查找第一个 active 的 super_admin 用户，签发 JWT 返回
3. 前端 `LoginView.vue` 启动时：URL token > localStorage JWT > auto-login 端点
4. K8s 部署中每个 gateway 设 `AUTO_LOGIN=true`

**涉及文件**：
- `packages/server/src/controllers/auth.ts`（+20 行 autoLogin 函数）
- `packages/server/src/routes/auth.ts`（+1 行路由注册）
- `packages/client/src/api/auth.ts`（+6 行 autoLogin API）
- `packages/client/src/views/LoginView.vue`（+6 行 auto-login 逻辑）

#### 多 Profile 网关端口冲突修复 + 新建 Profile 自动启动 Gateway（N-14, N-15）

**优先级**：P0 | **状态**：已完成

**N-14 端口冲突**：WebUI 本地模式启动多个 profile 的 gateway 时，所有 profile 默认使用 8642 端口导致冲突。新增 `gateway-port-resolver.ts` 自动为非 default profile 分配独立端口（8643 起），持久化到 `gateway_port.json`。

**N-15 自动启动**：`create()` 函数创建新 profile 后没有启动 gateway。新增 `startGatewayForNewProfile()` 函数，在 profile 创建成功后自动解析端口、启动 gateway、等待就绪。

**专家 code review 修复的关键问题**：
- `isPortAvailable` 只有 `EADDRINUSE` 才视为端口占用（其他错误视为可用）
- `assignmentLock` 序列化防止并发端口分配冲突
- `profileName` 显式参数传入，避免从路径解析错误
- 移除 `findFreePort` 回退逻辑，端口耗尽时直接抛错
- `writeAssignedPort` 不吞错误，让上层处理

**部署信息**：
- **镜像**：`ekkoye8888/hermes-web-ui:20260527e`
- **7 个 gateway deployment 全部滚动更新成功，1/1 Running**

**涉及文件**：
- `packages/server/src/services/hermes/gateway-port-resolver.ts`（新增，~107 行）
- `packages/server/src/services/hermes/gateway-runner.ts`（+5 行 port 参数）
- `packages/server/src/services/hermes/gateway-autostart.ts`（+30 行 startGatewayForNewProfile + resolveAndAssignPort 集成）
- `packages/server/src/services/hermes/gateway-manager.ts`（+1 行 env.API_SERVER_PORT）
- `packages/server/src/controllers/hermes/profiles.ts`（+9 行 create 中自动启动 gateway）

### 11.4 2026-05-29 变更记录

#### 基于 v0.6.4 升级

从 v0.6.4 tag 创建 `local-v0.6.4` 分支，通过 `git stash` + `git stash pop` 将 v0.6.3 上的自定义改动迁移到 v0.6.4 基础上。

**版本基础**：`v0.6.4`（`d610c3d1b`）

**新增上游提交**（v0.6.3 → v0.6.4，共 5 个）：

| 提交 | 说明 |
|------|------|
| `d610c3d1b` | fix preview runtime isolation and shutdown (#1088) |
| `1734bac9b` | add version preview workflow (#1086) |
| `7997bfa2b` | Run Docker publish only on releases (#1081) |
| `a6b3bec29` | Add virtualized chat pagination (#1080) |
| `21bb8385f` | ci: harden P0 workflow checks (#1077) |

**冲突解决**（3 个文件）：

上游 `Add virtualized chat pagination` 重构了消息列表组件，将样式移到新组件 `VirtualMessageList.vue`。冲突文件：

1. `HistoryMessageList.vue` — `.message-list` 样式块已移除（由 VirtualMessageList 处理），保留上游空块
2. `MessageList.vue` — 同上
3. `GroupMessageList.vue` — 同上

**额外修复**：`VirtualMessageList.vue` 第 271 行 `background-color: #333333` → `var(--bg-card-hover)`，确保暗色模式颜色变量生效。

**部署信息**：
- **镜像**：`ekkoye8888/hermes-web-ui:20260529`
- **7 个 gateway deployment 全部滚动更新成功，1/1 Running**
- **线上验证**：自动登录 ✅、favicon ✅、认证状态 ✅
