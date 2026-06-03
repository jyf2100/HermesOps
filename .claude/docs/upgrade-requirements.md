---
name: upgrade-requirements
description: Hermes Web UI 每次版本升级后必须重新应用的自定义需求清单
metadata: 
  node_type: memory
  type: project
  originSessionId: 254891ec-767b-4cab-966f-2722082f33be
---

# Hermes Web UI 升级后必做需求清单

每次基于上游新版本创建本地分支后，必须逐项检查并重新应用以下自定义改动。

---

## 一、品牌重塑

- [ ] 品牌名称从 "Hermes" 更名为 "NewHermes"（侧边栏 logo-text、index.html title）
- [ ] 替换品牌 Logo 图片和浏览器 favicon，源图片：`images.jpeg`（项目根目录）
  ```bash
  # 从源图生成 logo 和 favicon
  convert images.jpeg -resize 256x256 -background none packages/client/public/logo.png
  convert packages/client/public/logo.png -resize 64x64 -define icon:auto-resize=64,48,32,16 packages/client/public/favicon.ico
  ```

## 二、UI 清理

- [ ] 移除侧边栏"中转站"外部链接（apikey.fun）— `AppSidebar.vue`
- [ ] 隐藏侧边栏左下角版本信息区域（`display:none`），ThemeSwitch 移出该容器
- [ ] 侧边栏导航标签重命名："任务"→"定时任务"、"看板"→"我的任务"（9 个 i18n 文件）
- [ ] 移除首次登录修改密码提示框（`DefaultCredentialPrompt` 在 `App.vue` 的引用）
- [ ] 移除账户设置页的手动修改密码功能（`AccountSettings.vue`）
- [ ] 移除登录页默认密码提示文字（`LoginView.vue` 的 `defaultCredentialsHint`）
- [ ] 移除侧边栏退出登录按钮（`AppSidebar.vue`）

## 三、登录增强

- [ ] 登录页支持密码/令牌双模式登录（切换标签 UI）— `LoginView.vue`
- [ ] URL 带 token 参数时自动登录，登录后清除 URL 中的 token 防泄露
- [ ] 服务端自动登录端点 `GET /api/auth/auto-login`（`AUTO_LOGIN` 环境变量控制）— `controllers/auth.ts` + `routes/auth.ts`
- [ ] 前端 LoginView 启动时按优先级自动登录：URL token > localStorage JWT > auto-login 端点
- [ ] 登录限速参数环境变量可配置 — `login-limiter.ts`（NaN 防护）

## 四、主题与颜色

- [ ] 暗色模式下所有 `.dark &` 硬编码颜色改为 CSS/SCSS 变量（涉及 8 个聊天组件 + AppSidebar）
- [ ] Ink/Comic 视觉风格切换（ThemeSwitch 两态 + DisplaySettings 下拉）— `useTheme.ts` + `variables.scss` + `theme.ts`
- [ ] FOUC 防闪烁（index.html 行内脚本 + main.ts 初始化）

## 五、后端修复

- [ ] `stripLegacyApiServerGatewayConfig` 保留 `extra` 子对象（多 Profile 网关端口不冲突）— `config-helpers.ts`
- [ ] 历史记录不过滤 `api_server` 来源 — `sessions.ts` 控制器
- [ ] 渠道配置保存时自动启用对应平台 — `controllers/hermes/config.ts`
- [ ] 多 Profile 网关端口冲突修复 — 新增 `gateway-port-resolver.ts`，端口持久化到 `gateway_port.json`
  - default 固定 8642，其他 profile 从 8643 起自动分配空闲端口
  - `gateway-runner.ts` 增加 port 参数，spawn 时传递 `API_SERVER_PORT`
  - `gateway-autostart.ts` 所有启动路径集成端口解析
  - `gateway-manager.ts` 的 `startResolved()` 设置 `env.API_SERVER_PORT`
- [ ] 新建 Profile 自动启动 gateway — `profiles.ts` create() 调用 `startGatewayForNewProfile()`
  - `gateway-autostart.ts` 新增 `startGatewayForNewProfile()` 函数
  - 创建 profile 后自动解析端口 → 清理旧配置 → 启动 gateway → 等待就绪

## 六、部署配置

- [ ] K8s 每个 gateway deployment 设置环境变量：`AUTO_LOGIN=true`、`AUTH_TOKEN`、`HERMES_WEB_UI_HOME`、`HERMES_WEB_UI_API_BASE_URL`
- [ ] Docker 镜像标签：`ekkoye8888/hermes-web-ui:latest` + 日期标签
- [ ] containerd 导入前必须先 `ctr images rm` 旧标签

---

**关联**：[[k8s-deployment-architecture]] [[changelog-2026-05-15]]
