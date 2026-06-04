---
name: hermes-web-ui-upgrade
description: Hermes Web UI 版本升级全流程：版本检查 → 创建分支 → 按需求文档逐项修改 → 构建 → Docker 镜像 → K8s 部署 → 线上验证
version: 2.0.0
source: manual
command: /hermes-web-ui-upgrade
---

# Hermes Web UI 升级部署流程

从上游拉取新版本后，**按需求文档在纯净版本上逐项应用自定义改动**，构建测试，部署到 K8s 开发环境。

## ⚠️ 核心原则

> **不要从旧分支 diff 迁移！** 必须以新版本纯净代码为基础，按需求文档逐项检查并修改。
>
> 原因：旧分支可能包含与需求方向相反的改动（如需求要求移除某元素，但旧分支反而添加了它）。diff 迁移会导致遗漏或反向应用。

## 分支命名规范

| 规范 | 格式 | 示例 |
|------|------|------|
| 本地分支 | `local-v{VERSION}` | `local-v0.6.10` |
| 对应远程 tag | `v{VERSION}` | `v0.6.10` |

## 前置条件

| 项目 | 值 |
|------|-----|
| 项目路径 | `/mnt/disk01/workspaces/worksummary/hermes-web-ui` |
| 需求清单 | `.claude/docs/upgrade-requirements.md` |
| 设计文档 | `.claude/docs/Hermes_Web_UI_品牌重塑与功能修订设计文档_2026-05-27.md` |
| Logo 源图 | `.claude/docs/images-01.jpg` |
| GitHub 代理 | `http://172.32.147.190:7890` |
| K8s 集群 | roc-epyc 节点（172.32.153.184），namespace `hermes-agent` |

---

## 步骤 0：版本检查

对比本地当前版本与远程最新版本，判断是否需要升级。

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-web-ui

# 从当前分支名提取本地版本（local-v0.6.10 → v0.6.10）
CURRENT_BRANCH=$(git branch --show-current)
LOCAL_VERSION=$(echo "$CURRENT_BRANCH" | sed 's/^local-//')
if [ -z "$LOCAL_VERSION" ] || [ "$LOCAL_VERSION" = "$CURRENT_BRANCH" ]; then
  echo "WARNING: 当前分支 '$CURRENT_BRANCH' 不符合 local-v* 命名规范"
  LOCAL_VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
fi
echo "本地分支: $CURRENT_BRANCH  版本: $LOCAL_VERSION"

# 通过代理拉取远程最新 tag（直连 GitHub 会超时）
# 如果代理不通，尝试：curl 通过代理访问 GitHub API 获取最新 tag
# curl -s --connect-timeout 5 -x http://172.32.147.190:7890 https://api.github.com/repos/EKKOLearnAI/hermes-web-ui/tags?per_page=5
https_proxy=http://172.32.147.190:7890 git -c http.proxy=http://172.32.147.190:7890 fetch origin --tags

# 获取远程最新版本
REMOTE_VERSION=$(git tag -l 'v*' --sort=-v:refname | head -1)
echo "远程最新: $REMOTE_VERSION"
```

## 步骤 1：拉取上游更新

> 版本相同时可跳过此步和步骤 2。

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-web-ui

# 通过代理拉取
https_proxy=http://172.32.147.190:7890 git -c http.proxy=http://172.32.147.190:7890 fetch origin --tags

# 查看新版本提交
git log --oneline $LOCAL_VERSION..origin/main | head -20
```

## 步骤 2：创建新版本分支

```bash
# 使用步骤 0 中获取的远程最新版本号
NEW_VERSION=$REMOTE_VERSION

# 从新版本 tag 创建分支（命名规范：local-vX.Y.Z）
git stash push -m "pre-upgrade-changes"  # 先保存未提交的修改
git checkout -b local-$NEW_VERSION $NEW_VERSION
```

**此时代码是纯净的上游版本，没有任何自定义改动。**

## 步骤 3：按需求文档逐项应用自定义改动

> ⚠️ 这是核心步骤。**必须逐项检查需求文档**，在纯净版本上手动应用每个改动。
> 不要假设"上游已采纳"——必须逐项验证。

### 3.1 读取需求清单

```bash
cat .claude/docs/upgrade-requirements.md
```

### 3.2 逐项验证和修改

对每个 checklist 项：

1. **先检查**新版本当前状态（`grep` 或读取文件）
2. **判断**是否需要修改（对比需求要求 vs 当前状态）
3. **应用**修改

### 3.3 典型修改项（参考需求文档）

#### 品牌重塑

```bash
# 品牌名改为 NewHermes
# - packages/client/index.html: <title>NewHermes</title>
# - packages/client/src/components/layout/AppSidebar.vue: <span class="logo-text">NewHermes</span>

# Logo 重新生成（源图：.claude/docs/images-01.jpg）
convert .claude/docs/images-01.jpg -resize 256x256 -background none packages/client/public/logo.png
convert packages/client/public/logo.png -resize 64x64 -define icon:auto-resize=64,48,32,16 packages/client/public/favicon.ico
```

#### UI 清理

