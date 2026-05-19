# Admin 前端合并部署适配方案

> 日期：2026-05-19
> 状态：已审核，待实施
> 前置：gateway+webui 合并部署已完成（10 Pod → 5 Pod）
> 审核：前端架构专家 + 需求完整性专家（2026-05-19）

## 背景

合并部署将独立的 gateway（hermes-agent 镜像，port 8642）和 webui（hermes-web-ui 镜像，port 6060）合并为单个容器。后端 `agent_manager.py` 已更新为 `render_webui_deployment()`，前端需要适配。

## 不需要改的区域

| 区域 | 原因 |
|------|------|
| 侧边栏导航 (AdminLayout.tsx) | 菜单项仍然有效 |
| 仪表盘 (DashboardPage.tsx) | 后端只返回 gateway 部署，已自动适配 |
| 模板管理 | 与部署架构无关 |
| User 模式菜单 | 流程不受合并影响 |

## 需要改的区域

### 改动 1：创建 Agent 部署进度步骤对齐 [现有 Bug]

**问题**：后端 7 步 vs 前端 5 步，步骤状态错位。前端通过数组索引 `deployResult?.steps?.[idx]` 映射，导致 Step 4 (Creating Service) 显示为 "Update Ingress"，Step 6-7 完全不可见。

| # | 后端 (agent_manager.py) | 前端 stepLabels 现状 |
|---|-------------------------|---------------------|
| 1 | Creating Secret | ✅ deployStepSecret |
| 2 | Initializing data directory | ✅ deployStepInitData |
| 3 | Creating Deployment | ✅ deployStepCreateDeployment |
| 4 | Creating Service | ❌ 缺失（当前被 Ingress 标签覆盖） |
| 5 | Updating Ingress | ⚠️ 显示为第 4 步 |
| 6 | Creating nip.io Ingress | ❌ 缺失（完全不可见） |
| 7 | Waiting for ready | ⚠️ 显示为第 5 步 |

**涉及文件**：
- `admin/frontend/src/i18n/zh.ts` — 添加 `deployStepCreateService`、`deployStepNipIngress`
- `admin/frontend/src/i18n/en.ts` — 同步添加（注意：`zh.ts` 是 Translations 接口权威源，必须先改）
- `admin/frontend/src/pages/CreateAgentPage.tsx` — `stepLabels` 从 5 项扩展到 7 项（第 955 行）
- `admin/frontend/e2e/fixtures/mock-data.ts` — `mockCreateAgentResponse.steps` 从 5 项更新到 7 项

### 改动 2：Agent 详情 Overview 添加 WebUI URL [纯 UI 添加]

**问题**：合并后每个 agent 有独立的 nip.io URL，但 Overview tab 没有展示。

**已有基础设施**（无需后端/类型改动）：
- 后端 `AgentDetailResponse` 已有 `webui_url` 字段（models.py:176）
- 前端 `AgentDetail` 接口已有 `webui_url?: string`（admin-api.ts:212）
- Mock 数据已包含 `webui_url` 值（mock-data.ts:132）
- `AdminLayout.tsx` 已在 User 模式使用此字段

**只需**：在 `OverviewTab` JSX 中添加 UI 展示。

**涉及文件**：
- `admin/frontend/src/pages/AgentDetailPage.tsx` — Overview tab 中 API Access 卡片（~第 601 行）后添加 WebUI URL 卡片
- `admin/frontend/src/i18n/zh.ts` — 添加 `webuiUrl`、`webuiUrlHint`
- `admin/frontend/src/i18n/en.ts` — 同步添加

**UI 设计**：
- 在 API Access 卡片下方
- 显示可点击的 WebUI 地址（新标签页打开）
- 包含复制按钮

## 实施顺序

1. 添加 i18n keys（先 `zh.ts` 接口+值，再 `en.ts` 值）
2. 更新 `CreateAgentPage.tsx` stepLabels（5→7 项）
3. 更新 E2E mock `mockCreateAgentResponse.steps`（5→7 项）
4. `AgentDetailPage.tsx` Overview 添加 WebUI URL 卡片
5. TypeScript 编译验证 (`npx tsc --noEmit`)
6. E2E 测试验证 (`npx playwright test`)
7. 重建 admin 镜像并部署到 184
8. 手动验证创建 Agent 流程和 Overview 显示

## 审核发现（已纳入方案）

| 级别 | 发现 | 处理 |
|------|------|------|
| HIGH | 步骤映射错位是现有 bug，非未来需求 | 已纳入改动 1 |
| HIGH | 3 个 E2E 测试使用 5 步 mock | 已纳入实施步骤 3 |
| MEDIUM | webui_url 类型和数据已存在，纯 UI 添加 | 已在改动 2 注明 |
| MEDIUM | `zh.ts` 是 Translations 接口源，必须先改 | 已在实施步骤 1 注明 |
| MEDIUM | 数组索引映射脆弱，后端跳步会导致错位 | 本次不改，后续优化为按 step.label 动态渲染 |
| MEDIUM | nip.io 步骤失败是非致命的，UI 无区分 | 后续优化 |
| LOW | 后端 step 注释编号与实际 step 数字不一致 | 可选清理 |

## 验证标准

- [ ] 创建 Agent 部署进度显示 7 个步骤，标签正确
- [ ] 每个步骤状态图标正确（pending/running/done/failed）
- [ ] Overview tab 显示 WebUI URL 可点击链接
- [ ] 仪表盘正确显示 agent 卡片
- [ ] 侧边栏导航正常
- [ ] 所有 E2E 测试通过
- [ ] i18n 文件同步（zh/en）
- [ ] User 模式流程正常（登录→agent 详情→聊天/文件/面板）
