# 会话消息编辑与回退 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有消息悬停操作栏上完成编辑、回退、重新生成和删除，并去掉「移出上下文」。

**架构：** 用户消息操作栏仍是气泡下方的 `MessageActionBar`。编辑把该条消息换成铺满内容列的简化输入框，发送时才截断。回退、重新生成、删除都调用主进程 `agent_truncate_to` 原地改会话文件，并同步界面历史。不使用 `fork`，不把图标悬浮到气泡外侧。

**技术栈：** Electron、React、Vitest、现有 `@earendil-works/pi-coding-agent` 会话文件。

**规格：** `docs/superpowers/specs/2026-09-22-session-message-edit-rewind-design.md`

---

## 文件结构

- 创建 `electron-agent/electron/app/truncateSession.ts`：纯函数，按 entryId 截断会话行。
- 创建 `electron-agent/electron/app/truncateSession.test.ts`：截断、多分支拒绝、保留 header。
- 创建 `electron-agent/src/features/chat/input/composerBridge.ts`：底部输入框的 `setValue`。
- 创建 `electron-agent/src/features/chat/MessageEditBox.tsx`：编辑专用简化输入框。
- 修改 `electron-agent/src/features/chat/UserMessage.tsx`：操作栏槽位，以及编辑态替换消息。
- 修改 `electron-agent/src/features/chat/messageActions/slots.tsx`：去掉即将支持；编辑占原移出位置的行为由调用方槽位决定。
- 修改 `electron-agent/src/features/chat/messageActions/MessageActionBar.tsx`：进行中仍显示回退，隐藏编辑、重新生成、删除。
- 修改 `electron-agent/src/features/chat/TurnTimeline.tsx`：助手去掉回退和移出上下文。
- 修改 `electron-agent/electron/app/piRuntimeService.ts`：`agent_truncate_to`。
- 修改 `electron-agent/electron/ipc/register.ts`、`electron-agent/src/lib/pi.ts`、`electron-agent/src/stores/agent.ts`：命令与界面历史。

## 任务 1：会话截断纯函数

**文件：**
- 创建：`electron-agent/electron/app/truncateSession.ts`
- 测试：`electron-agent/electron/app/truncateSession.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { truncateSessionLines } from './truncateSession';

const header = JSON.stringify({ type: 'session', id: 's', version: 1 });
const user = (id: string, parentId: string | null) =>
  JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: id, timestamp: 1 } });
const assistant = (id: string, parentId: string) =>
  JSON.stringify({ type: 'message', id, parentId, message: { role: 'assistant', content: [{ type: 'text', text: id }], timestamp: 2 } });

describe('truncateSessionLines', () => {
  it('删除目标及其后的活动链，保留 header 和更早的消息', () => {
    const lines = [header, user('u1', null), assistant('a1', 'u1'), user('u2', 'a1')];
    const result = truncateSessionLines(lines, 'u2', 'drop-target');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual([header, user('u1', null), assistant('a1', 'u1')]);
  });

  it('keep-target 保留目标，只删除它后面的条目', () => {
    const lines = [header, user('u1', null), assistant('a1', 'u1')];
    const result = truncateSessionLines(lines, 'u1', 'keep-target');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((line) => JSON.parse(line).id)).toEqual(['s', 'u1']);
  });

  it('目标之后还有不属于后代的行时拒绝，且不改输入', () => {
    const lines = [header, user('u1', null), user('other', null)];
    const result = truncateSessionLines(lines, 'u1', 'drop-target');
    expect(result).toEqual({ ok: false, reason: 'branched' });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/app/truncateSession.test.ts`
预期：FAIL，找不到 `./truncateSession`。

- [ ] **步骤 3：编写最少实现代码**

`truncateSession.ts` 导出 `truncateSessionLines(lines, targetId, mode)`。`mode` 为 `drop-target` 或 `keep-target`。用 `parentId` 收集目标的后代。`drop-target` 连目标一起删，`keep-target` 只删后代。目标行之后若存在既不是目标也不是后代的行，返回 `{ ok: false, reason: 'branched' }`。成功时保留 header 和未删除行的原有顺序。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/app/truncateSession.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/truncateSession.ts electron-agent/electron/app/truncateSession.test.ts
git commit -m "feat(session): truncate session lines without leaving a branch"
```

## 任务 2：主进程截断命令

**文件：**
- 修改：`electron-agent/electron/app/piRuntimeService.ts`
- 修改：`electron-agent/electron/agent/workspaceHandle.ts`
- 修改：`electron-agent/electron/ipc/register.ts`
- 修改：`electron-agent/src/lib/pi.ts`
- 测试：`electron-agent/electron/app/piRuntimeService.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `piRuntimeService.test.ts` 增加：`agent_truncate_to` 对线性会话调用后，会话文件不再包含目标及其后的行，并调用 `reload`。对带旁支的文件返回失败且字节不变。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/app/piRuntimeService.test.ts -t "truncate"`
预期：FAIL，命令不存在。

- [ ] **步骤 3：编写最少实现代码**

`WorkspaceHandlePort` 增加 `reload()`，实现为已有的 `waitForIdle()` 加 `session.reload()`。`register.ts` 的命令表加入 `agent_truncate_to`。`piRuntimeService` 处理该命令：若正在流式则 `abort()`，然后 `waitForIdle()`，读 `sessionFile`，调用 `truncateSessionLines`，失败则不写文件。成功则写临时文件后 `rename`，再 `reload()`。`src/lib/pi.ts` 增加 `truncateTo(workspace, entryId, mode)`。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/app/piRuntimeService.test.ts -t "truncate"`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/app/piRuntimeService.test.ts electron-agent/electron/agent/workspaceHandle.ts electron-agent/electron/ipc/register.ts electron-agent/src/lib/pi.ts
git commit -m "feat(session): add agent_truncate_to for in-place history cuts"
```

## 任务 3：操作栏改为原型

**文件：**
- 修改：`electron-agent/src/features/chat/UserMessage.tsx`
- 修改：`electron-agent/src/features/chat/TurnTimeline.tsx`
- 修改：`electron-agent/src/features/chat/messageActions/slots.tsx`
- 修改：`electron-agent/src/features/chat/messageActions/MessageActionBar.tsx`
- 测试：`electron-agent/src/features/chat/messageActions/MessageActionBar.test.tsx`

- [ ] **步骤 1：编写失败的测试**

把流式用例改成：进行中仍渲染操作栏，且有回退、没有编辑。另加一条：用户消息栏位 `['rewind', 'edit', 'copy']` 时，编辑的可访问名称是「编辑」，不是「编辑（即将支持）」。菜单文案不包含「移出上下文」。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/messageActions/MessageActionBar.test.tsx`
预期：FAIL。进行中时期望看到回退，当前实现返回 null。

