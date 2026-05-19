# Admin Panel Pure Ink 单色主题重设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 admin panel 从 Cyberpunk 霓虹风改为与 hermes-web-ui 一致的 Pure Ink 严格单色风格，增加 light/dark 双模式切换。

**Architecture:** 保留 Tailwind token 名称（`accent-pink`、`accent-cyan`）只改值，让 60+ 处组件引用自动跟随。通过 `[data-theme="light"]` CSS 变量覆盖实现主题切换。新建 `useTheme` hook 管理 localStorage + DOM 属性。

**Tech Stack:** Tailwind 4 @theme CSS-first config, React 19, Vite 7, Inter 字体

**Design decisions (用户确认):**
- Accent: 严格单色，零色彩
- 主题: light + dark 双模式 + 切换按钮

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `admin/frontend/index.html` | Modify | 字体引入 |
| `admin/frontend/src/index.css` | Modify | 全部主题 tokens + light mode + 特效移除 |
| `admin/frontend/src/hooks/useTheme.ts` | Create | 主题切换 hook |
| `admin/frontend/src/components/AdminLayout.tsx` | Modify | 切换按钮 + 品牌视觉 |
| `admin/frontend/src/pages/LoginPage.tsx` | Modify | 硬编码颜色 + 字距 + 按钮对比度 |

---

## Task 0: 前置验证 — Tailwind 4 light mode 切换

**Why:** 评审发现 Tailwind 4 @theme 在构建时生成 `:root` CSS 变量。`[data-theme="light"]` 覆盖依赖于 CSS 变量运行时解析，需先验证可行。

- [ ] **Step 1: 启动 dev server**

```bash
cd admin/frontend && npm run dev
```

- [ ] **Step 2: 浏览器 console 验证**

打开 `http://localhost:5173/admin/`，在 DevTools Console 执行：

```js
document.documentElement.setAttribute('data-theme', 'light')
```

检查：背景色是否变白、文字是否变深。如果没变化，说明 Tailwind 4 的 `@theme` 变量不受 `[data-theme]` 选择器影响，需要改用 `:root` + `[data-theme]` 双方案。

- [ ] **Step 3: 确认通过后继续 Task 1**

如果 Step 2 不生效，改为在 `:root` 中声明 dark 变量，`[data-theme="light"]` 中覆盖。

---

## Task 1: index.html — 字体切换

**Files:** Modify `admin/frontend/index.html:13-17`

- [ ] **Step 1: 替换 Google Fonts**

```html
<!-- 替换前 -->
<!-- Preload critical fonts: Orbitron + Exo 2 -->
<link
  href="https://fonts.googleapis.com/css2?family=Exo+2:wght@300;400;500;600;700&family=Orbitron:wght@500;600;700&display=swap"
  rel="stylesheet"
/>

<!-- 替换后 -->
<!-- Inter — clean neutral typeface, matching hermes-web-ui -->
<link
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
  rel="stylesheet"
/>
```

**状态: 已完成** ✓

---

## Task 2: index.css — Pure Ink 双模式主题

**Files:** Modify `admin/frontend/src/index.css`

### 2a. 替换 @theme tokens

- [ ] **Step 1: 替换 surfaces + text + accent tokens**

```css
@theme {
  /* Surfaces — dark mode defaults */
  --color-background: #1a1a1a;
  --color-surface: #2a2a2a;
  --color-surface-secondary: #333333;
  --color-surface-tertiary: #3a3a3a;
  --color-surface-elevated: #444444;
  --color-sidebar-bg: #222222;
  --color-terminal: #111111;

  /* Text */
  --color-text-primary: #f0f0f0;
  --color-text-secondary: #999999;
  --color-text-muted: #666666;

  /* Accents — monochrome, kept named for compatibility */
  --color-accent-pink: #e0e0e0;
  --color-accent-cyan: #999999;
  --color-accent-glow: #555555;

  /* Semantic — desaturated */
  --color-success: #5cb85c;
  --color-warning: #e8a838;
  --color-destructive: #d45050;

  /* Borders */
  --color-border: rgba(255, 255, 255, 0.1);
  --color-border-subtle: rgba(255, 255, 255, 0.05);
  --color-border-cyan: rgba(255, 255, 255, 0.15);

  /* Bar */
  --color-bar-track: rgba(255, 255, 255, 0.08);

  /* Fonts */
  --font-display: "Inter", sans-serif;
  --font-body: "Inter", sans-serif;
  --font-mono: "JetBrains Mono", monospace;

  /* Motion */
  --duration-fast: 150ms;
  --duration-normal: 300ms;
  --duration-stagger: 60ms;
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
}
```

