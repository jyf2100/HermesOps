# Kanban 功能闭环修复计划

**产品经理**: 综合后端/架构/前端设计/TypeScript 五方专家 Review
**日期**: 2026-05-09
**目标**: 补齐 Kanban 操作闭环 + 修复专家发现的 CRITICAL/HIGH 问题

---

## 一、现状诊断

### 1.1 核心问题：操作断链

```
创建任务 ✓ → 手动 dispatch ✓ → worker spawn ✓ → ??? → blocked/done ✗
                                                  ↑
                                              这里断了
```

操作员能看到任务创建和 dispatch，但：
1. **看不到执行过程** — 没有日志，不知道 worker 在干什么
2. **看不到执行结果** — 任务完成了，summary/result 没展示
3. **无法恢复失败** — 任务 blocked 后没有重试按钮
4. **Dispatch 无反馈** — 点了 dispatch 按钮不知道成功没

### 1.2 专家 Review 汇总

**后端 Review（Python Expert）:**

| 严重性 | 问题 | 文件 |
|--------|------|------|
| CRITICAL | CORS 缺少 PATCH 方法，浏览器跨域请求被拦截 | main.py:117 |
| CRITICAL | Auth 重复实现 3 次（kanban/swarm/main），DRY 违规 | 三个文件 |
| HIGH | `_dashboard_cache` 无并发保护，shutdown/get_client 竞态 | kanban_routes.py:17 |
| HIGH | `_proxy` 不验证 agent_id 对应的 deployment 是否存在 | kanban_routes.py:69 |
| HIGH | readinessProbe 用 `/board` 返回完整数据，浪费资源 | templates.py:225 |
| MEDIUM | `kanban_list_tasks` 和 `kanban_board` 代理到相同后端路径 | kanban_routes.py:121-125 |
| MEDIUM | 所有端点缺少返回类型注解 | kanban_routes.py |

**前端设计 Review（Frontend Expert）:**

| 严重性 | 问题 | 文件 |
|--------|------|------|
| CRITICAL | `bg-surface-secondary` / `bg-surface-tertiary` CSS 变量未定义，列/评论背景透明 | KanbanColumn.tsx:57, TaskDrawer.tsx:239 |
| CRITICAL | `pollIntervalId` 模块级可变全局状态，测试无法隔离 | kanbanBoard.ts:33 |
| CRITICAL | TaskDrawer 中 `as unknown as Record<>` 不安全类型转换链 | TaskDrawer.tsx:49-50 |
| HIGH | 拖拽无视觉反馈（无 opacity/ring 变化） | KanbanCard.tsx:27-40 |
| HIGH | Dialog/Drawer 无焦点捕获，Tab 键泄露焦点 | CreateTaskModal.tsx, TaskDrawer.tsx |
| HIGH | `created_at` 显示为原始 Unix 时间戳（如 "1746789123"） | TaskDrawer.tsx:219 |
| HIGH | TaskDrawer 滑入动画不工作（从 null 到 mount 无法触发 transition） | TaskDrawer.tsx:58 |
| HIGH | `tasksByStatus` 在渲染路径内定义，每次渲染创建 6 个新数组 | KanbanTab.tsx:100-102 |
| MEDIUM | Store 和 TaskDrawer 绕过 `adminApi.kanban` 方法直接用 `adminFetch` | kanbanBoard.ts, TaskDrawer.tsx |
| MEDIUM | 轮询不感知标签页可见性，后台标签页浪费请求 | kanbanBoard.ts:57 |
| MEDIUM | `text-[10px]` 重复使用，低于 WCAG 可读性最低标准 | 多个文件 |
| MEDIUM | label/input 未通过 htmlFor/id 程序化关联 | CreateTaskModal.tsx, TaskDrawer.tsx |

---

## 二、修复计划

### Sprint 1: CRITICAL 修复 + 最小闭环（P0）

> 目标：消除阻断性 Bug，建立基本操作闭环

#### 1.1 CORS 添加 PATCH 方法
- **文件**: `admin/backend/main.py:117`
- **修改**: `allow_methods` 列表添加 `"PATCH"`
- **耗时**: 1 min

#### 1.2 定义缺失的 CSS 变量
- **文件**: `admin/frontend/src/index.css`
- **修改**: 在 `@theme` 块中添加 `--color-surface-secondary` 和 `--color-surface-tertiary`
- **耗时**: 2 min

#### 1.3 修复时间戳显示
- **文件**: `TaskDrawer.tsx`
- **修改**: 添加 `formatTime()` 工具函数，用 `Intl.DateTimeFormat` 格式化 `created_at`、`completed_at`、`comment.created_at`
- **耗时**: 5 min

#### 1.4 修复 TaskDrawer 滑入动画
- **文件**: `TaskDrawer.tsx`
- **修改**: 始终渲染 drawer 外壳（不为 null 时 return null），通过 CSS class 控制 open/close 状态
- **耗时**: 10 min

#### 1.5 添加 Unblock/Retry 按钮
- **文件**: `TaskDrawer.tsx`
- **功能**: 当 status=blocked 时显示 "Unblock & Retry" 按钮，PATCH `{status:"ready"}` + 重置 failures
- **耗时**: 10 min

