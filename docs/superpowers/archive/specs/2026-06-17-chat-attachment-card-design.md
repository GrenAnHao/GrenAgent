# 聊天附件卡片（发送后气泡折叠卡片）设计

- 日期：2026-06-17
- 状态：设计待评审（待用户审查规格 → writing-plans）
- 主题：用户复制多行文本 / 拖入文本文件后发送，当前在对话气泡里会被整段铺开，影响观感。把这些「粘贴文本块 / 文件块」在**发送后的用户消息气泡**里渲染成**可折叠的附件卡片**（默认折叠单行，点击展开、限高滚动），与其他会话组件视觉统一。

## 1. 背景与目标

### 现状链路

输入框侧已较完善：粘贴超过阈值（12 行或 1500 字符）的纯文本、或拖入文本文件，会被折叠成输入框上方的小 chip（`InputChips`），不灌进编辑器。

问题出在**发送之后**：

- 发送时 `composeMessage(markdown, pastedTexts)` 把正文 markdown 与各附件块**拼成一个纯文本字符串**——纯文本块直接追加（无标记），文件块用动态长度的 ```` ```相对路径 ```` 代码围栏包裹——再通过 `onSend(text)` 发给 pi。
- 发送后 `UserMessage` 只拿到这**一个 text 字符串**，用 `renderMessageTags` 解析 `@路径` 后，其余用 `white-space: pre-wrap` 一股脑铺开。长附件因此成为气泡里的「一大坨」。

### 成功标准（用户诉求）

1. 发送后的用户气泡里，粘贴文本块 / 文件块显示成**独立的可折叠卡片**，而不是整段纯文本。
2. 卡片**默认折叠为单行**（图标 + 标题 + 行数），点击展开；展开内容**限高滚动**。
3. 与现有会话组件视觉统一（lobehub 风格，明暗自适应）。
4. 切换会话 / 重开应用后，从历史恢复的旧消息也应**一致**地折叠成卡片。

### 非目标

- 不改输入框侧的 chip（`InputChips` 保持现状）。
- 不改 pi 后端 / agent loop；user message 仍是单一文本 prompt。
- 不把图片附件改成卡片（图片维持现有缩略图 + 预览）；不改 `@文件引用` pill。
- 不引入折叠状态的持久化（展开/折叠是纯前端 UI 态，刷新回到默认折叠即可）。

## 2. 现状盘点（决定可行边界）

| 关注点 | 现状 | 位置 |
|---|---|---|
| 附件暂存 | `PastedText { id, text, lines, chars, source? }`，source 为拖入文件相对路径 | `input/editor/types.ts` |
| 发送拼接 | `composeMessage`：纯文本块直接追加；文件块用动态 fence ```` ```source ```` 包裹 | `input/editor/composeMessage.ts` |
| 发送入口 | `ChatInput.send` → `composeMessage` → `onSend(text, images)`，user message 是纯文本 | `ChatInput.tsx` |
| 用户消息类型 | `{ kind:'user'; id; text; images?; steering? }`，**只有 text 字符串** | `stores/agentReducer.ts` |
| 实时插入 | `addUserMessage(state, text, images)` | `stores/agentReducer.ts` |
| 历史恢复 | `messagesFromAgent`：从 pi `get_messages` 的 user content 提取 `text`（与发送的同一串） | `stores/agentReducer.ts` |
| 气泡渲染 | `UserMessage` → `renderMessageTags(text)`（切 `@路径` chip + `pre-wrap` 文本） | `features/chat/UserMessage.tsx` / `messageTags.tsx` |

**结论**：实时发送与历史恢复的 user `text` 是**同一串**（都来自 `composeMessage` 的输出，经 pi 存储回显）。因此只要让 `composeMessage` 给附件块加上**稳定可解析的边界标记**，再让 `UserMessage` 用一个解析器从 text 切出附件块，实时与历史就**自动一致**，无需改消息类型、reducer、发送签名。这就是方案 A。

## 3. 方案选择（已定）

