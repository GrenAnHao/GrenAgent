# 对话项统一视觉系统设计（Cursor / Linear 紧凑技术感）

- 日期：2026-06-27
- 范围：`tauri-agent` 前端对话区所有「渲染对话项」的视觉统一
- 状态：设计定稿，待写实现计划
- 关联：`2026-06-21-question-selector-redesign-design.md`（ask_user）、`2026-06-20-chat-message-focus-actions-design.md`（消息操作栏）、`2026-06-14-chat-rendering-cr-a-container-design.md`（渲染容器）

## 1. 目标与背景

对话区现有 7 类渲染项各自实现样式，导致圆角（`12px` 硬编码 / `borderRadius` / `borderRadiusLG` / `999px` / `borderRadiusSM`）、卡面（`colorBgContainer` / `colorFillQuaternary` / `colorFillTertiary`）、内边距、卡头、折叠控件（`Collapse` / `Accordion` / 自定义 chevron）、状态表达各不相同，整体偏臃肿、不统一。

目标（三者合一，以「共享基元 + 设计 token」为底）：

1. **视觉一致**：统一卡面 / 圆角 / 间距 / 卡头 / 状态语义。
2. **可定制 / 主题化**：所有视觉走设计 token（`cssVar.*` + 少量 `--conv-*`），明暗 / 换肤只换变量值。
3. **工程收敛**：抽共享基元组件，消除各卡片重复样式。

视觉方向：**Cursor / Linear 风** —— 深色优先、紧凑、工程感、hairline 细边、等宽点缀、克制靛蓝强调；状态用小图标（绿勾 / 转圈 / 红叉），**不使用彩色左竖条 / 左色块**。设计稿见 `.superpowers/brainstorm/sess1/content/13-compact.html`（v7 定稿）。

## 2. 设计 Token（`convTokens`）

新增 `tauri-agent/src/features/chat/conv/convTokens.ts`，用 `createStaticStyles` + `cssVar`（零运行时，切主题不重渲染）。所有数值集中于此，禁止在各组件内再写散值。

> 设计稿中的暗色 hex 仅是这些 token 在暗色主题下的实现值；落地一律引用 token，保证明暗 / 换肤自适应。

### 2.1 颜色（映射到 antd `cssVar`）

| 语义 | token | 暗色近似 |
|---|---|---|
| 页面底 | `cssVar.colorBgLayout` | `#0d0e10` |
| **surface**（横条 / 卡片 / 用户气泡 / 代码框） | `cssVar.colorFillQuaternary` | `≈#161719` |
| hairline 细边 | `cssVar.colorBorderSecondary` | `rgba(255,255,255,.08)` |
| hairline hover | `cssVar.colorBorder` | `rgba(255,255,255,.12)` |
| 文字 高 / 中 / 低 / 微 | `colorText` / `colorTextSecondary` / `colorTextTertiary` / `colorTextQuaternary` | — |
| 强调（运行 / 链接 / 选中边） | `cssVar.colorInfo` | `≈#7c8cf8` |
| 强调淡底（选中 / 主按钮悬浮） | `color-mix(colorInfo 12%)` | — |
| 主按钮 | `cssVar.colorPrimary` | 主题主色 |
| 状态 完成 / 出错 | `cssVar.colorSuccess` / `cssVar.colorError` | — |
| 等宽 | `cssVar.fontFamilyCode` | — |

唯一新增的自定义变量（无对应 antd token 时）：可省略；surface 与 hairline 均复用上表，无需 `--conv-*`。若后续要单独调 surface 深浅，再引入 `--conv-surface` 由 `ThemeBridge` 写入。

### 2.2 尺寸

- **圆角**：`--conv-radius = cssVar.borderRadius`（surface / 代码框 / 选项行，统一 ~7–8px）；chip = `999px`。废弃 `12px` 硬编码与 `LG/SM` 混用。
- **间距**：4 / 6 / 8 / 10 / 12（行内 gap / 内边距）。
- **行高**：纯行 26px；横条 30px；卡头 28px；选项行 28px；按钮 24px。
- **字号**：标题 13(600) / 正文 14 / 元信息 11.5–12 / 微标 10.5–11。

## 3. 四级层次（核心）

按「重要度 / 交互性」分四级，视觉权重递增：

