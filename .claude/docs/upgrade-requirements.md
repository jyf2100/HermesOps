---
name: upgrade-requirements
description: Hermes Web UI 每次版本升级后必须重新应用的自定义需求清单
metadata:
  node_type: memory
  type: project
---

# Hermes Web UI 升级后必做需求清单

每次基于上游新版本创建本地分支后，必须逐项检查并重新应用以下自定义改动。

> **当前基准版本：v0.6.11**（2026-06-08 更新）

---

## 一、品牌重塑

- [ ] 品牌名称 "Hermes Studio" → "NewHermes"（index.html title、AppSidebar.vue logo-text）
- [ ] 桌面端品牌 "Hermes Studio" → "NewHermes Studio"（electron-builder.yml productName、index.ts、desktop-i18n.ts、cli-shim.ts、package.json、installer.nsh）
- [ ] Logo 图片和浏览器 favicon 重新生成（源图：`.claude/docs/images-01.jpg`）
  ```bash
  convert .claude/docs/images-01.jpg -resize 256x256 -background none packages/client/public/logo.png
  convert .claude/docs/images-01.jpg -resize 64x64 -define icon:auto-resize=64,48,32,16 packages/client/public/favicon.ico
  ```
- [ ] 桌面端图标重新生成（从 logo.png 转换各尺寸）
  ```bash
  convert packages/client/public/logo.png -resize 512x512 packages/desktop/build/icon.png
  convert packages/desktop/build/icon.png -resize 256x256 -define icon:auto-resize=256,128,64,48,32,16 packages/desktop/build/icon.ico
  convert packages/desktop/build/icon.png packages/desktop/build/icon.icns
  for s in 16 32 48 64 128 256 512; do convert packages/desktop/build/icon.png -resize ${s}x${s} packages/desktop/build/icons/${s}x${s}.png; done
  ```
- [ ] artifactName 日期更新为当天（`electron-builder.yml` 中 3 处）

## 二、UI 清理

- [ ] 移除侧边栏"中转站"外部链接（apikey.fun）— AppSidebar.vue `<a class="nav-item fun-link">` 整个标签
- [ ] 隐藏版本信息区域（`display:none`），ThemeSwitch 移出该 div — AppSidebar.vue
- [ ] 移除版本检查和更新按钮（handleUpdate、handleReloadClient 函数 + NButton）— AppSidebar.vue
- [ ] 移除 `DefaultCredentialPrompt` — App.vue 删除 import 和组件引用
- [ ] 移除退出登录按钮 — AppSidebar.vue 删除 handleLogout 函数和按钮

## 三、登录增强

- [ ] 登录限速使用环境变量 — `login-limiter.ts`
  ```ts
  const _envMax = parseInt(process.env.IP_MAX_FAILURES || '', 10)
  const IP_MAX_FAILURES = _envMax === 0 ? 0 : (_envMax || 10)
  ```

## 四、部署配置

- [ ] K8s 每个 gateway deployment 设置环境变量：`AUTO_LOGIN=true`、`AUTH_TOKEN`、`HERMES_WEB_UI_HOME`、`HERMES_WEB_UI_API_BASE_URL`
- [ ] Docker 镜像标签：`ekkoye8888/hermes-web-ui:latest` + 日期标签
- [ ] containerd 导入前必须先 `ctr images rm` 旧标签

## 上游已正确、无需修改的项

- i18n 导航标签（中文"任务"/"看板"已正确）
- 登录页已为密码模式（无 token/双模式）
- 暗色模式颜色已使用硬编码色值
- FOUC 防闪烁已有
- 账户设置无手动修改密码功能
- 登录页无默认密码提示

---

**关联**：[[k8s-deployment-architecture]] [[changelog-2026-05-15]]
