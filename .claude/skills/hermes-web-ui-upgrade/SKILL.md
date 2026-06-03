---
name: hermes-web-ui-upgrade
description: Hermes Web UI 版本升级全流程：版本检查 → 创建分支 → 应用自定义改动 → 构建 → E2E 测试 → Docker 镜像 → K8s 部署 → 线上验证
version: 1.1.0
source: manual
command: /hermes-web-ui-upgrade
---

# Hermes Web UI 升级部署流程

从上游拉取新版本后，重新应用自定义改动、构建测试、部署到 K8s 开发环境的标准化流程。

## 分支命名规范

| 规范 | 格式 | 示例 |
|------|------|------|
| 本地分支 | `local-v{VERSION}` | `local-v0.6.3` |
| 对应远程 tag | `v{VERSION}` | `v0.6.3` |

## 前置条件

| 项目 | 值 |
|------|-----|
| 项目路径 | `/mnt/disk01/workspaces/worksummary/hermes-web-ui` |
| 需求清单 | `.claude/docs/upgrade-requirements.md` |
| 设计文档 | `.claude/docs/Hermes_Web_UI_品牌重塑与功能修订设计文档_2026-05-27.md` |
| Logo 源图 | `.claude/docs/images.jpeg` |
| GitHub 代理 | `http://172.32.147.190:7890` |
| K8s 集群 | roc-epyc 节点（172.32.153.184），namespace `hermes-agent` |

---

## 步骤 0：版本检查

对比本地当前版本与远程最新版本，判断是否需要升级。

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-web-ui

# 从当前分支名提取本地版本（local-v0.6.3 → v0.6.3）
CURRENT_BRANCH=$(git branch --show-current)
LOCAL_VERSION=$(echo "$CURRENT_BRANCH" | sed 's/^local-//')
if [ -z "$LOCAL_VERSION" ] || [ "$LOCAL_VERSION" = "$CURRENT_BRANCH" ]; then
  echo "WARNING: 当前分支 '$CURRENT_BRANCH' 不符合 local-v* 命名规范"
  LOCAL_VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
fi
echo "本地分支: $CURRENT_BRANCH  版本: $LOCAL_VERSION"

# 通过代理拉取远程最新 tag（直连 GitHub 会超时）
if ! https_proxy=http://172.32.147.190:7890 git fetch origin --tags; then
  echo "WARNING: 远程 tag 拉取失败，版本对比可能不准确"
fi

# 获取远程最新版本
REMOTE_VERSION=$(git tag -l 'v*' --sort=-v:refname | head -1)
echo "远程最新: $REMOTE_VERSION"

# 比较
if [ -z "$LOCAL_VERSION" ]; then
  echo "⚠️  无法确定本地版本，建议继续升级"
