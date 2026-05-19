# 模板 soul.md AI 生成功能

## Context

用户在 TemplateEditor 中创建/编辑模板时，需要手动编写 soul.md。希望根据模板名称(display_name)和描述(description)，借用已配置 Agent 的 LLM 接口（OpenAI 兼容）自动生成 soul.md 角色提示词。

## 数据流

```
TemplateEditor [点击"AI 生成"]
  → 选择一个 Agent（下拉列表，缓存 agent 列表）
  → 前端读取该 Agent 的 LLM 配置（已有 adminApi 可获取 config + env）
  → POST /admin/api/profile-templates/generate-soul
      body: { name, description, provider, api_key, model, base_url }
  → 后端调用 OpenAI /chat/completions 生成 soul.md
  → 返回 { soul_md: "..." }
  → 前端填充到 textarea
```

**设计决策**：前端直接发送 LLM 凭证（同 `test_llm` 模式），避免后端读取 agent .env 中的密钥，减少攻击面。

## 后端改动

### 1. 新增请求/响应模型 — `admin/backend/models.py`

```python
class GenerateSoulRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str = Field(..., min_length=1, max_length=500)
    provider: LLMProvider
    api_key: str = Field(..., min_length=1, max_length=4096)
    model: str = Field("anthropic/claude-sonnet-4-20250514", max_length=256, pattern=r'^[a-zA-Z0-9\-_./:]+$')
    base_url: Optional[str] = Field(None, max_length=2048)

    @field_validator("base_url", mode="before")
    @classmethod
    def _validate_base_url(cls, v):
        if v is not None:
            if not v.startswith(("http://", "https://")):
                raise ValueError("base_url must start with http:// or https://")
            _check_ssrf(v)  # 复用现有 SSRF 校验
        return v

class GenerateSoulResponse(BaseModel):
    soul_md: str = Field(..., max_length=10_000)
```

### 2. 新增生成端点 — `admin/backend/profile_routes.py`

路由: `POST /profile-templates/generate-soul`

实现逻辑：
1. 复用 `test_llm()` 的 LLM 调用模式（httpx + headers + URL 构建）
2. 复用 `PROVIDER_URL_MAP` 获取默认 base_url，`determine_api_mode()` 判断协议
3. System prompt（name/description 已有长度限制防注入）：
   ```
   你是一个专业的 AI 角色提示词撰写专家。请根据以下信息生成一段 SOUL.md 角色提示词。
   
   角色名称：{name}
   角色描述：{description}
   
   要求：
   - 用中文撰写
   - 明确角色的专业能力和行为准则
   - 长度控制在 100-300 字
   - 直接输出提示词内容，不要加标题或多余格式
   ```
4. 使用 `httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))`
5. 截断 LLM 输出到 10000 字符以内
6. 错误响应中用 `re.sub(r'Bearer\s+\S+', 'Bearer ***', error)` 脱敏 API key
7. 返回 `GenerateSoulResponse`

**错误处理**：
- base_url 为空且 provider 无默认 URL → HTTP 422
- LLM 调用超时/失败 → HTTP 502 + 脱敏错误信息
- LLM 返回空内容 → HTTP 502 + "LLM returned empty response"

### 3. 挂载路由

profile_routes.py 已通过 `include_router` 挂载，新路由自动生效。

## 前端改动

### 4. 新增 API 方法 — `admin/frontend/src/lib/admin-api.ts`

```typescript
generateSoul(params: {
  name: string; description: string;
  provider: string; api_key: string; model: string; base_url?: string;
}): Promise<{ soul_md: string }> {
  return adminFetch("/profile-templates/generate-soul", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
```

### 5. TemplateEditor 添加"AI 生成"按钮 — `admin/frontend/src/components/template/TemplateEditor.tsx`

在 `<SoulMdEditor>` 的 label 行右侧添加"AI 生成"按钮：

1. **Agent 选择下拉**：点击按钮后弹出小型 popover，含一个 `<select>` 列出所有 Agent（列表在 modal 打开时一次性加载，缓存到组件 state）
2. **LLM 配置读取**：选择 Agent 后，调用已有的 `adminApi.getAgentConfig(agentId)` + `adminApi.getAgentEnv(agentId)` 获取 provider/model/base_url
3. env 返回的 api_key 是 masked 的(`****`)，用户需手动输入 API Key