- **移除中转站链接** — AppSidebar.vue 删除 `<a class="nav-item fun-link" href="https://apikey.fun/...">` 整个 `<a>` 标签
- **移除退出按钮** — AppSidebar.vue 删除 `handleLogout` 函数和 `<button class="nav-item logout-item">` 整个按钮
- **隐藏版本信息** — AppSidebar.vue 中 `<div class="version-info">` 改为 `<div class="version-info" style="display:none">`，ThemeSwitch 移出该 div
- **移除 DefaultCredentialPrompt** — App.vue 删除 import 和 `<DefaultCredentialPrompt />`

#### i18n 导航标签

修改 9 个 locale 文件中 sidebar 区域的 jobs 和 kanban 标签名（每个语言不同）。

#### login-limiter 环境变量

`login-limiter.ts` 中将硬编码常量改为 `process.env` 读取 + `|| 10` NaN 防护 + `IP_MAX_FAILURES === 0` 短路逻辑。

### 3.4 修改后验证

```bash
# 快速验证关键项
echo "--- 品牌名 ---"
grep '<title>' packages/client/index.html
grep 'logo-text' packages/client/src/components/layout/AppSidebar.vue | head -1

echo "--- 中转站 ---"
grep -c 'apikey.fun' packages/client/src/components/layout/AppSidebar.vue

echo "--- 退出按钮 ---"
grep -c 'handleLogout' packages/client/src/components/layout/AppSidebar.vue

echo "--- 版本信息 ---"
grep 'version-info' packages/client/src/components/layout/AppSidebar.vue | head -1

echo "--- DefaultCredentialPrompt ---"
grep -c 'DefaultCredentialPrompt' packages/client/src/App.vue

echo "--- 修改总览 ---"
git diff --stat v0.6.10
```

## 步骤 4：构建验证

```bash
npm run build
```

如果构建失败，先修复类型错误再继续。

## 步骤 5：构建 Docker 镜像

```bash
cd /mnt/disk01/workspaces/worksummary/hermes-web-ui

TODAY=$(date +%Y%m%d)
docker build -t ekkoye8888/hermes-web-ui:latest -t ekkoye8888/hermes-web-ui:${TODAY} .
```

## 步骤 6：部署到 K8s 开发环境

```bash
# 导入 containerd（先删旧标签！否则不会覆盖）
sudo ctr -n k8s.io images rm docker.io/ekkoye8888/hermes-web-ui:latest 2>/dev/null
docker save ekkoye8888/hermes-web-ui:latest | sudo ctr -n k8s.io images import -
sudo ctr -n k8s.io images tag \
  docker.io/ekkoye8888/hermes-web-ui:latest \
  docker.io/ekkoye8888/hermes-web-ui:${TODAY} --force

# 滚动重启
kubectl rollout restart deployment/hermes-gateway-{1..7} -n hermes-agent
kubectl rollout status deployment/hermes-gateway-{1..7} -n hermes-agent --timeout=180s

# 验证
kubectl get pods -n hermes-agent | grep gateway
```

## 步骤 7：线上验证

```bash
# 验证首页标题
curl -s -H "Host: agent1.172-32-153-184.nip.io" http://localhost:40080/ | grep -o '<title>[^<]*</title>'

# 验证 favicon
curl -s -H "Host: agent1.172-32-153-184.nip.io" http://localhost:40080/favicon.ico -o /tmp/check.ico
file /tmp/check.ico

# 验证 auth status
curl -s -H "Host: agent1.172-32-153-184.nip.io" http://localhost:40080/api/auth/status
```

浏览器访问 `http://agent1.172-32-153-184.nip.io:40080/`：
- 品牌名显示 NewHermes
- Logo 显示新图标
- 侧边栏无中转站链接、无版本信息、无退出按钮

## 步骤 8：更新需求文档

- 更新 `upgrade-requirements.md`，标注当前基准版本
- 记录哪些需求已被上游采纳、哪些仍需手动修改

---

## 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 构建失败 TS6133 | 移除功能后残留未使用的导入 | 删除对应的 import 和变量 |
| containerd 导入不生效 | 旧 tag 未删除 | 先 `ctr images rm` 再 import |
| favicon 未更新 | 浏览器缓存 | Ctrl+Shift+R 强制刷新 |
| Logo 是旧版本 | 未重新转换 | 重新执行 ImageMagick 转换命令 |
| GitHub 代理不通 | 代理服务未启动 | 先通过 curl API 获取最新版本信息 |
| git fetch 超时 | 代理和直连都不通 | `git -c http.proxy=` 显式指定代理 |
| 需求遗漏 | 从旧分支 diff 迁移 | 改为按需求文档在纯净版本上逐项修改 |

## 注意事项

- **永远不要 `git push` 到 origin/main** — 本地分支 `local-v*` 只在本地维护
- **containerd 不覆盖** — 导入前必须先 `ctr images rm` 旧标签
- **本机即 184** — 不需要 SSH，直接本地操作
- **GitHub 需代理** — `https_proxy=http://172.32.147.190:7890`
- **按需求文档修改，不按旧分支 diff 迁移** — 这是 v2.0 的核心变化