- [ ] **步骤 3：编写最少实现代码**

`UserMessage` 的 `bar` 改为 `['rewind', 'edit', 'copy']`，`menu` 改为 `['copy', 'divider', 'rewind', 'edit', 'regenerate', 'del']`。`slots.tsx` 里编辑、重新生成、删除的 label 去掉「即将支持」。`MessageActionBar` 在 `isStreaming` 时从 `bar` 和 `menu` 滤掉 `edit`、`regenerate`、`del`，不再整栏返回 null。`TurnTimeline` 去掉 rewind 和 exclude。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/messageActions/MessageActionBar.test.tsx src/features/chat/UserMessage.test.tsx`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/UserMessage.tsx electron-agent/src/features/chat/TurnTimeline.tsx electron-agent/src/features/chat/messageActions/slots.tsx electron-agent/src/features/chat/messageActions/MessageActionBar.tsx electron-agent/src/features/chat/messageActions/MessageActionBar.test.tsx
git commit -m "feat(chat): put edit in the context-exclude slot"
```

## 任务 4：编辑输入框

**文件：**
- 创建：`electron-agent/src/features/chat/MessageEditBox.tsx`
- 创建：`electron-agent/src/features/chat/MessageEditBox.test.tsx`
- 修改：`electron-agent/src/features/chat/UserMessage.tsx`

- [ ] **步骤 1：编写失败的测试**

渲染 `MessageEditBox`，期望有预填文字、名称为「取消」的按钮、名称为「发送」的按钮，并且没有「模型」按钮。点击取消调用 `onCancel` 且不调用 `onSend`。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/MessageEditBox.test.tsx`
预期：FAIL，组件不存在。

- [ ] **步骤 3：编写最少实现代码**

`MessageEditBox` 铺满内容列。复用底部输入框的编辑器、图片块、拖放和 `@`。`/` 的选项只保留技能。工具栏不渲染模式、审批、模型、联网、生图、朗读、压缩、新会话、增强提示词。只有取消和发送。`UserMessage` 在编辑态用它替换气泡。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/MessageEditBox.test.tsx`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/MessageEditBox.tsx electron-agent/src/features/chat/MessageEditBox.test.tsx electron-agent/src/features/chat/UserMessage.tsx
git commit -m "feat(chat): edit a user message in a simplified composer"
```

## 任务 5：接上截断、回退、重新生成和删除

**文件：**
- 创建：`electron-agent/src/features/chat/input/composerBridge.ts`
- 修改：`electron-agent/src/features/chat/ChatInput.tsx`
- 修改：`electron-agent/src/stores/agent.ts`
- 测试：`electron-agent/src/features/chat/messageEditFlow.test.tsx`

- [ ] **步骤 1：编写失败的测试**

覆盖规格状态机里的四条：编辑取消不调用截断；编辑发送调用 `drop-target` 后再发送；截断成功但发送失败时把文字写入底部输入框；回退确认调用截断后，下一次发送不再带截断。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/messageEditFlow.test.tsx`
预期：FAIL。

- [ ] **步骤 3：编写最少实现代码**

`composerBridge` 只保存底部输入框的 `setValue`。编辑发送先取文字，调用 `truncateTo(entryId, 'drop-target')`，成功后再走普通发送。失败且截断已成功时 `setValue(文字)`。回退确认先记住文字，停止回合，`truncateTo(entryId, 'drop-target')`，再 `setValue`。重新生成对最后一条用户消息使用 `keep-target`，然后用原文调用普通发送。删除确认后 `drop-target`，不写入输入框。界面历史在截断成功后写成剩余对话；写入失败则删除该会话的 ui-history 文件。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/messageEditFlow.test.tsx electron/app/truncateSession.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/input/composerBridge.ts electron-agent/src/features/chat/ChatInput.tsx electron-agent/src/stores/agent.ts electron-agent/src/features/chat/messageEditFlow.test.tsx
git commit -m "feat(chat): cut session history on edit, rewind, regenerate, and delete"
```

## 规格覆盖

- 操作栏位置和菜单：任务 3。
- 编辑框、取消、发送才删除、失败回填：任务 4 和任务 5。
- 回退确认后删除再普通发送：任务 5。
- 重新生成和删除：任务 5。
- 去掉移出上下文：任务 3。
- 会话文件与界面历史：任务 1、任务 2、任务 5。
- 不悬浮到气泡外：任务 3 只改槽位，不新增外侧图标。
