# Plan 模式卡片化（Cursor Plan Mode 复刻）设计

- 日期：2026-06-17
- 状态：设计待评审（待用户确认拆解与起点 → writing-plans）
- 主题：把「AI 提问」与「Plan 产出」从当前的 Modal 弹窗 / 纯文本 notice，升级为 Cursor 风格的**对话流卡片**——一个**通用选项卡片（Questions）** + 一个 **Plan 摘要卡片**（todo 预览 / View Plan 详情 / 模型选择 / Build 执行 / 继续发消息改 plan）。

## 1. 背景与目标

当前 Pi（GrenAgent）的两处交互体验与 Cursor 有差距：

- **AI 提问**：extension 调 `ctx.ui.select/confirm/input` → `ExtensionUiHost` 弹 **Modal**。一次一题、阻塞、不进对话历史。Cursor 是对话流内的 Questions 卡片（标题 + A/B/C/D + 可多选 + Continue/Skip，可多题）。
- **Plan**：`agent-mode` 解析助手文本里的 `Plan:` 段提取 todo，再 `sendMessage` 一条 customType 消息 → 前端 `NoticePill`（只有标题 + 内容）。Cursor 是 Plan 摘要卡：标题 + 摘要 + todo 预览（前几条 + 「N more」）+ **View Plan**（看完整计划与内部 todo）+ **模型选择** + **Build**（开始执行）/ 继续发消息让它改 plan。

### 成功标准（用户诉求）

1. **通用选项卡片**：以卡片形式提供选项供选择，不止用于 plan 澄清，任何「需要用户在若干选项里选」的场景都复用同一组件。
2. **Plan 摘要卡片**（对话流内）：摘要 + 内部 todo，可 **View Plan** 看详情，可**选择执行模型**，可**开始执行（Build）**，也可**继续发消息让 AI 修改当前 plan**。
3. 两类卡片都在**对话流内**（像 Cursor，留在对话历史），不是临时 Modal。

### 非目标

- 不复刻 Cursor 的多 agent judging、云端等周边。
- 不改动 pi 的 agent loop 内核；只通过 extension 既有能力（工具 / 命令 / 事件 / `sendMessage` / `ctx.ui`）+ 前端渲染实现。
- 本设计不含 Debug 模式卡片（debug 已另有 runtime log 基建）。

## 2. 现状盘点（决定可行边界）

| 关注点 | 现状 | 位置 |
|---|---|---|
| 对话流消息类型 | `user` / `assistantGroup` / `tool` / `notice` | `groupMessages.ts` 的 `DisplayMessage` |
| customType 消息渲染 | `notice` → `NoticePill`（标题 + Markdown 内容） | `ChatMessageItems.tsx` / `NoticePill.tsx` |
| AI 提问 | `ctx.ui.select/confirm/input` → `extension_ui_request` → `ExtensionUiHost` 弹 Modal，应答回 `extension_ui_response` | `ExtensionUiHost.tsx` |
| 状态回读 | `ctx.ui.setStatus(key, text)` → `ExtensionUiHost` 按 `statusKey` 写 zustand store | 既有 plan-mode / goal / mcp / agent-mode 都用 |
| plan 产出 | `agent-mode` 解析 `Plan:` 文本 → `extractTodoItems` → `sendMessage({customType:"plan-steps"...})`；执行用 `executionMode + todoItems + [DONE:n]` | `extensions/agent-mode/index.ts` + `utils.ts` |
| 模型/RPC | 前端 `pi.setModel` / `agent_set_mode`；扩展可发命令、可 `sendMessage`、可 `ctx.ui.*` | `commands/agent.rs` / `lib/pi.ts` |

**结论**：对话流卡片可行——extension 通过 `sendMessage(customType, JSON)` 把结构化数据塞进对话流，前端 `groupMessages` 加新 kind 解析、`ChatMessageItems` 渲染卡片；交互回传走「发消息」或 `extension_ui_response`。