| 级别 | 用途 | 形态 | 对话项 |
|---|---|---|---|
| **L1 低调行** | 环境信息，最弱 | 单行浅色文字 + 图标 + chevron，无底无边 | 深度思考、注入提示（知识库 / 记忆 / dream / distill） |
| **L2 纯行** | 常规过程 | 行：状态图标 + 工具图标 + 等宽名 · 参数 + 右侧 meta + chevron；仅 hover 有底；展开=轻缩进 + 淡底代码块（**无左竖线**） | 工具调用（read/write/bash/edit/搜索/终端…）、上下文折叠组 |
| **L3 横条** | 侧重组件 | 整条 surface（底 + hairline + 圆角），单行 | 子代理（单 / 并行 / 链式组） |
| **L4 卡片** | 结构化 / 可交互 | surface 卡（卡头 + body + footer 槽） | 计划卡、ask_user 提问卡、生图卡 |

用户气泡：右对齐 surface 气泡（同 surface 家族），归 L4 surface 风但无卡头。助手正文：纯 markdown，无外壳。

### 3.1 状态语义（统一，无彩色竖条）

状态只在**行首图标**（lead，宽 14–16px）体现：

- 完成 = 绿勾（`colorSuccess`）
- 运行中 = 转圈 spinner（`colorInfo`）+ 名/参数/meta 文字转 `colorInfo`（可选 `shinyText`）
- 出错 = 红叉（`colorError`）+ meta `colorError`
- 中性（L1）= 无状态图标，用领域图标（脑 / sparkle）

徽章 / meta 文案统一：`+52` / `+3 −1`（diff）/ `完成·6步` / `运行中…` / `出错`。

## 4. 共享基元（`tauri-agent/src/features/chat/conv/`）

全部 `createStaticStyles` + `cssVar`（零运行时），props 驱动、无 store 依赖（除少数需要的），可单测 / 预览。

| 基元 | 职责 | 关键 props |
|---|---|---|
| `convTokens.ts` | 设计 token（样式对象 + 常量） | — |
| `StatusGlyph` | 状态→图标+色（绿勾/转圈/红叉/无） | `status` |
| `ConvRow` | L2 纯行：lead + 图标 + 名·参数 + 右槽 + 可展开 body | `status, icon, name, args, meta, children?` |
| `MutedLine` | L1 低调行 | `icon, text, count?, onToggle?` |
| `ConvStrip` | L3 横条 surface 单行 | `status, icon, title, chip?, meta?, onToggle?` |
| `ConvCard` | L4 卡片 surface（卡头/body/footer 槽） | `label, title?, children, footer?` |
| `CodeSurface` | 展开体的代码 / 输出 / diff 块（淡底 + hairline + 等宽） | `lang?, children` |
| `OptionRow` | ask_user 单选 / 多选行（序号 + 文本 + 推荐 / 勾选） | `index, label, selected, multi?, recommended?` |
| `Disclosure` | 统一 chevron 折叠控件（替代 Collapse/Accordion/各自 chevron） | `open, onToggle` |

图标统一用 `@lobehub/ui` 的 `Icon` + `lucide-react`（遵循无 emoji 规则）。

## 5. 对话项 → 基元映射（迁移对照）

| 现有组件 | 级别 | 改用基元 |
|---|---|---|
| `ReasoningInline`（思考） | L1 | `MutedLine` + `Disclosure` + `CodeSurface`(展开) |
| `NoticePill`（注入） | L1 | `MutedLine` + `Disclosure` |
| `ToolExecution`（工具，含 read/write/bash/edit/ls/json） | L2 | `ConvRow` + `StatusGlyph` + `Disclosure` + `CodeSurface` |
| `SearchCards`（grep/glob/code_search） | L2 | `ConvRow`（行内查询高亮）+ `CodeSurface` |
| `ContextToolGroup`（查找折叠组） | L2 | `ConvRow`(neutral) |
| `TerminalCard`（bash 输出） | L2 | 并入 `ConvRow` 展开 + `CodeSurface`（**去掉 terminal 头栏 / `$` 命令重复**） |
| `SubAgentInline` / `SubAgentGroupInline`（子代理） | L3 | `ConvStrip`（+ 展开 body） |
| `PlanCard`（计划） | L4 | `ConvCard` + `Option/step` + footer |
| `InlineQuestionCard` / `QuestionsCard` / `AnsweredQuestionsCard` / `AnswerCard`（ask_user） | L4 | `ConvCard` + `OptionRow`；已答=`MutedLine` 风收起记录 |
| `UserMessage` | surface 气泡 | 复用 surface token（右对齐） |
| 生图卡（generate_image，`extensionCards`） | L4 | `ConvCard` |
| `SubAgentConversation` / `SubAgentLogBody`（右坞） | — | 复用 `ConvRow`/`CodeSurface` 渲染气泡（沿用现有 live 刷新） |