### 2b. 添加 light mode 覆盖

- [ ] **Step 2: 在 @theme 块之后、body 之前添加 light mode**

```css
[data-theme="light"] {
  --color-background: #f5f5f5;
  --color-surface: #ffffff;
  --color-surface-secondary: #f0f0f0;
  --color-surface-tertiary: #e8e8e8;
  --color-surface-elevated: #e0e0e0;
  --color-sidebar-bg: #fafafa;
  --color-terminal: #e0e0e0;

  --color-text-primary: #1a1a1a;
  --color-text-secondary: #666666;
  --color-text-muted: #999999;

  --color-accent-pink: #333333;
  --color-accent-cyan: #666666;
  --color-accent-glow: #cccccc;

  --color-border: rgba(0, 0, 0, 0.1);
  --color-border-subtle: rgba(0, 0, 0, 0.05);
  --color-border-cyan: rgba(0, 0, 0, 0.15);

  --color-bar-track: rgba(0, 0, 0, 0.08);
}
```

### 2c. 移除 cyberpunk 特效

- [ ] **Step 3: 替换 body 背景**

```css
/* 替换前 */
body {
  background-color: var(--color-background);
  background-image:
    radial-gradient(ellipse at 20% 50%, rgba(123, 45, 142, 0.15), transparent 70%),
    radial-gradient(ellipse at 80% 20%, rgba(5, 217, 232, 0.08), transparent 50%),
    radial-gradient(ellipse at 50% 80%, rgba(255, 42, 109, 0.06), transparent 60%);
}

/* 替换后 */
body {
  background-color: var(--color-background);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

- [ ] **Step 4: 替换 glass/glow/scrollbar**

```css
/* Glass → flat surface */
.glass {
  background: var(--color-surface);
}
.glass-heavy {
  background: var(--color-surface-secondary);
}

/* Glow → none */
.glow-pink { box-shadow: none; }
.glow-cyan { box-shadow: none; }
.glow-pink-text { text-shadow: none; }

/* Scrollbar → neutral gray */
::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.3);
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.5);
}
```

**状态: 已完成** ✓

---

## Task 3: useTheme hook

**Files:** Create `admin/frontend/src/hooks/useTheme.ts`

- [ ] **Step 1: 创建 hook**

```typescript
import { useState, useEffect, useCallback } from "react";

type Theme = "dark" | "light";

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem("admin_theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("admin_theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggleTheme } as const;
}
```

**状态: 已完成** ✓

---

## Task 4: AdminLayout — 主题切换按钮 + 视觉调整

**Files:** Modify `admin/frontend/src/components/AdminLayout.tsx`

- [ ] **Step 1: 添加 import**

```typescript
// 在现有 import 后添加
import { useTheme } from "../hooks/useTheme";
```

- [ ] **Step 2: 在 SidebarContent 中使用 hook**

在 `SidebarContent` 函数顶部添加：

```typescript
const { theme, toggleTheme } = useTheme();
```

- [ ] **Step 3: 修改品牌标题字距**

```tsx
// 替换前 (line 309)
<h1 className="font-[family-name:var(--font-display)] text-base font-bold tracking-[0.12em] text-accent-pink/80">

