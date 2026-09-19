# 对话排版与字号轴 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 对齐 DSH 的中文字体栈、Markdown 标题阶梯/块间距，以及外观里 12–17 px 的整窗可读文字字号轴。

**架构：** `themeStore.fontSize` 持久化；`useFontSizeSync` 把 `--pi-font-size` 写到 `documentElement`；`contentFont.css` 在 `html` 上派生 delta / secondary / 标题 token，并用 `html body` 压过 antd reset。对话 Markdown 仍走 `@lobehub/ui`，由 `LazyMarkdown` 给根节点加 `.pi-md` 盖样式。

**技术栈：** TypeScript、React、zustand persist、antd-style、@lobehub/ui、lucide-react、vitest + testing-library。

**上游规格：** `docs/superpowers/specs/2026-09-15-chat-typography-design.md`

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- **按编号顺序执行，不要跳序。** 任务 1–3 是数字与 DOM 变量，任务 4 才落 CSS，任务 5 才改 Markdown 宿主。
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。图标用 `@lobehub/ui` 的 `Icon` + `lucide-react`。
- **不要改** antd `token.fontSize`、Wiki `wikiStyles.root` 的 13 px、`SettingsPanel` 页标题/导航/分组标题、代码高亮、终端、模块栏尺寸、11 px 标签。
- **不要**导出 `secondaryFontSize()`。次级档只存在于 CSS `min()/max()`。
- **不要**解析 `contentFont.css` 去做公式单测（jsdom 不算 `min()`）。clamp 测 TS；次级表人工对照规格 §1 / §3。
- `index.css` 的选择器必须是 `html body`，不能写 `body`（antd v6 无哈希 `body` reset 会盖掉同特异度的 Vite CSS）。
- `.pi-md` 宿主：`className` 确实会被 `@lobehub/ui` 的 `Markdown` 转发到根节点（已核实）：`Markdown.mjs:30-33` → `Typography.mjs:9` 的 `cx(styles.root, className)`，落在 `<article>` 上。不需要自建 `<div>`。
- **`.pi-md` 的样式会被 @lobehub 压过 —— 已实测，必须按下面两条写，否则整条轴在对话 Markdown 里完全不生效：**
  - `Markdown.mjs:15`：`variant="chat"` 时 `fontSize` 默认 **14**；`Typography.mjs:11-18` 把它写成 `<article>` 上的**行内**变量 `--lobe-markdown-font-size: 14px`。
  - `markdown.style.mjs:368-393`：root 规则实际是 `.hash :not(:has(.ignore-markdown-style)) { font-size: var(--lobe-markdown-font-size) }`，特异度 **(0,2,0)**；标题是 `.hash :not(:has(...)) h1 { … }`，**(0,2,1)**。注意字号不落在 `<article>` 上，而是落在**每个后代**上——`variant="chat"` 时它们恒为 14 px。
  - 而 `.pi-md p` / `.pi-md h1` 只有 (0,1,1)，全输；`@lobehub/ui` 又是 `lazy()` 动态导入的，注入晚于 `contentFont.css`，打平也输。
  - 必做一：`LazyMarkdown` 给 `<Markdown>` 传 `style`，用行内变量把 `--lobe-markdown-font-size` / `--lobe-markdown-line-height` 换成我们的轴（Typography 里 `...style` 展开在自有变量之后，压得住）。
  - 必做二：`contentFont.css` 里所有 `.pi-md` 规则统一写成 **`.pi-md.pi-md.pi-md …`（(0,3,x)）**，确定性地压过 (0,2,x)。不靠注入顺序，也不整表 `!important`。
- `LazyMarkdown` 的 `<Markdown>` 是 `lazy()` 的。单测 mock `@lobehub/ui` 的 `Markdown` 为同时转发 `className` 与 `style` 的 `div`，再用 `findByTestId` 等待 Suspense。
- `ThemeBridge` 顶层有 `useTheme()`。字号同步抽成 `useFontSizeSync`，单测只渲 hook，不要为了写 `--pi-font-size` 去挂整棵 `ThemeProvider`。
- persist 脏数据走 `onRehydrateStorage` 回调里 clamp，不要手写 `merge`。
- UI 以 vitest 为准。规格 §1 四条人工确认（`html body` 是否生效、中文实际命中字体、默认档 1 px 变大、Markdown 后代跟着轴）在全部任务完成后由人点 Electron，不写进自动化。
- `vitest.config.ts` 配了 `projects`（`main` 跑 `electron/**`、`renderer` 跑 `src/**` + jsdom + `src/test/setup.ts`）。`npx vitest run src/xxx.test.ts` 若报 “No test files found”，补 `--project renderer`。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试>
```

**提交：**

```powershell
git add <本任务文件>
git commit -m @"
feat(theme): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/theme/contentFont.ts` | `FONT_SIZE_MIN/MAX/DEFAULT`、`clampFontSize` |
| `electron-agent/src/theme/contentFont.test.ts` | clamp 边界 |
| `electron-agent/src/theme/contentFont.css` | `--pi-*` 轴、`html body` 字体、`.pi-md` 排版 |
| `electron-agent/src/theme/useFontSizeSync.ts` | 把 store 的字号写到 `--pi-font-size` |
| `electron-agent/src/theme/useFontSizeSync.test.ts` | 根节点 CSS 变量 |
| `electron-agent/src/stores/themeStore.test.ts` | 默认 / set / persist / rehydrate |
| `electron-agent/src/features/chat/LazyMarkdown.test.tsx` | `pi-md` / secondary / `prose={false}` |
| `electron-agent/src/features/settings/AppearanceSettings.test.tsx` | 步进器 |

修改：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/index.css` | `@import` + 删掉旧 `body` 字体栈（改由 contentFont.css 的 `html body` 负责） |
| `electron-agent/src/stores/themeStore.ts` | `fontSize`、`setFontSize`、`partialize`、`onRehydrateStorage` |
| `electron-agent/src/components/ThemeBridge.tsx` | 调用 `useFontSizeSync()` |
| `electron-agent/src/features/chat/LazyMarkdown.tsx` | `tone` / `prose`、className 宿主、兜底 `pre` 字体 |
| `electron-agent/src/features/settings/SettingCard.tsx` | `desc` prop；标题走正文字号 |
| `electron-agent/src/features/settings/AppearanceSettings.tsx` | 「对话字号」卡片 + 步进器 |
| `electron-agent/src/features/settings/SettingField.tsx` | label 正文、desc 次级 |
| `electron-agent/src/features/settings/ProvidersSettings.tsx` | label 正文、desc 次级 |
| `electron-agent/src/features/settings/CapabilityModelField.tsx` | 同上 |
| `electron-agent/src/features/settings/ProviderDiagnostics.tsx` | label 正文、desc 次级（`metricLabel` 11 px 不动） |
| `electron-agent/src/features/chat/TurnTimeline.tsx` | 去掉 `fontSize={14}` |
| `electron-agent/src/features/chat/ReasoningInline.tsx` | `tone="secondary"` |
| `electron-agent/src/features/chat/NoticePill.tsx` | secondary + 紧凑标题选择器 |
| `electron-agent/src/features/chat/NoticeSplitPill.tsx` | 同上 |
| `electron-agent/src/features/chat/SubAgentInline.tsx` | 两处 `tone="secondary"` |
| `electron-agent/src/features/chat/PlanCard.tsx` | Markdown 默认 prose；title/todo/fallback/docError/summary 改变量 |
| `electron-agent/src/features/chat/MarkdownWarmup.tsx` | 去掉 `fontSize={14}` |
| `electron-agent/src/features/chat/chatStyles.ts` | 气泡跟轴 |
| `electron-agent/src/features/chat/input/editor/MessageEditor.tsx` | `.editor` 用 `--pi-md-base` |
| `electron-agent/src/features/panels/PageContentViewer.tsx` | `.body` 次级；Markdown `tone="secondary"` |
| `electron-agent/src/components/QuestionSelector/index.tsx` | 去掉 `fontSize={14}` |
| `electron-agent/src/features/sessions/ProjectItem.tsx` | 去掉写死 13 px |
| `electron-agent/src/features/sessions/Sidebar.tsx` | `.more` 次级 |
| `electron-agent/src/features/tools/cardStyles.ts` | `inspectorTitle` 次级 |
| `electron-agent/src/features/agentData/wiki/WikiLibraryWorkspace.tsx` | `prose={false}` |
| `electron-agent/src/features/agentData/wiki/WikiPageEditor.tsx` | 两处 `prose={false}` |
| `electron-agent/src/features/agentData/wiki/WikiSourceDialog.tsx` | `prose={false}` |

