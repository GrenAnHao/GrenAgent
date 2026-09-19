# 对话排版与字号轴

- 日期：2026-09-15
- 范围：GrenAgent 桌面端可读文字的字体栈、Markdown 排版、外观里 12–17 px 字号轴
- 状态：设计已按节批准，待实现计划
- 对照：DSH `ui-theme` 字号设置、`gradient-shadow-text.css` 轴公式、`MarkdownText.module.css` 块间距；不换 DSH 的 Markdown 解析器

## 1. 目标 / 非目标

**目标**

1. 中文字体栈对齐 DSH（苹方 / 微软雅黑优先），去掉现在 `body` 里 Roboto / Oxygen 抢在中文脸前面的问题。
2. 助手 Markdown 的标题阶梯、行高、段/列表/表格间距对齐 DSH（默认 14 / 24，h2 = 19 / 28）。
3. 外观设置增加对话字号 12–17（默认 14），立刻生效；标题、次级文字跟同一增量。
4. 整窗可读文字跟轴（侧栏会话名、设置文案、输入框都跟）。模块栏、11 px 标签、code、消息操作图标保持像素。

**非目标**

- 不替换 `@lobehub/ui` Markdown，不做 DSH 自研解析器、增量冻结、CJK `**加粗**` 语法。
- 不做宽表格撑出对话列。
- 不改 antd `token.fontSize`（避免按钮、Tag、模块栏一起胀）。
- 不把 Wiki 文档区改成聊天标题阶梯（Wiki 工作区字号来自 `wikiStyles.root` 写死的 13 px，本轮不动）。
- 不改代码高亮字号、终端字号。
- 不改 `SettingsPanel` 面板框架自身的字号（18 px 页标题、13 px 导航项、12 px 分组标题）。
- 不做 Electron 窗口级 e2e。

**成功标准**

默认 14 时，助手正文是 14 px / 24 px 行高，h2 为 700 / 19 / 28，段落与列表块间距 16 px，表格用次级字号和发丝分割。外观里把字号调到 17 后，正文变 17、h2 变 22，思考/通知仍比正文小一号（15），模块栏宽度仍 56 px，行内 code 仍 12 px。刷新后字号仍在。非法持久化值回落到 12–17 内或 14。

另需人工确认三条：

1. DevTools 里 `body` 的 `font-family` / `font-size` **确实由 `contentFont.css` 的 `html body` 规则生效**，不是 antd reset。
2. 中文在 Windows 上落微软雅黑、macOS 上落苹方，不再被 Roboto / Oxygen 截胡（取一段中文消息看 computed font-family 的实际命中字体）。
3. §5 列出的「默认档 1 px 变大」已看过实际观感并接受。
4. 对话 Markdown 内：助手正文 `<p>` 的 `font-size` 跟着轴走（调到 17 时是 17 而不是 14），`<article>` 行内 `--lobe-markdown-font-size` 指向 `var(--pi-font-size, 14px)`。这是全案最容易静默失效的一处。

## 2. 已确认的设计决定

| 维度 | 决定 |
| --- | --- |
| 渲染器 | 继续 `@lobehub/ui` Markdown，外面包 `.pi-md` 盖样式 |
| `pi-md` 宿主 | `className` 透传给 `Markdown`（需先确认它转发到根节点）；不转发则 `LazyMarkdown` 自建 `<div>` |
| 字号状态 | `themeStore.fontSize`，`pi-theme` 持久化，非后端 config |
| 写入 DOM | `ThemeBridge` 写 `--pi-font-size` 到 `documentElement` |
| 派生轴 | 静态 CSS 用 DSH 公式算 delta / secondary / 标题阶梯 |
| 字体栈 | `html body`（不是 `body`），对标 DSH `--dsw-font-family` |
| 跟轴范围 | 整窗可读文字 |
| 不跟轴 | 模块栏、11 px 标签、code、消息操作图标、SettingsPanel 框架 |
| 次级档 | 思考、通知、工具摘要、设置说明：始终比正文小一号（DSH secondary 公式） |
| 侧栏行 | 高度仍 28 / 32 px，标题跟字号、单行省略 |
| 设置 UI | 外观页「对话字号」胶囊步进器，即时生效；`SettingCard` 加 `desc` prop |
| Wiki | `LazyMarkdown` 可关 prose；不套聊天标题阶梯 |

