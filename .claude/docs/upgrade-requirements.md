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

> **当前基准版本：v0.6.10**（2026-06-04 更新）
>
> ⚡ v0.6.10 已采纳了 v0.6.9 以下的大部分自定义改动，仅剩 1 项需要手动处理。

---

## 一、品牌重塑

- [x] 品牌名称 "Hermes Studio"（侧边栏 logo-text、index.html title）— **v0.6.10 已采纳**
- [x] Logo 图片和浏览器 favicon — **v0.6.10 已包含正确文件**
  ```bash
  # 如需重新生成（源图：.claude/docs/images-01.jpg）
  convert .claude/docs/images-01.jpg -resize 256x256 -background none packages/client/public/logo.png
  convert packages/client/public/logo.png -resize 64x64 -define icon:auto-resize=64,48,32,16 packages/client/public/favicon.ico
  ```

## 二、UI 清理

- [x] 侧边栏无"中转站"外部链接 — **v0.6.10 已采纳**
- [x] 侧边栏无版本信息区域 — **v0.6.10 已采纳**
- [x] 导航标签为"任务"/"看板" — **v0.6.10 已采纳**
- [ ] ⚠️ 移除 `DefaultCredentialPrompt` — **需手动处理：App.vue 删除 import 和组件引用（3行）**
- [x] 无手动修改密码功能（AccountSettings） — **v0.6.10 已采纳**
- [x] 登录页无默认密码提示 — **v0.6.10 已采纳**
- [x] 侧边栏无退出登录按钮 — **v0.6.10 已采纳**

## 三、登录增强

- [x] 登录页密码模式 — **v0.6.10 已采纳**（上游已移除 token/双模式）
- [x] auto-login 端点已移除 — **v0.6.10 已采纳**（上游和本地一致）
- [x] 登录限速使用环境变量 — **v0.6.10 已采纳**

## 四、主题与颜色

- [x] 暗色模式颜色已使用硬编码色值替代 CSS 变量（8 个聊天组件） — **v0.6.10 已采纳**
- [x] Ink/Comic 视觉风格已移除 — **v0.6.10 已采纳**
- [x] FOUC 防闪烁 — **v0.6.10 已采纳**

## 五、后端修复

- [x] `stripLegacyApiServerGatewayConfig` 简化 — **v0.6.10 已采纳**
- [x] 多 Profile 端口分配已简化 — **v0.6.10 已采纳**
  - `gateway-port-resolver.ts` 已被上游删除
  - `gateway-runner.ts` 已移除 port 参数
  - `gateway-autostart.ts` 已简化
- [x] 新建 Profile 自动启动 gateway — **v0.6.10 已采纳**

## 六、部署配置

- [ ] K8s 每个 gateway deployment 设置环境变量：`AUTO_LOGIN=true`、`AUTH_TOKEN`、`HERMES_WEB_UI_HOME`、`HERMES_WEB_UI_API_BASE_URL`
- [ ] Docker 镜像标签：`ekkoye8888/hermes-web-ui:latest` + 日期标签
- [ ] containerd 导入前必须先 `ctr images rm` 旧标签

---

## 升级操作速查（v0.6.10 基准）

```bash
# 1. 创建新版本分支
git fetch origin tag v0.6.11
git checkout -b local-v0.6.11 v0.6.11

# 2. 仅需修改的文件
#    - App.vue: 移除 DefaultCredentialPrompt 的 import 和组件引用

# 3. 构建验证
npm run build

# 4. Docker 构建 + K8s 部署
TODAY=$(date +%Y%m%d)
docker build -t ekkoye8888/hermes-web-ui:latest -t ekkoye8888/hermes-web-ui:${TODAY} .
sudo ctr -n k8s.io images rm docker.io/ekkoye8888/hermes-web-ui:latest 2>/dev/null
docker save ekkoye8888/hermes-web-ui:latest | sudo ctr -n k8s.io images import -
kubectl rollout restart deployment/hermes-gateway-{1..7} -n hermes-agent
```

---

**关联**：[[k8s-deployment-architecture]] [[changelog-2026-05-15]]