---

### 任务 1：`clampFontSize`

**文件：**
- 创建：`electron-agent/src/theme/contentFont.ts`
- 测试：`electron-agent/src/theme/contentFont.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { clampFontSize, FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN } from './contentFont';

describe('clampFontSize', () => {
  it('keeps 14', () => {
    expect(clampFontSize(14)).toBe(14);
  });

  it('rounds 13.6 up and 13.4 down', () => {
    expect(clampFontSize(13.6)).toBe(14);
    expect(clampFontSize(13.4)).toBe(13);
  });

  it('clamps to 12..17', () => {
    expect(clampFontSize(11)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(99)).toBe(FONT_SIZE_MAX);
  });

  it('coerces numeric strings', () => {
    expect(clampFontSize('14')).toBe(14);
  });

  it('falls back to 14 for garbage', () => {
    expect(clampFontSize(NaN)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(Infinity)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(null)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(undefined)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize('abc')).toBe(FONT_SIZE_DEFAULT);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/theme/contentFont.test.ts
```

预期：FAIL，找不到 `./contentFont`。

- [ ] **步骤 3：编写最少实现**

```ts
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 17;
export const FONT_SIZE_DEFAULT = 14;

export function clampFontSize(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}
```

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/theme/contentFont.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/theme/contentFont.ts electron-agent/src/theme/contentFont.test.ts
git commit -m @"
feat(theme): 增加对话字号 clamp

"@
```

---

### 任务 2：`themeStore.fontSize` 持久化

**文件：**
- 修改：`electron-agent/src/stores/themeStore.ts`
- 测试：`electron-agent/src/stores/themeStore.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { FONT_SIZE_DEFAULT } from '../theme/contentFont';
import { useThemeStore } from './themeStore';

afterEach(() => {
  localStorage.removeItem('pi-theme');
  useThemeStore.setState({
    appearance: 'dark',
    primaryColor: undefined,
    neutralColor: undefined,
    colorScheme: useThemeStore.getState().colorScheme,
    fontSize: FONT_SIZE_DEFAULT,
  });
});

