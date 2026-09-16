# 选择面板（ask_user）重设计 — 设计规格

- 日期：2026-06-21
- 范围：GrenAgent 桌面端 `ask_user` 阻塞式选择面板的结构与皮肤重设计
- 状态：设计已通过视觉伴侣逐项确认，待规格审查

## 1. 背景与问题

`ask_user` 工具用于让用户在对话中做选择（选方案 / 测验 / 确认）。当前实现存在两类问题：

1. **位置割裂**：阻塞态走 `ctx.ui.select`，前端 `PromptRequestCard` 把卡片渲染在**输入框上方**，与对话流里的题目/代码分离——看题要在上、选项在下，且选项一多会把对话和输入框挤走。
2. **皮肤笨重**：外层卡 + 内层 `QuestionSelector` 形成"卡中卡"、"请选择"标题重复两次；方块感重、不精致。
3. **能力不足**：当前阻塞路径靠逐题 `ctx.ui.select`（单选、单题），无法良好支持**多选**、**多题**、**选项很多**的题。

## 2. 目标 / 非目标

**目标**
- 选择卡**内联进对话流**，紧跟提问那条消息（保持阻塞）。
- 皮肤重做为"精致描边"风格，跟随 app 暗色主题。
- 支持：单选、**多选**、**多题（分页步骤）**、**选项很多（卡内滚动）**。
- 明确对话界面内的布局（对齐、宽度、限高）。

**非目标**
- 不改 `confirm` / `input` / 其它扩展的 `ctx.ui.select`（仍在输入框上方）。
- 不修改 pi core（`@earendil-works/pi-coding-agent`，node_modules，不可改）。
- 不引入 Modal/弹窗。
- 阻塞路径不收图片（贴图仅保留在 `!hasUI` 的对话流回退卡）。

## 3. 已确认的设计决定（经视觉伴侣逐项批准）

| 维度 | 决定 |
| --- | --- |
| 结构 | **内联**进对话流，渲染在消息列表末尾（紧跟提问消息） |
| 皮肤 | **精致描边（变体 2）**：外框 + 圆点页眉 + 圆形字母徽章 + 选中填充强调色 + 对勾 + 取消/确定页脚 |
| 多选 | 方形字母徽章、可多选、页眉显示"已选 N"；至少 1 项才可确定 |
| 多题 | **分页步骤**：一题一页，顶部进度条 + 步骤圆点 + 上一题/下一题，最后一题变"提交"；本题未答时"下一步/提交"禁用 |
| 选项多 | 卡内**限高 ~228px + 滚动**，页眉/页脚固定 |
| 布局 | 左对齐（与助手消息同栏起始）、宽度跟随内容**封顶 600px**、窄屏自适应 |
| 单题 | 不显示进度/导航，就是普通确定/取消卡 |
| 颜色 | 全用 `antd-style` 的 `cssVar` 主题变量，不硬编码 hex |

## 4. 架构：富交互 + 阻塞 + 内联

### 4.1 约束

- pi core 的 `ctx.ui` 只有：`select(title, options: string[]) → string|undefined`、`input(title, placeholder?) → string|undefined`、`confirm(title, message) → boolean`；`opts` 仅 `{signal, timeout}`。
- 前端 `ExtensionUiRequest` 仅携带 `method / title / message / options[] / placeholder / prefill`。
- 阻塞 + 回传通路（`extension_ui_request` → `extension_ui_response{id,value}` → resolve 掉 await 的 `ctx.ui.*`）已实现并可用。
- 结论：结构化数据（多题/多选/自定义）**无法新增字段穿过 pi core**，只能放进被原样转发的字符串字段（`title`）。

### 4.2 通路（不改 pi core）

1. `ask_user.execute`（`hasUI` 时）：`normalizeQuestions` 得到 `QuestionsCardData` → 包裹哨兵信封 `{ __askUser: 1, data }` → `JSON.stringify` 作为载荷。`const answer = await ctx.ui.input(payload)`。
2. `extension_ui_request{ method:"input", title: payload }` 到达前端。
3. `ExtensionUiHost`：当 `method==="input"` 且 `title` 能解析出 `__askUser` 哨兵 → 路由到新的 `inlineQuestionStore`；否则维持原行为（`uiPromptStore` → `PromptRequestCard`，在输入框上方）。
4. `InlineQuestionCard`（渲染在消息列表末尾）：用 `QuestionSelector`（皮肤2 / 步骤 / 多选 / 滚动）渲染 `data`。
   - 提交：`extensionUiRespond(ws, { id, value: formatAnswers(...) })`（复用现有 `formatAnswers`，产出 `[我的选择] …`）。
   - 取消：`extensionUiRespond(ws, { id, cancelled: true })`。
5. `ctx.ui.input` resolve：得到字符串 → `ask_user` 直接作为工具结果返回；得到 `undefined`（取消）→ 返回"用户取消了选择"。