**最终简化 UX**：
- 按钮"AI 生成"点击后，弹出小对话框
- 对话框含：Agent 选择下拉 + API Key 输入框
- 前端从选中 Agent 的 config 获取 provider/model/base_url，用户只需输入 API Key
- 点击"生成"后调用 `adminApi.generateSoul()`
- 成功后填充 soul.md textarea，失败显示 toast

### 6. i18n — `admin/frontend/src/i18n/en.ts` + `zh.ts`

新增 key（两个文件同步）：
- `templateGenerateSoul`: "Generate with AI" / "AI 生成"
- `templateGenerateSoulSelectAgent`: "Select Agent" / "选择 Agent"
- `templateGenerateSoulGenerating`: "Generating..." / "生成中..."
- `templateGenerateSoulFailed`: "Generation failed" / "生成失败"
- `templateGenerateSoulApiKey`: "API Key" / "API 密钥"

## 关键文件

| 文件 | 改动 |
|------|------|
| `admin/backend/models.py` | 新增 `GenerateSoulRequest` + `GenerateSoulResponse` |
| `admin/backend/profile_routes.py` | 新增 `POST /profile-templates/generate-soul` 端点 |
| `admin/frontend/src/lib/admin-api.ts` | 新增 `generateSoul()` 方法 |
| `admin/frontend/src/components/template/TemplateEditor.tsx` | 添加"AI 生成"按钮 + Agent 选择 |
| `admin/frontend/src/i18n/en.ts` | 新增 5 个 key |
| `admin/frontend/src/i18n/zh.ts` | 新增 5 个 key |

## 复用现有代码

- `TestLLMRequest` 的验证模式 (models.py:344-361) — provider/api_key/model/base_url 校验 + SSRF
- `test_llm()` 的 httpx 调用模式 (agent_manager.py:927-983)
- `PROVIDER_URL_MAP` (constants.py:20-30) — provider→默认 URL
- `PROVIDER_API_MODE_MAP` (constants.py:35-39) — provider→协议模式
- `determine_api_mode()` + `is_bearer_auth_endpoint()` 辅助函数

## 第一轮审查反馈已采纳

| 问题 | 处理 |
|------|------|
| HIGH: Secret exposure via read_env_raw | 改为前端传 LLM 凭证，后端不读 .env |
| HIGH: Prompt injection risk | name(100) + description(500) 长度限制 |
| HIGH: Missing error handling | 新增 422/502 错误处理 + API key 脱敏 |
| MEDIUM: SSRF on stored base_url | 前端传入，走 Pydantic SSRF 校验 |
| MEDIUM: Timeout too short | 改为 60s + 10s connect |
| MEDIUM: Route placement | 保留 `/profile-templates/generate-soul`（结果用于 template 字段） |

## 第二轮专家审查反馈及处理方案

### 安全专家

| ID | 级别 | 问题 | 处理 |
|----|------|------|------|
| SC1 | CRITICAL | SSRF 只拦截 3 个 hostname，未拦截内网 IP 段 | 增强 `_check_ssrf()`：hostname 解析后检查 `ipaddress.is_private/is_loopback/is_link_local`；同时修复 test_llm 等已有路径 |
| SC2 | CRITICAL | 端点未显式声明 auth 依赖 | 实现时必须加 `dependencies=[auth]`，且建议 `admin_only` 模式 |
| SH1 | HIGH | API key 可能通过异常 log 泄露 | 实现中不 log request body/headers；添加注释明确禁止 |
| SH2 | HIGH | Prompt injection 仅靠长度限制 | 可接受（admin-only），但用 XML tag 包裹用户输入 + 声明数据非指令 |
| SH3 | HIGH | 无限流，可被刷 LLM API 费用 | 添加 `asyncio.Semaphore(3)` 全局并发限制 |
| SM2 | MEDIUM | Anthropic provider 的 `x-api-key` header 未脱敏 | 脱敏正则增加 `x-api-key` 模式 |
| SM3 | MEDIUM | 10K 截断可能截断在行中 | 截断到 10000 字符前的最后一个换行符 |

