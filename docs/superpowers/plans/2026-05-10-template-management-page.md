# Profile Template 管理页面 — 需求设计文档

> 版本: 1.1 | 日期: 2026-05-10 | 状态: 评审反馈已 incorporated

## 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-05-10 | 初稿 |
| 1.1 | 2026-05-10 | 整合需求专家 + 架构专家评审反馈 |

## 1. 背景与问题

### 现状

Hermes Admin 的 Profile 配置管理系统包含三层结构：

```
默认配置 (DEFAULT) → 模板覆盖 (Template) → Profile 覆盖 (Profile) → Agent Pod
```

后端已提供完整的模板 CRUD + 克隆 API（6 个端点），前端已有：
- `ProfileList` 组件：管理 agent 级别的 profile（创建/编辑/删除/同步）
- `ProfileEditor` 组件：profile 编辑弹窗，含模板选择下拉框

### 问题

1. **模板只能被选择，不能被管理**：前端只有 `GET /profile-templates` 被调用（填充下拉框），POST/PUT/DELETE/clone 端点无前端消费
2. **管理员只能通过 API 管理模板**：创建、编辑、删除模板都需要直接调用 API，无 UI 支持
3. **Skills 配置不透明**：模板的 `config_overrides` 中包含 `skills.enabled/disabled`，但管理员无法直观看到模板和技能的关联关系
4. **内置模板不可发现**：管理员不知道系统预置了哪些模板、每个模板做了什么配置

### 目标用户

Hermes 集群管理员（**admin-only**，不对 user mode 开放）。

## 2. 功能需求

### F1: 模板列表页

**路由**: `/templates`

**权限**: admin-only（前端参照 SwarmGuard 模式守卫，侧边栏仅管理员可见）

**优先级**: P0

**描述**: 以卡片网格形式展示所有模板（内置 + 自定义），支持筛选和搜索。

**验收标准**:

| ID | 验收条件 |
|----|---------|
| F1.1 | 页面加载时调用 `GET /profile-templates` 获取所有模板 |
| F1.2 | 以 responsive 卡片网格展示：`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4` |
| F1.3 | 每张卡片显示：display_name、description（截断至 2 行）、profile_count、更新时间、内置/自定义 badge、skills 标签（如有，以 tag 形式展示 enabled skill 名称） |
| F1.4 | 支持三种筛选：全部 / 内置 / 自定义（tab 切换） |
| F1.5 | 支持按 name 和 display_name 搜索，使用后端 `?search=` API + 300ms debounce |
| F1.6a | **无模板空状态**："暂无模板"（系统初始化异常，极少出现） |
| F1.6b | **搜索/筛选无结果**："未找到匹配的模板" |
| F1.7 | 加载状态显示 skeleton 或 loading 文字 |
| F1.8 | API 错误时显示错误信息 + 重试按钮 |

### F2: 模板创建

**优先级**: P0

**描述**: 通过弹窗表单创建新的自定义模板。

**验收标准**:

| ID | 验收条件 |
|----|---------|
| F2.1 | 点击 Header 的"新建模板"按钮，弹出 ModalOverlay 编辑器 |
| F2.2 | 表单字段：name（必填）、display_name、description、config_overrides（JSON）、soul_md |
| F2.3 | name 校验：必填，正则 `^[a-zA-Z0-9_-]{1,64}$`（与后端 TemplateCreate 一致），不可与已有模板重名 |
| F2.4 | config_overrides 校验：合法 JSON，失败时显示 "Invalid JSON" 错误 |
| F2.5 | 保存成功后关闭弹窗、刷新列表、显示成功 toast |
| F2.6 | 保存失败显示错误信息（粉色错误框） |
| F2.7 | 支持三种关闭方式：Cancel 按钮、X 按钮、Escape 键 |

### F3: 模板编辑

**优先级**: P0

**描述**: 编辑已有模板的内容。

**验收标准**:

| ID | 验收条件 |
|----|---------|
| F3.1 | 点击卡片"编辑"按钮，弹出 ModalOverlay 编辑器，预填现有数据 |
| F3.2 | name 字段始终只读（创建后不可修改） |
| F3.3 | **内置模板**：config_overrides 和 soul_md 只读（灰色禁用），只能编辑 display_name 和 description |
| F3.4 | **自定义模板**：所有字段可编辑（name 除外） |
| F3.5 | 保存时调用 `PUT /profile-templates/{id}`，返回 `{template, affected_profiles}` |
| F3.6 | 当列表数据中该模板的 `profile_count > 0` 时，保存前显示确认提示："此修改将影响 {profile_count} 个关联 Profile，是否继续？"（使用列表中已缓存的 profile_count，不依赖 PUT 返回值） |
| F3.7 | 保存成功后刷新列表，toast 显示 "已更新，影响 {affected_profiles} 个 Profile" |