## 3. 架构总览

```
pi 扩展（agent-mode / 新 questions 能力）
  ├─ 产出结构化卡片消息：sendMessage({ customType, content: JSON }, { display:true, triggerTurn:false })
  │     customType = "agent-questions"  → 选项卡数据
  │     customType = "agent-plan"       → Plan 卡数据（含 .pi/plans/<id>.md 路径）
  └─ 写 plan 详情文件：.pi/plans/<id>.md（View Plan 读它）

前端
  groupMessages.ts   : customType 命中 → 新 DisplayMessage kind 'questions' | 'plan'（解析 JSON）
  ChatMessageItems   : kind 'questions' → <QuestionsCard>；kind 'plan' → <PlanCard>
  QuestionsCard      : 标题 + 选项(A/B/C/D, 可多选) + Continue/Skip → 回传
  PlanCard           : 摘要 + todo 预览 + View Plan(读 plan 文件) + 模型选择 + Build/继续改 → 回传

回传通道（二选一，见决策 D1）
  A. 发消息：pi.prompt(workspace, "<结构化应答文本>")，AI 下一轮据此继续
  B. extension_ui_response：若卡片由阻塞式 ctx.ui 发起，则 resolve 该 promise
```

## 4. 数据结构

### 4.1 通用选项卡（Questions）

```ts
interface QuestionsCardData {
  kind: 'questions';
  // 一组问题，逐题渲染（对应 Cursor 的「1 of N」）
  questions: Array<{
    id: string;
    title: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean; // 默认单选
  }>;
  // 回传方式标记（见决策 D1）
  replyVia?: 'message' | 'ui_response';
  requestId?: string; // replyVia==='ui_response' 时关联 extension_ui_request
}
```

回传文本（replyVia==='message' 时）约定为人类可读 + 可解析：

```
[选择] 问题1: 选项A标签; 问题2: 选项B标签, 选项C标签
```

### 4.2 Plan 摘要卡（Plan）

```ts
interface PlanCardData {
  kind: 'plan';
  id: string;            // plan id，对应 .pi/plans/<id>.md
  title: string;
  summary: string;
  todos: Array<{ text: string; done?: boolean }>;
  planFile: string;      // 相对工作区路径 .pi/plans/<id>.md，View Plan 读全文
  status: 'draft' | 'executing' | 'done';
}
```

## 5. 交互流

### 5.1 Questions（通用选项）

1. AI（任意模式，尤其 plan 澄清）需要用户选择 → 扩展产出 `agent-questions` 卡片。
2. 用户在卡片里选 A/B/C/D（可多选）→ 点 Continue（或 Skip 跳过）。
3. 前端回传 → AI 下一轮据此继续（plan 澄清场景：拿到答案后生成/细化 plan）。

### 5.2 Plan

1. 进入 Plan 模式，AI 调研后产出结构化 plan：写 `.pi/plans/<id>.md`（完整计划 + todo），并 `sendMessage` 一条 `agent-plan` 卡数据。
2. 对话流出现 Plan 摘要卡：标题 + 摘要 + 前几条 todo + 「N more」。
3. 用户三选一：
   - **View Plan** → 右侧/弹层展示 `.pi/plans/<id>.md` 全文 + 完整 todo。
   - **选模型 + Build** → 以所选模型开始执行（切到执行：agent-mode 恢复完整工具 + 注入剩余 todo + `[DONE:n]` 跟踪）。
   - **继续发消息** → 让 AI 修改当前 plan（重写 plan 文件 + 刷新卡片）。

## 6. 组件设计（前端）