### 架构专家

| ID | 级别 | 问题 | 处理 |
|----|------|------|------|
| AH1 | HIGH | GenerateSoulRequest 与 TestLLMRequest 字段重复 | 让 GenerateSoulRequest 继承 TestLLMRequest 并添加 name + description |
| AH2 | HIGH | LLM HTTP 调用逻辑将重复 test_llm 约 40 行 | 提取 `call_llm_chat()` 共享函数到 profile_routes.py 或新模块 |
| AH3 | HIGH | 无限流/并发控制 | 同 SH3，Semaphore(3) |
| AM1 | MEDIUM | 无 Agent 时下拉为空 | 前端显示空状态提示 + 禁用生成按钮 |
| AM2 | MEDIUM | config.yaml 用正则解析 provider/model 脆弱 | 后端新增 `GET /agents/{id}/llm-config` 返回结构化数据（v2 迭代）|
| AM3 | MEDIUM | 设计只提 OpenAI 协议，遗漏 Anthropic | 明确要求通过 `determine_api_mode()` 支持双协议 |
| AM4 | MEDIUM | SoulMdEditor 无 action slot | 添加 `actions?: ReactNode` prop |

### 前端 UX 专家

| ID | 级别 | 问题 | 处理 |
|----|------|------|------|
| FC1 | CRITICAL | 无 Agent 时下拉空，用户卡住 | 显示"暂无可用 Agent"提示 + 禁用按钮 |
| FC2 | CRITICAL | Agent 无 LLM 配置时未处理 | 选择后校验配置完整性，不完整时显示内联警告 |
| FH1 | HIGH | 应用 ModalOverlay 而非 popover | 改用 ModalOverlay(max-w-md)，保持一致性 |
| FH2 | HIGH | 60s 调用无取消机制 | 用 AbortController + "取消"按钮 |
| FH3 | HIGH | 已有 soul.md 内容时无覆盖确认 | 非空时显示"将替换当前内容"警告 |
| FH4 | HIGH | API Key 输入未设 type="password" | 默认 password + 可见性切换 |
| FH5 | HIGH | 缺少 i18n key | 新增 5 个额外 key（见下方） |

### 新增 i18n key

```
templateGenerateSoulDialogTitle: "Generate Role Prompt with AI" / "AI 生成角色提示词"
templateGenerateSoulNoAgents: "No agents available. Create an agent with LLM config first." / "暂无可用 Agent，请先创建并配置 LLM"
templateGenerateSoulNoLlmConfig: "Selected agent has no LLM configuration" / "所选 Agent 未配置 LLM"
templateGenerateSoulOverwriteWarning: "This will replace the current content" / "将替换当前内容"
templateGenerateSoulSuccess: "Soul.md generated successfully" / "角色提示词生成成功"
```

### 实现调整摘要

1. **后端提取共享 `call_llm_chat()`**：统一 test_llm 和 generate-soul 的 LLM 调用逻辑
2. **GenerateSoulRequest 继承 TestLLMRequest**：减少模型重复
3. **增强 SSRF 防护**：hostname → IP 解析 + 私有网段检查
4. **Semaphore(3) 并发限制**
5. **前端改用 ModalOverlay + AbortController + 空状态处理**
6. **SoulMdEditor 添加 `actions` prop**

## 验证

1. 在 TemplateEditor 中创建新模板，填入名称和描述
2. 点击"AI 生成"按钮，弹出 ModalOverlay 对话框
3. 无 Agent 时显示空状态提示，Agent 无 LLM 配置时显示警告
4. 选择 Agent、输入 API Key、点击"生成"
5. 生成中可取消（AbortController），60s 超时
6. 成功后 toast + 填充 soul.md textarea
7. 已有内容时显示覆盖警告
8. builtin 模板编辑模式下不显示生成按钮
9. 确认生成失败时显示错误 toast（API key 脱敏）
10. SSRF 测试：传入内网 IP base_url 应被拒绝
11. 并发限制测试：同时发起 4 个请求，第 4 个应被拒绝或排队