## 3. 字号轴

新建 `electron-agent/src/theme/contentFont.ts`，作为唯一数字来源：

```ts
export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 17
export const FONT_SIZE_DEFAULT = 14

export function clampFontSize(value: unknown): number
```

`clampFontSize`：非有限数字 → 14；否则 `Math.round` 后夹进 12–17。

次级档一律走 CSS 的 `min/max` 派生，**不再导出 `secondaryFontSize()`**：实现里没有任何需要 px 数字的地方（全部是 CSS 变量或 antd-style 模板字符串），导出它只会变成没有消费方的空壳。公式正确性由下面这张表 + §1 成功标准人工核对（jsdom 不解析 `min()/max()`，写不了单测，见 §8）。

次级表（与 CSS 等价，单位 px）：

| 正文 | 12 | 13 | 14 | 15 | 16 | 17 |
| --- | --- | --- | --- | --- | --- | --- |
| 次级 | 11 | 12 | 13 | 13 | 14 | 15 |

公式：`min(size - 1, max(13, size - 2))`，CSS 里照抄字面量。

`themeStore` 增加 `fontSize: number`（默认 14）和 `setFontSize(n)`（内部 clamp）。`partialize` 带上 `fontSize`。rehydrate 后再 clamp 一次，脏数据不会写出非法 `--pi-font-size`。

`ThemeBridge` 订阅 `fontSize`，执行：

```ts
document.documentElement.style.setProperty('--pi-font-size', `${clampFontSize(fontSize)}px`)
```

只写这一条。其余由 `electron-agent/src/theme/contentFont.css` 在 `html` 上派生（与 DSH 把派生写在 `body` 上同构，我们挂 `html` 以便和现有 `--gren-*` 一起从根继承）：

```css
html {
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
```

`--pi-font-sans` 与 `--pi-font-mono` 定义在**同一个 `html { }` 块内**（自定义属性必须有宿主选择器，不要单独裸写在文件里）：

```css
html {
  /* …上面那批派生 token… */
  --pi-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --pi-font-mono: "SF Mono", "JetBrains Mono", "Fira Code", Consolas,
    "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei";
}
```

`--pi-font-mono` 故意没有裸 `monospace` 尾巴，避免 Windows 中文落到宋体（DSH 同款注释）。

`--pi-font-sans` 也没带 antd 默认栈里的 `'Apple Color Emoji' / 'Segoe UI Emoji'`。当前 emoji 走 `@lobehub/fluent-emoji` 图片、图标走 lucide 的 SVG，不依赖文本 emoji 字体；若实现时发现某处确实渲染文本 emoji，在 `sans-serif` 前补回这两个族名即可。

`index.css` 的 `body` 字体改为 `var(--pi-font-sans)`，并加上字号/行高。**选择器必须写成 `html body`，不能写 `body`**：

```css
html body {
  font-family: var(--pi-font-sans);
  font-size: var(--pi-font-size, 14px);
  line-height: calc(24px + var(--pi-font-delta, 0px));
}
```

原因：antd v6 的全局 reset 里有一条无哈希的 `body { font-size: <token.fontSize>; font-family: <token.fontFamily>; }`（本项目 `App.tsx` 用 `hashed: false` + `cssVar`，reset 仍按无 hash 注入）。它由 cssinjs 在 React 渲染时注入 `<style>`，**晚于** Vite 在模块求值阶段注入的 `index.css`，同为 `body`（0,0,1）时后者胜出、整条轴失效。`html body` 特异度 0,0,2，与注入顺序无关。这不是理论风险：现有 `index.css` 的 `body` 字体栈能否生效本身也受同一顺序影响，实现第一步就是打开 DevTools 确认「body 的 font-size / font-family 由哪条规则生效」，再按上式落地。

`contentFont.css` 在 `src/index.css` 顶部 `@import`。首帧在 `ThemeBridge` 跑完之前，`--pi-font-size` 未写时用 `14px` fallback，与默认一致。

**已知取舍：** body 用 px 行高，后代按「计算值」继承，因此自身字号大于正文且未重写行高的元素（如 `SettingsPanel` 的 18 px 页标题）在放大时会显得偏紧。接受，不为此引入第二条轴。