### F4: 模板删除

**优先级**: P0

**描述**: 删除自定义模板（内置模板不可删除）。

**验收标准**:

| ID | 验收条件 |
|----|---------|
| F4.1 | 自定义模板卡片显示"删除"按钮 |
| F4.2 | 内置模板卡片不显示"删除"按钮 |
| F4.3 | 点击删除弹出确认对话框："确认删除模板 '{display_name}'？" |
| F4.4 | 如果有关联 Profile（profile_count > 0），确认对话框附加提示："此模板关联了 {profile_count} 个 Profile。删除后，这些 Profile 将失去模板关联（template_id 置为 NULL），但其 config_overrides 不会改变，也不再跟随模板更新。" |
| F4.5 | 确认后调用 `DELETE /profile-templates/{id}` |
| F4.6 | 删除成功后刷新列表、显示成功 toast |

### F5: 模板克隆

**优先级**: P1

**描述**: 基于已有模板创建副本。

**验收标准**:

| ID | 验收条件 |
|----|---------|
| F5.1 | 点击卡片"克隆"按钮，弹出编辑器 |
| F5.2 | name 预填 `{原name}-copy`（可修改） |
| F5.3 | display_name 追加 "(副本)" 后缀，description、config_overrides、soul_md 复制原模板值 |
| F5.4 | 保存时调用 `POST /profile-templates/{id}/clone` |
| F5.5 | 保存成功后刷新列表 |

### F6: 技能管理 Tab

**优先级**: P1

**描述**: 在模板管理页面以独立 Tab 展示已注册的技能（Skills）聚合视图。

**验收标准**:

| ID | 验收条件 |
|----|---------|
| F6.1 | 页面顶部 Tab Bar：[模板管理] [技能管理]，默认显示模板管理 |
| F6.2 | 切换到技能管理 Tab 时，调用 `GET /profile-templates/skills-summary` 获取聚合数据（懒加载，切换回来不重新请求） |
| F6.3 | 以卡片网格展示技能，每张卡片显示：skill_name、被引用模板数 |
| F6.4 | 点击 skill 卡片，切换到模板管理 Tab 并用 `template_ids` 过滤显示关联模板（在 Header 下方显示 "筛选: {skill_name}" 条件标签，可清除） |
| F6.5 | 空状态："暂无技能注册，启动 Agent 后自动发现" |

### F7: 导航与路由

**优先级**: P0

**描述**: 在侧边栏增加模板管理导航入口。

**验收标准**:

| ID | 验收条件 |
|----|---------|
| F7.1 | 侧边栏增加"模板管理"导航项，位于 Dashboard 和 Settings 之间，仅 admin 模式可见 |
| F7.2 | 点击导航到 `/templates` |
| F7.3 | 当前页面为 `/templates` 时，导航项高亮 |
| F7.4 | i18n 支持：中英文导航文字 |
| F7.5 | ProfileEditor 模板选择下拉框旁增加"管理模板"链接，点击跳转 `/templates` |

## 3. 非功能需求

| ID | 需求 |
|----|------|
| NF1 | 页面加载时间 < 1s（API 响应时间除外） |
| NF2 | 全部交互支持中英文 i18n，无硬编码文字 |
| NF3 | 响应式布局：支持 768px-1920px 视口（与 AdminLayout 现有断点一致） |
| NF4 | 与现有设计系统保持一致（Tailwind + 项目 token + ModalOverlay） |
| NF5 | E2E 测试覆盖所有 P0 功能（至少 10 个核心场景：列表加载、内置/自定义筛选、搜索、创建、编辑内置、编辑自定义、删除确认、删除取消、错误状态、路由导航） |

## 4. 数据模型

### 模板 (ProfileTemplate)

```typescript
interface ProfileTemplateData {
  id: number;
  name: string;                        // 唯一标识, ^[a-zA-Z0-9_-]{1,64}$
  display_name: string;                // 显示名称
  description: string;                 // 描述
  config_overrides: Record<string, unknown>;  // 配置覆盖 (JSONB)
  soul_md: string | null;              // 系统提示词
  is_builtin: boolean;                 // 是否内置
  profile_count?: number;              // 关联 profile 数 (列表 API JOIN 返回)
  created_at: string;
  updated_at: string;
}
```

