# 命令 / URL 标签与执行性命令去幽灵 设计

- 日期：2026-06-29
- 范围：`tauri-agent` 前端聊天输入区与对话气泡的标签（chip）系统
- 状态：设计定稿，待写实现计划
- 关联：`2026-06-27-conversation-items-unified-style-design.md`（对话项统一视觉）、`2026-06-27-self-evolve-status-display-design.md`（dream/distill notice）、`2026-06-17-chat-attachment-card-design.md`（粘贴附件）
- 设计稿（1:1 原型）：`.superpowers/brainstorm/cmd-tags/content/proto-1to1.html`

## 1. 目标与背景

两个相互独立、可分别落地的改动，统一收敛在「ChatTag chip 体系 + 对话气泡渲染」上：

- **Part A — URL 粘贴成链接 chip**：粘贴一条 URL 时，自动收成一枚链接 chip（与现有 `/命令`、`@文件` chip 同一套视觉），避免长链接撑乱输入框；发送后在对话气泡里也渲染成同一枚 chip。纯视觉整洁，不改变语义（发送文本仍是原始 URL，**不**触发抓取）。
- **Part B — 执行性命令不再留幽灵气泡**：像 `/dream`、`/compact` 这类「发出后不产生对话轮次、切换会话即消失」的命令，当前会乐观插入一枚用户气泡，重载 / 切换会话后该气泡消失（幽灵）。改为发出后**不插**用户气泡，给一条轻量「已执行 /xxx」瞬态提示；命令自带的持久化 notice（如「Dream 已启动」）照旧。

### 现状（代码事实）

- 粘贴拦截 `input/editor/usePasteCapture.ts`：图片 → 长文本 → `/命令`（`useCommandPaste`）。**无** URL 处理，URL 落为纯文本。
- chip 渲染 `input/editor/ChatTag/ChatTagView.tsx`：类目 `file` / `directory` / `command`（命令再按 `commandGroup` 分色，工具命令用青柠 `#BCE641`）。
- 对话气泡渲染 `messageTags.tsx` 的 `renderMessageTags`：仅识别 `@路径` → 文件 chip、`/skill:名` 或展开后的 `<skill>` 块 → 技能 chip；其余按纯文本。URL、普通命令均为纯文本。
- 发送 `ChatView.tsx` 的 `handleSend`：`store.pushUserMessage(text)` 乐观插气泡 + `pi.prompt(workspace, text)`。`/dream` 这类命令被 Pi 当动作执行（`extensions/self-evolve/index.ts` 的 `ctx.ui.notify`），**不**写入会话轮次；其 notice 经 `agentReducer` 落为 `{ kind:'notice' }`、由 `NoticePill` 渲染且会持久化。
- 因此幽灵只出在乐观的 `pushUserMessage` 那一枚气泡上。

## 2. Part A — URL 链接 chip

### 2.1 新增标签类目 `link`

| 文件 | 改动 |
|---|---|
| `input/editor/ChatTag/types.ts` | `ChatTagCategory` 增加 `'link'` |
| `input/editor/ChatTag/ChatTagNode.ts` | `$createChatTagNode` / 序列化把 `link` 与 `file`/`command` 并列透传（仅枚举扩展，节点结构不变） |
| `input/editor/ChatTag/ChatTagView.tsx` | 加 `link` 配色与图标 |
| `input/editor/ChatTag/tagText.ts` | `tagToText`：`link` → 直接输出原始 URL（无 `@` / `/` 前缀） |

### 2.2 粘贴识别（`useUrlPaste`，对照 `useCommandPaste`）

- 新增 `input/editor/useUrlPaste.ts`，导出 `tryUrlPaste(text): boolean`。
- 判定：`text.trim()` 整体匹配单条 URL `^https?:\/\/\S+$`（无内部空白）。命中→插入 `INSERT_CHAT_TAG_COMMAND`，payload `{ category:'link', label: 精简形, value: 完整URL }`；返回 `true`。否则 `false` 放行默认粘贴。
- `usePasteCapture.ts` 顺序：图片 → 长文本（`isLongPaste`）→ **URL（`tryUrlPaste`）** → 命令（`tryCommandPaste`）。长链接已被 `isLongPaste` 拦在前；URL 以 `http(s)://` 起、命令以 `/` 起，互不冲突。

### 2.3 chip 视觉（与现有 chip 同一套几何）

- 复用 `ChatTagView` 的 `tag` 几何（`padding:0 5px;border-radius:5px;gap:3px;font-weight:500;line-height:1.6;icon 13px`）。
- `link` 配色：青色系，`color: cssVar.cyan`，`background: color-mix(in srgb, cssVar.cyan 16%, transparent)`（与文件蓝 `colorInfo`、命令紫 `purple` 区分）。图标 lucide `Link2`。
- label 精简形：`hostname` +（可选首段 path）+ 过长截断（如 `github.com/.../pull/123`）；`value` 存完整 URL，`title` 悬浮显示完整。精简规则集中在一个 `formatUrlLabel(url)` 纯函数，便于单测与调整。

### 2.4 对话气泡渲染（`messageTags.tsx`）