- **方案 A（已选）：文本边界标记 + 渲染解析**。`composeMessage` 给附件块包 XML 风格标记；`UserMessage` 解析 text 渲染卡片。实时 + 历史一致，改动集中在拼接层与渲染层。
- 方案 B（结构化字段）：user message 加 `attachments` 字段。渲染干净，但历史恢复只有 text、拿不到结构化字段，旧消息退回一大坨；且改动面大（消息类型 / reducer / 发送链路 / 回显匹配）。否决。
- 方案 C（仅前端临时态）：只在发送瞬间本地渲染。刷新 / 切换即丢失，历史完全不支持。否决。

## 4. 边界标记格式（已定：XML 风格）

`composeMessage` 把每个附件块包成 `<pi:attachment>` 标签，拼在正文之后、块间空行分隔。

文件块：

```
<pi:attachment type="file" path="src/config.ts" lines="42">
{文件内容}
</pi:attachment>
```

粘贴文本块：

```
<pi:attachment type="text" lines="120" chars="3210">
{粘贴内容}
</pi:attachment>
```

约定：

- 属性：`type`（`file` | `text`）、`path`（仅 `file`，相对路径或文件名）、`lines`（行数）、`chars`（字符数，可选）。
- 开标签后紧跟一个换行、闭标签前紧跟一个换行（解析时各裁掉一个，还原原始内容）。
- **转义兜底**：包裹前把内容里出现的字面量 `</pi:attachment>` 替换为 `</pi:attachment\u200b>`（插入零宽字符）避免提前闭合；解析后反向还原。内容含该串概率极低，转义只为绝对安全。
- 选择 XML 标签而非沿用代码围栏：边界对解析与对 AI 都最清晰（接近 Cursor / Claude 的 XML 上下文约定），且不与用户正文里的普通 ```` ``` ```` 代码块混淆。

**对 AI 的影响**：AI 会看到 `<pi:attachment ...>` 包裹（取代当前文件块的 ```` ```path ```` 围栏与纯文本块的无标记追加），作为清晰的附件上下文边界，通常有益。

## 5. 共享契约模块（单一来源）

标记的「包裹」与「解析」是同一契约，集中到一个文件，避免 composeMessage 与渲染侧各写一份导致漂移。

新增 `features/chat/attachment.ts`：

```ts
export interface AttachmentBlock {
  attType: 'file' | 'text';
  path?: string;
  lines: number;
  chars?: number;
  content: string;
}

// 供 composeMessage 用：把一个附件块包成 <pi:attachment> 文本（含转义）。
export function wrapAttachment(block: AttachmentBlock): string;

// 供 UserMessage 用：把消息 text 切成正文段与附件段。
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'attachment'; block: AttachmentBlock };
export function parseAttachments(text: string): MessagePart[];
```

- `parseAttachments` 用非贪婪正则扫描 `<pi:attachment\s+属性>\n?内容\n?</pi:attachment>`，解析属性，标签之间 / 前后的普通文本作为 `text` 段；逐段反转义还原内容。
- 容错：属性缺失按缺省（lines=0）；**标签未闭合 / 解析异常 → 该片段当作普通 text 段**，绝不抛错。
- 旧会话消息（无 `<pi:attachment>`）→ 解析得到单个 text 段 → 等价现有行为（向后兼容）。

## 6. 数据流（端到端）

```
发送
  ChatInput.send
    → composeMessage(markdown, pastedTexts)
        正文 markdown 原样
        每个 PastedText → wrapAttachment({attType: source?'file':'text', path:source, lines, chars, content:text})
        正文 + 各 <pi:attachment> 块，空行分隔
    → onSend(text)  // 发给 pi，AI 看到带标记的完整文本

渲染（实时 addUserMessage / 历史 messagesFromAgent 都拿到同一 text）
  UserMessage(text)
    → parseAttachments(text) → MessagePart[]
        text 段   → renderMessageTags(seg.text)  // 现有 @路径 chip + pre-wrap
        attach 段 → <AttachmentCard block={...} />
```

## 7. 组件设计：AttachmentCard.tsx（前端）