**注意**: `profile_count` 需添加到 `src/types/profile.ts` 的 `ProfileTemplateData` 接口中。后端 `GET /profile-templates` 已返回该字段。

### 技能摘要 (SkillSummary) — 新增 API

```typescript
interface SkillSummaryItem {
  name: string;
  template_count: number;
  template_ids: number[];
}

interface SkillsSummaryResponse {
  skills: SkillSummaryItem[];
}
```

## 5. API 规格

### 已有端点（无需修改）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/profile-templates` | 列表，支持 `?is_builtin=true/false` 和 `?search=xxx`（ILIKE 搜索 name + display_name） |
| POST | `/profile-templates` | 创建，请求体 `TemplateCreate` |
| GET | `/profile-templates/{id}` | 详情 |
| PUT | `/profile-templates/{id}` | 更新，返回 `{template, affected_profiles}` |
| DELETE | `/profile-templates/{id}` | 删除，内置不可删，外键 SET NULL 级联 |
| POST | `/profile-templates/{id}/clone` | 克隆 |

### 新增端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/profile-templates/skills-summary` | 聚合所有模板中 skills 字段，返回去重列表 |

**实现位置**: `admin/backend/profile_routes.py`（与模板管理同领域）

**实现方式**: Python 层全量加载模板 + 聚合（模板数量有限，< 100，无需 SQL 层优化或 GIN 索引）

```python
@router.get("/profile-templates/skills-summary", dependencies=[auth])
async def skills_summary(request: Request):
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(ProfileTemplate.id, ProfileTemplate.config_overrides)
        )
        rows = result.all()

    skills_map: dict[str, dict] = {}
    for tmpl_id, config in rows:
        if not isinstance(config, dict):
            continue
        skills_cfg = config.get("skills", {})
        for key in ("enabled", "disabled"):
            for name in skills_cfg.get(key, []):
                if name not in skills_map:
                    skills_map[name] = {"name": name, "template_ids": []}
                if tmpl_id not in skills_map[name]["template_ids"]:
                    skills_map[name]["template_ids"].append(tmpl_id)

    return {"skills": [
        {**v, "template_count": len(v["template_ids"])}
        for v in skills_map.values()
    ]}
```

## 6. 前端组件架构

```
TemplateListPage.tsx
├── Tab Bar (模板管理 / 技能管理)
├── Tab 1: 模板管理
│   ├── Header (标题 + 搜索框 + 新建按钮)
│   ├── Filter Bar (全部 / 内置 / 自定义) + skill 筛选条件标签
│   ├── TemplateCard[] (卡片网格)
│   └── TemplateEditor (ModalOverlay 弹窗)
└── Tab 2: 技能管理
    ├── Header
    └── SkillCard[] (卡片网格)
```

### 共享子组件提取（优先于新页面开发）

TemplateEditor 与 ProfileEditor 存在大量重复代码，先提取共享组件：

```
src/components/shared/
├── ModalOverlay.tsx        # 已有
├── JsonEditor.tsx          # 新增: JSON textarea + validation + error display
└── SoulMdEditor.tsx        # 新增: soul_md textarea + preview toggle
```

提取后 ProfileEditor 也应迁移使用这些共享组件。

### 页面级状态管理

提取自定义 hook `useTemplates()` 封装模板列表状态：

```typescript
function useTemplates() {
  const [templates, setTemplates] = useState<ProfileTemplateData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (search?: string) => { ... }, []);
  return { templates, loading, error, reload: load };
}
```

不引入 Zustand——模板页面状态是页面级的，不需要跨组件共享（仅在 ProfileEditor 的"管理模板"链接跳转时，页面会重新 mount）。

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/pages/TemplateListPage.tsx` | 页面组件，管理 Tab 切换、数据加载、搜索/筛选状态 |
| `src/components/template/TemplateCard.tsx` | 模板卡片，显示模板信息、skills 标签、操作按钮 |
| `src/components/template/TemplateEditor.tsx` | 创建/编辑/克隆弹窗表单，复用 JsonEditor + SoulMdEditor |
| `src/components/shared/JsonEditor.tsx` | JSON textarea + 实时校验 + 错误提示（从 ProfileEditor 提取） |
| `src/components/shared/SoulMdEditor.tsx` | soul_md textarea + 预览切换（从 ProfileEditor 提取） |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/App.tsx` | 添加 `/templates` → `TemplateListPage` 路由 |
| `src/components/AdminLayout.tsx` | 侧边栏添加"模板管理"导航项（admin-only） |
| `src/components/profile/ProfileEditor.tsx` | 迁移使用 JsonEditor + SoulMdEditor 共享组件 + 添加"管理模板"链接 |
| `src/types/profile.ts` | `ProfileTemplateData` 添加 `profile_count?: number` 字段 |
| `src/i18n/en.ts` | 添加模板管理相关英文 key |
| `src/i18n/zh.ts` | 添加模板管理相关中文 key |
| `src/lib/admin-api.ts` | 封装模板 CRUD API 方法（6 个现有 + 1 个 skills-summary） |