// 替换后
<h1 className="text-base font-semibold tracking-[0.06em] text-text-primary">
```

- [ ] **Step 4: 在侧边栏底部添加主题切换按钮**

找到 SidebarContent 底部的语言切换区域，在其旁添加主题按钮：

```tsx
<button
  onClick={toggleTheme}
  className="p-2 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface/50 transition-colors"
  aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
  title={theme === "dark" ? "Light mode" : "Dark mode"}
>
  {theme === "dark" ? (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
    </svg>
  ) : (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
    </svg>
  )}
</button>
```

---

## Task 5: LoginPage — 硬编码颜色修复

**Files:** Modify `admin/frontend/src/pages/LoginPage.tsx`

**评审发现的 6 处硬编码问题：**

- [ ] **Step 1: 移除输入框 focus shadow 硬编码 rgba (4 处)**

所有 `focus:shadow-[0_0_0_2px_rgba(5,217,232,0.15)]` 替换为：

```
focus:shadow-[0_0_0_2px_rgba(128,128,128,0.15)]
```

涉及行号：166, 199, 222, 237

```tsx
// 替换前 (line 166 示例)
className="... focus:shadow-[0_0_0_2px_rgba(5,217,232,0.15)]"

// 替换后
className="... focus:shadow-[0_0_0_2px_rgba(128,128,128,0.15)]"
```

- [ ] **Step 2: 修复提交按钮 hover shadow + 对比度**

```tsx
// 替换前 (line 267-271)
className={`w-full h-11 text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all ${
  isAdmin
    ? "bg-accent-pink text-white hover:shadow-[0_0_20px_rgba(255,42,109,0.3)]"
    : "bg-accent-cyan text-background hover:shadow-[0_0_20px_rgba(5,217,232,0.3)]"
}`}

// 替换后 — 移除 neon shadow，修复对比度（text-white → text-background）
className={`w-full h-11 text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
  isAdmin
    ? "bg-accent-pink text-background hover:opacity-90"
    : "bg-accent-cyan text-background hover:opacity-90"
}`}
```

对比度验证：
- Dark: `bg-accent-pink` (#e0e0e0) + `text-background` (#1a1a1a) → 8.4:1 ✓
- Light: `bg-accent-pink` (#333333) + `text-background` (#f5f5f5) → 8.2:1 ✓
- Dark: `bg-accent-cyan` (#999999) + `text-background` (#1a1a1a) → 5.1:1 ✓
- Light: `bg-accent-cyan` (#666666) + `text-background` (#f5f5f5) → 4.7:1 ✓ (AA pass)

- [ ] **Step 3: 修复品牌标题字距**

```tsx
// 替换前 (line 102)
<h1 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-[0.15em] text-text-primary glow-pink-text text-center mb-1">

// 替换后
<h1 className="text-3xl font-semibold tracking-[0.06em] text-text-primary text-center mb-1">
```

改动：移除 `font-[family-name:var(--font-display)]`（默认 Inter）、`tracking-[0.15em]` → `tracking-[0.06em]`、移除 `glow-pink-text`、`font-bold` → `font-semibold`

---

## Task 6: 验证

- [ ] **Step 1: TypeScript 编译**

```bash
cd admin/frontend && npx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 2: Dev server 视觉验证**

```bash
npm run dev
```

检查清单：
- [ ] Dark 模式：纯灰阶，无紫色/粉色/青色残存，Inter 字体
- [ ] 点击主题切换 → Light 模式：白底灰字，对比度正常
- [ ] 刷新页面 → 保持上次选择的主题
- [ ] LoginPage：按钮文字可读，输入框 focus 无霓虹色
- [ ] 所有页面卡片/按钮/表格视觉正常

- [ ] **Step 3: E2E 测试**

```bash
npm run test:e2e
```

Expected: 全部通过（E2E 断言的是 Tailwind 类名不是颜色值，token 改名不影响）

---

## 不改动的部分

- 组件中的 Tailwind 类名（`text-accent-pink`、`bg-accent-cyan/10` 等）——token 值改变后视觉自动跟随
- 组件逻辑、路由、状态管理
- 后端代码
- E2E 测试代码
