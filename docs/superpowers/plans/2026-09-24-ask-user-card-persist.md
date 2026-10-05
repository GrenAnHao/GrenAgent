# 询问卡跨重启保持 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 未发送、未取消的 `ask_user` 浮层在重启后仍在，已选内容填回；发送或取消写回同一次工具调用并让模型继续。选项文字被截断时悬停显示全文。

**架构：** 题目来自会话里最后一次没有 `toolResult` 的 `ask_user`。草稿写在 `<sessionFile>.ask-user-draft.json`，不进模型上下文。进程仍在等待时走现有 `extension_ui_response`。重启后没有等待，宿主 `appendMessage` 补上工具结果，再调用 `session.agent.continue()`。`loadMessages` 里把其它残留 `running` 工具标成 `error` 的逻辑必须放过这次 `ask_user`。

**技术栈：** Electron、React、Vitest、Pi `AgentSession`（`sessionManager.appendMessage`、`agent.continue()`）。

**规格：** `docs/superpowers/specs/2026-09-24-ask-user-card-persist-design.md`

---

## 文件结构

- 创建 `electron-agent/src/features/chat/conv/labelOverflows.ts`：判断标签是否被截断。
- 修改 `electron-agent/src/features/chat/conv/OptionRow.tsx`：截断时悬停全文。
- 修改 `electron-agent/src/features/chat/conv/OptionRow.test.tsx`。
- 创建 `electron-agent/src/features/chat/pendingAskUser.ts`：从会话消息找出最后一次未完成的 `ask_user`。
- 创建 `electron-agent/src/features/chat/pendingAskUser.test.ts`。
- 修改 `electron-agent/src/stores/agentReducer.ts`：没有结果的 `ask_user` 画成 `running` 工具行。
- 修改 `electron-agent/src/stores/agentReducer.test.ts`。
- 修改 `electron-agent/src/stores/agent.ts`：重载时豁免该行，并恢复浮层。
- 创建 `electron-agent/electron/agent/askUserDraft.ts`：草稿文件读写。
- 创建 `electron-agent/electron/agent/askUserDraft.test.ts`。
- 创建 `electron-agent/electron/agent/completeAskUser.ts`：补写工具结果并 `continue()`。
- 创建 `electron-agent/electron/agent/completeAskUser.test.ts`。
- 修改 `electron-agent/electron/app/piRuntimeService.ts`、`electron-agent/electron/ipc/register.ts`、`electron-agent/src/lib/pi.ts`：暴露草稿读写和完成命令。preload 已按命令名转发，不用改。
- 修改 `electron-agent/src/stores/inlineQuestionStore.ts`：区分活着的等待和重启恢复。
- 修改 `electron-agent/src/features/chat/InlineQuestionCard.tsx`：填草稿、改动即存、按来源发送或取消。
- 修改 `electron-agent/src/features/chat/input/overlayPrompt.ts`：发普通消息时，恢复来的卡走补写取消。

---

### 任务 1：选项被截断时显示全文

**文件：**
- 创建：`electron-agent/src/features/chat/conv/labelOverflows.ts`
- 修改：`electron-agent/src/features/chat/conv/OptionRow.tsx`
- 测试：`electron-agent/src/features/chat/conv/OptionRow.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `OptionRow.test.tsx` 末尾追加：

```tsx
import { labelOverflows } from './labelOverflows';

it('labelOverflows is true only when scroll width exceeds client width', () => {
  expect(labelOverflows({ scrollWidth: 120, clientWidth: 40 })).toBe(true);
  expect(labelOverflows({ scrollWidth: 40, clientWidth: 40 })).toBe(false);
  expect(labelOverflows({ scrollWidth: 10, clientWidth: 40 })).toBe(false);
});