## 4. Markdown 排版（`.pi-md`）

`LazyMarkdown` 默认给根节点加 `pi-md`。新增：

```ts
tone?: 'body' | 'secondary'  // 默认 body
prose?: boolean              // 默认 true；false 时不加 pi-md，供 Wiki
```

调用方不再传数字 `fontSize`。`.pi-md` 自己设 `font: var(--pi-md-base)`，权重高于 lobehub 默认。`className` 若有则拼在后面。

**宿主怎么来（实现前先定）：** `LazyMarkdown`（`features/chat/LazyMarkdown.tsx`）现在没有任何包裹元素，正文直接是 `@lobehub/ui` 的 `<Markdown>` 根节点。两条路径二选一：

1. **推荐**——把 `pi-md` 作为 `className` 透传给 `<Markdown className={cx('pi-md', className)}>`。前提是 `@lobehub/ui` 的 `Markdown` 把 `className` 转发到根节点；**实现第一步要在 DevTools 里确认**，不确认就假设会白干活。
2. 兜底——`LazyMarkdown` 自己包一层 `<div className="pi-md">`。副作用是给每条消息多加一个 DOM 层，且 §4 里「第一个/最后一个子块」的语义变成对这一层生效，需重测。

`.pi-md` 选择器打在宿主下的语义标签（`h1`–`h6`、`p`、`ul`/`ol`、`blockquote`、`hr`、`a`、`table`、`:not(pre) > code`），不依赖 lobehub 内部 class。

**层叠：`.pi-md` 打不过 @lobehub，必须显式加权（已实测 `node_modules/@lobehub/ui/es/Markdown/`）。**

- `Markdown.mjs:15`：`variant="chat"` 时 `fontSize` 默认 **14**，经 `Typography.mjs:11-18` 写成 `<article>` 上的**行内**变量 `--lobe-markdown-font-size: 14px`。
- `markdown.style.mjs:368-393` 的 root 规则是 `.hash :not(:has(.ignore-markdown-style)) { font-size: var(--lobe-markdown-font-size) }` → **(0,2,0)**；标题为 **(0,2,1)**。字号落在**每个后代**上而不是 `<article>` 上，所以 `variant="chat"` 时后代恒为 14 px。
- `.pi-md p` / `.pi-md h1` 只有 (0,1,1)，全输；`@lobehub/ui` 在 `LazyMarkdown` 里是 `lazy()` 动态导入，注入晚于 `contentFont.css`，打平也输。

因此两条必做：

1. `LazyMarkdown` 给 `<Markdown>` 传 `style`，把 `--lobe-markdown-font-size` / `--lobe-markdown-line-height` 用行内变量指回我们的轴（`Typography` 里 `...style` 展开在自有变量之后，压得住）。`tone="secondary"` 时指向次级变量。
2. `contentFont.css` 里所有 `.pi-md` 规则写成 **`.pi-md.pi-md.pi-md …`（(0,3,x)）**，确定性压过 (0,2,x)。不靠注入顺序，也不整表 `!important`。

另：`pre` 的字号是 `calc(--lobe-markdown-font-size * 0.85)`，基字号跟轴后会涨到 14.45 px，需显式钉回 12 px（代码块不跟轴）。

**mermaid 分段留缝：** `renderMermaidAware` 在含 mermaid 的消息里会吐出**多个** `MarkdownBlock`（`LazyMarkdown.tsx` 第 50–62 行），即多个平级 `.pi-md`。加上「首/末子块 margin 归零」后，相邻 `.pi-md` 的子元素 margin 会穿透塌陷成 0，图前后文字会贴死。补一条：

```css
.pi-md + .pi-md { margin-block-start: 16px; }
```

规则（对标 DSH `MarkdownText.module.css`，token 换成 `--pi-*` / `--gren-*` / `cssVar` 能表达的边框色）：

