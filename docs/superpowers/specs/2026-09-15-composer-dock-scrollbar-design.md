# 输入框 Dock 与全高滚动条

- 日期：2026-09-15
- 范围：GrenAgent 桌面端主对话列的滚动几何、输入框上方 dock（任务 / 目标 / 排队）、对话流 todo 一行摘要，以及 `todo` 工具三态整表覆盖
- 状态：设计已按节批准，待实现计划
- 对照：DSH `TodoPanel` / `todo_write` 行 / 会话列座椅；不照搬 DSH 外层原生滚动（与 Virtua 冲突）

本规格改写 `docs/superpowers/specs/2026-09-13-goal-bar-and-chat-width-design.md` §2.1 的附着：`GoalPill` 不再嵌进 `composer-surface` 顶行，改挂到输入框上方的 dock。Goal 行内容、操作、完成态仍展示、抽屉，仍以该文 §2.2–2.3 与 `docs/superpowers/specs/2026-09-13-goal-on-session-design.md` 为准。

询问卡 / `/` / `@` 的 pop 规则仍以 `docs/superpowers/specs/2026-09-14-composer-prompt-overlay-design.md` 为准；本规格只约束它们不进入座椅留白。

## 1. 目标 / 非目标

**目标**

1. 主对话列滚动条铺满整列高度（含输入框那一段），消息内容停在输入框与 dock 之上，不钻到输入框下面。
2. 最新任务清单钉在输入框上方，默认折叠；展开只加大座椅高度，把对话顶上去。
3. 对话流拿掉整张 `TodoCard`，每次 todo 调用只留一行「更新任务清单」。
4. `GoalPill` 和 `SteerQueue` 与任务条同一列 dock；Goal 从输入框卡片里搬出来。
5. `todo` 工具改为三态整表覆盖，以支持进行中与并行。

**非目标**

- 不改子代理面板（右侧 dock 的 transcript，没有这套座椅）。
- 不把审批卡、工作区栏做成可折叠 dock 条。
- 不把询问卡、`/`、`@` 改成占位控件。
- 不画假滚动条，不把 Virtua 换成整页原生滚动。
- 不持久化任务条折叠状态。
- 不增加「同时进行中条数」的部署开关（一律允许多条 `in_progress`）。
- 不改 Goal 命令平面、审批回传、slash 关闭规则。
- 不测系统滚动条像素皮肤，不做 Electron 窗口级 e2e。

**成功标准**

有消息时，滚动条轨道从列顶画到列底。永久槽时滑块可走到输入框右侧；覆盖式滚动条见 §3。末条消息底边在座椅顶之上。任务条折叠只显示非零计数、不露任务名；展开后列表封顶 180px。对话流出现「更新任务清单」一行且没有 `card-todo`。空会话仍居中输入框、没有这条全高滚动条。

## 2. 已确认的设计决定

| 维度 | 决定 |
| --- | --- |
| 滚动 | 列表铺满列（`inset: 0`），Virtua 仍是唯一滚动容器；composer+dock 盖在底部 |
| 留白 | 列表 `padding-bottom` = 座椅实测高度；dock 展开只加大这块留白 |
| 滚动条让位 | 永久槽：座椅 `right` 等于槽宽。覆盖式：`right: 0`，靠滚轮 |
| Todo 位置 | 最新计划在 dock；对话流只留一行摘要 |
| Dock 成员 | 任务 + Goal 条 + SteerQueue |
| 审批 / 工作区栏 | 仍占高度、计入座椅，不是可折叠条 |
| Pop | `/`、`@`、询问卡锚定输入框，不进留白 |
| Goal 完成态 | 仍显示（不跟 DSH 那样藏掉） |
| 排队 | 现有 SteerQueue 行，不加折叠头 |
| 任务默认 | 折叠；箭头收起朝上、展开朝下 |
| todo 工具 | 整表覆盖，`pending \| in_progress \| completed`；去掉 add/toggle/list/clear |
| 范围 | 仅主对话列 |

## 3. 列结构

有消息（或有斜杠回执，即现有 `showEmptyLayout === false`）时，主对话列是一层相对定位盒子：

```
列（position:relative; height:100%）
├─ VirtualizedMessageList  position:absolute; inset:0
│    Virtua VList = 唯一 overflow 滚动容器
│    padding-bottom = 座椅高度
│    滚动条铺满列高
└─ 座椅 position:absolute; left:0; bottom:0; right:<滚动条宽>
     顶部 36px 渐隐
     内层仍用 CHAT_CONTENT_WIDTH + margin auto（与现在 COMPOSE_COLUMN 同宽）
     ├─ 重试 / 压缩 / 错误条（若有）
     └─ ChatInput / MessageEditor
          ├─ 任务条（若有）
          ├─ GoalPill（若有）
          ├─ SteerQueue（若有）
          ├─ WorkspaceBar
          ├─ 审批卡 PromptRequestCard
          └─ composer-surface（无 Goal）
```