it('shows the full label in a tooltip only when the row overflows', () => {
  const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
  const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 40 });
  try {
    render(<OptionRow index="A" label="很长的选项文本" selected={false} onClick={() => {}} />);
    expect(screen.getByTestId('option-row-label').getAttribute('title')).toBe('很长的选项文本');
  } finally {
    if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll);
    if (client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', client);
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/conv/OptionRow.test.tsx`

预期：FAIL，`labelOverflows` 不存在。

- [ ] **步骤 3：编写最少实现代码**

`labelOverflows.ts`：

```ts
export function labelOverflows(node: { scrollWidth: number; clientWidth: number }): boolean {
  return node.scrollWidth > node.clientWidth;
}
```

`OptionRow.tsx` 的标签改为测量后才带 `title`。单行省略样式保持不变。`title` 用原生提示，不引入新组件。

```tsx
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { labelOverflows } from './labelOverflows';

// 在组件内：
const labelRef = useRef<HTMLSpanElement>(null);
const [overflow, setOverflow] = useState(false);
useLayoutEffect(() => {
  const el = labelRef.current;
  setOverflow(el ? labelOverflows(el) : false);
}, [label]);

<span
  ref={labelRef}
  className={styles.label}
  data-testid="option-row-label"
  title={overflow ? label : undefined}
>
  {label}
</span>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/conv/OptionRow.test.tsx`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/conv/labelOverflows.ts electron-agent/src/features/chat/conv/OptionRow.tsx electron-agent/src/features/chat/conv/OptionRow.test.tsx
git commit -m "feat: show full ask_user option text when the row truncates"
```

---

### 任务 2：找出未完成的 ask_user

**文件：**
- 创建：`electron-agent/src/features/chat/pendingAskUser.ts`
- 测试：`electron-agent/src/features/chat/pendingAskUser.test.ts`

未完成指：助手消息里有 `toolCall`，名称是 `ask_user`（忽略大小写），后面没有相同 `toolCallId` 的 `toolResult`。多次未完成时只返回最后一次。参数取 `arguments`，没有则取 `input`。

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { findPendingAskUser } from './pendingAskUser';

const ask = (id: string, question: string) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name: 'ask_user', arguments: { questions: [{ question, options: [{ label: '甲' }, { label: '乙' }] }] } }],
});
const result = (id: string) => ({ role: 'toolResult', toolCallId: id, toolName: 'ask_user', content: [{ type: 'text', text: 'done' }] });

