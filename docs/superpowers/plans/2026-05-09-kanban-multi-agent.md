# Admin 看板多 Agent 协作 — 需求设计文档

> 日期：2026-05-09
> 状态：设计完成，待实现
> 分支：2026.5.9

## 一、背景

Hermes 上游内核已支持完整的多 Agent 看板协作能力（profile 分派、父子依赖图、编排拆解、结构化交接），但 Admin 面板只暴露了最基础的单 agent 任务管理。本设计补齐 Admin UI 对上游多 agent 能力的暴露。

### 上游已有能力（Admin 未暴露）

| 能力 | 上游实现 | Admin 状态 |
|------|---------|-----------|
| Assignee profile 分派 | `_default_spawn()` 用 `hermes -p <assignee>` 启动子进程 | 文本输入框，无选择器 |
| 父子依赖图 | `task_links` 表，`link_tasks()` 写入，`recompute_ready()` 自动推进 | 无 UI |
| 任务进度 | `/board` 返回 `link_counts`、`progress` | 数据已返回，前端未用 |
| Profile 列表 | `GET /api/plugins/kanban/assignees` 返回已知 profile + 负载 | 未代理 |
| 编排拆解 | `kanban-orchestrator` 技能自动生成子任务 | 无 UI |
| 诊断引擎 | `kanban_diagnostics.py` 检测幻觉卡片、连续失败等 | 无 UI |

### 约束

1. **一期只做同 agent 内的多 profile 协作**。`dispatch_once()` 只在单个 pod 内运行，不能把任务分发给另一个 agent。
2. **Admin 不直接操作 kanban SQLite DB**，只通过 dashboard sidecar API 代理。
3. **纯代理透传架构**：Admin backend 只补代理路由，不增加业务逻辑。

---

## 二、用户场景

### 场景 1：项目经理拆解复杂任务

运营人员收到"撰写竞品分析报告"的需求。他在看板创建一个 orchestrator 任务，指定 assignee 为 orchestrator profile，附加 kanban-orchestrator skill。系统自动拆解为 researcher 调研、analyst 分析、writer 撰写三个子任务，按依赖链串联。他只需看全局进度。

### 场景 2：开发者排查卡住的任务链

一个 5 步流水线在第 3 步失败。开发者打开 TaskDrawer，看到依赖图——一眼定位哪一步卡住、失败原因、上游交付内容。直接操作重试或手动推进。

### 场景 3：管理员调整任务分配

创建任务时 assignee 填错，任务已 running。管理员在 TaskDrawer 中从下拉列表切换 assignee 到正确的 profile，重置状态为 ready，重新派发。

### 场景 4：观察者查看 agent 间交接质量

技术负责人点开子任务的 TaskDrawer，查看"上游产出"区域的 summary 和 metadata，确认父任务交付的信息完整性。

---

## 三、功能优先级

### P0 — 必做（解锁基本多 Agent 协作）

#### P0-1：Assignee Profile 选择器

**当前**：`CreateTaskModal` 和 `TaskDrawer` 的 assignee 是纯文本 `<input>`，默认值 "default"。

**目标**：下拉选择器，列出 agent 已配置的 profile 名称，消除拼写错误。

**后端**：
```
# kanban_routes.py 新增
GET /agents/{agent_id}/kanban/assignees
  → proxy to sidecar GET /api/plugins/kanban/assignees
  → 返回 AssigneeProfile[]
```

**前端**：
- `kanbanBoard.ts` 新增 `assignees: AssigneeProfile[]` state + `fetchAssignees(agentId)` action
- `CreateTaskModal.tsx` — modal 打开时拉取 assignees，assignee 替换为 combobox（可搜索 + 可手动输入）
- `TaskDrawer.tsx` — 同样替换 assignee 输入为 combobox
- 每个 option 显示：profile 名称 + 当前任务数（负载提示）

**类型定义**：
```typescript
interface AssigneeProfile {
  name: string;
  on_disk: boolean;
  counts: Record<KanbanStatus, number>;
}
```

#### P0-2：任务依赖关系（创建时指定 parents）

**当前**：创建任务时不传 `parents` 字段。

**目标**：CreateTaskModal 增加"上游任务"多选区域，从当前 board 任务列表中选择。