`/`、`@`、询问卡继续 portal，量位置仍锚 `composer-surface`，不参与 `padding-bottom`。

空会话（`showEmptyLayout`，判定不变：无消息且无斜杠回执）保持现在的居中品牌 + 输入框。座椅不铺底，不挂 Virtua 全高滚动条，不渲染 dock（草稿没有任务 / 目标 / 排队）。从空到有内容时，现有 `layoutId` 形变保留：居中输入框滑到贴底座椅。

座椅用 `ResizeObserver` 量高度，写进列表 `padding-bottom`。贴底时座椅变高，现有 Virtua 贴底 / resize 锚点逻辑把最后一条钉在座椅顶之上。

滚动条宽度：量 Virtua 滚动容器的 `offsetWidth - clientWidth`。大于 0（永久槽）时座椅让出该宽度，滑块全程可点。等于 0（覆盖式滚动条）时座椅 `right: 0`；输入框高度内滑块可能被座椅挡住，靠 §6 滚轮操作对话。

「回到底部」按钮现在 `inset-block-end: 16px`。改为 `bottom = 座椅高度 + 16px`，避免压在输入框上。`ChatMiniMap` 不贴底，不必为座椅让位。

## 4. Dock

从上到下（远离输入框 → 靠近输入框）：任务、目标、排队，然后才是工作区栏、审批卡、输入框。空的 dock 条目不渲染，不留空位。

三条 dock 用同一套条形卡片：细边框、圆角、输入框上方那层底色（对齐 DSH 条，而不是嵌进 `composer-surface`）。工作区栏、审批卡保持现有外观，不套这套条。

### 4.1 任务条

数据：当前会话消息里**最后一次成功**的 `todo` 工具结果 `details.todos`（见 §5.3）。清空或没有成功快照：不渲染。

默认折叠，折叠状态只存在组件实例里，不写设置、不跟会话走。列表被清空而卸载后，下次再出现仍从折叠开始。

折叠头：清单图标 + 标题「任务」+ 非零计数。计数三段为「N 已完成」「N 进行中」「N 待处理」，零段省略，段之间用 U+2002 加 `·` 拼接。折叠时不出现任何任务名。

展开：一行一项，单行省略。状态符：

| status | 符 |
| --- | --- |
| `completed` | 绿色勾选环 |
| `in_progress` | 旋转环；允许多条同时进行中 |
| `pending` | 虚线圈 |

列表 `max-height: 180px`，超出在条内滚，不把座椅撑破列。

折叠箭头：收起朝上，展开朝下（条从输入框上方向上长）。点整行头部切换。

### 4.2 目标条

把现在的 `GoalPill` 从 `composer-surface` 的 `goalSlot` 挪到任务条和排队之间。仍是一行：灯、状态句、条件、耗时、操作。不折叠。详情仍走 `SessionGoalDrawer`。

无快照、`sessionId` 未就绪：不渲染。已完成的目标仍显示。

`MessageEditor` 现有测试「pill 在 `composer-surface` 内」改为断言 pill 在 surface 外、座椅 dock 内。

### 4.3 排队

`SteerQueue` 原样：引导 / 跟进行，始终展开。空则不渲染。这一期不加折叠头。只换到 dock 叠层并套条形卡片底。

## 5. todo 工具与对话流

### 5.1 工具契约

工具名仍是 `todo`。参数改为整表覆盖，去掉 `action` / `add` / `toggle` / `list` / `clear`：

```ts
interface Todo {
  id: number;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface TodoState {
  todos: Todo[];
  nextId: number;
}

// 工具参数
{ todos: Array<{ id?: number; text: string; status: Todo['status'] }> }
```

规则：

- 每次调用整表替换内存状态，写入 `details: { todos, nextId }`。
- `todos: []` 即清空，状态回到 `{ todos: [], nextId: 1 }`。
- `text` 去首尾空白后必须非空，否则整次调用失败、不改状态。
- 缺 `id` 的项用 `nextId` 分配并自增。带 `id` 的项沿用该 id；同一调用里 id 重复则失败、不改状态。写完后 `nextId = max(nextId, 所有 id 的最大值 + 1)`。
- 允许多条 `in_progress`。
- 身份是 `id`，允许不同项文案相同。
- 描述与 `promptGuidelines` 改为：每次提交完整列表；进行中标 `in_progress`；并行工作可同时标多条；完成后立刻标 `completed`；琐碎单步不必建表。

成功 `content` 用一段计数摘要即可（pending / in_progress / completed 各几条），不必再输出 `[x] #1:` 全表——全表已在 `details` 和 dock 里。

### 5.2 旧会话

`reconstructFromEntries` 取分支上最后一条**成功**的 `todo` toolResult `details`（跳过 `isError` / `details.error` / 畸形 `todos`）。规范化每条：