- props：`block: AttachmentBlock`。
- 本地状态：`open`（默认 `false` = 折叠）。
- 折叠态（单行）：左 lucide 图标（`file` 块用 `FileText`，`text` 块用 `ClipboardList`）+ 标题（`file`：path 的 basename；`text`：固定文案「粘贴文本」）+ 右侧 meta（`N 行`，`text` 再加 `· X 字`）+ 末尾 `ChevronRight`。整行可点，`hover` 高亮。
- 展开态：头部下方 `<pre>` 展示 `content`，等宽字体，`max-height: 240px; overflow: auto`，`white-space: pre`；`ChevronRight` 旋转 90 度。
- 样式：`createStaticStyles` + `cssVar`（与 `InputChips` / 输入区一致）；圆角边框 `colorBorderSecondary`、底色 `colorBgElevated/colorFillTertiary`，明暗自适应。
- 布局：卡片在用户气泡**下方、右对齐、独立成卡**（不塞进彩色气泡内）。`UserMessage` 的 `ChatItemShell` 内：正文气泡 + 其后依次堆叠各 `AttachmentCard`。
- 图标统一用 `@lobehub/ui` 的 `Icon` + `lucide-react`，遵守 no-emoji 规则。

## 8. 改动文件清单

| 文件 | 改动 |
|---|---|
| `features/chat/attachment.ts` | 新增：`wrapAttachment` / `parseAttachments` / 类型 / 转义常量 |
| `features/chat/attachment.test.ts` | 新增：包裹格式、解析各组合、往返还原、转义、未闭合回退 |
| `features/chat/AttachmentCard.tsx` | 新增：折叠卡片组件 |
| `input/editor/composeMessage.ts` | 改：附件块改用 `wrapAttachment`（替换现有直接追加 / 动态 fence） |
| `input/editor/composeMessage.test.ts` | 改：更新断言为带 `<pi:attachment>` 标记的输出 |
| `features/chat/UserMessage.tsx` | 改：用 `parseAttachments` 切段，text 段走 `renderMessageTags`，attach 段渲染 `AttachmentCard` |

## 9. 测试

- `attachment.test.ts`
  - `wrapAttachment`：file 块 / text 块输出格式正确（属性、换行）。
  - `parseAttachments`：纯正文、单附件、多附件、`附件 + 正文 + 附件` 混排、正文段内含 `@路径`、未闭合标签回退为 text、内容含 `</pi:attachment>` 经转义后能正确还原。
  - 往返：`wrapAttachment` 产出经 `parseAttachments` 还原出原始 `content` 与属性。
  - 向后兼容：无标记文本解析为单个 text 段。
- `composeMessage.test.ts`：更新为校验带标记的拼接结果（正文 + `<pi:attachment>` 块）。
- `AttachmentCard`（若有渲染测试基建）：折叠 / 展开切换、标题与 meta 文案、明暗样式。

## 10. 拆解（单一实现计划即可覆盖）

| 阶段 | 范围 |
|---|---|
| 1 | `attachment.ts` 契约（wrap + parse + 转义）+ 单测 |
| 2 | `composeMessage` 接入 `wrapAttachment` + 更新其测试 |
| 3 | `AttachmentCard.tsx` 组件 |
| 4 | `UserMessage` 接入 `parseAttachments` 渲染 |

强依赖顺序：1 → 2 / 3（并行）→ 4。规模小，适合一个实现计划。

## 11. 关键决策（已定）

- **D1 数据流**：方案 A（文本边界标记 + 渲染解析）。理由：实时与历史一致、改动集中、历史折叠免费。
- **D2 标记格式**：XML 风格 `<pi:attachment>`，含 `type/path/lines/chars`。理由：边界清晰、对 AI 友好、不与正文代码块混淆。
- **D3 默认形态**：A（默认折叠单行），点击展开、限高 240px 滚动。
- **D4 卡片位置**：用户气泡下方、右对齐、独立成卡（不塞进彩色气泡内）。
- **D5 覆盖范围**：粘贴文本块 + 拖入文件块；图片与 `@引用` 不变；仅改发送后气泡，输入框 chip 不动。

## 12. 风险与注意

- **与正文代码块冲突**：`<pi:attachment` 标签独特，用户正文几乎不会写；叠加内容转义兜底。
- **向后兼容**：旧会话消息无标记 → 解析为单段 text → 维持现有渲染；旧历史里 ```` ```path ```` 文件块不再识别为卡片（按普通 markdown 代码块显示），可接受。
- **AI 遵循度**：标记由前端 `composeMessage` 生成（非依赖模型输出），稳定可靠。
- **解析健壮性**：所有异常路径回退为纯文本渲染，不影响消息可读性，不崩溃。