**数据流**：
```
前端 POST /tasks { title, body, ..., parents: ["task-001", "task-002"] }
  → sidecar create_task() → link_tasks() 写入 task_links 表
  → 子任务初始状态 todo，等所有 parents done 后 recompute_ready() → ready
  → dispatcher pick up ready 任务，spawn worker
```

**前端**：
- `kanbanBoard.ts` — `createTask` 参数增加 `parents?: string[]`
- `CreateTaskModal.tsx` — 新增 parents 多选区域：
  - 搜索框过滤当前 board 任务
  - 已选 parents 显示为可删除标签
  - 不允许选择自己、不允许循环依赖（前端 BFS 检测）

#### P0-3：KanbanCard 依赖状态显示

**当前**：卡片只显示 title、priority、skills、labels。

**目标**：利用 `/board` 已返回的 `link_counts` 和 `progress` 字段。

**显示规则**：
- 有父任务且未全部完成：显示 `⬆ 2` 灰色图标（等待 2 个上游）
- 有父任务且全部完成：显示 `⬆ ✓` 绿色图标
- 有子任务：显示 `⬇ 3`（3 个下游）
- 父任务显示进度：`2/3 done`

**前端**：
- `kanban-types.ts` — `KanbanTask` 增加：
  ```typescript
  link_counts?: { parents: number; children: number };
  progress?: { done: number; total: number };
  parents?: string[];
  children?: string[];
  ```
- `KanbanCard.tsx` — 在 priority dot 旁边或卡片底部增加依赖 badge

#### P0-4：TaskDrawer 依赖关系展示

**目标**：TaskDrawer 新增"依赖关系"区域。

**展示**：
- "上游任务"：列出 parents，每条显示 title + status badge，可点击跳转到该任务的 Drawer
- "下游任务"：列出 children，同上
- 子任务状态聚合：如 "2/3 已完成"

**数据来源**：`GET /tasks/{id}` 已返回完整 `links` 对象。前端请求时额外获取关联任务的标题。

---

### P1 — 应做（提升可观测性）

#### P1-1：任务依赖图可视化

**在看板顶部增加"图视图"切换按钮**：
- 默认看板视图（列模式）
- 切换后显示 DAG 图：节点 = 任务，有向边 = 依赖关系
- 节点颜色映射状态（triage=灰, running=蓝, done=绿, blocked=红）
- 点击节点打开 TaskDrawer

**渲染方案**：轻量自绘 DAG（CSS 定位 + SVG 连线），用拓扑排序做层级布局。不引入外部图形库。

#### P1-2：上游产出查看

**TaskDrawer 新增"上游产出"区域**：
- 展示每个父任务的 `latest_summary` 和 `result`
- 便于确认上游交付质量

**实现**：从 `GET /tasks/{id}` 获取父任务 ID 列表，再逐个请求父任务详情获取 summary/result。可并行请求。

#### P1-3：一键编排拆解

**CreateTaskModal 增加"自动拆解"开关**：
- 勾选后，任务自动附加 `skills: ["kanban-orchestrator"]`
- Worker 执行时会调用 `kanban_create` 自动生成子任务图
- 用户无需手动创建子任务

**实现**：前端在提交时，如果"自动拆解"开关打开，在 skills 列表中追加 `kanban-orchestrator`。无需新 API。

---

### P2 — 可选

| 功能 | 说明 |
|------|------|
| 诊断告警横幅 | 看板顶部显示连续失败、幻觉卡片等告警，依赖上游诊断引擎 |
| Assignee 过滤 | 看板顶部按 profile 过滤显示，前端过滤即可 |
| 跨任务 @提及 | 评论中 @任务ID 自动在该任务下创建引用评论 |

---

### 非目标

1. 不做实时协作编辑（多用户冲突解决）
2. 不做 profile 增删改管理（属于 Agent 配置页面职责）
3. 不做任务执行日志流式查看（已有 TerminalTab）
4. 不做工作流模板保存/复用（YAGNI）
5. **不做跨 agent 的任务链接**（每个 agent 看板独立，跨 agent 走 Orchestrator）

---

## 四、数据模型变更

### kanban-types.ts 扩展