#### 1.6 Dispatch 反馈优化
- **文件**: `KanbanTab.tsx`
- **功能**: Dispatch 返回后 toast 展示 spawned/crashed/blocked 数量
- **耗时**: 5 min

#### 1.7 任务结果展示
- **文件**: `TaskDrawer.tsx`
- **功能**: 展示 `latest_summary`、`result`、`last_failure_error`、`worker_pid`
- **耗时**: 10 min

**Sprint 1 总耗时**: ~45 min

### Sprint 2: 体验增强（P1）

> 目标：日志查看 + 拖拽反馈 + 自动 dispatch

#### 2.1 Worker 日志查看
- **后端**: `kanban_routes.py` 添加 `GET /tasks/{id}/log` 端点
  - 通过 K8s exec 读取 `/opt/data/kanban/logs/{task_id}.log` 最后 200 行
- **前端**: `TaskDrawer.tsx` 添加可折叠日志面板
- **耗时**: 25 min

#### 2.2 拖拽视觉反馈
- **文件**: `KanbanCard.tsx`
- **修改**: `onDragStart` 设 `opacity-50`，`onDragEnd` 恢复；添加 `onDragEnd` 清理逻辑
- **耗时**: 10 min

#### 2.3 Running 状态视觉指示
- **文件**: `KanbanCard.tsx`
- **修改**: running 卡片添加 pulse 动画，blocked 卡片添加红色图标
- **耗时**: 10 min

#### 2.4 创建后自动 Dispatch
- **文件**: `kanbanBoard.ts`
- **修改**: `createTask` 完成后自动调用 dispatch 端点
- **耗时**: 10 min

#### 2.5 消除不安全类型转换
- **文件**: `kanban-types.ts` + `TaskDrawer.tsx`
- **修改**: 定义 `KanbanTaskDetail`（扩展 `KanbanTask` + `comments` 字段），替换所有 `as unknown as` 链
- **耗时**: 10 min

**Sprint 2 总耗时**: ~65 min

### Sprint 3: 工程质量（P2）

> 目标：Review 发现的所有 HIGH 问题

#### 3.1 Auth 逻辑统一
- **文件**: 新建 `admin/backend/auth.py`，修改三个路由文件
- **耗时**: 15 min

#### 3.2 缓存并发保护
- **文件**: `kanban_routes.py`
- **修改**: 添加 `asyncio.Lock` 保护 `_dashboard_cache`
- **耗时**: 5 min

#### 3.3 焦点捕获
- **文件**: `CreateTaskModal.tsx`, `TaskDrawer.tsx`
- **修改**: 添加 `useEffect` 实现 Tab/Shift+Tab 焦点循环
- **耗时**: 15 min

#### 3.4 轮询感知标签页可见性
- **文件**: `kanbanBoard.ts`
- **修改**: `visibilitychange` 事件监听，隐藏时暂停轮询
- **耗时**: 10 min

#### 3.5 tasksByStatus 性能优化
- **文件**: `KanbanTab.tsx`
- **修改**: `useMemo` 预计算按状态分组的任务 Map
- **耗时**: 5 min

#### 3.6 label/input 关联
- **文件**: `CreateTaskModal.tsx`, `TaskDrawer.tsx`
- **修改**: 添加 htmlFor/id 属性关联
- **耗时**: 5 min

**Sprint 3 总耗时**: ~55 min

### Sprint 4: 后续迭代（P3）

#### 4.1 实时日志流（SSE）
- 通过 SSE 从 dashboard sidecar 推送 worker 日志

#### 4.2 任务搜索与过滤
- 按状态过滤、按优先级排序、关键词搜索

#### 4.3 批量操作
- 多选任务、批量状态变更、批量 dispatch

#### 4.4 i18n
- 所有 kanban 文本翻译为中文/英文

#### 4.5 乐观更新
- 拖拽时立即更新本地状态，失败后回滚

---

## 三、实施顺序

```
Sprint 1 (P0)          Sprint 2 (P1)        Sprint 3 (P2)
  1.1 CORS PATCH         2.1 日志查看          3.1 Auth 统一
  1.2 CSS 变量           2.2 拖拽反馈          3.2 缓存锁
  1.3 时间戳             2.3 Running 动画      3.3 焦点捕获
  1.4 滑入动画           2.4 自动 dispatch     3.4 可见性轮询
  1.5 Unblock            2.5 类型安全          3.5 性能优化
  1.6 Dispatch 反馈                            3.6 Label 关联
  1.7 结果展示
  ↓                       ↓                     ↓
  部署验证               部署验证               部署验证
```

## 四、验收标准

1. 创建任务 → 自动 dispatch → worker 执行 → 看到日志 → 看到结果
2. 任务失败 → 看到失败原因 → 点击重试 → 重新执行
3. 任务 blocked → 点击 unblock → 恢复 ready → 重新执行
4. 所有 kanban PATCH 请求不被 CORS 拦截
5. 列背景色正确渲染（不再透明）
6. 时间戳人类可读
7. Drawer 滑入动画正常
8. 拖拽有视觉反馈