- 根：`font: var(--pi-md-base)`；`overflow-wrap: anywhere`。
- `h1`–`h3`：对应 `--pi-md-h*`，`margin: 32px 0 16px`。
- `h4`：`--pi-md-h4`，`margin: 16px 0`。
- `h5, h6`：600 + 正文字号 / 24+delta，`margin: 16px 0`。
- 标题内 `strong`：`font-weight: inherit`。
- `p`：`margin: 16px 0`。
- `h4`–`h6` 后紧跟列表：缝 8 px。
- `ul, ol`：`margin: 16px 0; padding-left: 18px`。`li` 非首项 `margin-top: 6px`。嵌套列表 `margin-top: 4px`。
- `hr`：0.5 px 高、`margin: 32px 0`，色用 `colorBorderSecondary`。
- `blockquote`：左 2 px 次要色、`padding-left: 14px`、`margin: 16px 0 0`。
- 行内 code：固定 `12px / 19px`、`var(--pi-font-mono)`、浅底、0.5 px 边、`border-radius: 6px`、`padding: 0 5px`。**不跟轴**。
- 表格：单元格字号 `--pi-font-size-secondary`、行高 `calc(22px + var(--pi-font-delta-secondary))`；`th` 字重 500；`padding: 10px 16px`；底边 0.5 px；首列 `padding-left: 0`。不实现 DSH 的宽表 `overflow` 切换和列外撑开。
- 第一个 / 最后一个子块 `margin-top` / `margin-bottom` 为 0。

`.pi-md.pi-md-secondary`（`tone="secondary"`）：根改用 `--pi-font-size-secondary` 与 `calc(20px + var(--pi-font-delta-secondary, 0px))`。标题仍用同一套阶梯 token（会略大于次级正文，这是 DSH 思考区也不把 h2 压成 13 的取舍）；通知卡片例外见下。

**通知例外：** `NoticePill` / `NoticeSplitPill` 现在把内部 h1–h4 压成 12 px 紧凑块（`NoticePill.tsx` 第 18–26 行、`.body` 第 15 行 12 px）。继续保持紧凑：标题字号改为 `var(--pi-font-size-secondary)`，`margin` 仍 4 px，不套 32 / 16 的聊天阶梯。它们仍传 `tone="secondary"`。

**别靠注入顺序取胜，也别用非法简写：** 通知规则要压过聊天阶梯的 (0,3,1)，写成 `.body .pi-md.pi-md.pi-md :is(h1,...,h6)`（(0,4,1)）。另外 `font: 600 13px / inherit sans` 是**非法**的——`inherit` 不能做简写的 line-height 分量，带 `var()` 时整条 `font` 会在计算值时刻被丢弃；改用 `font-size` + `font-weight` 两条普通属性。

**Wiki：** 更正一处事实——`wikiStyles.document` 只设了 `width / max-width / line-height: 1.65` 和 `pre`、`img` 规则，**不含任何字号与标题规则**；17 px / 18 px 的 h3 属于 `wikiStyles.header`、`listHeader` 等其他键。所以：

- 调用处仍传 `prose={false}`——否则聊天阶梯会直接落进资料页且无人压制。
- 「Wiki 根字号」没有可改的地方：Wiki 工作区的字号来自 `wikiStyles.root` 的写死 13 px，与 `body` 无关，本轮不动。
- 四个调用点：`WikiLibraryWorkspace.tsx:316`、`WikiPageEditor.tsx:125`、`WikiPageEditor.tsx:142`、`WikiSourceDialog.tsx:118`。

## 5. 谁读哪一档

**正文（`--pi-font-size` / 24+delta）**

- 助手 `TurnTimeline` 文本段、用户气泡（`chatStyles.bubble` 去掉写死 14 / 1.6）
- 输入框 `MessageEditor` 的 `.editor`（`font: var(--pi-md-base)`）
- 侧栏会话名、项目名（`ProjectItem` 去掉写死 13 px；`SessionItem` 本身没写死，自动跟）
- 设置卡片标题、字段名（`SettingCard.title` 现 14；`SettingField.tsx` 里 `SettingFieldInput` 的 `styles.label` 现 13）
- `QuestionSelector`（现 `fontSize={14}`）、`MarkdownWarmup`（现 14）
- `PlanCard`：正文 Markdown（`PlanCard.tsx:199`）、待办行 `styles.todo`（现 13）、`fallback` / `docError`（现 13）、卡片标题 `styles.title`（现 14）

**次级（`--pi-font-size-secondary`）**