### 后端新增

| 文件 | 改动 |
|------|------|
| `admin/backend/profile_routes.py` | 添加 `GET /profile-templates/skills-summary` 端点 |

## 7. 实现阶段

### Phase 0: 共享组件提取

0. 从 ProfileEditor 提取 `JsonEditor` 和 `SoulMdEditor` 共享组件
1. ProfileEditor 迁移使用共享组件
2. 验证现有 147 个 E2E 测试不受影响

### Phase 1: P0 核心功能

3. `admin-api.ts` 封装模板 API 方法
4. `types/profile.ts` 添加 `profile_count` 字段
5. `TemplateCard` 组件
6. `TemplateEditor` 组件（复用 JsonEditor + SoulMdEditor）
7. `TemplateListPage` 页面（仅模板管理 Tab）
8. 路由 + 导航（App.tsx + AdminLayout + ProfileEditor"管理模板"链接）
9. i18n keys（中英文）
10. E2E 测试（10+ 核心 P0 场景）

### Phase 2: P1 增强功能

11. 后端 `skills-summary` 端点
12. 技能管理 Tab
13. 技能→模板筛选联动

## 8. 不做的事 (Non-goals)

- **Skills CRUD**：技能由 Agent Pod 上报，不是管理员创建的，Tab 只做只读展示
- **模板版本控制**：不在此次实现模板变更历史
- **模板导入导出**：不在此次实现模板的 JSON 导入导出
- **Profile 管理**：Profile 管理仍在 Agent 详情页的 Profiles Tab，不迁移
- **拖拽排序**：模板列表不需要拖拽排序功能
- **并发编辑保护**：两个管理员同时编辑同一模板为 last-write-wins，不在此次实现乐观锁
- **批量操作**：不支持批量删除模板，逐个操作即可
- **只读详情页**：查看完整配置通过编辑弹窗实现（不误操作需确认），不单独做详情页

## 9. 评审反馈追踪

| # | 来源 | 级别 | 问题 | 处理 |
|---|------|------|------|------|
| 1 | 需求 | CRITICAL | F3.6 确认提示依赖 PUT 返回值 | 已修复：改用列表 profile_count |
| 2 | 需求 | CRITICAL | ProfileTemplateData 缺 profile_count | 已修复：Phase 1 步骤 4 |
| 3 | 需求 | HIGH | name 校验前后端不一致 | 已修复：统一为 `^[a-zA-Z0-9_-]{1,64}$` |
| 4 | 需求 | HIGH | 删除模板后 Profile 处理说明 | 已修复：F4.4 补充 SET NULL 行为说明 |
| 5 | 需求 | HIGH | 搜索应明确用后端 API | 已修复：F1.5 改为后端搜索 + debounce |
| 6 | 需求 | HIGH | 空状态区分不足 | 已修复：F1.6a/b 两种空状态 |
| 7 | 需求 | MEDIUM | 克隆 display_name 未加后缀 | 已修复：F5.3 追加 "(副本)" |
| 8 | 需求 | MEDIUM | 模板卡片未展示 skills 摘要 | 已修复：F1.3 增加 skills 标签 |
| 9 | 需求 | MEDIUM | 响应式断点偏窄 | 已修复：NF3 改为 768px-1920px |
| 10 | 需求 | LOW | ProfileEditor 缺"管理模板"链接 | 已采纳：F7.5 |
| 11 | 架构 | HIGH | TemplateEditor/ProfileEditor 重复代码 | 已修复：新增 Phase 0 提取共享组件 |
| 12 | 架构 | HIGH | skills-summary 性能方案 | 已明确：Python 层聚合，模板数有限 |
| 13 | 架构 | MEDIUM | 建议提取 useTemplates hook | 已采纳：第 6 节补充 |
| 14 | 架构 | MEDIUM | Tab 切换不重新加载 | 已采纳：F6.2 懒加载 + 缓存 |
| 15 | 架构 | MEDIUM | F6.4 技能→模板筛选交互 | 已修复：改为条件标签 + 可清除 |
| 16 | 需求 | INFO | admin-only 权限 | 已明确：F1 权限说明 |