describe('findPendingAskUser', () => {
  it('returns null when the only ask_user has a tool result', () => {
    expect(findPendingAskUser([ask('a', '第一题'), result('a')])).toBeNull();
  });

  it('returns the last unanswered ask_user and ignores an earlier one', () => {
    const pending = findPendingAskUser([ask('a', '旧题'), ask('b', '新题')]);
    expect(pending?.toolCallId).toBe('b');
    expect(pending?.args).toMatchObject({ questions: [{ question: '新题' }] });
  });

  it('returns null when there is no ask_user', () => {
    expect(findPendingAskUser([{ role: 'user', content: 'hi' }])).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/pendingAskUser.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：编写最少实现代码**

```ts
export interface PendingAskUser {
  toolCallId: string;
  args: Record<string, unknown>;
}

export function findPendingAskUser(messages: Array<{ role?: unknown; content?: unknown; toolCallId?: unknown }>): PendingAskUser | null {
  const pending = new Map<string, PendingAskUser>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (!block || block.type !== 'toolCall') continue;
        const name = typeof block.name === 'string' ? block.name.toLowerCase() : '';
        const id = typeof block.id === 'string' ? block.id : '';
        if (name !== 'ask_user' || !id) continue;
        const raw = block.arguments ?? block.input ?? {};
        pending.set(id, { toolCallId: id, args: raw && typeof raw === 'object' ? raw as Record<string, unknown> : {} });
      }
    }
    if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') pending.delete(msg.toolCallId);
  }
  let last: PendingAskUser | null = null;
  for (const item of pending.values()) last = item;
  return last;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/pendingAskUser.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/pendingAskUser.ts electron-agent/src/features/chat/pendingAskUser.test.ts
git commit -m "feat: find the latest unanswered ask_user tool call"
```

---

### 任务 3：重载后画出「等待你选择」

**文件：**
- 修改：`electron-agent/src/stores/agentReducer.ts`（`messagesFromAgent` 循环结束后）
- 修改：`electron-agent/src/stores/agent.ts`（`loadMessages` 里把 `running` 改成 `error` 的那段）
- 测试：`electron-agent/src/stores/agentReducer.test.ts`

`messagesFromAgent` 现有循环不要改配对逻辑。循环结束后，若 `findPendingAskUser` 有结果，且 `out` 里还没有相同 `toolCallId` 的工具行，追加一条 `status: 'running'` 的 `ask_user` 行，`args` 用 pending 的参数。

`loadMessages` 把残留 `running` 标成 `error`，是为了避免死掉的工具永远转圈。这次未完成的 `ask_user` 除外，保持 `running`。其它工具仍标 `error`。

- [ ] **步骤 1：编写失败的测试**

在 `agentReducer.test.ts` 的 `messagesFromAgent` 用例后追加：

```ts
it('messagesFromAgent keeps an unanswered ask_user as a running tool row', () => {
  const msgs = messagesFromAgent([
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { questions: [{ question: '选哪个' }] } }],
    },
  ] as never);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]).toMatchObject({ kind: 'tool', toolCallId: 'q1', toolName: 'ask_user', status: 'running' });
});

it('messagesFromAgent does not keep ask_user after its tool result arrives', () => {
  const msgs = messagesFromAgent([
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { questions: [] } }],
    },
    { role: 'toolResult', toolCallId: 'q1', toolName: 'ask_user', content: [{ type: 'text', text: '[我的选择]\n1. 选哪个：甲' }], isError: false },
  ] as never);
  expect(msgs.filter((m) => m.kind === 'tool' && m.status === 'running')).toHaveLength(0);
  expect(msgs.some((m) => m.kind === 'tool' && m.status === 'done')).toBe(true);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/stores/agentReducer.test.ts`

预期：FAIL，第一条长度为 0。

- [ ] **步骤 3：编写最少实现代码**

`messagesFromAgent` 在 `return out` 之前：

```ts
const pending = findPendingAskUser(msgs);
if (pending && !out.some((m) => m.kind === 'tool' && m.toolCallId === pending.toolCallId)) {
  out.push({
    kind: 'tool',
    id: nextId(),
    toolCallId: pending.toolCallId,
    toolName: 'ask_user',
    args: pending.args,
    result: undefined,
    status: 'running',
  });
}
```

`agent.ts` 的 sanitize 改为：

```ts
const sanitized = processed.map((m) =>
  m.kind === 'tool' && m.status === 'running' && m.toolName.toLowerCase() !== 'ask_user'
    ? { ...m, status: 'error' as const }
    : m,
);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/stores/agentReducer.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/stores/agentReducer.ts electron-agent/src/stores/agentReducer.test.ts electron-agent/src/stores/agent.ts
git commit -m "feat: show a waiting row for an unanswered ask_user"
```

---

### 任务 4：草稿文件

**文件：**
- 创建：`electron-agent/electron/agent/askUserDraft.ts`
- 测试：`electron-agent/electron/agent/askUserDraft.test.ts`

路径是 `<sessionFile>.ask-user-draft.json`。内容是 `{ toolCallId, selected, customTexts, extraText, extraImages }`。`toolCallId` 不一致、JSON 损坏、文件不存在，都返回 `null`。

- [ ] **步骤 1：编写失败的测试**

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { askUserDraftPath, readAskUserDraft, writeAskUserDraft, deleteAskUserDraft } from './askUserDraft';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('askUserDraft', () => {
  it('round-trips a draft and ignores a mismatched tool call id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ask-draft-'));
    dirs.push(dir);
    const sessionFile = path.join(dir, 's.jsonl');
    const draft = { toolCallId: 'q1', selected: { q1: ['o1'] }, customTexts: { q1: '自定义' }, extraText: '补充', extraImages: [{ type: 'image' as const, mimeType: 'image/png', data: 'aaa' }] };
    await writeAskUserDraft(sessionFile, draft);
    expect(askUserDraftPath(sessionFile)).toBe(`${sessionFile}.ask-user-draft.json`);
    expect(await readAskUserDraft(sessionFile, 'q1')).toEqual(draft);
    expect(await readAskUserDraft(sessionFile, 'other')).toBeNull();
    await deleteAskUserDraft(sessionFile);
    expect(await readAskUserDraft(sessionFile, 'q1')).toBeNull();
    await readFile(`${sessionFile}.ask-user-draft.json`).catch((error: NodeJS.ErrnoException) => {
      expect(error.code).toBe('ENOENT');
    });
  });

  it('returns null for corrupt json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ask-draft-'));
    dirs.push(dir);
    const sessionFile = path.join(dir, 's.jsonl');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${sessionFile}.ask-user-draft.json`, '{');
    expect(await readAskUserDraft(sessionFile, 'q1')).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/agent/askUserDraft.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：编写最少实现代码**

```ts
import { readFile, rm, writeFile } from 'node:fs/promises';

export interface AskUserDraft {
  toolCallId: string;
  selected: Record<string, string[]>;
  customTexts: Record<string, string>;
  extraText: string;
  extraImages: Array<{ type: 'image'; mimeType: string; data: string }>;
}

export function askUserDraftPath(sessionFile: string): string {
  return `${sessionFile}.ask-user-draft.json`;
}

export async function readAskUserDraft(sessionFile: string, toolCallId: string): Promise<AskUserDraft | null> {
  try {
    const parsed = JSON.parse(await readFile(askUserDraftPath(sessionFile), 'utf8')) as Partial<AskUserDraft>;
    if (!parsed || parsed.toolCallId !== toolCallId) return null;
    if (!parsed.selected || typeof parsed.selected !== 'object') return null;
    return {
      toolCallId,
      selected: parsed.selected,
      customTexts: parsed.customTexts && typeof parsed.customTexts === 'object' ? parsed.customTexts : {},
      extraText: typeof parsed.extraText === 'string' ? parsed.extraText : '',
      extraImages: Array.isArray(parsed.extraImages) ? parsed.extraImages.filter((img) => img && img.type === 'image' && typeof img.mimeType === 'string' && typeof img.data === 'string') : [],
    };
  } catch {
    return null;
  }
}

export async function writeAskUserDraft(sessionFile: string, draft: AskUserDraft): Promise<void> {
  await writeFile(askUserDraftPath(sessionFile), JSON.stringify(draft));
}

export async function deleteAskUserDraft(sessionFile: string): Promise<void> {
  await rm(askUserDraftPath(sessionFile), { force: true });
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/agent/askUserDraft.test.ts`

预期：PASS。

- [ ] **步骤 5：把读写接到 IPC**

`piRuntimeService` 增加三个方法，按 workspace 取 `handle.session.sessionFile`，空则抛错。命令名：`ask_user_draft_read`（参数 `toolCallId`）、`ask_user_draft_write`（参数 `draft`）、`ask_user_draft_delete`。

`register.ts` 的 `registerPiCommands` 列表加入这三个名字。`src/lib/pi.ts` 的 `pi` 对象增加：

```ts
readAskUserDraft: (workspace: string, toolCallId: string) =>
  invoke<AskUserDraft | null>('ask_user_draft_read', { workspace, toolCallId }),
writeAskUserDraft: (workspace: string, draft: AskUserDraft) =>
  invoke<void>('ask_user_draft_write', { workspace, draft }),
deleteAskUserDraft: (workspace: string) =>
  invoke<void>('ask_user_draft_delete', { workspace }),
```

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agent/askUserDraft.ts electron-agent/electron/agent/askUserDraft.test.ts electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/ipc/register.ts electron-agent/src/lib/pi.ts
git commit -m "feat: store unanswered ask_user drafts beside the session"
```

---

### 任务 5：补写工具结果并继续模型

**文件：**
- 创建：`electron-agent/electron/agent/completeAskUser.ts`
- 测试：`electron-agent/electron/agent/completeAskUser.test.ts`
- 修改：`electron-agent/electron/app/piRuntimeService.ts`、`electron-agent/electron/ipc/register.ts`、`electron-agent/src/lib/pi.ts`

`Agent.continue()` 要求最后一条是 user 或 toolResult。宿主先 `sessionManager.appendMessage`，再把同一条放进 `agent.state.messages`，然后 `await agent.continue()`。不调用 `session.prompt`，不插入用户消息。

已有相同 `toolCallId` 的 `toolResult`：返回 `'duplicate'`，不追加、不 `continue`。`toolCallId` 不是当前未完成的那次：抛错。`isStreaming` 为真：抛错。

取消文案固定为 `用户取消了 ask_user 选择（未作答）。`。发送时 `value` 走已有 `decodeAskUserAnswer`：有文本或图片就作为工具结果内容；两者都空则与取消相同。

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it, vi } from 'vitest';
import { completeAskUser } from './completeAskUser';

function fakeSession(messages: Array<Record<string, unknown>>) {
  const appended: unknown[] = [];
  return {
    appended,
    isStreaming: false,
    messages,
    sessionManager: { appendMessage: (message: unknown) => { appended.push(message); return 'e1'; } },
    agent: {
      state: { messages: [...messages] },
      continue: vi.fn(async () => {}),
    },
  };
}

describe('completeAskUser', () => {
  it('appends a cancel tool result and continues once', async () => {
    const session = fakeSession([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: { questions: [{ question: '选哪个' }] } }] },
    ]);
    await completeAskUser(session, { toolCallId: 'q1', cancelled: true });
    expect(session.appended).toHaveLength(1);
    expect(session.appended[0]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'q1',
      toolName: 'ask_user',
      content: [{ type: 'text', text: '用户取消了 ask_user 选择（未作答）。' }],
    });
    expect(session.agent.state.messages.at(-1)).toEqual(session.appended[0]);
    expect(session.agent.continue).toHaveBeenCalledTimes(1);
  });

  it('does not append twice when the tool result already exists', async () => {
    const session = fakeSession([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'q1', toolName: 'ask_user', content: [{ type: 'text', text: 'done' }] },
    ]);
    await expect(completeAskUser(session, { toolCallId: 'q1', cancelled: true })).resolves.toBe('duplicate');
    expect(session.appended).toHaveLength(0);
    expect(session.agent.continue).not.toHaveBeenCalled();
  });

  it('rejects a tool call that is not the pending ask_user', async () => {
    const session = fakeSession([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'q1', name: 'ask_user', arguments: {} }] },
    ]);
    await expect(completeAskUser(session, { toolCallId: 'other', cancelled: true })).rejects.toThrow(/pending/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/agent/completeAskUser.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：编写最少实现代码**

`completeAskUser` 接收上面测试里的 session 形状，内部用 `findPendingAskUser(session.messages)`。`messages` 与 `agent.state.messages` 在测试里分开；实现以 `session.messages` 判断是否未完成，追加后同步到 `agent.state.messages`。

工具结果对象：

```ts
{
  role: 'toolResult',
  toolCallId,
  toolName: 'ask_user',
  content,
  isError: false,
  timestamp: Date.now(),
}
```

`content`：取消或空答案时为 `[{ type: 'text', text: '用户取消了 ask_user 选择（未作答）。' }]`。有答案时用 `decodeAskUserAnswer`（从 `extensions/agent-mode/questions.ts` 导入）拆成文本块和图片块。

返回 `'ok'` 或 `'duplicate'`。`isStreaming` 时抛 `Error('ask_user completion requires an idle session')`。pending 不匹配时抛 `Error('ask_user tool call is not pending')`。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/agent/completeAskUser.test.ts`

预期：PASS。

- [ ] **步骤 5：接到运行时**

`piRuntimeService.send` 增加 `agent_complete_ask_user`。从当前 workspace 的 session 取 `messages`、`sessionManager`、`agent`、`isStreaming`，调用 `completeAskUser`。成功或 `duplicate` 后 `deleteAskUserDraft(session.sessionFile)`。失败不删草稿。

`register.ts` 列表加入 `agent_complete_ask_user`。`src/lib/pi.ts` 增加：

```ts
completeAskUser: (workspace: string, toolCallId: string, value?: string, cancelled?: boolean) =>
  invoke<'ok' | 'duplicate'>('agent_complete_ask_user', { workspace, toolCallId, value, cancelled }),
```

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agent/completeAskUser.ts electron-agent/electron/agent/completeAskUser.test.ts electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/ipc/register.ts electron-agent/src/lib/pi.ts
git commit -m "feat: finish a restored ask_user by appending its tool result"
```

---

### 任务 6：重启后恢复浮层并填回草稿

**文件：**
- 修改：`electron-agent/src/stores/inlineQuestionStore.ts`
- 修改：`electron-agent/src/stores/agent.ts`（`loadMessages`）
- 测试：`electron-agent/src/stores/inlineQuestionStore.test.ts`

浮层条目增加字段：

```ts
export interface InlineQuestionItem {
  workspace: string;
  id: string;
  data: QSData;
  mode: 'live' | 'restored';
  toolCallId?: string;
  sessionPath?: string;
  draft?: AskUserDraft | null;
}
```

现有 `setRequest` 的调用方补上 `mode: 'live'`。`ExtensionUiHost` 写入时 `mode` 为 `live`。恢复时 `mode` 为 `restored`，`id` 与 `toolCallId` 都用工具调用 id，避免和活着的 UI 请求 id 混用。

`loadMessages` 在写入 sanitized 消息之后：用原始 `msgs` 调 `findPendingAskUser`。没有则 `clear(workspace)`。有则读草稿（`sessionPath` 为空就当没有草稿），用 `normalizeQuestions` 从 `pending.args` 得到题目。`normalizeQuestions` 返回 null 时不恢复。然后 `setRequest`：

```ts
{
  workspace,
  id: pending.toolCallId,
  data,
  mode: 'restored',
  toolCallId: pending.toolCallId,
  sessionPath: sessionPath ?? undefined,
  draft,
}
```

`ToolExecution` 已经在 `status === 'running'` 且 store 有条目时显示「等待你选择」。恢复后两者都成立。

同一会话内容未变而提前 return 的分支也要执行这段恢复，否则重启后缓存命中会跳过浮层。把恢复抽成 `loadMessages` 内部函数，两条路径都调用。

- [ ] **步骤 1：编写失败的测试**

在 `inlineQuestionStore.test.ts` 断言 `mode: 'restored'` 的条目能被 `clear(workspace, id)` 清掉，且 id 不同的 `clear` 不会清掉它。沿用现有 clear 语义。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/stores/inlineQuestionStore.test.ts`

预期：FAIL，直到 `setRequest` 接受新字段。若现有测试因缺 `mode` 失败，给旧夹具补 `mode: 'live'`，不要放宽 clear 规则。

- [ ] **步骤 3：实现恢复**

按上面的类型和 `loadMessages` 调用完成。题目规范化：

```ts
const raw = pending.args as { questions?: RawQuestion[]; allowExtra?: boolean; allowExtraImages?: boolean; extraPlaceholder?: string };
const data = normalizeQuestions(raw.questions ?? [], pending.toolCallId, raw);
```

`readAskUserDraft` 失败时 `draft` 为 `null`，浮层仍打开。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/stores/inlineQuestionStore.test.ts src/features/extensionUi/ExtensionUiHost.test.tsx`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/stores/inlineQuestionStore.ts electron-agent/src/stores/inlineQuestionStore.test.ts electron-agent/src/stores/agent.ts electron-agent/src/features/extensionUi/ExtensionUiHost.tsx
git commit -m "feat: reopen an unanswered ask_user after the session reloads"
```

---

### 任务 7：草稿随选择更新，发送和取消按来源分流

**文件：**
- 修改：`electron-agent/src/features/chat/InlineQuestionCard.tsx`
- 修改：`electron-agent/src/features/chat/input/overlayPrompt.ts`
- 测试：`electron-agent/src/features/chat/InlineQuestionCard.test.tsx`、`electron-agent/src/features/chat/input/overlayPrompt.test.ts`

`InlineQuestionCard` 在 `reqId` 变化时，若 `item.draft` 存在，用草稿初始化 `selected`、`customTexts`、`extraText`、`extraImages`；否则清空。

每次这些状态变化，且 `item.sessionPath` 与 `item.toolCallId` 都在，调用 `pi.writeAskUserDraft`。活着的等待若还没有 `toolCallId`，从当前会话消息用 `findPendingAskUser` 补上再写。没有会话路径就不写。

发送：

- `mode === 'live'`：现有 `extensionUiRespond`，成功后 `deleteAskUserDraft` 并 `clear`。
- `mode === 'restored'`：`pi.completeAskUser(workspace, toolCallId, encodedValue)`。返回 `'ok'` 或 `'duplicate'` 后 `clear`。抛错则 `message.error`，不清浮层、不删草稿。

取消与发送相同，只是 `cancelled: true`，不传答案。

`cancelPendingOverlay` 在 `inline.mode === 'restored'` 时改为 `pi.completeAskUser(workspace, inline.toolCallId, undefined, true)`。失败返回 `'failed'` 且不 `clear`。`mode === 'live'` 仍走 `extensionUiRespond`。成功后删除草稿。

- [ ] **步骤 1：编写失败的测试**

`InlineQuestionCard.test.tsx` 增加：

该文件现有 mock 只有 `extensionUiRespond`。改成同时提供 `completeAskUser` 和 `writeAskUserDraft`：

```tsx
const { respond, completeAskUser, writeAskUserDraft } = vi.hoisted(() => ({
  respond: vi.fn(() => Promise.resolve()),
  completeAskUser: vi.fn(() => Promise.resolve('ok' as const)),
  writeAskUserDraft: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/pi', () => ({ extensionUiRespond: respond, completeAskUser, writeAskUserDraft }));
```

追加用例。草稿预选 `a`，不需要再点选项；确定按钮的 testid 是 `inline-question-continue`：

```tsx
it('fills restored draft and completes the tool call on continue', () => {
  useInlineQuestionStore.getState().setRequest({
    workspace: '/ws',
    id: 'q1',
    mode: 'restored',
    toolCallId: 'q1',
    sessionPath: '/tmp/s.jsonl',
    draft: { toolCallId: 'q1', selected: { q1: ['a'] }, customTexts: {}, extraText: '', extraImages: [] },
    data,
  });
  render(<InlineQuestionCard />);
  fireEvent.click(screen.getByTestId('inline-question-continue'));
  expect(completeAskUser).toHaveBeenCalledWith('/ws', 'q1', '[我的选择]\n1. T：甲', undefined);
  expect(respond).not.toHaveBeenCalled();
});
```

`overlayPrompt.test.ts` 增加一条：`mode: 'restored'` 时 `cancelPendingOverlay` 调用 `completeAskUser(..., true)`，不调用 `extensionUiRespond`。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/InlineQuestionCard.test.tsx src/features/chat/input/overlayPrompt.test.ts`

预期：FAIL。

- [ ] **步骤 3：实现分流与草稿写回**

按本任务开头的规则改两个文件。写草稿失败只忽略，不挡住选择。补写失败必须留住浮层和草稿。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/InlineQuestionCard.test.tsx src/features/chat/input/overlayPrompt.test.ts src/features/chat/input/ComposerPromptOverlay.test.tsx src/features/tools/ToolExecution.test.tsx`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/InlineQuestionCard.tsx electron-agent/src/features/chat/InlineQuestionCard.test.tsx electron-agent/src/features/chat/input/overlayPrompt.ts electron-agent/src/features/chat/input/overlayPrompt.test.ts
git commit -m "feat: keep ask_user selections until the card is sent or cancelled"
```

---

## 自检

规格第 2 节目标 1 至 5 由任务 2、3、5、6、7 覆盖。目标 6 由任务 1 覆盖。非目标里的审批卡和普通 select/confirm/input 没有任务去改。无界面 `QuestionsCard` 不改数据通路；它共用 `OptionRow`，因此超长选项也会有提示。工具调用未写入会话时 `findPendingAskUser` 返回 null，不恢复。