describe('themeStore fontSize', () => {
  it('defaults to 14', () => {
    expect(useThemeStore.getState().fontSize).toBe(14);
  });

  it('setFontSize writes and clamps', () => {
    useThemeStore.getState().setFontSize(17);
    expect(useThemeStore.getState().fontSize).toBe(17);
    useThemeStore.getState().setFontSize(99);
    expect(useThemeStore.getState().fontSize).toBe(17);
  });

  it('partializes fontSize', () => {
    useThemeStore.getState().setFontSize(16);
    const raw = localStorage.getItem('pi-theme');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.fontSize).toBe(16);
  });

  it('rehydrate clamps dirty fontSize', async () => {
    localStorage.setItem(
      'pi-theme',
      JSON.stringify({ state: { fontSize: 999, appearance: 'dark', colorScheme: 'github' }, version: 0 }),
    );
    await useThemeStore.persist.rehydrate();
    expect(useThemeStore.getState().fontSize).toBe(17);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/themeStore.test.ts
```

预期：FAIL，`fontSize` 为 `undefined`。

- [ ] **步骤 3：编写最少实现**

在 `themeStore.ts`：

1. `import { clampFontSize, FONT_SIZE_DEFAULT } from '../theme/contentFont';`
2. `ThemeState` 增加 `fontSize: number` 和 `setFontSize: (fontSize: number) => void`。
3. 初始值 `fontSize: FONT_SIZE_DEFAULT`，`setFontSize: (fontSize) => set({ fontSize: clampFontSize(fontSize) })`。
4. `partialize` 增加 `fontSize: state.fontSize`。
5. persist 选项增加：

```ts
onRehydrateStorage: () => (state) => {
  if (!state) return;
  const next = clampFontSize(state.fontSize);
  if (next !== state.fontSize) useThemeStore.setState({ fontSize: next });
},
```

不要手写 `merge`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/themeStore.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/stores/themeStore.ts electron-agent/src/stores/themeStore.test.ts
git commit -m @"
feat(theme): 持久化对话字号

"@
```

---

### 任务 3：把字号写到 `--pi-font-size`

**文件：**
- 创建：`electron-agent/src/theme/useFontSizeSync.ts`
- 测试：`electron-agent/src/theme/useFontSizeSync.test.ts`
- 修改：`electron-agent/src/components/ThemeBridge.tsx`

- [ ] **步骤 1：编写失败的测试**

```ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FONT_SIZE_DEFAULT } from './contentFont';
import { useThemeStore } from '../stores/themeStore';
import { useFontSizeSync } from './useFontSizeSync';

afterEach(() => {
  useThemeStore.setState({ fontSize: FONT_SIZE_DEFAULT });
  document.documentElement.style.removeProperty('--pi-font-size');
});

describe('useFontSizeSync', () => {
  it('writes --pi-font-size on the root', () => {
    useThemeStore.setState({ fontSize: 14 });
    renderHook(() => useFontSizeSync());
    expect(document.documentElement.style.getPropertyValue('--pi-font-size')).toBe('14px');
  });

  it('updates when the store changes', () => {
    useThemeStore.setState({ fontSize: 14 });
    renderHook(() => useFontSizeSync());
    act(() => {
      useThemeStore.getState().setFontSize(16);
    });
    expect(document.documentElement.style.getPropertyValue('--pi-font-size')).toBe('16px');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/theme/useFontSizeSync.test.ts
```

预期：FAIL，找不到模块。

- [ ] **步骤 3：编写最少实现**

`useFontSizeSync.ts`：

```ts
import { useLayoutEffect } from 'react';
import { useThemeStore } from '../stores/themeStore';
import { clampFontSize } from './contentFont';

export function useFontSizeSync(): void {
  const fontSize = useThemeStore((s) => s.fontSize);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--pi-font-size', `${clampFontSize(fontSize)}px`);
  }, [fontSize]);
}
```

`ThemeBridge.tsx`：在现有 `useLayoutEffect` 之前调用 `useFontSizeSync()`。不要把字号写进那个依赖 `theme` 的 effect——字号变更不应重写全部 `--gren-*`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/theme/useFontSizeSync.test.ts src/stores/themeStore.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/theme/useFontSizeSync.ts electron-agent/src/theme/useFontSizeSync.test.ts electron-agent/src/components/ThemeBridge.tsx
git commit -m @"
feat(theme): 同步对话字号到 CSS 变量

"@
```

---

### 任务 4：字体栈与字号轴 CSS

**文件：**
- 创建：`electron-agent/src/theme/contentFont.css`
- 修改：`electron-agent/src/index.css`
- 测试：`electron-agent/src/theme/contentFont.test.ts`（追加一条读 `index.css` 的断言，**不要**解析 `contentFont.css` 的 `min()` 公式）

- [ ] **步骤 1：追加失败的测试**

在 `contentFont.test.ts` 增加：

```ts
import { readFileSync } from 'node:fs';

it('index.css imports the axis and uses html body', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  expect(css).toContain("@import './theme/contentFont.css'");
  expect(css).toContain('html body');
  expect(css).not.toMatch(/^body\s*\{/m);
});
```

最后一条：删掉 `index.css` 里现在那个单独的 `body { font-family: ... }` 规则（字体改由 `contentFont.css` 的 `html body` 承担）。密码框那条 `input[type='password']` 保留。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/theme/contentFont.test.ts
```

预期：FAIL，`index.css` 不含 `@import`。

- [ ] **步骤 3：写入 `contentFont.css` 并改 `index.css`**

`contentFont.css` 必须是**一个** `html { }` 块里同时放 sans/mono 与派生 token（自定义属性要有宿主），再用 `html body` 应用字体。`.pi-md` 规则本任务一起写上，任务 5 的 class 才会有样式可挂。

完整文件。**所有 `.pi-md` 规则一律用 `.pi-md.pi-md.pi-md` 前缀**：@lobehub 的 root 规则是
`.hash :not(:has(.ignore-markdown-style)) h1`（(0,2,1)），单个 `.pi-md`（(0,1,1)）和打平的都压不过它。

```css
/* 对话字号轴。--pi-font-size 由 useFontSizeSync 写在 documentElement 上（12–17px，默认 14）。
   次级档公式与 DSH 相同：min(size - 1px, max(13px, size - 2px)) → 12→11 … 14→13、15→13、17→15。
   选择器必须是 html body：antd v6 hashed:false 会注入无哈希 body { font-size; font-family }，
   晚于 Vite 的 index.css，同为 (0,0,1) 时会盖掉本文件。 */
html {
  --pi-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --pi-font-mono: "SF Mono", "JetBrains Mono", "Fira Code", Consolas,
    "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";

  --pi-font-delta: calc(var(--pi-font-size, 14px) - 14px);
  --pi-font-size-secondary: min(
    calc(var(--pi-font-size, 14px) - 1px),
    max(13px, calc(var(--pi-font-size, 14px) - 2px))
  );
  --pi-font-delta-secondary: calc(var(--pi-font-size-secondary) - 13px);

  --pi-md-h1: 700 calc(21px + var(--pi-font-delta)) / calc(30px + var(--pi-font-delta)) var(--pi-font-sans);
  --pi-md-h2: 700 calc(19px + var(--pi-font-delta)) / calc(28px + var(--pi-font-delta)) var(--pi-font-sans);
  --pi-md-h3: 700 calc(18px + var(--pi-font-delta)) / calc(26px + var(--pi-font-delta)) var(--pi-font-sans);
  --pi-md-h4: 600 var(--pi-font-size, 14px) / calc(24px + var(--pi-font-delta)) var(--pi-font-sans);
  --pi-md-base: var(--pi-font-size, 14px) / calc(24px + var(--pi-font-delta)) var(--pi-font-sans);
}

html body {
  font-family: var(--pi-font-sans);
  font-size: var(--pi-font-size, 14px);
  line-height: calc(24px + var(--pi-font-delta, 0px));
}

.pi-md.pi-md.pi-md {
  min-width: 0;
  overflow-wrap: anywhere;
  font: var(--pi-md-base);
  color: inherit;
}

.pi-md.pi-md.pi-md-secondary {
  font-size: var(--pi-font-size-secondary, 13px);
  line-height: calc(20px + var(--pi-font-delta-secondary, 0px));
}

/* mermaid 分段会吐多个平级 .pi-md；首末子块 margin 归零后相邻块会塌陷成 0，补一条缝。 */
.pi-md + .pi-md {
  margin-block-start: 16px;
}

.pi-md.pi-md.pi-md strong {
  font-weight: 600;
}

.pi-md.pi-md.pi-md h1 {
  font: var(--pi-md-h1);
  margin: 32px 0 16px;
}

.pi-md.pi-md.pi-md h2 {
  font: var(--pi-md-h2);
  margin: 32px 0 16px;
}

.pi-md.pi-md.pi-md h3 {
  font: var(--pi-md-h3);
  margin: 32px 0 16px;
}

.pi-md.pi-md.pi-md h4 {
  font: var(--pi-md-h4);
  margin: 16px 0;
}

.pi-md.pi-md.pi-md :where(h5, h6) {
  font: 600 var(--pi-font-size, 14px) / calc(24px + var(--pi-font-delta, 0px)) var(--pi-font-sans);
  margin: 16px 0;
}

.pi-md.pi-md.pi-md :where(h1, h2, h3, h4, h5, h6) strong {
  font-weight: inherit;
}

.pi-md.pi-md.pi-md p {
  margin: 16px 0;
}

.pi-md.pi-md.pi-md :where(h4, h5, h6) + :where(ul, ol) {
  margin-top: 8px;
}

.pi-md.pi-md.pi-md :where(h4, h5, h6):has(+ :where(ul, ol)) {
  margin-bottom: 8px;
}

.pi-md.pi-md.pi-md a {
  color: var(--gren-acc, inherit);
  text-decoration: underline;
  text-decoration-color: var(--gren-border, rgba(127, 127, 127, 0.45));
  text-underline-offset: 3px;
}

.pi-md.pi-md.pi-md a:hover,
.pi-md.pi-md.pi-md a:focus {
  outline: none;
  text-decoration-color: var(--gren-acc, inherit);
}

.pi-md.pi-md.pi-md :where(ul, ol) {
  margin: 16px 0;
  padding-left: 18px;
}

.pi-md.pi-md.pi-md li:not(:first-child) {
  margin-top: 6px;
}

.pi-md.pi-md.pi-md li > :where(ul, ol) {
  margin-top: 4px;
}

.pi-md.pi-md.pi-md li > p {
  margin: 8px 0;
}

.pi-md.pi-md.pi-md li > *:first-child {
  margin-top: 0;
}

.pi-md.pi-md.pi-md li > *:last-child {
  margin-bottom: 0;
}

.pi-md.pi-md.pi-md hr {
  display: block;
  border: none;
  height: 0.5px;
  margin: 32px 0;
  background: var(--gren-border, rgba(127, 127, 127, 0.28));
}

.pi-md.pi-md.pi-md blockquote {
  border-left: 2px solid var(--gren-fg-muted, rgba(127, 127, 127, 0.55));
  margin: 16px 0 0;
  padding-left: 14px;
}

/* 行内 code 不跟轴。 */
.pi-md.pi-md.pi-md :not(pre) > code {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  font: 12px/19px var(--pi-font-mono);
  background-color: var(--gren-bg-2, rgba(127, 127, 127, 0.1));
  border: 0.5px solid var(--gren-border, rgba(127, 127, 127, 0.22));
  border-radius: 6px;
  padding: 0 5px;
}

/* lobe 的 pre 是 calc(--lobe-markdown-font-size * 0.85)，基字号跟轴后会涨到 14.45px。
   本轮钉在 12px（与现在 14 * 0.85 ≈ 11.9 等价），代码块不跟轴。 */
.pi-md.pi-md.pi-md pre {
  font-size: 12px;
}

.pi-md.pi-md.pi-md table {
  display: table;
  border-collapse: collapse;
  width: 100%;
  margin: 16px 0;
  box-shadow: none;
}

.pi-md.pi-md.pi-md th,
.pi-md.pi-md.pi-md td {
  min-width: 0;
  padding: 10px 16px;
  border-bottom: 0.5px solid var(--gren-border, rgba(127, 127, 127, 0.22));
  font-size: var(--pi-font-size-secondary, 13px);
  line-height: calc(22px + var(--pi-font-delta-secondary, 0px));
  text-align: start;
}

.pi-md.pi-md.pi-md th {
  font-weight: 500;
}

.pi-md.pi-md.pi-md th:first-child,
.pi-md.pi-md.pi-md td:first-child {
  padding-left: 0;
}

.pi-md.pi-md.pi-md td:last-child {
  padding-right: 0;
}

.pi-md.pi-md.pi-md > *:first-child,
.pi-md.pi-md.pi-md p:first-child {
  margin-top: 0;
}

.pi-md.pi-md.pi-md > *:last-child,
.pi-md.pi-md.pi-md p:last-child {
  margin-bottom: 0;
}
```

`index.css` 文件最顶上加：

```css
@import './theme/contentFont.css';
```

删掉：

```css
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
}
```

其余规则（`*` reset、密码框、checkbox、browser）原样保留。

链接保留下划线（`text-decoration: underline` + 低对比下划线色，hover 换成主色）。@lobehub 只给 `a` 换了 `colorInfoText`、没有装饰；我们换成主色后如果不留下划线，链接在正文里几乎不可辨。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/theme/contentFont.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/theme/contentFont.css electron-agent/src/theme/contentFont.test.ts electron-agent/src/index.css
git commit -m @"
feat(theme): 接入苹方字栈与字号轴 CSS

"@
```

---

### 任务 5：`LazyMarkdown` 的 `tone` / `prose` 宿主

**文件：**
- 修改：`electron-agent/src/features/chat/LazyMarkdown.tsx`
- 测试：`electron-agent/src/features/chat/LazyMarkdown.test.tsx`

- [ ] **步骤 1：确认 `Markdown` 转发 `className`（已确认，直接照做）**

`node_modules/@lobehub/ui/es/Markdown/Markdown.mjs:30-33` 把 `className` 用 `cx(variants(...), className)` 传给 `Typography`；`Typography.mjs:9` 再 `cx(styles.root, className)` 落到 `<article>`。走「透传 className」这条路，不要自建 wrapper。

同一处也确认了「动工前必读」里的行内变量链路，任务 5 的 `style` 合成才有意义。

- [ ] **步骤 2：编写失败的测试**

```tsx
import { render, screen } from '@testing-library/react';
import type { CSSProperties, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@lobehub/ui', () => ({
  Markdown: ({
    children,
    className,
    style,
  }: {
    children?: ReactNode;
    className?: string;
    style?: CSSProperties;
  }) => (
    <div className={className} style={style} data-testid="lobe-md">
      {children}
    </div>
  ),
}));

import { LazyMarkdown } from './LazyMarkdown';

describe('LazyMarkdown prose classes', () => {
  it('adds pi-md by default', async () => {
    render(<LazyMarkdown>hello</LazyMarkdown>);
    const root = await screen.findByTestId('lobe-md');
    expect(root.className.split(/\s+/)).toContain('pi-md');
    expect(root.className.split(/\s+/)).not.toContain('pi-md-secondary');
  });

  it('adds pi-md-secondary for tone=secondary', async () => {
    render(
      <LazyMarkdown tone="secondary" enableMermaid={false}>
        hello
      </LazyMarkdown>,
    );
    const root = await screen.findByTestId('lobe-md');
    expect(root.className.split(/\s+/)).toEqual(expect.arrayContaining(['pi-md', 'pi-md-secondary']));
  });

  it('omits pi-md when prose is false', async () => {
    render(
      <LazyMarkdown prose={false} enableMermaid={false}>
        hello
      </LazyMarkdown>,
    );
    const root = await screen.findByTestId('lobe-md');
    expect(root.className.split(/\s+/)).not.toContain('pi-md');
    expect(root.className.split(/\s+/)).not.toContain('pi-md-secondary');
  });

  // 这条是全案的关键回归：@lobehub 在 variant="chat" 下把后代字号钉成 14px，
  // 必须用行内变量指回我们的轴，否则整条字号轴对 Markdown 内容无效。
  it('repoints lobe markdown vars at the axis', async () => {
    render(<LazyMarkdown enableMermaid={false}>hello</LazyMarkdown>);
    const root = await screen.findByTestId('lobe-md');
    expect(root.style.getPropertyValue('--lobe-markdown-font-size')).toBe('var(--pi-font-size, 14px)');
  });

  it('repoints at the secondary axis for tone=secondary', async () => {
    render(
      <LazyMarkdown tone="secondary" enableMermaid={false}>
        hello
      </LazyMarkdown>,
    );
    const root = await screen.findByTestId('lobe-md');
    expect(root.style.getPropertyValue('--lobe-markdown-font-size')).toBe(
      'var(--pi-font-size-secondary, 13px)',
    );
  });
});
```

`enableMermaid={false}` 避免测试去拉 `Mermaid`。默认用例会走 mermaid 分段，但 `'hello'` 没有围栏，仍是单段 markdown。

mock 只导出 `Markdown`，而 `LazyMarkdown` 还会拉进 `./Mermaid`（它从 `@lobehub/ui` 取 `ActionIcon` / `Icon` / `Mermaid`）。这些在 mock 下是 `undefined`，但只在 `Mermaid` 真正渲染时才用到，本用例不渲染它，模块求值不会炸。若后续加了会渲染 Mermaid 的用例，改成
`vi.mock('@lobehub/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('@lobehub/ui')>()), Markdown: ... }))`。

- [ ] **步骤 3：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/LazyMarkdown.test.tsx
```

预期：FAIL，根节点没有 `pi-md`。

- [ ] **步骤 4：编写最少实现**

把 `LazyMarkdown.tsx` 改成（保留现有 ErrorBoundary / mermaid 分段 / `stripInlineImages`；只扩 props 与 className / 兜底 pre）：

```tsx
type LazyMarkdownProps = Omit<MarkdownProps, 'fontSize'> & {
  tone?: 'body' | 'secondary';
  prose?: boolean;
};

function markdownClassName(prose: boolean, tone: 'body' | 'secondary', className?: string): string | undefined {
  const names = [
    prose ? 'pi-md' : null,
    prose && tone === 'secondary' ? 'pi-md-secondary' : null,
    className,
  ].filter(Boolean) as string[];
  return names.length > 0 ? names.join(' ') : undefined;
}

const fallbackPreStyle = {
  margin: 0,
  whiteSpace: 'pre-wrap' as const,
  fontFamily: 'var(--pi-font-sans)',
  fontSize: 'var(--pi-font-size, 14px)',
  lineHeight: 'calc(24px + var(--pi-font-delta, 0px))',
};

// @lobehub 把 --lobe-markdown-font-size / -line-height 写成 <article> 上的行内变量，
// variant="chat" 时恒为 14px / 1.6，会把后代字号钉死（见「动工前必读」）。Typography 里
// `...style` 展开在自有变量之后，用行内 style 指回我们的轴即可。
const LOBE_AXIS_BODY = {
  '--lobe-markdown-font-size': 'var(--pi-font-size, 14px)',
  '--lobe-markdown-line-height': 'calc(24px + var(--pi-font-delta, 0px))',
} as CSSProperties;

const LOBE_AXIS_SECONDARY = {
  '--lobe-markdown-font-size': 'var(--pi-font-size-secondary, 13px)',
  '--lobe-markdown-line-height': 'calc(20px + var(--pi-font-delta-secondary, 0px))',
} as CSSProperties;

function MarkdownBlock(props: Omit<MarkdownProps, 'enableMermaid'>) {
  const plain: ReactNode = props.children as ReactNode;
  return (
    <MarkdownErrorBoundary fallback={<pre style={fallbackPreStyle}>{plain}</pre>}>
      <Suspense fallback={<span style={{ whiteSpace: 'pre-wrap' }}>{plain}</span>}>
        <Markdown enableMermaid={false} {...props} />
      </Suspense>
    </MarkdownErrorBoundary>
  );
}

function LazyMarkdownInner({
  enableMermaid = true,
  children,
  tone = 'body',
  prose = true,
  className,
  style,
  ...rest
}: LazyMarkdownProps) {
  const mdClass = markdownClassName(prose, tone, className);
  const axisStyle = tone === 'secondary' ? LOBE_AXIS_SECONDARY : LOBE_AXIS_BODY;
  const blockProps = { ...rest, className: mdClass, style: { ...axisStyle, ...style } };
  if (typeof children !== 'string') {
    return <MarkdownBlock {...blockProps}>{children}</MarkdownBlock>;
  }
  return <>{renderMermaidAware(stripInlineImages(children), enableMermaid, blockProps)}</>;
}
```

需要 `import type { CSSProperties } from 'react';`。

`renderMermaidAware` 的 `rest` 类型跟着变成带 `className` / `style` 的 `MarkdownRest`。`Omit<MarkdownProps, 'fontSize'>` 会让任务 7 里残留的 `fontSize={14}` 变成 TS 错误，这是故意的。

`style` 只在这里合成，调用方不用管。注意 `Markdown` 的类型是 `style?: CSSProperties`，自定义属性要 `as CSSProperties` 断言（上面两个常量已断言）。

- [ ] **步骤 5：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/LazyMarkdown.test.tsx
```

预期：PASS。

- [ ] **步骤 6：Commit**

```powershell
git add electron-agent/src/features/chat/LazyMarkdown.tsx electron-agent/src/features/chat/LazyMarkdown.test.tsx
git commit -m @"
feat(chat): Markdown 宿主挂上 pi-md

"@
```

---

### 任务 6：外观页字号步进器

**文件：**
- 修改：`electron-agent/src/features/settings/SettingCard.tsx`
- 修改：`electron-agent/src/features/settings/AppearanceSettings.tsx`
- 测试：`electron-agent/src/features/settings/AppearanceSettings.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
import { ThemeProvider } from '@lobehub/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FONT_SIZE_DEFAULT } from '../../theme/contentFont';
import { useThemeStore } from '../../stores/themeStore';
import { AppearanceSettings } from './AppearanceSettings';

afterEach(() => {
  cleanup();
  useThemeStore.setState({ fontSize: FONT_SIZE_DEFAULT });
});

function mount() {
  return render(
    <ThemeProvider themeMode="dark">
      <AppearanceSettings />
    </ThemeProvider>,
  );
}

describe('AppearanceSettings font size', () => {
  it('shows the store value', () => {
    mount();
    expect(screen.getByTestId('font-size-stepper').textContent).toContain('14');
  });

  it('increments and decrements the store', () => {
    mount();
    fireEvent.click(screen.getByTestId('font-size-inc'));
    expect(useThemeStore.getState().fontSize).toBe(15);
    fireEvent.click(screen.getByTestId('font-size-dec'));
    expect(useThemeStore.getState().fontSize).toBe(14);
  });

  it('disables decrement at 12 and increment at 17', () => {
    useThemeStore.setState({ fontSize: 12 });
    const { unmount } = mount();
    expect(screen.getByTestId('font-size-dec')).toBeDisabled();
    expect(screen.getByTestId('font-size-inc')).not.toBeDisabled();
    unmount();
    useThemeStore.setState({ fontSize: 17 });
    mount();
    expect(screen.getByTestId('font-size-inc')).toBeDisabled();
    expect(screen.getByTestId('font-size-dec')).not.toBeDisabled();
  });
});
```

`getByTestId('font-size-stepper').textContent` 会含胶囊里的数字和旁边的 `px`。用 `toContain('14')` 即可。若 `ColorSwatches` 把测试拖垮，再 `vi.mock('@lobehub/ui', async (importOriginal) => { const actual = await importOriginal<typeof import('@lobehub/ui')>(); return { ...actual, ColorSwatches: () => null }; })`。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/settings/AppearanceSettings.test.tsx
```

预期：FAIL，找不到 `font-size-stepper`。

- [ ] **步骤 3：`SettingCard` 增加 `desc`**

```tsx
interface Props {
  title?: string;
  desc?: ReactNode;
  children: ReactNode;
}

const useStyles = createStyles(({ css, token }) => ({
  card: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    padding: 16px 20px;
    margin-block-end: 16px;
  `,
  title: css`
    font-size: var(--pi-font-size, 14px);
    font-weight: 600;
    color: ${token.colorText};
    margin-block-end: 8px;
  `,
  titleWithDesc: css`
    margin-block-end: 4px;
  `,
  desc: css`
    font-size: var(--pi-font-size-secondary, 13px);
    color: ${token.colorTextDescription};
    margin-block-end: 8px;
    line-height: calc(20px + var(--pi-font-delta-secondary, 0px));
  `,
}));

export function SettingCard({ title, desc, children }: Props) {
  const { styles, cx } = useStyles();
  return (
    <div className={styles.card} data-testid={title ? `set-card-${title}` : 'set-card'}>
      {title ? <div className={cx(styles.title, desc && styles.titleWithDesc)}>{title}</div> : null}
      {desc ? <div className={styles.desc}>{desc}</div> : null}
      {children}
    </div>
  );
}
```

- [ ] **步骤 4：在 `AppearanceSettings` 加步进器**

在现有 `styles` 里追加（token 用 `cssVar`，与文件其余部分一致）：

```ts
control: css`
  display: inline-flex;
  align-items: center;
  gap: 8px;
`,
stepper: css`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 72px;
  height: 36px;
  border-radius: 18px;
  background: ${cssVar.colorFillSecondary};
  font-size: var(--pi-font-size, 14px);
  line-height: calc(24px + var(--pi-font-delta, 0px));
`,
value: css`
  min-width: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
`,
unit: css`
  font-size: var(--pi-font-size, 14px);
  color: ${cssVar.colorTextSecondary};
`,
arrows: css`
  position: absolute;
  right: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  opacity: 0;
  .stepper:hover &,
  .stepper:focus-within & {
    opacity: 1;
  }
`,
arrow: css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 12px;
  padding: 0;
  border: none;
  border-radius: 3px;
  color: ${cssVar.colorText};
  background: ${cssVar.colorFillTertiary};
  cursor: pointer;
  &:disabled {
    color: ${cssVar.colorTextQuaternary};
    cursor: default;
  }
`,
```

箭头默认隐藏、hover / focus-within 才显示。这里**不能**写 `.stepper:hover .arrows`：antd-style 生成的 `styles.arrows` / `styles.stepper` 是哈希类名（如 `css-1a2b3c`），模板里写死 `.arrows` / `.stepper` 永远选不中；`&:hover &` 那套父选择器插值在 `createStaticStyles` 里也编不出来。用一个字面量属性选择器当锚点：

```ts
stepper: css`
  /* …几何… */
  &:hover [data-arrows],
  &:focus-within [data-arrows] {
    opacity: 1;
  }
`,
arrows: css`
  position: absolute;
  right: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  opacity: 0;
`,
```

JSX 里给箭头容器加 `data-arrows`（空属性即可，不需要值）。

组件里：

```tsx
import { ChevronDown, ChevronUp } from 'lucide-react';
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../theme/contentFont';

const fontSize = useThemeStore((s) => s.fontSize);
const setFontSize = useThemeStore((s) => s.setFontSize);
```

在现有第一张「主题」卡片**之前**插入：

```tsx
<SettingCard
  title="对话字号"
  desc="只放大可读文字。模块栏、状态标签和代码保持原大小。"
>
  <div className={styles.control}>
    <div className={styles.stepper} data-testid="font-size-stepper">
      <span className={styles.value}>{fontSize}</span>
      <span className={styles.arrows} data-arrows>
        <button
          type="button"
          className={styles.arrow}
          data-testid="font-size-inc"
          aria-label="增大字号"
          disabled={fontSize >= FONT_SIZE_MAX}
          onClick={() => setFontSize(fontSize + 1)}
        >
          <Icon icon={ChevronUp} size={9} />
        </button>
        <button
          type="button"
          className={styles.arrow}
          data-testid="font-size-dec"
          aria-label="减小字号"
          disabled={fontSize <= FONT_SIZE_MIN}
          onClick={() => setFontSize(fontSize - 1)}
        >
          <Icon icon={ChevronDown} size={9} />
        </button>
      </span>
    </div>
    <span className={styles.unit}>px</span>
  </div>
</SettingCard>
```

数字必须来自 store，不要用 click 回声。文件顶部已有 `Icon` 从 `@lobehub/ui` 导入。

- [ ] **步骤 5：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/settings/AppearanceSettings.test.tsx
```

预期：PASS。

- [ ] **步骤 6：Commit**

```powershell
git add electron-agent/src/features/settings/SettingCard.tsx electron-agent/src/features/settings/AppearanceSettings.tsx electron-agent/src/features/settings/AppearanceSettings.test.tsx
git commit -m @"
feat(settings): 外观页增加对话字号步进器

"@
```

---

### 任务 7：Markdown 调用方与通知紧凑标题

**文件：**
- 修改：`electron-agent/src/features/chat/TurnTimeline.tsx`（约第 50 行）
- 修改：`electron-agent/src/features/chat/ReasoningInline.tsx`（约第 119 行）
- 修改：`electron-agent/src/features/chat/NoticePill.tsx`
- 修改：`electron-agent/src/features/chat/NoticeSplitPill.tsx`
- 修改：`electron-agent/src/features/chat/SubAgentInline.tsx`（约第 273、286 行）
- 修改：`electron-agent/src/features/chat/PlanCard.tsx`（约第 199 行）
- 修改：`electron-agent/src/features/chat/MarkdownWarmup.tsx`（约第 60 行）
- 修改：`electron-agent/src/features/panels/PageContentViewer.tsx`（约第 91 行）
- 修改：`electron-agent/src/components/QuestionSelector/index.tsx`（约第 225 行）

任务 5 的 `Omit<MarkdownProps, 'fontSize'>` 会让这些 `fontSize={12|13|14}` 编译失败。本任务只改调用方和通知内部 CSS，不改 Wiki（任务 8）。

- [ ] **步骤 1：跑一次现有相关测试，确认基线**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/ReasoningInline.test.tsx src/features/chat/TurnTimeline.test.tsx src/features/chat/LazyMarkdown.test.tsx
```

预期：PASS（若某文件因 `fontSize` 类型已红，先做步骤 2）。

- [ ] **步骤 2：替换调用**

| 文件 | 改成 |
| --- | --- |
| `TurnTimeline.tsx` | `<LazyMarkdown variant="chat" animated={segment.streaming}>` |
| `ReasoningInline.tsx` | `<LazyMarkdown variant="chat" tone="secondary">` |
| `NoticePill.tsx` | `<LazyMarkdown variant="chat" tone="secondary">` |
| `NoticeSplitPill.tsx` | 同上 |
| `SubAgentInline.tsx` 两处 | `<LazyMarkdown variant="chat" tone="secondary">` |
| `PlanCard.tsx` | `<LazyMarkdown>`（已无 fontSize，保持默认 prose） |
| `MarkdownWarmup.tsx` | `<LazyMarkdown variant="chat">` |
| `PageContentViewer.tsx` | `<LazyMarkdown variant="chat" tone="secondary">` |
| `QuestionSelector/index.tsx` | `<LazyMarkdown enableMermaid={false} variant="chat">` |

全文搜索 `fontSize={` 在 `electron-agent/src` 里不应再命中 `LazyMarkdown`。

- [ ] **步骤 3：通知紧凑标题提高特异度**

`NoticePill.tsx` 与 `NoticeSplitPill.tsx` 的 `.body` 里，把写死 12 px 改成次级变量，选择器改打在 `.pi-md` 上。

两条硬约束：

1. **`font` 简写里不能写 `/ inherit`。** `font: 600 13px / inherit sans` 是非法的（`inherit` 只能作为整条属性的 CSS 关键字，不能作为简写的 line-height 分量）；带 `var()` 时它会在「计算值时刻无效」，整条 `font` 被丢弃，标题既不变粗也拿不到我们的字号。改用普通属性。
2. **特异度要压过我们在 `contentFont.css` 里的 `.pi-md.pi-md.pi-md h1`（(0,3,1)），也必须压过 @lobehub 的 (0,2,1)。** 所以通知这边用 `& .pi-md.pi-md.pi-md :is(...)` → (0,4,1)。

```ts
body: css`
  max-height: 200px;
  margin-block-start: 4px;
  overflow: auto;
  padding-inline-end: 4px;
  scrollbar-width: thin;
  font-size: var(--pi-font-size-secondary, 13px);
  color: ${cssVar.colorTextSecondary};

  & .pi-md.pi-md.pi-md :is(h1, h2, h3, h4, h5, h6) {
    margin: 4px 0;
    font-size: var(--pi-font-size-secondary, 13px);
    font-weight: 600;
    color: ${cssVar.colorTextSecondary};
  }

  & .pi-md.pi-md.pi-md p {
    margin: 4px 0;
  }

  & .pi-md.pi-md.pi-md :is(ul, ol) {
    margin: 2px 0;
    padding-inline-start: 18px;
  }

  & .pi-md.pi-md.pi-md li {
    margin: 1px 0;
  }
`,
```

两份文件结构相同（`NoticeSplitPill` 原规则只到 h4，统一扩到 h6 无害）。都改。

- [ ] **步骤 4：运行测试**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/LazyMarkdown.test.tsx src/features/chat/ReasoningInline.test.tsx src/features/chat/TurnTimeline.test.tsx
```

预期：PASS。再跑：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit -p tsconfig.json
```

若项目 `tsc` 太慢或配置不含 renderer，至少保证
`npx vitest run src/features/chat src/components/QuestionSelector src/features/panels` 里现有测试仍绿。
（按目录给，不要写 `src/features/panels/PageContentViewer.test.tsx`——该文件不存在，vitest 会直接报 “No test files found” 并以非 0 退出。）

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/TurnTimeline.tsx electron-agent/src/features/chat/ReasoningInline.tsx electron-agent/src/features/chat/NoticePill.tsx electron-agent/src/features/chat/NoticeSplitPill.tsx electron-agent/src/features/chat/SubAgentInline.tsx electron-agent/src/features/chat/PlanCard.tsx electron-agent/src/features/chat/MarkdownWarmup.tsx electron-agent/src/features/panels/PageContentViewer.tsx electron-agent/src/components/QuestionSelector/index.tsx
git commit -m @"
feat(chat): 对话 Markdown 改走字号轴

"@
```

`PlanCard.tsx` 本任务只动 LazyMarkdown 那一行的话，若还没改 title/summary，任务 8 再改样式；也可以本任务一步改完 PlanCard 样式，避免文件拆两次。**推荐本任务把 PlanCard 样式一并改完**（见步骤 3b）。

- [ ] **步骤 3b（与步骤 3 一起做）：`PlanCard` 与 `PageContentViewer` 字号**

`PlanCard.tsx`：

```ts
title: css`
  padding: 9px 12px 0;
  font-size: var(--pi-font-size, 14px);
  font-weight: 600;
  letter-spacing: -0.01em;
  color: ${cssVar.colorText};
`,
summary: css`
  padding: 4px 12px 0;
  font-size: var(--pi-font-size-secondary, 13px);
  line-height: calc(20px + var(--pi-font-delta-secondary, 0px));
  color: ${cssVar.colorTextSecondary};
  white-space: pre-wrap;
`,
todo: css`
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: var(--pi-font-size, 14px);
  color: ${cssVar.colorText};
`,
docError: css`
  font-size: var(--pi-font-size, 14px);
  color: ${cssVar.colorTextTertiary};
`,
fallback: css`
  padding: 10px 12px;
  font-size: var(--pi-font-size, 14px);
  color: ${cssVar.colorTextSecondary};
  white-space: pre-wrap;
`,
```

（上面是完整规则，别只贴 `font-size` 一行把 `color` / `padding` 丢了。）

`more` 保持 `font-size: 12px`。

`PageContentViewer.tsx` 的 `.body`：

```ts
body: css`
  overflow-x: hidden;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  padding-inline-end: 4px;
  font-size: var(--pi-font-size-secondary, 13px);
  line-height: calc(20px + var(--pi-font-delta-secondary, 0px));
  color: ${cssVar.colorText};
  word-break: break-word;
  overflow-wrap: anywhere;
`,
```

`.url` 12 px、`.meta` 11 px 不动。

---

### 任务 8：其余可读表面 + Wiki `prose={false}`

**文件：**
- 修改：`electron-agent/src/features/chat/chatStyles.ts`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx`
- 修改：`electron-agent/src/features/sessions/ProjectItem.tsx`
- 修改：`electron-agent/src/features/sessions/Sidebar.tsx`
- 修改：`electron-agent/src/features/tools/cardStyles.ts`
- 修改：`electron-agent/src/features/settings/SettingField.tsx`
- 修改：`electron-agent/src/features/settings/ProvidersSettings.tsx`
- 修改：`electron-agent/src/features/settings/CapabilityModelField.tsx`
- 修改：`electron-agent/src/features/settings/ProviderDiagnostics.tsx`
- 修改：`electron-agent/src/features/agentData/wiki/WikiLibraryWorkspace.tsx`
- 修改：`electron-agent/src/features/agentData/wiki/WikiPageEditor.tsx`
- 修改：`electron-agent/src/features/agentData/wiki/WikiSourceDialog.tsx`

- [ ] **步骤 1：气泡与输入框**

`chatStyles.ts` 的 `bubble`：

```ts
bubble: css`
  padding: 8px 12px;
  border: 1px solid ${cssVar.colorBorderSecondary};
  border-radius: ${cssVar.borderRadius};
  background: ${cssVar.colorFillQuaternary};
  font: var(--pi-md-base);
  white-space: pre-wrap;
  word-break: break-word;
`,
```

`MessageEditor.tsx` 的 `editor` 在现有 `p { margin-block: 0 }` 之前加：

```ts
editor: css`
  font: var(--pi-md-base);

  p {
    margin-block: 0;
  }
  /* 其余 .editor_mention 规则保留 */
`,
```

- [ ] **步骤 2：侧栏与工具摘要**

`ProjectItem.tsx` 的 `row`：删掉 `font-size: 13px;`（继承 body 正文字号）。高度 32 px 保留。

`Sidebar.tsx` 的 `.more`：

```ts
font-size: var(--pi-font-size-secondary, 13px);
```

`.sec` / `.secLabel` 的 11 px 不动。

`cardStyles.ts` 的 `inspectorTitle`：

```ts
font-size: var(--pi-font-size-secondary, 13px);
```

`pathLabel` / `paramKey` / `paramValue` / `toolName` 的等宽与 12 px 不动。

- [ ] **步骤 3：设置字段名与说明**

四处 `label` 现 13 px → `font-size: var(--pi-font-size, 14px);`

四处 `desc` 现 12 px → `font-size: var(--pi-font-size-secondary, 13px);`

具体键：

- `SettingField.tsx` 的 `label`、`desc`
- `ProvidersSettings.tsx` 的 `label`、`desc`（`title` 13/600 也是字段区标题，改成 `var(--pi-font-size, 14px)`）
- `CapabilityModelField.tsx` 的 `label`、`desc`
- `ProviderDiagnostics.tsx` 的 `label`、`desc`（`title` 同样改成正文字号；`metricLabel` 11 px、`metricValue` 14 px 写死保留）

- [ ] **步骤 4：Wiki 关掉聊天阶梯**

四个调用都加 `prose={false}`，不要改 `wikiStyles.root` 的 13 px：

- `WikiLibraryWorkspace.tsx`：`<LazyMarkdown prose={false}>{sourceDetail.content}</LazyMarkdown>`
- `WikiPageEditor.tsx` 预览与快照两处
- `WikiSourceDialog.tsx` 预览资料

- [ ] **步骤 5：运行测试**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/theme src/stores/themeStore.test.ts src/features/settings/AppearanceSettings.test.tsx src/features/chat/LazyMarkdown.test.tsx src/features/chat/chatStyles.test.ts src/features/settings/ProvidersSettings.test.tsx src/features/agentData/WikiPanel.test.tsx
```

`WikiPanel.test.tsx` 若 mock 了 `LazyMarkdown`，确认没被 `prose` 打坏（mock 通常忽略多余 props）。

预期：PASS。

- [ ] **步骤 6：Commit**

```powershell
git add electron-agent/src/features/chat/chatStyles.ts electron-agent/src/features/chat/input/editor/MessageEditor.tsx electron-agent/src/features/sessions/ProjectItem.tsx electron-agent/src/features/sessions/Sidebar.tsx electron-agent/src/features/tools/cardStyles.ts electron-agent/src/features/settings/SettingField.tsx electron-agent/src/features/settings/ProvidersSettings.tsx electron-agent/src/features/settings/CapabilityModelField.tsx electron-agent/src/features/settings/ProviderDiagnostics.tsx electron-agent/src/features/agentData/wiki/WikiLibraryWorkspace.tsx electron-agent/src/features/agentData/wiki/WikiPageEditor.tsx electron-agent/src/features/agentData/wiki/WikiSourceDialog.tsx
git commit -m @"
feat(ui): 可读文字改读对话字号轴

"@
```

---

## 全部完成后的人工核对（不自动化）

对照规格 §1：

1. DevTools 里 `body` 的 `font-size` / `font-family` 生效规则应是 `html body`（`contentFont.css`），不是 antd 的 `body` reset。
2. 一段中文消息的 computed `font-family`：Windows 命中微软雅黑，macOS 命中苹方；栈里不应再出现 Roboto / Oxygen。
3. 默认 14 时 Setting 字段名、侧栏项目名会比现在大约 1 px，这是接受项。
4. 字号调到 17：正文 17、h2 22、思考/通知 15、模块栏仍 56、行内 code 仍 12。刷新后字号仍在。
5. **对话 Markdown 内**：DevTools 选一个助手正文 `<p>`，确认它是 `<article class="… pi-md">` 的后代、`font-size` 为 17 px（不是 14），且 `<article>` 的行内 `style` 里 `--lobe-markdown-font-size` 是 `var(--pi-font-size, 14px)`。这是全案最容易静默失效的一处。

---

## 自检

**规格覆盖**

| 规格章节 | 任务 |
| --- | --- |
| §3 clamp / 常量 | 任务 1 |
| §3 themeStore + onRehydrateStorage | 任务 2 |
| §3 ThemeBridge 只写 `--pi-font-size` | 任务 3 |
| §3 CSS 轴、`html body`、sans/mono | 任务 4 |
| §4 `.pi-md` 规则（(0,3,x) 压过 @lobehub (0,2,x)）、mermaid `+` 缝、`pre` 钉 12 px | 任务 4 |
| §4 行内 `--lobe-markdown-*` 指回轴 | 任务 5（含两条回归断言） |
| §4 tone/prose 宿主、兜底 pre | 任务 5 |
| §4 通知紧凑标题特异度 | 任务 7 |
| §6 SettingCard.desc + 步进器 | 任务 6 |
| §5 正文/次级调用方 | 任务 7–8 |
| §4 Wiki `prose={false}`、root 13 不动 | 任务 8 |
| §7 错误处理 | 任务 1–2、任务 5 兜底 pre |
| §8 测试表 | 任务 1、2、3、5、6（无 CSS `min()` 单测，符合规格） |
| 非目标：antd token、SettingsPanel 框架、模块栏、11 px、code 高亮 | 未列入任何任务 |

**占位符：** 无 TODO /「类似任务 N」。`ColorSwatches` mock 是条件句，有具体代码。

**类型名：** `clampFontSize`、`FONT_SIZE_*`、`tone`、`prose`、`useFontSizeSync`、`--pi-font-size` 前后一致。无 `secondaryFontSize`。