`ChatMessageItems` / `TurnTimeline` / `groupMessages` 的分发与分段逻辑不变，只替换叶子渲染。

## 6. 数据流与行为（不变）

- `ChatMessage[]` → `groupMessages` → `DisplayMessage[]` → `ChatMessageItems` 分发 → 基元渲染。保持现有 `turn.segments` 分段、todo 去重、spawn_agent 展开、`MemoSegment` 按值 memo。
- 流式：沿用 `LazyMarkdown animated`、子代理 transcript 节流、registry 轮询（含本轮已修的 `SubAgentLogBody` live 刷新）。
- 折叠态：运行中默认展开、终态默认收起的现有逻辑保留。
- `data-testid` 全部保留（`subagent-inline` / `notice-pill` / `plan-card` / `reasoning-inline` / `subagent-log-*` 等），现有测试不改断言即应通过。

## 7. 主题与性能

- 全部走 `cssVar`，明暗 / 换肤同帧切换、不重序列化（与现有 `createStaticStyles` 口径一致）。
- `content-visibility` / `LazyMount` / `MemoSegment` 记忆化等性能机制不动。
- 设计稿暗色 hex 仅为参考；浅色由 `cssVar` 自动适配（surface 用 `colorFillQuaternary` 半透明，浅色下为浅灰，无需单独配色）。

## 8. 迁移计划（增量、不改行为）

按依赖顺序，一次一个，每步 tsc + lint + 相关单测全绿：

1. `conv/convTokens.ts` + `StatusGlyph` + `Disclosure` + `CodeSurface`（+ 单测）。
2. `ConvRow` → 迁移 `ToolExecution`（最常见，先落地验证）。
3. `ConvStrip` → 迁移 `SubAgentInline` / `SubAgentGroupInline`。
4. `MutedLine` → 迁移 `ReasoningInline` / `NoticePill`。
5. `ConvCard` + `OptionRow` → 迁移 `PlanCard` / ask_user 系列 / 生图卡。
6. `UserMessage` 与右坞复用 surface / `CodeSurface`。
7. 清理：`chatStyles` / `cardStyles` 中被 token 取代的散值收敛 / 删除。

每步保留 `data-testid` 与交互；`cardStyles` / `chatStyles` 逐步瘦身为引用 `convTokens`。

## 9. 测试

- 基元单测：`StatusGlyph`（状态→图标/色）、`ConvRow`（展开/收起/meta）、`OptionRow`（选中/多选/推荐）、`Disclosure`。
- 迁移后现有 `*.test.tsx`（`ToolExecution` / `SubAgentInline` / `NoticePill` / `PlanCard` / `QuestionsCard` / `AnswerCard` …）全绿，断言不变。
- `npx tsc -p tauri-agent`（构建期 `tsc && vite build`）零新增错误；`npx eslint` 无新增。
- 预览页 `preview.html`（`src/preview.tsx`）扩展为基元画廊，作为视觉回归参照。

## 10. 非目标（YAGNI）

- 不改对话数据结构 / store / 后端协议。
- 不引入新依赖（图标用既有 lucide，样式用既有 antd-style）。
- 不做浅色专属配色（交给 `cssVar` 自适配）。
- 不动 `groupMessages` 的分段 / 去重算法。
- 不在本轮引入彩色状态左条（已被否决）。

## 附：设计稿

`.superpowers/brainstorm/sess1/content/` 下 `13-compact.html`（v7 定稿）、`11-consistent.html`（surface 一致）、`12-ask.html`（ask_user）。`.superpowers/` 建议加入 `.gitignore`。