elif [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
  echo "✅ 已是最新版本 ($LOCAL_VERSION)，无需升级"
  # 可跳过步骤 1~2，直接执行步骤 3（重新应用改动）或步骤 6（重新部署）
else
  echo "⬆️  需要升级: $LOCAL_VERSION → $REMOTE_VERSION"
  git log --oneline $LOCAL_VERSION..$REMOTE_VERSION | head -20
fi
```

## 步骤 1：拉取上游更新

> 版本相同时可跳过此步和步骤 2。

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-web-ui

# 通过代理拉取（直连 GitHub 会超时）
https_proxy=http://172.32.147.190:7890 git fetch origin

# 查看新版本提交
git log --oneline $LOCAL_VERSION..origin/main | head -20
```

## 步骤 2：创建新版本分支

```bash
# 使用步骤 0 中获取的远程最新版本号
NEW_VERSION=$REMOTE_VERSION

# 从新版本 tag 创建分支（命名规范：local-vX.Y.Z）
https_proxy=http://172.32.147.190:7890 git fetch origin tag $NEW_VERSION
git checkout -b local-$NEW_VERSION $NEW_VERSION
```

## 步骤 3：应用自定义改动

**必须逐项检查** `.claude/docs/upgrade-requirements.md` 中的所有 checklist。

### 3.1 用 git diff 快速迁移

如果上一版本分支还在，可以直接 diff + apply：

```bash
# 找到上一个本地分支（自动检测最新的 local-v* 分支）
OLD_BRANCH=$(git branch --list 'local-v*' | sort -V | tail -1 | tr -d ' *')
OLD_VERSION=$(echo "$OLD_BRANCH" | sed 's/^local-//')
echo "从旧分支迁移: $OLD_BRANCH (基于 $OLD_VERSION)"

# 从上一版本分支导出改动（排除二进制文件）
git diff $OLD_VERSION..$OLD_BRANCH -- ':!*.png' ':!*.ico' ':!*.jpeg' > /tmp/custom.patch
git apply --check /tmp/custom.patch
git apply /tmp/custom.patch

# 二进制文件单独恢复
git checkout $OLD_BRANCH -- packages/client/public/logo.png packages/client/public/favicon.ico
```

### 3.2 重新生成 Logo（如有需要）

```bash
convert .claude/docs/images.jpeg -resize 256x256 -background none packages/client/public/logo.png
convert packages/client/public/logo.png -resize 64x64 -define icon:auto-resize=64,48,32,16 packages/client/public/favicon.ico
```

### 3.3 解决冲突

如果 apply 有冲突，逐文件手动解决。参考设计文档中各改动的具体位置。

**重点检查这些文件（上游可能修改）：**

- `LoginView.vue` — 登录页改动多
- `AppSidebar.vue` — 品牌名、链接、退出按钮
- `App.vue` — DefaultCredentialPrompt 引用
- `controllers/auth.ts` — auto-login 端点
- `routes/auth.ts` — auto-login 路由
- `services/login-limiter.ts` — 环境变量配置
- `services/config-helpers.ts` — stripLegacyApiServerGatewayConfig 修复
- `services/hermes/gateway-autostart.ts` — 多 Profile 端口 + 自动启动
- `services/hermes/gateway-port-resolver.ts` — 端口分配
- `services/hermes/gateway-runner.ts` — port 参数
- `controllers/hermes/profiles.ts` — create 自动启动 gateway

## 步骤 4：构建验证

```bash
# 类型检查 + Vite 构建 + 服务端构建
npm run build
```

如果构建失败，先修复类型错误再继续。

## 步骤 5：E2E 功能测试

构建成功后，逐项验证需求清单中的功能：

### 5.1 启动本地开发服务器（可选）

```bash
npm run dev
```

### 5.2 功能检查清单

| 测试项 | 验证方法 |
|--------|----------|
| 品牌名 "NewHermes" | 检查 index.html title 和 AppSidebar logo-text |
| Logo 和 favicon | 检查 public/logo.png 和 favicon.ico 是否从 images.jpeg 生成 |
| 中转站链接不显示 | AppSidebar.vue 中无 apikey.fun 链接 |
| 版本信息隐藏 | AppSidebar.vue 中 version-info 区域 display:none |
| 导航标签名 | "定时任务"、"我的任务"（非原版） |
| 无退出登录按钮 | AppSidebar 底部无 logout 按钮 |
| 无首次登录改密提示 | App.vue 无 DefaultCredentialPrompt |
| 无手动修改密码 | AccountSettings.vue 无改密码功能 |
| 密码/令牌双模式 | 登录页有两个切换标签 |
| URL token 自动登录 | 访问 `?token=xxx` 自动登录并清除 URL |
| 服务端自动登录 | `AUTO_LOGIN=true` 时访问直接跳转聊天页 |
| 登录限速可配置 | login-limiter.ts 使用环境变量 + NaN 防护 |
| 暗色模式颜色正确 | 8 个聊天组件无硬编码颜色值 |
| Ink/Comic 切换 | ThemeSwitch 两态切换正常 |
| FOUC 防闪烁 | 刷新页面无白屏闪烁 |
| stripLegacy 修复 | config-helpers.ts 保留 extra 子对象 |
| 多 Profile 端口 | gateway-port-resolver.ts 端口分配（default=8642，其他从 8643 起） |
| 新 Profile 启动 | 创建 profile 后 gateway 自动启动 |

### 5.3 关键 API 端点测试

```bash
# 自动登录端点
curl -s -H "Host: agent1.172-32-153-184.nip.io" http://localhost:40080/api/auth/auto-login

# 认证状态
curl -s -H "Host: agent1.172-32-153-184.nip.io" http://localhost:40080/api/auth/status
```

## 步骤 6：构建 Docker 镜像

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-web-ui

TODAY=$(date +%Y%m%d)
docker build -t ekkoye8888/hermes-web-ui:latest -t ekkoye8888/hermes-web-ui:${TODAY} .
```

## 步骤 7：部署到 K8s 开发环境

```bash
# 导入 containerd（先删旧标签！否则不会覆盖）
sudo ctr -n k8s.io images rm docker.io/ekkoye8888/hermes-web-ui:latest 2>/dev/null
docker save ekkoye8888/hermes-web-ui:latest | sudo ctr -n k8s.io images import -
sudo ctr -n k8s.io images tag \
  docker.io/ekkoye8888/hermes-web-ui:latest \
  docker.io/ekkoye8888/hermes-web-ui:${TODAY} --force

# 确保环境变量设置（首次或新 deployment）
for i in 1 2 3 4 5 6 7; do
  kubectl set env deployment/hermes-gateway-$i AUTO_LOGIN=true -n hermes-agent
done

# 滚动重启
kubectl rollout restart deployment/hermes-gateway-{1..7} -n hermes-agent
kubectl rollout status deployment/hermes-gateway-{1..7} -n hermes-agent --timeout=120s

# 验证
kubectl get pods -n hermes-agent | grep gateway
```

## 步骤 8：线上验证

```bash
# 验证自动登录
curl -s -H "Host: agent1.172-32-153-184.nip.io" http://localhost:40080/api/auth/auto-login | head -c 100

# 验证 favicon
curl -s -H "Host: agent1.172-32-153-184.nip.io" http://localhost:40080/favicon.ico -o /tmp/check.ico
file /tmp/check.ico
```

浏览器访问 `http://agent1.172-32-153-184.nip.io:40080/`：
- 自动登录跳转到聊天页面
- 品牌名显示 NewHermes
- Logo 显示新图标
- 侧边栏无中转站链接、无版本信息、无退出按钮

## 步骤 9：更新文档

- 更新设计文档中的版本号和变更记录
- 更新 `upgrade-requirements.md` 中的版本基础
- 更新 `.claude/docs/` 目录下的设计文档

---

## 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 构建失败 TS6133 | 移除功能后残留未使用的导入 | 删除对应的 import 和变量 |
| containerd 导入不生效 | 旧 tag 未删除 | 先 `ctr images rm` 再 import |
| 自动登录不工作 | AUTO_LOGIN 环境变量未设置 | `kubectl set env deployment/... AUTO_LOGIN=true` |
| favicon 未更新 | 浏览器缓存 | Ctrl+Shift+R 强制刷新 |
| Logo 是旧版本 | images.jpeg 未重新转换 | 重新执行 ImageMagick 转换命令 |
| git apply 冲突 | 上游修改了同名文件 | 逐文件手动合并 |
| 多 Profile 端口冲突 | gateway_port.json 不存在或过期 | 删除对应 profile 目录下的 gateway_port.json，重启 gateway |

## 注意事项

- **永远不要 `git push` 到 origin/main** — 本地分支 `local-v*` 只在本地维护
- **containerd 不覆盖** — 导入前必须先 `ctr images rm` 旧标签
- **本机即 184** — 不需要 SSH，直接本地操作
- **GitHub 需代理** — `https_proxy=http://172.32.147.190:7890`