- `parseMessageTags` 的 inline pass 增加 URL 段识别：在现有 `@文件` / `/skill` 规则基础上加「行首或空白后 + `https?://非空白串`」（与 `@file` 同款边界，避开 email、避免误吞普通文字）。
- 命中 → `MessageSegment` 新增 `{ type:'link'; url:string }`；`renderMessageTags` 渲染 `<ChatTagView category="link" label={formatUrlLabel(url)} value={url} />`。
- 边界：不处理 markdown 链接 `[文字](url)`（用户气泡基本是纯文本；如出现，保持纯文本由 markdown 渲染，不强转 chip）。

## 3. Part B — 执行性命令不留幽灵气泡

### 3.1 命令分类（`commandClassification.ts`，保守白名单）

- 新增 `input/commandClassification.ts`：
  - `EXECUTIVE_COMMANDS: Set<string>`（**保守**：仅放确定的纯动作命令）：
    `compact, newSession, new, dream, distill, share, unshare, export, undo, redo, model, models, theme, themes, agent, agents, editor, mcp, session, sessions, help, exit, quit`。
  - **不放**不确定者（`init / review / goal / deep-research` 等）→ 默认保留气泡（符合「保守」取向：宁可多留，不误杀真实用户轮次）。
  - `isExecutiveCommand(name: string, command?: PiCommand): boolean`：命中清单（去 `skill:` 前缀、小写比较）返回 `true`；预留 `command?.kind === 'action'` 钩子——将来 Pi 在 `get_commands` 标记命令类型后可平滑接管，无需改调用方。
- 注：`/skill`、提示词（`apiSource:'prompt'`）命令会展开成真实提示词轮次、本就持久化，**不**在清单内、保留气泡。

### 3.2 发送分支（`ChatView.tsx` 的 `handleSend`）

- 在 `handleSend` 开头（`behavior` 分支之前）加「单命令短路」：
  - 用 `parseCommandToken(text)` 判定「整条消息就是单个命令（可带参数）」；命中且 `isExecutiveCommand(name)`：
    - **跳过** `store.pushUserMessage`、**跳过** `awaitingResponse`；
    - 调 `message.info('已执行 /' + name)`（antd `message`，瞬态 toast，不进时间线、不持久化）；
    - 仍 `await pi.prompt(workspace, text)` 让 Pi 执行；提前 `return`，不跑空轮 / 重试判定（这些命令本就不产生轮次）。
  - 否则走现有逻辑（保留乐观气泡）。
- Pi 自带 notice（如「Dream 已启动」`NoticePill`）照旧经事件流落入并持久化 → 切换 / 重载后看到的完全一致。

### 3.3 反馈一致性

- 「已执行 /xxx」是**瞬态 toast**（即时确认、不留痕），与「持久化 notice」职责分离：dream/distill 两者并存且互补（一条「已收到」、一条「后台任务已起」）；compact 有压缩指示器、newSession 重置视图，本身即反馈。

## 4. 数据流与行为（不变项）

- `ChatMessage[]` → `groupMessages` → `ChatMessageItems` 分发渲染不变；只在叶子 `renderMessageTags` 增加 URL 段。
- slash 菜单（`useSlashOptions`）的命令插入、`frontend` 命令（compact/newSession）在选择时即执行的现有路径不变。
- steer / followUp 路由、重试、`text.startsWith('/')` 的 `startTimeoutMs` 短路不变（执行性命令短路在更前，二者不冲突）。
- 既有 chip（file/directory/command）、`@文件`、`/skill` 渲染不变。

## 5. 测试

- 新增 `useUrlPaste` / `formatUrlLabel`：纯 URL 转 chip、URL 后跟文字 / 多段不整体转、精简 label 各形态。
- `commandPaste.test.ts` 不变；新增 `commandClassification.test.ts`：清单命中、`skill:` 前缀、大小写、未知命令保留气泡。
- `messageTags.test.ts` 扩展：URL 段切分、与 `@文件` / `/skill` 混排、email / 路径 / markdown 链接不误伤。
- `ChatView` 发送分支：执行性单命令不 `pushUserMessage` 且不置 `awaitingResponse`；普通文本 / 含命令的长文本仍插气泡。
- `npx tsc -p tauri-agent` 与 `npx eslint` 零新增问题。`preview.tsx` 可加 link chip 到 chip 画廊作视觉回归。

## 6. 非目标（YAGNI）

- 不让 URL 触发抓取 / 作为上下文（仅视觉整洁；web-fetch 仍由用户显式触发）。
- 不改后端 / Pi 协议；不依赖新的命令元数据（`kind` 仅作可选钩子，缺省走白名单）。
- 不把所有命令都强渲染成气泡 chip（执行性命令根本不进气泡）。
- 不动 `groupMessages` / store / 会话持久化结构。
- 不引入新依赖（图标用既有 lucide `Link2`，样式用既有 antd-style / `cssVar`）。

## 7. 落地顺序（两个独立 PR）

1. **Part A**：`types`/`ChatTagNode`/`ChatTagView`/`tagText` 加 `link` → `useUrlPaste` + `usePasteCapture` → `messageTags` URL 段 → 单测。
2. **Part B**：`commandClassification.ts`（+单测）→ `handleSend` 单命令短路 → 发送分支单测。

## 附：设计稿

`.superpowers/brainstorm/cmd-tags/content/` 下 `proto-1to1.html`（1:1 定稿）、`executive-cmd.html`（前后对比）、`url-chip.html`（chip 一致性）。建议把 `.superpowers/` 加入 `.gitignore`。