```typescript
// 新增类型
interface AssigneeProfile {
  name: string;
  on_disk: boolean;
  counts: Record<KanbanStatus, number>;
}

// KanbanTask 扩展字段
interface KanbanTask {
  // ... 已有字段 ...
  parents?: string[];
  children?: string[];
  link_counts?: { parents: number; children: number };
  progress?: { done: number; total: number };
}

// KanbanTaskDetail 扩展字段
interface KanbanTaskDetail extends KanbanTask {
  // ... 已有字段 ...
  links?: {
    parents: { id: string; title: string; status: KanbanStatus }[];
    children: { id: string; title: string; status: KanbanStatus }[];
  };
}
```

### kanbanBoard.ts Store 扩展

```typescript
// 新增 state
assignees: AssigneeProfile[];

// 新增 actions
fetchAssignees(agentId: number): Promise<void>;
createTask(agentId, data: {
  // ... 已有字段 ...
  parents?: string[];
}): Promise<void>;
```

---

## 五、后端变更清单

### kanban_routes.py 新增路由

| 路由 | 方法 | 代理目标 |
|------|------|---------|
| `/agents/{id}/kanban/assignees` | GET | sidecar `/api/plugins/kanban/assignees` |
| `/agents/{id}/kanban/links` | POST | sidecar `/api/plugins/kanban/links` |

### 无需变更

- `POST /tasks` 已透传 body（含 parents），无需改动
- `GET /board` 已返回 link_counts、progress，无需改动
- `GET /tasks/{id}` 已返回 links，无需改动

---

## 六、前端组件变更清单

| 组件 | P0 变更 | P1 变更 |
|------|---------|---------|
| `kanban-types.ts` | +link_counts, progress, parents/children, AssigneeProfile, links | — |
| `kanbanBoard.ts` | +assignees state, fetchAssignees(), createTask 透传 parents | — |
| `CreateTaskModal.tsx` | assignee→combobox, +parents 多选区 | +自动拆解开关 |
| `TaskDrawer.tsx` | assignee→combobox, +依赖关系区域 | +上游产出区 |
| `KanbanCard.tsx` | +link_counts badge（⬆⬇图标） | — |
| `KanbanTab.tsx` | — | +图视图切换按钮 |
| `admin-api.ts` | +getAssignees() | — |
| `i18n/zh.ts` + `en.ts` | ~15 个新 key | ~10 个新 key |

---

## 七、实施顺序

### Phase 1：P0（预计 2-3 天）

1. `kanban_routes.py` — 新增 `/assignees` 代理路由
2. `kanban-types.ts` — 扩展类型定义
3. `kanbanBoard.ts` — 新增 assignees state + fetchAssignees
4. `admin-api.ts` — 新增 getAssignees
5. `CreateTaskModal.tsx` — assignee combobox + parents 多选
6. `TaskDrawer.tsx` — assignee combobox + 依赖关系区域
7. `KanbanCard.tsx` — link_counts badge
8. `i18n` — 新增翻译 key
9. 构建部署验证

### Phase 2：P1（预计 2-3 天）

1. `KanbanTab.tsx` — 图视图切换 + DAG 渲染
2. `TaskDrawer.tsx` — 上游产出区域
3. `CreateTaskModal.tsx` — 自动拆解开关

### Phase 3：P2（按需）

1. 诊断告警横幅
2. Assignee 过滤
3. 跨任务 @提及

---

## 八、关键风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 循环依赖（A→B→C→A） | 任务永远无法 ready | 前端 BFS 环检测 + 上游 `link_tasks()` 校验 |
| Profile 列表为空 | 无法选择 assignee | combobox fallback 到手动输入 |
| dispatch 只在单 pod 内 | 不能跨 agent 分派 | 一期限定同 agent 多 profile |
| 大量任务 DAG 渲染 | 前端卡顿 | 只渲染直接依赖（2 层），懒加载展开 |
| 15s 轮询延迟 | 父任务完成后子任务状态不即时 | dispatch 后强制刷新 board |

---

## 九、成功指标

| 指标 | 基线 | 目标 |
|------|------|------|
| 多步任务创建率 | 0% | 2 周内 >20% 任务含 parents |
| 任务阻塞发现时间 | 人工巡检 | <5 分钟 |
| Assignee 错误率 | 文本输入常出错 | <2% |
