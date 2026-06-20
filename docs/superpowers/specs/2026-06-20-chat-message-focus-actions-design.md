# GrenAgent 对话焦点气泡功能卡片（消息操作栏）设计 — Phase 1

> 状态：设计已与用户逐项确认（范围 = 最小集；推进 = A1 渐进两阶段；Phase 1 设计已获批）。下一步：writing-plans 拆实现计划。
> 参考：lobehub `src/features/Conversation/Messages/components/MessageActionBar/`（声明式 slot → `ActionIconGroup`）+ `Messages/User/Actions/index.tsx`（bar/menu 配置，与用户截图逐项对应）。

## 1. 背景与问题

`tauri-agent` 的对话渲染在「1:1 复刻 lobehub」设计（`docs/superpowers/specs/2026-06-14-grenagent-chat-render-lobehub-replica-design.md`）中**刻意推迟了消息操作栏**：

- 6.1 节：「时间/操作栏：hover 才显隐（opacity 200ms）——本期可省略 actions，仅保留结构位。」
- 第 2 节非目标：「消息编辑 / 分支 / 重新生成等 lobe-ui ChatList 自带能力——GrenAgent 暂不需要。」

现在补上这块：用户 hover/focus 一条消息时，在气泡下方浮现一排操作（lobehub 的 `ActionsBar`，即「焦点气泡功能卡片」）。当前 `ChatMessageItems` → `UserMessage` / `ChatItemShell` / `TurnTimeline` 都没有任何 actions 层，需要新增。

## 2. 目标 / 非目标

**目标（Phase 1，本期）**：

- 复刻 lobehub 焦点气泡的**交互/视觉骨架**：hover/focus-within 显隐、气泡下方对齐、常驻图标条 + `...` 溢出菜单。
- 接通**复制**（用户消息 + 助手消息），立即可用。
- `编辑 / 重新生成 / 删除` 三个动作以 **disabled 占位 + tooltip「即将支持」** 呈现，保证截图里那套完整菜单的视觉，但不接后端。
- 架构镜像 lobehub 的声明式 slot，使 Phase 2 接 fork 时 **UI/slot 结构零改动**。

**非目标（本期不做）**：

- `编辑重发 / 重新生成 / 删除` 的真实后端逻辑（依赖 pi fork 链路，见 Phase 2）。
- lobehub 的 `branching(创建子话题) / tts(语音朗读) / translate(翻译) / share(分享) / collapse / reaction`——最小集已砍掉。
- 移动端/触摸常显策略（桌面 Tauri 以 hover 为主）。

## 3. 关键决策（已与用户确认）

| 编号 | 决策 | 选择 |
|------|------|------|
| Q1 | 功能范围 | **最小集**：用户气泡 = 复制 / 编辑重发 / 重新生成 / 删除；助手消息 = 复制。砍掉 子话题/朗读/翻译/分享 |
| Q2 | 推进方式 | **A1 渐进两阶段**：本期 UI 骨架 + 复制可用，其余三动作占位；下阶段补 fork 链路 |
| Q3 | 删除语义（Phase 2） | pi 无「单条删除」原语，删除按 **fork「截断到此」**（删这条及其后所有）实现 |
| — | 触发显隐 | hover 或键盘 `focus-within`；预留固定高度行避免跳动 |

## 4. 架构

新增 Pi 本地模块 `features/chat/messageActions/`，镜像 lobehub 声明式 slot 架构但精简：

```
ctx: { role: 'user' | 'assistant'; text: string }   // Phase 2 再加 entryId
  └─ <MessageActionBar bar={Slot[]} menu={Slot[]} ctx={ctx} />
       └─ resolveSlots(slot key → action builder)
            ├─ copy        → 真实现（copyToClipboard + toast）
            ├─ edit        → disabled 占位（tooltip「即将支持」）
            ├─ regenerate  → disabled 占位
            └─ del         → disabled 占位
       └─ 渲染 @lobehub/ui <ActionIconGroup items={bar} menu={menu} onActionClick={...} />
```

- slot 是字符串 key（`'copy' | 'edit' | 'regenerate' | 'del' | 'divider'`），与 lobehub 同构（对齐 `MessageActionBar/types.ts` 的 `MessageActionSlot`）。
- 每个 action 由一个 builder 产出 `{ key, icon, label, handleClick?, disabled? }`；占位项 `disabled: true` 且无 `handleClick`。
- Phase 2 衔接：把占位项的 `disabled` 去掉 + 填 `handleClick(ctx.entryId)` 即可，slot 列表与组件不变。

> 备注：优先用 `@lobehub/ui` 的 `ActionIconGroup`（与 lobehub 1:1）。若该版本未导出 `ActionIconGroup`，回退为 `ActionIcon` + antd `Dropdown` 组合（Pi `features/sessions/RowActions.tsx` 已验证此组合可用）。实现期一次性确认。

## 5. 组件设计

### 5.1 ChatItemShell（新增 actions 槽）
- 新增可选 prop `actions?: ReactNode`，渲染在内容下方。
- **预留固定高度行（约 28px）**，默认 `opacity:0`；hover/focus-within 才 `opacity:1`（200ms 过渡）——避免显隐时整列高度跳动（对齐 lobehub `User/Actions` 的 `actionBarHolder` 占位高度 28px）。
- 对齐：用户 `align-self: flex-end`（右下），助手 `align-self: flex-start`（左下），对齐 lobehub `ChatItem/components/Actions.tsx` 的 `alignSelf`。