- `QuestionsCard.tsx`（通用）：props = `QuestionsCardData` + `onSubmit(answers)`。逐题渲染选项（lucide 图标 + 文字，遵守 no-emoji），底部 Continue / Skip。**独立可复用**。
- `PlanCard.tsx`：props = `PlanCardData` + 回调。头部标题 + 摘要；todo 预览（前 3 条 + 「N more」）；底部 View Plan（左）+ 模型选择器（复用 `ModelAction` 同款 Select）+ Build（右）。
- `ViewPlan`：读 `planFile` 用 `LazyMarkdown` 渲染（mermaid 已默认开），todo 用既有 `TodoCard` 风格圆形图标。
- 渲染接入：`groupMessages.ts` 新增 kind；`ChatMessageItems.tsx` 分发。

## 7. pi 端改动

- **Questions 能力**：在 `agent-mode`（或新建 `questions` 扩展）提供一个让 AI「提问并等待选择」的入口。两种实现见决策 D1。
- **Plan 结构化**：`agent-mode` 在 `agent_end`（plan 阶段）由「解析 Plan: 文本」升级为：
  - 生成 plan id，写 `.pi/plans/<id>.md`（标题 + 摘要 + 编号 todo）
  - `sendMessage('agent-plan', JSON)` 产出卡数据（替代当前 `plan-steps` notice）
  - 执行（Build）沿用既有 `executionMode + todoItems + [DONE:n]`，叠加可选 model override

## 8. 拆解（分阶段，各自可独立交付）

| 阶段 | 范围 | 依赖 |
|---|---|---|
| **1. 通用选项卡片** | pi 产出结构化 questions + 前端 `QuestionsCard` + 回传 | 无（独立） |
| **2a. Plan 结构化** | agent-mode 产出 `agent-plan` 卡数据 + 写 `.pi/plans/<id>.md` | 无 |
| **2b. Plan 卡片 UI** | `PlanCard` 摘要 + todo 预览 + View Plan | 2a |
| **2c. 执行与改写** | 模型选择 + Build 触发执行 + 继续发消息改 plan | 2b |

建议顺序：1 → 2a → 2b → 2c（阶段 1 独立且是 plan 澄清前置）。

## 9. 关键决策（待用户确认）

- **D1 — Questions 回传机制（已定：阻塞式 + 选完留卡片）**：
  - 选项**即时弹出、阻塞等待**（`ctx.ui.select`，AI turn 内等待，贴近 Cursor）。
  - 用户**选完后**：在对话流留下一张「问题 + 答案」卡片（`customType=agent-answer`，前端 `AnswerCard`），持久在历史。
  - 落地：提供 `_shared/ask.ts` 的 `askChoice(pi, ctx, title, options)` helper = `ctx.ui.select`（即时弹出）+ 选完 `sendMessage('agent-answer', {title, answer})`（留卡片）；任何扩展复用。弹出 UI 由 `ExtensionUiHost` 的 select 升级为 A/B/C/D 选项卡 + Continue/Skip（即时层）。
- **D2 — Plan 文件位置**：`.pi/plans/<id>.md`（与既有 `.pi/` 运行时目录一致；`.pi` 在文件树跳过，但 View Plan 直接按路径读）。
- **D3 — Build 的模型选择**：每次执行可临时覆盖模型（plan 用强模型、执行用快模型）。落地为执行前 `pi.setModel` 或 spawn 执行时带 model。
- **D4 — 是否整合现有 plan-mode 执行流**：复用 `executionMode + [DONE:n]`，仅把「产出/展示」换成卡片；执行内核不动。

## 10. 风险与注意

- **AI 遵循度**：questions/plan 的结构化产出依赖模型按约定输出（JSON / 写 plan 文件）。deepseek 等较弱模型可能不稳——需要 prompt 约束 + 解析容错（解析失败回退当前的文本/notice 行为）。
- **回传歧义**：消息流回传需用稳定可解析的文本格式（见 4.1），并对 AI 明确「这是用户的选择」。
- **持久化**：卡片是对话消息，切会话/刷新由 pi 的消息历史恢复；Plan 卡的 todo 勾选状态沿用 agent-mode 的 session entry。
- **向后兼容**：解析失败或旧会话 → 回退现有 `NoticePill` 渲染，不破坏历史消息。