- 已有合法 `status`：沿用。
- 否则 `done === true` → `completed`，其余 → `pending`。
- 缺 `id` 的项按出现顺序补 id，并据此推 `nextId`。

旧 `details.action` 忽略。失败或畸形条目不写入内存状态，也不作为 dock 快照。

### 5.3 Dock 的数据源

渲染进程从当前会话 `messages` 推导：倒序找最后一条 `toolName === 'todo'` 且成功的结果，读规范化后的 `details.todos`。流式过程中若已有 `details.todos` 则跟上；还没有则 dock 保持上一份成功快照。

扩展进程仍在 `session_start` / `session_tree` 用 `reconstructFromEntries` 恢复内存，供下一次 `execute`。两边同一套规范化。

### 5.4 对话流一行

`ToolExecution` 不再为 todo 走 `renderExtensionCard` / `TodoCard`。todo 与 `show_visual` 一样：一行 `ConvRow`，无 body、无展开箭头。

- `name`：「更新任务清单」
- `args`（可省略）：`{done}/{total} 已完成`；若存在可用的第一条 `in_progress` 文案，再拼 ` · {文案}`。`ConvRow` 已在 name 与 args 之间插分隔点，args 不要再以 `·` 开头
- `meta`（不收缩）：并行进行中多于 1 条时为 `+{其余条数}`；否则不渲染
- 清空成功：`args` 为「已清空」，无 `meta`
- 进行中尚无 details：只有标题
- 调用失败：`ConvRow` 错误态；`args` 用错误文案；**不**用失败结果更新 dock

摘要算法（与 DSH `planSummary` 同构，输入为规范化后的列表）：

- `done` = `status === 'completed'` 的条数，`total` = 长度
- 第一条文案非空的 `in_progress` 作为 hint；其后再计其余 `in_progress` 为 `+N`
- 第一条进行中文案不可用（缺 / 非字符串 / 空白）则无 hint、无 `+N`，只保留完成数

`groupMessages` 同一回合多次 todo 仍合并成最新一行，规则不变。历史回合各留自己那一行，不跟随 dock 的最新整表。

`extensionCards` 删除 `TodoCard` 与 `todo` 注册。`generate_image` 仍走独立卡。预览页里 TodoCard 那一节改为任务条 + 对话流行。

## 6. 滚轮

有消息时：

| 指针位置 | 行为 |
| --- | --- |
| dock / 审批 / 工作区栏 / 输入框外壳 | `preventDefault`，转发给 Virtua `scrollBy` |
| 输入框正文且该方向还能滚 | 原生滚草稿 |
| 输入框正文已到顶/底 | 转发给 Virtua |
| `/`、`@`、询问卡自身可滚 | 只滚浮层，不转发对话 |
| 空会话 | 不转发 |

向上转发时沿用列表现有逻辑：立刻取消自动贴底（与 `VirtualizedMessageList` 容器 `onWheel` 里 `deltaY < 0` 相同）。

## 7. 错误与边界

- 畸形 `details`（`todos` 非数组等）：当作没有成功快照；dock 不更新；对话流回退成只标题或错误态，不渲染旧 `TodoCard`。
- 工具失败不覆盖上一份成功 dock。
- 文本空白或 id 冲突：工具失败，状态不变。
- 空会话不测量座椅、不挂全高列表。
- 覆盖式滚动条：座椅 `right` 为 0；输入框高度内不保证能拖滑块，用滚轮。

## 8. 测试

纯函数：摘要（完成数、hint、`+N`、空、无进行中、第一进行中文案不可用）；整表覆盖；清空；空白文本 / 重复 id 失败且不改状态；旧 `done` 映射；失败结果不参与 reconstruct。

组件：任务条空则无 DOM；折叠不露任务名；零计数段省略；展开可并行进行中；列表有 180px 上限。`GoalPill` 在 `composer-surface` 外。SteerQueue 仍在座椅。对话流有「更新任务清单」、无 `card-todo`。同一回合多次 todo 仍一行。空会话仍居中。审批卡在时 `padding-bottom` 大于只有输入框时；询问卡出现不改变它。

滚轮：外壳转发给列表；草稿未到边缘不转发；pop 滚动不转发。

不测：滚动条滑块像素、真实窗口系统皮肤、子代理面板。

## 9. 主要改动面

- `extensions/todo/`：类型、`applyTodo`、reconstruct、工具参数与说明、单测
- `electron-agent`：`ChatView` 列几何；`VirtualizedMessageList` 接收 `paddingBottom` 与对外 `scrollBy`；`MessageEditor` dock 叠层；新建任务条与摘要纯函数；`ToolExecution` todo 行；删除 `TodoCard`；Goal / SteerQueue 测试；`preview.tsx` 相关节

不改 pi core、不改子代理面板、不改询问卡关闭规则。