- `ReasoningInline`
- `NoticePill` / `NoticeSplitPill`（含紧凑标题，见 §4）
- `SubAgentInline` 里现在 `fontSize={13}` 的 Markdown
- 工具卡摘要行（`cardStyles.inspectorTitle` 的 12 px 改为 secondary；等宽 path / param 仍固定 12 px）
- 设置字段说明（说明文字一律次级：`SettingFieldInput` 的 `styles.desc`，以及三处复制实现 `ProvidersSettings.desc`、`CapabilityModelField.desc`、`ProviderDiagnostics.desc`，均为 12）
- `PageContentViewer`（`.body` 现 13）
- `PlanCard` 摘要（现 12.5 px）
- 侧栏「更多」行（`Sidebar` `.more` 现 12 px）

**固定像素（本轮不改数字）**

- `ModuleRail` 宽 56、格子 42
- 一切现有 11 px：侧栏分区大写标题（`Sidebar` 第 39 / 51 行）、已排除/已中断等标签
- 行内 code、代码块、`LazyHighlighter`、`StructuredMessageBody` 的 12.5 px 等宽 pre
- 消息 `MessageActionBar` 图标热区
- 侧栏行高 28 / 32 px
- `SettingsPanel` 自己的 18 px 页标题、12 px 分组标题、13 px 导航项与底栏文案（属于「面板框架」而非对话，本轮不动）
- `PlanCard.more`（12）、`PageContentViewer.url`（12）、`.meta`（11）：标签类，保持像素

`body` 已设正文字号后，未写死 `font-size` 的可读节点会自动跟轴。写死 12 / 13 又属于上表「正文/次级」的，改为对应变量；写死 11 或等宽的保持像素。

**默认 14 下的既有 1 px 变化（已确认接受）：** `SettingFieldInput.label` 13→14、各类 `desc` 12→13、`ProjectItem` 13→14、`Sidebar .more` 12→13、`PlanCard.summary` 12.5→13、`inspectorTitle` 12→13。这是「次级 = 正文 − 1」公式在默认档的直接结果，不是回归。

## 6. 外观设置

`AppearanceSettings` 增加一张 `SettingCard`，标题「对话字号」，说明：「只放大可读文字。模块栏、状态标签和代码保持原大小。」

`SettingCard`（`features/settings/SettingCard.tsx`）现在只有 `title` + `children` 两个 prop，**没有承载说明文字的位置**。给它加 `desc?: ReactNode`，渲染在标题下方、用次级字号（`--pi-font-size-secondary`）与 `colorTextDescription`。不要只在 `children` 里塞一个裸 `<div>`——那会绕过 §5 的次级档，且 `SettingFieldInput` 的 `styles.desc` 是 `createStyles` 内部样式、外部拿不到。

控件：高 36 px、圆角胶囊，中间 tabular 数字，右侧上下箭头（hover / focus-within 显示），胶囊外跟 `px`。`data-testid="font-size-stepper"`，加减按钮 `font-size-inc` / `font-size-dec`。

- 当前值为 `FONT_SIZE_MAX` 时禁用增加；`MIN` 时禁用减少。
- 点击调用 `setFontSize(fontSize ± 1)`，展示值永远来自 store，不信点击回声。
- 与主题一样即时生效，不进设置保存条（`SettingsPanel` 已对 `appearance` 隐藏保存条）。

步进器自身用正文档字号；11 px 辅助不要出现在这张卡片上。

## 7. 错误处理

- 持久化缺字段、字符串、`NaN`、`Infinity`、越界：clamp 到 12–17 或默认 14，不抛错。落地方式写死为 `persist` 的 `onRehydrateStorage`：它返回的回调里对 `state.fontSize` 再 clamp 一次并 `set`，保证脏数据既不进 store 也不进 DOM。（不要靠 `merge` 手写——`merge` 只在有持久化数据时触发，且容易漏掉后续 `setState`。）
- `ThemeBridge` 只写 clamp 后的值。
- Markdown 抛错仍走 `LazyMarkdown` 现有纯文本 `pre` 兜底（`LazyMarkdown.tsx` 第 31 行）。它在 `MarkdownErrorBoundary` 里、拿不到 `pi-md`，且带内联 `style`——必须就地改成 `font-family: var(--pi-font-sans)` + 正文字号，不用等宽（那是失败降级，不是代码块）。

## 8. 测试

全部 vitest，不启 Electron。