### 5.2 chatStyles（hover 显隐）
- 新增 `.actions`（opacity 过渡）与 `.item:hover .actions` / `.item:focus-within .actions { opacity: 1 }`。
- 补上 replica 设计 6.1 预留的「结构位」。

### 5.3 UserMessage（用户气泡操作栏）
- 构造 `ctx = { role: 'user', text: bodyText }`（`bodyText` 已是 `parseAttachments` 去附件/tag 后的纯文本）。
- 挂 `<MessageActionBar bar={['regenerate','edit','copy']} menu={['edit','copy','divider','regenerate','del']} ctx={ctx} />`——与用户截图逐项对应（常驻：重新生成/编辑/复制 + `...`；菜单：编辑/复制/创建——本期无子话题，故菜单去掉 branching/tts/translate，仅留 编辑/复制/divider/重新生成/删除）。
- 仅 `copy` 生效，其余 disabled。

### 5.4 TurnTimeline（助手仅复制）
- 在回合末尾挂 `<MessageActionBar bar={['copy']} ctx={{ role: 'assistant', text }} />`。
- `text` = 该 turn 所有 `kind:'text'` 段内容拼接（不含 thinking/tool）。

### 5.5 图标（lucide via @lobehub/ui，遵守 no-emoji）
copy=`Copy` · edit=`PencilLine` · regenerate=`RotateCcw` · del=`Trash2` · more=`MoreHorizontal`。

## 6. 数据流（复制）

对齐 lobehub `MessageActionBar/actions/copy.ts`：

- `handleClick`：用 `@lobehub/ui` 的 `copyToClipboard(content)` 写剪贴板，成功后用 antd `App.useApp().message.success('已复制')` 提示（lobehub 同款）；若 Pi 未挂 antd `App` Provider，则改用 Pi 现有 toast，实现期确认。
- 用户文本 = `UserMessage` 的 `bodyText`；助手文本 = turn 内 text 段拼接。
- 占位动作：无 `handleClick`，`disabled`，tooltip「即将支持」。

## 7. 交互与可达性

- 显示触发：鼠标 hover 或键盘 `focus-within`；`role="menubar"`，`ActionIconGroup` 自带键盘可达。
- 流式中：复制可用（复制当前已生成文本）。
- 桌面 Tauri 为主，hover 即可；「最后一条是否常显」留作后续可选项，本期仅 hover/focus。

## 8. 占位策略（Phase 2 衔接）

`edit / regenerate / del` 渲染为 disabled + tooltip「即将支持」。可用一个常量开关（如 `PHASE2_ACTIONS_ENABLED = false`）统一控制三者启用，Phase 2 仅需翻开关 + 填 builder 的 `handleClick`。

## 9. 视觉规范

沿用 replica 设计 token（`cssVar.*`，gray 深色）：操作栏图标走 `colorTextTertiary`，hover `colorText`；圆角/间距对齐 `ActionIconGroup` 默认。不写死 hex，随主题走。

## 10. 测试

- 单测（vitest，`features/chat`）：
  - `MessageActionBar` slot 解析：bar/menu 正确项、`divider` 插入、占位项 `disabled` 且无 `handleClick`。
  - `copy` builder：`handleClick` 调用 `copyToClipboard`，参数为目标文本。
- 渲染测：`UserMessage` / `TurnTimeline` 输出含 actions 行；hover 显隐 class 存在。
- 复用现有 `ChatItemShell.test.tsx` / `UserMessage.test.tsx`，随改动更新。

## 11. 文件清单

| 文件 | 处置 |
|------|------|
| `features/chat/messageActions/MessageActionBar.tsx` | 新增（slot 解析 + ActionIconGroup） |
| `features/chat/messageActions/types.ts` | 新增（`MessageActionContext` / `MessageActionSlot`） |
| `features/chat/messageActions/actions/copy.ts` | 新增（复制真实现） |
| `features/chat/messageActions/slots.ts` | 新增（占位 builder：edit/regenerate/del） |
| `features/chat/ChatItemShell.tsx` | 改：新增 `actions` 槽 + 显隐结构 |
| `features/chat/chatStyles.ts` | 改：actions 行 hover/focus-within 显隐样式 |
| `features/chat/UserMessage.tsx` | 改：挂用户 bar/menu |
| `features/chat/TurnTimeline.tsx` | 改：助手末尾挂 copy |

## 12. Phase 2 预告（不在本期，仅记录衔接点）

接通 `编辑重发 / 重新生成 / 删除`，依赖 pi fork 链路：

- `lib/pi.ts`：新增 `fork(workspace, entryId)` / `getForkMessages(workspace)` 包装（Rust 侧 `agent_fork` / `agent_get_fork_messages` 已就绪并注册，见 `src-tauri/src/commands/agent.rs`）。
- `agentReducer`：给 `user` 消息保存 pi 的 `entryId`（当前用客户端 `m${n}`，未捕获 pi 消息 id），供 fork 定位。
- 动作映射：重新生成 = `fork(entryId)` + `prompt(原文)`；编辑重发 = `fork(entryId)` + `prompt(新文)`；删除 = `fork` 截断到此（删这条及其后所有）。
- 需先做一次 **fork 语义 spike**：确认 `Fork` 是新建分叉会话还是原地截断、`entryId` 粒度、`GetForkMessages` 返回形状。