### 4.3 取舍说明

- 这是**用 `ctx.ui.input` 作为结构化载荷的阻塞传输**，是在"不可改 pi core + 需要富交互 + 需要阻塞"三重约束下唯一可行的方案。哨兵字段隔离它与普通 `input` 请求，互不影响。
- 载荷为 JSON 字符串，体量可控；规格层面**限制单次最多 ~8 题**以防载荷与 UI 过大（超出在 `normalizeQuestions` 截断并 `log`）。

## 5. 组件与文件改动

**后端（agent-mode）**
- `extensions/agent-mode/index.ts`：重写 `ask_user.execute` 的 `hasUI` 分支为 §4.2 通路；`!hasUI` 维持现有"发 `agent-questions` 消息 + 提示停下"的非阻塞回退。
- `extensions/agent-mode/questions.ts`：移除上一版的 `collectAnswers` / `AskUserUi`（被 §4.2 取代）；保留 `normalizeQuestions`、`makeQuestionsId`、类型；新增 `≤8 题` 截断。
- `extensions/agent-mode/questions.test.ts`：移除 `collectAnswers` 用例；补 `normalizeQuestions` 的截断用例。

**前端（tauri-agent）**
- `src/components/QuestionSelector/index.tsx`：① 皮肤2;② **步骤模式**（`questions.length > 1` 时分页：进度条 + 圆点 + 上一题/下一题/提交 + 本题校验）;③ 多选方形徽章 + "已选 N";④ 每页 `max-height + overflow` 滚动;⑤ 布局（左对齐、`max-width:600`）。两处渲染共享此组件。
- `src/stores/inlineQuestionStore.ts`（新）：暂存当前内联问题请求 `{ workspace, id, data }`，按 workspace 一条。
- `src/features/chat/InlineQuestionCard.tsx`（新）：从 `inlineQuestionStore` 读取并渲染 `QuestionSelector`，处理提交/取消 → `extensionUiRespond`。
- 消息列表（`src/features/chat/ChatMessageItems.tsx` 或其容器）：在末尾渲染 `InlineQuestionCard`（存在待处理内联问题时）。
- `src/features/extensionUi/ExtensionUiHost.tsx`：`input` 请求带 `__askUser` 哨兵 → 路由到 `inlineQuestionStore`；其余不变。
- `src/features/chat/input/PromptRequestCard.tsx`：维持 `confirm`/`input`(非 ask_user)/`select`；不再承担 ask_user。
- `src/features/chat/QuestionsCard.tsx`：作为 `!hasUI` 回退保留（同样吃皮肤2，因共享 `QuestionSelector`）。

**提示词**：`ask-user.md` / `ask_user` 描述已是"阻塞 + 先给上下文",无需改。

## 6. 状态与行为

- **单选**：选一项即可"确定"。
- **多选**：可多选、页眉计数、≥1 可"确定"；方形字母徽章。
- **多题（分页）**：进度条 + 圆点（已答打勾/当前高亮/未到弱化）；第 1 题"上一题"禁用；中间"下一题"；末题"提交"；**本题未答时"下一步/提交"禁用**。
- **选项多**：页内滚动，页眉/页脚固定。
- **自定义项**：选中"其他"→ 内联文本框，需填写才算已答。
- **取消**：任意步骤"取消"→ `cancelled`，工具返回"用户取消"。
- **作答后**：卡片收起为只读摘要（`[我的选择] …`），不可再改。

## 7. 测试

- `normalizeQuestions`：现有用例 + 截断（>8 题）用例。
- `QuestionSelector`：步骤导航（首/中/末态、校验禁用）、多选计数、单题不分页、滚动阈值（前端组件测试）。
- `formatAnswers`：现有用例覆盖单选/多选/自定义/补充。
- `ExtensionUiHost`：`input` + `__askUser` 哨兵 → 写 `inlineQuestionStore`；普通 `input` → `uiPromptStore`（路由测试）。
- 回归：`agent-mode`、`fable-behavior`、`PromptRequestCard` 现有测试保持绿。

## 8. 风险与回退

- **载荷走 `title`**：依赖 pi core 原样转发 `title` 字符串。若未来 pi core 截断/清洗 `title`，需改走其它转发字段或推动 pi core 增字段；当前版本可用。
- **`!hasUI`（print/headless）**：无对话框，回退到非阻塞 `agent-questions` 卡（行为同今天）。
- **载荷过大**：限 ≤8 题并 `log` 截断。

## 9. 与既有提交的关系

本设计**取代**上一提交（`66099f0f`）中 `ask_user` 的"逐题 `ctx.ui.select` + `collectAnswers`"阻塞实现：改为单次 `ctx.ui.input` 承载整张富卡、内联渲染。阻塞语义与"先给上下文"的提示词约束保持不变。