| 文件 | 断言 |
| --- | --- |
| `theme/contentFont.test.ts` | `clampFontSize`：`14` 直通、`13.6`→14、`13.4`→13、`11`→12、`99`→17、`'14'`→14、`NaN`/`Infinity`/`null`/`undefined`/`'abc'`→14 |
| `stores/themeStore.test.ts` | 默认 14；`setFontSize(17)`；`setFontSize(99)` → 17；`partialize` 含 `fontSize`；localStorage 预置 `{"state":{"fontSize":999}}` 后 rehydrate → 17 |
| `features/settings/AppearanceSettings.test.tsx` | 渲染当前值；inc/dec 写 store；14 时可加减；12 禁用减、17 禁用加 |
| `components/ThemeBridge.test.tsx` | 根样式 `--pi-font-size` 为 `14px`，改 store 后变 `16px` |
| `features/chat/LazyMarkdown.test.tsx` | 默认根 class 含 `pi-md`、不含 `pi-md-secondary`；`tone="secondary"` 两者都有；`prose={false}` 都没有；根元素行内 `--lobe-markdown-font-size` 分别指向 `var(--pi-font-size, 14px)` / `var(--pi-font-size-secondary, 13px)` |

几点约束：

- `ThemeBridge` 顶层调了 `useTheme()`（antd-style），脱离 `ThemeProvider` 会抛。要么测试里包一层 `@lobehub/ui` 的 `ThemeProvider`，要么把字号那一段抽成独立 hook（如 `useFontSizeSync()`，`ThemeBridge` 里调一行），测试直接渲染该 hook——**推荐后者**，顺带让 §8 那条断言不依赖整套主题上下文。
- 不解析 `contentFont.css` 文本，也不在 jsdom 里断言 `min()/max()` 的计算结果（jsdom 不支持）。次级档 12→11 … 17→15 由 §1 成功标准人工核对，CSS 抄 §3 字面量。
- `LazyMarkdown.test.tsx` 要 `await` Suspense（`<Markdown>` 是 `lazy` 的），直接同步断言拿不到根节点。

## 9. 主要改动文件

- 新建 `electron-agent/src/theme/contentFont.ts`、`contentFont.css`、`contentFont.test.ts`
- `electron-agent/src/index.css` — import + `html body` 字体/字号
- `electron-agent/src/stores/themeStore.ts` — `fontSize`、`setFontSize`、`partialize`、`onRehydrateStorage`
- `electron-agent/src/components/ThemeBridge.tsx` — 写 `--pi-font-size`
- `electron-agent/src/features/settings/AppearanceSettings.tsx`、`SettingCard.tsx`（新增 `desc` prop）、`SettingField.tsx`
- `electron-agent/src/features/chat/LazyMarkdown.tsx` — 新增 `tone` / `prose`，`pi-md` 宿主，兜底 `pre` 字体；`.pi-md` 规则落在 `contentFont.css`
- 十个传 `fontSize={12|13|14}` 的调用方：`TurnTimeline.tsx:50`、`ReasoningInline.tsx:119`、`NoticePill.tsx:72`、`NoticeSplitPill.tsx:62`、`SubAgentInline.tsx:273` 与 `:286`、`PlanCard.tsx:199`、`MarkdownWarmup.tsx:60`、`panels/PageContentViewer.tsx:91`、`components/QuestionSelector/index.tsx:225`
- `electron-agent/src/features/chat/NoticePill.tsx`、`NoticeSplitPill.tsx` — 紧凑标题跟随次级档 + 提升选择器权重
- `electron-agent/src/features/chat/PlanCard.tsx` — `title` / `todo` / `fallback` / `docError` / `summary`
- `electron-agent/src/features/chat/chatStyles.ts`、`input/editor/MessageEditor.tsx`
- 侧栏 `ProjectItem.tsx`、`Sidebar.tsx`（`.more`）
- `features/tools/cardStyles.ts` 的 `inspectorTitle`
- 设置页另外三处 12/13 复制实现：`ProvidersSettings.tsx`、`CapabilityModelField.tsx`、`ProviderDiagnostics.tsx`
- Wiki 四处调用加 `prose={false}`：`WikiLibraryWorkspace.tsx:316`、`WikiPageEditor.tsx:125` 与 `:142`、`WikiSourceDialog.tsx:118`
