---
name: docker-image-version-check
description: |
  Docker 镜像版本检查最佳实践。Use when: (1) 需要判断远程 Docker 镜像是否有更新,
  (2) docker pull 前需要确认是否需要下载, (3) 对比本地和远程镜像是否一致。
  关键原则：先查后拉，用 digest 判断，不要用版本号判断。
author: Claude Code
version: 1.0.0
date: 2026-06-01
---

# Docker 镜像版本检查

## Problem
直接 `docker pull` 下载镜像很慢（可能几分钟到几十分钟），而镜像可能根本没有更新。需要先快速确认是否有新版本，再决定是否下载。

## Context / Trigger Conditions
- 需要更新基础镜像（如 `nousresearch/hermes-agent:latest`）
- 想确认远程是否有比本地更新的镜像
- 需要判断是否需要重新构建和部署

## Solution

### 1. 先查 Docker Hub API（秒级完成）

```bash
# 需要代理（直连 Docker Hub API 可能超时）
https_proxy=http://YOUR_PROXY curl -s \
  "https://hub.docker.com/v2/repositories/OWNER/IMAGE/tags/?page_size=5&ordering=last_updated" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
for t in d.get('results',[]):
  print(f\"{t['name']:20s} 更新于 {t.get('last_updated','?')[:10]}  digest: {t['digest'][:24]}...\")
"
```

### 2. 对比本地镜像

```bash
# 本地镜像 digest 和创建时间
docker images OWNER/IMAGE --digests --format "{{.Tag}}\t{{.Digest}}\t{{.CreatedAt}}"
```

### 3. 只有 digest 不同时才 pull

```bash
# digest 相同 → 不需要 pull
# digest 不同 → 需要更新
docker pull OWNER/IMAGE:latest
```

## Key Rules

| 做法 | 正确 ✅ | 错误 ❌ |
|------|---------|---------|
| 检查顺序 | 先查 Docker Hub → 再决定 pull | 先 pull → 再查版本 |
| 对比方法 | 用 digest/SHA 对比 | 用 `--version` 对比 |
| 版本号 | 仅作参考，不作为更新依据 | 仅凭版本号判断是否更新 |

### 为什么版本号不可靠？

- `--no-cache` 重建后镜像 SHA 变了，但版本号可能不变
- 基础镜像可能重新构建（OS 更新、依赖修补）但不改版本号
- npm/pip 依赖更新不会反映在版本号中

## Example

```bash
# ✅ 正确流程
# Step 1: 查远程（秒级）
https_proxy=http://172.32.147.190:7890 curl -s \
  "https://hub.docker.com/v2/repositories/nousresearch/hermes-agent/tags/?page_size=3&ordering=last_updated"

# Step 2: 对比本地
docker images nousresearch/hermes-agent --digests

# Step 3: 仅当需要时 pull
docker pull nousresearch/hermes-agent:latest

# Step 4: pull 后用 digest 确认
docker images nousresearch/hermes-agent --digests
```

## Notes
- Docker Hub API 不走代理可能超时，务必配置 `https_proxy`
- Docker Hub API 的 digest 字段和 `docker images --digests` 显示的 digest 格式可能不同（一个是 manifest digest，一个是 image digest），但只要一致就说明是同一镜像
- `docker pull` 显示 "Image is up to date" 说明本地已是最新
