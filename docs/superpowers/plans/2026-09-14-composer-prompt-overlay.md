# 询问卡改为输入框浮层 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 待答的 `ask_user` / 非审批 `select` / `confirm` / `input` 改到 Composer 锚定浮层；会话里只留占位，选完或取消后才落摘要；发送普通消息等于取消题目。

**架构：** 独立 portal（`ComposerPromptOverlay`）按 `surfaceRef` 量位置，z-index 1050，不跟 slash 失焦生命周期。`ask_user` 工具行占位只在该 workspace 的 `inlineQuestionStore` **有条目**时出现（`status === 'running' && item`），store 清空即消失——不需要额外的抑制标记。选择 / 确认 / 输入的摘要是本机 `ui-prompt-receipt` notice。审批卡仍由 `PromptRequestCard` 占位。

**技术栈：** TypeScript、React、antd-style、@lobehub/ui、zustand、vitest + testing-library。只改 `electron-agent`。

**上游规格：** `docs/superpowers/specs/2026-09-14-composer-prompt-overlay-design.md`（以 §12 审查修订为准）

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- **按编号顺序执行，不要跳序。** 询问卡的渲染权从 `ToolExecution` 交到 `ComposerPromptOverlay` 是一次性切换，放在任务 7 里一次做完：先建浮层，再把 `ToolExecution` 的 running 分支改成占位、删掉 `InlineQuestionCard` import。任务 4 只改 `done` 分支（「已取消」），此时 running 仍渲染 `InlineQuestionCard`，所以中间 commit 不会出现「整卡没人渲染」。
- **不要给 `inlineQuestionStore` 加 `suppressed` / `suppress()`。** 占位条件写成 `status === 'running' && 该 workspace 有条目` 就够：`clear()` 之后占位自然消失，发送取消和点卡上取消都走 `clear()`。加抑制标记是多余状态，且会让「点完取消、工具还没 done」这段时间继续显示呼吸中的「等待你选择」。
- **发送不取消审批卡。** `cancelPendingOverlay` 对 `source === 'permission'` 或 `isApprovalSelect` 的请求返回 `idle`，`send()` 照发。这是现状行为（审批卡顶在输入框上方，发送消息不会动它），保持不变。
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。图标用 `@lobehub/ui` 的 `Icon` + `lucide-react`。
- **不要改** `ExtensionUiHost` 路由（`__askUser` → `inlineQuestionStore`，其余 → `uiPromptStore`）、pi core、`createBoxMenu` 失焦、审批按钮文案、`QuestionsCard`、`extensions/agent-mode/questions.ts`。
- `send()` 的取消插入点必须在 `ChatInput.tsx` 空判**之后**。空回车不得取消待答题。
- portal 容器必须是 `document.getElementById(LOBE_THEME_APP_ID) ?? document.body`。浮层挂在 `surface` **之后**。
- 审批排除：`request.source === 'permission'` **或** `isApprovalSelect(request.options)`。
- 询问卡优先：`inlineQuestionStore` 有值时浮层只渲染询问卡。
- 本地 notice 的 id 用 `local-${crypto.randomUUID()}`，不要用 `nextId()`。
- UI 以 vitest 为准，不要求点 Electron 真窗。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试>
```

涉及类型的任务再加：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit
```

**提交：**

```powershell
git add <本任务文件>
git commit -m @"
feat(chat): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/features/chat/input/overlayPrompt.ts` | 是否进浮层、发送取消、摘要 JSON |
| `electron-agent/src/features/chat/input/overlayPrompt.test.ts` | 上述纯函数 |
| `electron-agent/src/features/chat/PromptPendingRow.tsx` | 「等待你选择」/「已取消」一行 |
| `electron-agent/src/features/chat/PromptPendingRow.test.tsx` | testid + 文案 |
| `electron-agent/src/features/chat/UiPromptReceipt.tsx` | `ui-prompt-receipt` 摘要 |
| `electron-agent/src/features/chat/UiPromptReceipt.test.tsx` | 三种 outcome |
| `electron-agent/src/features/chat/input/OverlayUiPromptCard.tsx` | 非审批 select / confirm / input 卡体 |
| `electron-agent/src/features/chat/input/OverlayUiPromptCard.test.tsx` | 从 PromptRequestCard 迁来的非审批用例 + 摘要 |
| `electron-agent/src/features/chat/input/ComposerPromptOverlay.tsx` | portal 锚定浮层 |
| `electron-agent/src/features/chat/input/ComposerPromptOverlay.test.tsx` | 出现条件、不关、优先询问卡 |
| `electron-agent/src/features/chat/ChatInput.test.tsx` | 空输入不取消；有内容先取消再 send |

修改：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/features/tools/AnsweredQuestionsCard.tsx` | 导出 `parseAnswers` |
| `electron-agent/src/features/tools/ToolExecution.tsx` | `ask_user` 占位 / 已取消 / 已回答 |
| `electron-agent/src/features/tools/ToolExecution.test.tsx` | 新增 ask_user 用例 |
| `electron-agent/src/features/chat/ChatMessageItems.tsx` | 渲染 `ui-prompt-receipt` |
| `electron-agent/src/features/chat/ChatListView.tsx` | footer 三条优先级 |
| `electron-agent/src/features/chat/ChatListView.test.tsx` | footer 不双行 |
| `electron-agent/src/features/chat/input/PromptRequestCard.tsx` | 只留审批 |
| `electron-agent/src/features/chat/input/PromptRequestCard.test.tsx` | 删掉迁走的非审批用例 |
| `electron-agent/src/features/chat/ChatInput.tsx` | `send()` async + 空判后取消 |
| `electron-agent/src/features/chat/input/ChatInputContext.tsx` | `send` 类型改为可返回 Promise |
| `electron-agent/src/features/chat/input/editor/MessageEditor.tsx` | surface 之后挂浮层 |
| `electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx` | mock 浮层 |
| `electron-agent/src/features/chat/InlineQuestionCard.tsx` | 注释改为「浮层内渲染」 |

不改：`ExtensionUiHost.tsx`、`createBoxMenu`、`QuestionsCard.tsx`、`waitingUiPrompt.ts`。

---

### 任务 1：`overlayPrompt` 纯函数

**文件：**
- 创建：`electron-agent/src/features/chat/input/overlayPrompt.ts`
- 测试：`electron-agent/src/features/chat/input/overlayPrompt.test.ts`

- [ ] **步骤 1：写失败测试**

`overlayPrompt.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const { respond, resolvePermission } = vi.hoisted(() => ({
  respond: vi.fn(() => Promise.resolve()),
  resolvePermission: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../lib/pi', () => ({
  extensionUiRespond: respond,
  pi: { resolvePermission },
}));

import { useInlineQuestionStore } from '../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../stores/uiPromptStore';
import {
  appendUiPromptReceipt,
  cancelPendingOverlay,
  parseUiPromptReceipt,
  shouldRenderUiPromptInOverlay,
} from './overlayPrompt';

afterEach(() => {
  respond.mockClear();
  resolvePermission.mockClear();
  useInlineQuestionStore.setState({ byWorkspace: {} });
  useUiPromptStore.setState({ byWorkspace: {} });
});

describe('shouldRenderUiPromptInOverlay', () => {
  it('excludes permission and approval selects', () => {
    expect(shouldRenderUiPromptInOverlay({ id: '1', method: 'select', source: 'permission', options: ['允许', '拒绝'] })).toBe(false);
    expect(shouldRenderUiPromptInOverlay({ id: '2', method: 'select', options: ['允许', '拒绝'] })).toBe(false);
    expect(shouldRenderUiPromptInOverlay({ id: '3', method: 'select', options: ['红', '蓝'] })).toBe(true);
    expect(shouldRenderUiPromptInOverlay({ id: '4', method: 'confirm', title: '删？' })).toBe(true);
    expect(shouldRenderUiPromptInOverlay({ id: '5', method: 'input', title: '名' })).toBe(true);
  });
});

describe('parseUiPromptReceipt', () => {
  it('parses answered and cancelled payloads', () => {
    expect(parseUiPromptReceipt(JSON.stringify({ outcome: 'answered', title: '选', value: '红' }))).toEqual({
      outcome: 'answered',
      title: '选',
      value: '红',
    });
    expect(parseUiPromptReceipt(JSON.stringify({ outcome: 'cancelled', title: '选' }))).toEqual({
      outcome: 'cancelled',
      title: '选',
    });
    expect(parseUiPromptReceipt('not-json')).toBeNull();
  });
});

describe('appendUiPromptReceipt', () => {
  it('appends a local notice with local- id', () => {
    const messages: Array<{ kind: string; id: string; customType?: string; content?: string }> = [];
    const setState = (fn: (s: { messages: typeof messages }) => { messages: typeof messages }) => {
      const next = fn({ messages });
      messages.splice(0, messages.length, ...next.messages);
    };
    appendUiPromptReceipt(setState, { outcome: 'confirmed', title: '信任', value: '确定' });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe('notice');
    expect(messages[0]?.customType).toBe('ui-prompt-receipt');
    expect(messages[0]?.id.startsWith('local-')).toBe(true);
    expect(JSON.parse(messages[0]!.content!)).toEqual({ outcome: 'confirmed', title: '信任', value: '确定' });
  });
});

describe('cancelPendingOverlay', () => {
  it('returns idle when nothing pending', async () => {
    expect(await cancelPendingOverlay('/ws')).toBe('idle');
    expect(respond).not.toHaveBeenCalled();
  });

  it('cancels ask_user and clears the store', async () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: { kind: 'questions', id: 'q1', questions: [] },
    });
    expect(await cancelPendingOverlay('/ws')).toBe('cancelled');
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'u1', cancelled: true });
    expect(useInlineQuestionStore.getState().byWorkspace['/ws']).toBeUndefined();
  });

  it('cancels overlay select and ignores approval', async () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'a1', method: 'select', options: ['允许', '拒绝'] },
    });
    expect(await cancelPendingOverlay('/ws')).toBe('idle');

    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 's1', method: 'select', title: '色', options: ['红', '蓝'] },
    });
    expect(await cancelPendingOverlay('/ws')).toBe('cancelled');
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 's1', cancelled: true });
  });

  it('cancels confirm with confirmed: false', async () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'c1', method: 'confirm', title: '删？' },
    });
    expect(await cancelPendingOverlay('/ws')).toBe('cancelled');
    expect(respond).toHaveBeenCalledWith('/ws', { type: 'extension_ui_response', id: 'c1', confirmed: false });
  });

  it('returns failed and keeps the store when respond rejects', async () => {
    respond.mockRejectedValueOnce(new Error('down'));
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 's2', method: 'input', title: '名' },
    });
    expect(await cancelPendingOverlay('/ws')).toBe('failed');
    expect(useUiPromptStore.getState().byWorkspace['/ws']?.request.id).toBe('s2');
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/overlayPrompt.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：最少实现**

`overlayPrompt.ts`：

```ts
import type { ExtensionUiRequest } from '../../../lib/pi';
import { extensionUiRespond } from '../../../lib/pi';
import { isApprovalSelect } from './PromptRequestCard';
import { useInlineQuestionStore } from '../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../stores/uiPromptStore';
import type { ChatMessage } from '../../../stores/agentReducer';

export function shouldRenderUiPromptInOverlay(request: ExtensionUiRequest): boolean {
  if (request.source === 'permission') return false;
  if (request.method === 'confirm' || request.method === 'input') return true;
  if (request.method === 'select') return !isApprovalSelect(request.options);
  return false;
}

export type OverlayCancelResult = 'idle' | 'cancelled' | 'failed';

export async function cancelPendingOverlay(workspace: string): Promise<OverlayCancelResult> {
  const inline = useInlineQuestionStore.getState().byWorkspace[workspace];
  if (inline) {
    try {
      await extensionUiRespond(workspace, { type: 'extension_ui_response', id: inline.id, cancelled: true });
      useInlineQuestionStore.getState().clear(workspace, inline.id);
      return 'cancelled';
    } catch {
      return 'failed';
    }
  }

  const ui = useUiPromptStore.getState().byWorkspace[workspace];
  if (!ui || !shouldRenderUiPromptInOverlay(ui.request)) return 'idle';
  try {
    if (ui.request.method === 'confirm') {
      await extensionUiRespond(workspace, { type: 'extension_ui_response', id: ui.request.id, confirmed: false });
    } else {
      await extensionUiRespond(workspace, { type: 'extension_ui_response', id: ui.request.id, cancelled: true });
    }
    useUiPromptStore.getState().clear(workspace, ui.request.id);
    return 'cancelled';
  } catch {
    return 'failed';
  }
}

export interface UiPromptReceipt {
  outcome: 'answered' | 'confirmed' | 'cancelled';
  title: string;
  value?: string;
}

export function parseUiPromptReceipt(content: string): UiPromptReceipt | null {
  try {
    const parsed = JSON.parse(content) as Partial<UiPromptReceipt>;
    if (parsed.outcome === 'answered' || parsed.outcome === 'confirmed') {
      if (typeof parsed.title !== 'string' || typeof parsed.value !== 'string') return null;
      return { outcome: parsed.outcome, title: parsed.title, value: parsed.value };
    }
    if (parsed.outcome === 'cancelled' && typeof parsed.title === 'string') {
      return { outcome: 'cancelled', title: parsed.title };
    }
    return null;
  } catch {
    return null;
  }
}

export function appendUiPromptReceipt(
  setState: (updater: (s: { messages: ChatMessage[] }) => { messages: ChatMessage[] }) => void,
  receipt: UiPromptReceipt,
): void {
  const content = JSON.stringify(receipt);
  setState((s) => ({
    messages: [
      ...s.messages,
      { kind: 'notice', id: `local-${crypto.randomUUID()}`, customType: 'ui-prompt-receipt', content },
    ],
  }));
}
```

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/overlayPrompt.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/input/overlayPrompt.ts electron-agent/src/features/chat/input/overlayPrompt.test.ts
git commit -m @"
feat(chat): add overlay prompt helpers

"@
```

---

### 任务 2：`PromptPendingRow`

**文件：**
- 创建：`electron-agent/src/features/chat/PromptPendingRow.tsx`
- 测试：`electron-agent/src/features/chat/PromptPendingRow.test.tsx`

- [ ] **步骤 1：写失败测试**

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptPendingRow } from './PromptPendingRow';

afterEach(cleanup);

describe('PromptPendingRow', () => {
  it('renders the waiting label with the given test id', () => {
    render(<PromptPendingRow data-testid="ask-user-pending" label="等待你选择" live />);
    expect(screen.getByTestId('ask-user-pending')).toBeTruthy();
    expect(screen.getByText('等待你选择')).toBeTruthy();
  });

  it('renders a static cancelled row', () => {
    render(<PromptPendingRow data-testid="ask-user-cancelled" label="已取消" />);
    expect(screen.getByTestId('ask-user-cancelled')).toBeTruthy();
    expect(screen.getByText('已取消')).toBeTruthy();
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/PromptPendingRow.test.tsx
```

预期：FAIL。

- [ ] **步骤 3：最少实现**

`live` 为 true 时复用 `PreparingIndicator`（呼吸点 + 闪字），外层包 `data-testid`。`live` 默认 false：一行 14px 次要色文字，视觉跟 `NoticePill` / `MutedLine` 同级，不要呼吸动画。

```tsx
import { memo } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { PreparingIndicator } from './PreparingIndicator';

const styles = createStaticStyles(({ css }) => ({
  static: css`
    padding-block: 8px;
    font-size: 14px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

export const PromptPendingRow = memo(function PromptPendingRow({
  label,
  live = false,
  'data-testid': testId,
}: {
  label: string;
  live?: boolean;
  'data-testid': string;
}) {
  if (live) {
    return (
      <div data-testid={testId}>
        <PreparingIndicator label={label} />
      </div>
    );
  }
  return (
    <div className={styles.static} data-testid={testId}>
      {label}
    </div>
  );
});
```

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/PromptPendingRow.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/PromptPendingRow.tsx electron-agent/src/features/chat/PromptPendingRow.test.tsx
git commit -m @"
feat(chat): add prompt pending row

"@
```

---

### 任务 3：`UiPromptReceipt` + 消息分发

**文件：**
- 创建：`electron-agent/src/features/chat/UiPromptReceipt.tsx`
- 测试：`electron-agent/src/features/chat/UiPromptReceipt.test.tsx`
- 修改：`electron-agent/src/features/chat/ChatMessageItems.tsx`

- [ ] **步骤 1：写失败测试**

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { UiPromptReceipt } from './UiPromptReceipt';

afterEach(cleanup);

describe('UiPromptReceipt', () => {
  it('renders answered / confirmed / cancelled', () => {
    const { rerender } = render(
      <UiPromptReceipt content={JSON.stringify({ outcome: 'answered', title: '色', value: '红' })} />,
    );
    expect(screen.getByTestId('ui-prompt-receipt')).toBeTruthy();
    expect(screen.getByText('已回答')).toBeTruthy();
    expect(screen.getByText('红')).toBeTruthy();

    rerender(<UiPromptReceipt content={JSON.stringify({ outcome: 'confirmed', title: '信任', value: '确定' })} />);
    expect(screen.getByText('已确认')).toBeTruthy();

    rerender(<UiPromptReceipt content={JSON.stringify({ outcome: 'cancelled', title: '色' })} />);
    expect(screen.getByText('已取消')).toBeTruthy();
  });

  it('renders nothing for garbage', () => {
    const { container } = render(<UiPromptReceipt content="nope" />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/UiPromptReceipt.test.tsx
```

预期：FAIL。

- [ ] **步骤 3：实现组件并挂到 `ChatMessageItems`**

`UiPromptReceipt` 用 `MutedLine`（`features/chat/conv/MutedLine.tsx`，与 `NoticePill` 同级）：`answered` →「已回答」，`confirmed` →「已确认」，`cancelled` →「已取消」。解析走 `parseUiPromptReceipt`，解析不出（`null`）时整个组件返回 `null`。

`MutedLine` 只有 `icon / text / count / open / onToggle / data-testid`，**没有正文槽**（它渲染成一个 `<button>`）。所以 `value` 只能拼进 `text`，而且必须是两个独立文本节点——拼成 `已回答 · 红` 一个字符串的话，下面用例里的 `getByText('已回答')` 匹配不到：

```tsx
<MutedLine
  data-testid="ui-prompt-receipt"
  text={
    <>
      {heading}
      {value ? <span> · {value}</span> : null}
    </>
  }
/>
```

不要传 `onToggle`（摘要不可折叠），传了会多渲染一个 chevron。

`ChatMessageItems.tsx` 的 `notice` 分支，在 `subagent-settled` 之后、`NoticePill` 之前插入：

```tsx
if (msg.customType === 'ui-prompt-receipt') return <UiPromptReceipt content={msg.content} />;
```

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/UiPromptReceipt.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/UiPromptReceipt.tsx electron-agent/src/features/chat/UiPromptReceipt.test.tsx electron-agent/src/features/chat/ChatMessageItems.tsx
git commit -m @"
feat(chat): render ui-prompt-receipt notices

"@
```

---

### 任务 4：`ask_user` 工具行「已取消」

**文件：**
- 修改：`electron-agent/src/features/tools/AnsweredQuestionsCard.tsx`（导出 `parseAnswers`）
- 修改：`electron-agent/src/features/tools/ToolExecution.tsx`
- 测试：`electron-agent/src/features/tools/ToolExecution.test.tsx`

- [ ] **步骤 1：写失败测试**

本任务**只动 `done` 分支**。`running` 分支继续渲染 `<InlineQuestionCard />`，占位留给任务 7（浮层落地后再切）——否则本任务一提交，就没有任何地方渲染询问卡了。

在 `ToolExecution.test.tsx` 末尾加一组（文件已有 ThemeProvider `wrap`）：

```tsx
describe('ToolExecution ask_user', () => {
  it('shows cancelled when done with no answers', () => {
    wrap(
      <ToolExecution
        toolName="ask_user"
        args={{ questions: [{ question: 'T', options: ['甲'] }] }}
        result={{ content: [{ type: 'text', text: '用户取消了选择' }] }}
        status="done"
      />,
    );
    expect(screen.getByTestId('ask-user-cancelled')).toBeTruthy();
    expect(screen.queryByTestId('answered-questions-card')).toBeNull();
  });

  it('shows answered card when done with choices', () => {
    wrap(
      <ToolExecution
        toolName="ask_user"
        args={{ questions: [{ question: 'T', options: ['甲', '乙'] }] }}
        result={{ content: [{ type: 'text', text: '[我的选择]\n1. T：乙' }] }}
        status="done"
      />,
    );
    expect(screen.getByTestId('answered-questions-card')).toBeTruthy();
  });
});
```

`afterEach(cleanup)` 已存在，不要重复 `cleanup`。`args.questions[].question` 是 `extractQData`（`AnsweredQuestionsCard.tsx:76-89`）认的字段名，别写成 `title`。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/tools/ToolExecution.test.tsx
```

预期：FAIL，取消后仍渲染 `answered-questions-card`。

- [ ] **步骤 3：最少实现**

1. `AnsweredQuestionsCard.tsx`：把 `parseAnswers` 改成 `export function parseAnswers`。
2. `ToolExecution.tsx` 的 `ask_user` 分支改成：

```tsx
if (bareName === 'ask_user') {
  if (status === 'done') {
    if (parseAnswers(result).length === 0) {
      return <PromptPendingRow data-testid="ask-user-cancelled" label="已取消" />;
    }
    return <AnsweredQuestionsCard args={args} result={result} />;
  }
  return <InlineQuestionCard />;
}
```

判定只能用 `parseAnswers(result).length === 0`，**不能**用 `AnsweredQuestionsCard` 内部的 `count`。`count = Math.max(qdata.length, answers.length)`，取消时 `args.questions` 仍在 → `qdata.length ≥ 1` → `count ≥ 1` → 现在的真实行为是渲染出「有题目、答案为空」的卡，不是整行空白。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/tools/ToolExecution.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/tools/AnsweredQuestionsCard.tsx electron-agent/src/features/tools/ToolExecution.tsx electron-agent/src/features/tools/ToolExecution.test.tsx
git commit -m @"
feat(chat): show ask_user stub instead of inline card

"@
```

---

### 任务 5：`ChatListView` footer 优先级

**文件：**
- 修改：`electron-agent/src/features/chat/ChatListView.tsx`
- 测试：`electron-agent/src/features/chat/ChatListView.test.tsx`

- [ ] **步骤 1：写失败测试**

`ChatListView.test.tsx` 已 mock `AgentStoreContext`，workspace 是 `/test`。追加：

```tsx
import { useUiPromptStore } from '../../stores/uiPromptStore';

// afterEach 里加：
useUiPromptStore.setState({ byWorkspace: {} });

  it('shows 等待你选择 when a non-approval ui prompt is pending and waitingUiPrompt is empty', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/test',
      request: { id: 's1', method: 'select', title: '色', options: ['红', '蓝'] },
    });
    setMessages([{ kind: 'user', id: 'u1', text: 'hi' } as ChatMessage]);
    render(
      <ThemeProvider themeMode="dark">
        <ChatListView />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('ui-prompt-pending')).toBeTruthy();
    expect(screen.getByText('等待你选择')).toBeTruthy();
  });

  it('does not add 等待你选择 when waitingUiPrompt already occupies the footer', () => {
    mockState.waitingUiPrompt = { kind: 'select', title: '请求批准' };
    useUiPromptStore.getState().setRequest({
      workspace: '/test',
      request: { id: 's1', method: 'select', title: '色', options: ['红', '蓝'] },
    });
    setMessages([{ kind: 'user', id: 'u1', text: 'hi' } as ChatMessage]);
    render(
      <ThemeProvider themeMode="dark">
        <ChatListView />
      </ThemeProvider>,
    );
    expect(screen.getByText('等待批准…')).toBeTruthy();
    expect(screen.queryByTestId('ui-prompt-pending')).toBeNull();
    expect(screen.queryByText('等待你选择')).toBeNull();
  });

  it('does not show overlay pending for approval selects', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/test',
      request: { id: 'a1', method: 'select', options: ['允许', '拒绝'] },
    });
    setMessages([{ kind: 'user', id: 'u1', text: 'hi' } as ChatMessage]);
    render(
      <ThemeProvider themeMode="dark">
        <ChatListView />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('ui-prompt-pending')).toBeNull();
  });
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/ChatListView.test.tsx
```

预期：FAIL，没有 `ui-prompt-pending`。

- [ ] **步骤 3：改 `ChatListView`**

```tsx
const { workspace } = useAgentStoreContext();
const uiPrompt = useUiPromptStore((s) => s.byWorkspace[workspace]);
const overlayPending = Boolean(uiPrompt && shouldRenderUiPromptInOverlay(uiPrompt.request));

const last = grouped[grouped.length - 1];
const lastIsSteer = last?.kind === 'user' && last.steering === true;
const showDefaultPreparing =
  (isStreaming || Boolean(awaitingResponse)) &&
  !lastIsSteer &&
  (!last || (last.kind !== 'turn' && last.kind !== 'tool'));

const footer = waitingLabel ? (
  <PreparingIndicator label={waitingLabel} />
) : overlayPending ? (
  <PromptPendingRow data-testid="ui-prompt-pending" label="等待你选择" live />
) : showDefaultPreparing ? (
  <PreparingIndicator />
) : undefined;
```

`showPreparing` 删掉，改用上面的 `footer`。补 `useAgentStoreContext`、`useUiPromptStore`、`shouldRenderUiPromptInOverlay`、`PromptPendingRow` 的 import。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/ChatListView.test.tsx
```

预期：PASS（含原有「等待批准」用例）。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/ChatListView.tsx electron-agent/src/features/chat/ChatListView.test.tsx
git commit -m @"
feat(chat): reuse footer slot for overlay pending

"@
```

---

### 任务 6：抽出 `OverlayUiPromptCard`

**文件：**
- 创建：`electron-agent/src/features/chat/input/OverlayUiPromptCard.tsx`
- 测试：`electron-agent/src/features/chat/input/OverlayUiPromptCard.test.tsx`
- 修改：`electron-agent/src/features/chat/input/PromptRequestCard.tsx`
- 修改：`electron-agent/src/features/chat/input/PromptRequestCard.test.tsx`

把 `PromptRequestCard` 里非审批的 select / confirm / input UI **原样搬**到新卡。本任务结束时：`PromptRequestCard` 只渲染审批（`source === 'permission'` 或 `isApprovalSelect`），其它请求返回 `null`。非审批用例迁到新测试文件，并加上摘要 notice。

- [ ] **步骤 1：写失败测试**

`OverlayUiPromptCard.test.tsx` 从 `PromptRequestCard.test.tsx` 拷贝「keeps generic selects」「responds to confirm」「responds to input」「dismisses a select」四例，把渲染目标改成 `<OverlayUiPromptCard />`。再加：

```tsx
it('appends a receipt notice on confirm and on cancel', () => {
  const store = {
    messages: [] as Array<{ kind: string; customType?: string; content?: string }>,
    setState(fn: (s: { messages: typeof store.messages }) => { messages: typeof store.messages }) {
      const next = fn({ messages: store.messages });
      store.messages = next.messages;
    },
  };
  // mock useAgentStore 返回 { useStore: store } —— 按 AgentStoreContext 现有 mock 方式写
});
```

若 hook mock 过重，改测 `appendUiPromptReceipt` 已被调用：把 `overlayPrompt.appendUiPromptReceipt` 做成可 spy 的具名导出，用例里 `vi.spyOn`。更简单的做法：mock `AgentStoreContext.useAgentStore`：

```tsx
const messages: unknown[] = [];
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useAgentStore: () => ({
    useStore: {
      setState: (fn: (s: { messages: unknown[] }) => { messages: unknown[] }) => {
        const next = fn({ messages });
        messages.splice(0, messages.length, ...(next.messages as unknown[]));
      },
    },
  }),
}));
```

确定后：`fireEvent.click(confirm)` → `messages[0].customType === 'ui-prompt-receipt'` 且 `outcome === 'confirmed'`。点 skip → `outcome === 'cancelled'`。发送取消路径**不要**在本卡调用 `appendUiPromptReceipt`。

同时改 `PromptRequestCard.test.tsx`：删掉那四个非审批用例，改成：

```tsx
it('ignores generic selects now handled by the overlay', () => {
  useUiPromptStore.getState().setRequest({
    workspace: '/ws',
    request: { id: 'u1c', method: 'select', title: '选一个', options: ['红', '蓝'] },
  });
  const { container } = render(<PromptRequestCard />);
  expect(container.firstChild).toBeNull();
});
```

审批两例保持不变。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/OverlayUiPromptCard.test.tsx src/features/chat/input/PromptRequestCard.test.tsx
```

预期：第一个文件 FAIL（模块无）；PromptRequestCard 的「ignores generic selects」FAIL（现在仍渲染 `prompt-request-select`）。

- [ ] **步骤 3：搬家并瘦身**

1. 新建 `OverlayUiPromptCard.tsx`：从 `PromptRequestCard` 剪走 select / confirm / input 的 JSX 与本地 state。读 `useUiPromptStore`；若没有条目或 `!shouldRenderUiPromptInOverlay(request)` 则 `return null`。`respond` 成功后（回传 + `clear`）调用 `appendUiPromptReceipt`。

`useStore` 必须在**组件顶层**取，不能在 `respond` 回调里调 `useAgentStore()` —— 那是 hook，写在回调里违反 hook 规则：

```tsx
const { useStore } = useAgentStore();

// ... respond 内：
appendUiPromptReceipt(useStore.setState, receipt);
```

receipt 规则：

- select 确定：`{ outcome: 'answered', title: request.title ?? '请选择', value: chosenLabel }`
- confirm 确定：`{ outcome: 'confirmed', title: request.title ?? '确认', value: '确定' }`
- input 提交：`{ outcome: 'answered', title: request.title ?? '请输入', value: text }`
- 取消 / X：`{ outcome: 'cancelled', title: heading }`

回传通道与现在一致：`source === 'permission'` 不会进这张卡。testid 保持 `prompt-request-select` / `prompt-request-card` / `prompt-request-dismiss`，避免无谓改测试。

2. `PromptRequestCard` 只留审批分支。入口：

```tsx
if (!item) return null;
if (item.request.source !== 'permission' && !isApprovalSelect(item.request.options)) return null;
```

然后是现在的审批 JSX。`respond` 审批路径保持原样（含 `resolvePermission`）。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/OverlayUiPromptCard.test.tsx src/features/chat/input/PromptRequestCard.test.tsx src/features/chat/input/overlayPrompt.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/input/OverlayUiPromptCard.tsx electron-agent/src/features/chat/input/OverlayUiPromptCard.test.tsx electron-agent/src/features/chat/input/PromptRequestCard.tsx electron-agent/src/features/chat/input/PromptRequestCard.test.tsx
git commit -m @"
feat(chat): move non-approval prompts out of PromptRequestCard

"@
```

---

### 任务 7：`ComposerPromptOverlay` + 工具行占位

**文件：**
- 创建：`electron-agent/src/features/chat/input/ComposerPromptOverlay.tsx`
- 测试：`electron-agent/src/features/chat/input/ComposerPromptOverlay.test.tsx`
- 修改：`electron-agent/src/features/chat/InlineQuestionCard.tsx`（只改文件头注释）
- 修改：`electron-agent/src/features/tools/ToolExecution.tsx`（running 分支改占位，删 `InlineQuestionCard` import）
- 修改：`electron-agent/src/features/tools/ToolExecution.test.tsx`（补占位用例）

- [ ] **步骤 1：写失败测试**

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';

vi.mock('../../../lib/pi', () => ({
  extensionUiRespond: vi.fn(() => Promise.resolve()),
  pi: { resolvePermission: vi.fn() },
}));
vi.mock('../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useAgentStore: () => ({
    useStore: { setState: () => undefined },
  }),
}));

import { ComposerPromptOverlay } from './ComposerPromptOverlay';
import { useInlineQuestionStore } from '../../../stores/inlineQuestionStore';
import { useUiPromptStore } from '../../../stores/uiPromptStore';

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

afterEach(() => {
  cleanup();
  useInlineQuestionStore.setState({ byWorkspace: {} });
  useUiPromptStore.setState({ byWorkspace: {} });
});

function renderOverlay() {
  const anchorRef = createRef<HTMLDivElement>();
  const view = render(
    <>
      <div
        ref={anchorRef}
        data-testid="composer-surface"
        style={{ width: 400, height: 80 }}
      />
      <ComposerPromptOverlay anchorRef={anchorRef} />
    </>,
  );
  return view;
}

describe('ComposerPromptOverlay', () => {
  // 用 spyOn + mockRestore，不要直接改 prototype：直接改会永久污染本文件后续用例。
  // 不要用 vi.restoreAllMocks()，它会把上面 vi.mock 里的 vi.fn() 一并处理掉。
  let rectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 400, left: 20, width: 480, height: 80, bottom: 480, right: 500, x: 20, y: 400, toJSON() {},
    } as DOMRect);
  });
  afterEach(() => {
    rectSpy?.mockRestore();
  });

  it('renders ask_user into the overlay', () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: {
        kind: 'questions',
        id: 'q1',
        questions: [{ id: 'q1', title: 'T', options: [{ id: 'a', label: '甲' }] }],
      },
    });
    renderOverlay();
    expect(screen.getByTestId('composer-prompt-overlay')).toBeTruthy();
    expect(screen.getByTestId('inline-question')).toBeTruthy();
  });

  it('renders overlay select and skips approval', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 's1', method: 'select', title: '色', options: ['红', '蓝'] },
    });
    renderOverlay();
    expect(screen.getByTestId('composer-prompt-overlay')).toBeTruthy();
    expect(screen.getByTestId('prompt-request-select')).toBeTruthy();

    cleanup();
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 'a1', method: 'select', options: ['允许', '拒绝'] },
    });
    renderOverlay();
    expect(screen.queryByTestId('composer-prompt-overlay')).toBeNull();
  });

  it('prefers ask_user when both stores have values', () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: {
        kind: 'questions',
        id: 'q1',
        questions: [{ id: 'q1', title: 'T', options: [{ id: 'a', label: '甲' }] }],
      },
    });
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 's1', method: 'select', title: '色', options: ['红', '蓝'] },
    });
    renderOverlay();
    expect(screen.getByTestId('inline-question')).toBeTruthy();
    expect(screen.queryByTestId('prompt-request-select')).toBeNull();
  });

  it('does not close on Escape or click outside', () => {
    useUiPromptStore.getState().setRequest({
      workspace: '/ws',
      request: { id: 's1', method: 'select', title: '色', options: ['红', '蓝'] },
    });
    renderOverlay();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(document.body);
    expect(screen.getByTestId('composer-prompt-overlay')).toBeTruthy();
    expect(useUiPromptStore.getState().byWorkspace['/ws']?.request.id).toBe('s1');
  });

  it('renders nothing when no request is pending', () => {
    renderOverlay();
    expect(screen.queryByTestId('composer-prompt-overlay')).toBeNull();
  });
});
```

再在 `ToolExecution.test.tsx` 的 `ask_user` describe 里补两条（需要 `vi.mock('../../stores/AgentStoreContext', () => ({ useAgentStoreContext: () => ({ workspace: '/ws' }) }))` 放在文件顶部、import 之前）：

```tsx
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';

describe('ToolExecution ask_user stub', () => {
  afterEach(() => {
    useInlineQuestionStore.setState({ byWorkspace: {} });
  });

  it('shows the pending stub only while a request is in the store', () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: { kind: 'questions', id: 'q1', questions: [] },
    });
    wrap(<ToolExecution toolName="ask_user" args={{}} result={{}} status="running" />);
    expect(screen.getByTestId('ask-user-pending')).toBeTruthy();
    expect(screen.queryByTestId('inline-question')).toBeNull();
  });

  it('hides the stub once the store is cleared', () => {
    wrap(<ToolExecution toolName="ask_user" args={{}} result={{}} status="running" />);
    expect(screen.queryByTestId('ask-user-pending')).toBeNull();
  });

  it('renders nothing on error', () => {
    const { container } = wrap(<ToolExecution toolName="ask_user" args={{}} result={{}} status="error" />);
    expect(screen.queryByTestId('ask-user-pending')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/ComposerPromptOverlay.test.tsx
```

预期：FAIL。

- [ ] **步骤 3：实现浮层**

对照 `SlashBoxMenu.tsx`：

- props：`anchorRef: RefObject<HTMLElement | null>`
- `createPortal(..., document.getElementById(LOBE_THEME_APP_ID) ?? document.body)`
- `position: fixed; z-index: 1050; left / width / bottom`，`MENU_GAP = 8`，`bottom = window.innerHeight - rect.top + 8`
- measure：`ResizeObserver` + `window resize` + `scroll` capture，回调 `requestAnimationFrame`
- 首次 `anchor` 为空则跳过
- 根节点 `data-testid="composer-prompt-overlay"`，`max-height: min(60vh, 480px); overflow-y: auto`
- **不要**挂 `onBlur`、`Escape`、点外面关闭
- 询问卡优先：有 `inlineQuestionStore[workspace]` → `<InlineQuestionCard />`；否则有 overlay ui prompt → `<OverlayUiPromptCard />`；否则 `null`（此时不要 portal）
- 没有条目时不要 portal 空壳

`InlineQuestionCard.tsx` 文件头注释改成：阻塞式 ask_user 富卡，由 `ComposerPromptOverlay` 渲染。

浮层落地后，把 `ToolExecution.tsx` 的 `ask_user` 分支 running 那段换成占位，并删掉 `InlineQuestionCard` 的 import：

```tsx
if (bareName === 'ask_user') {
  if (status === 'done') {
    if (parseAnswers(result).length === 0) {
      return <PromptPendingRow data-testid="ask-user-cancelled" label="已取消" />;
    }
    return <AnsweredQuestionsCard args={args} result={result} />;
  }
  if (status === 'running' && hasPendingQuestion) {
    return <PromptPendingRow data-testid="ask-user-pending" label="等待你选择" live />;
  }
  return null;
}
```

`hasPendingQuestion` 在 `ToolExecutionInner` **函数开头**取，不能写在 `if` 里（hook 规则）：

```tsx
const { workspace } = useAgentStoreContext();
const hasPendingQuestion = useInlineQuestionStore((s) => Boolean(s.byWorkspace[workspace]));
```

占位条件带 `hasPendingQuestion` 是必需的：`clear()` 之后工具 status 仍是 `running`，若只看 status，用户点完取消 / 确定后占位会一直挂在会话里（还带着呼吸动画），直到 sidecar 回报 `done`。带了这个条件，四种收尾（确定 / 取消 / 发送取消 / 回退无 UI）都会立刻收掉占位。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/ComposerPromptOverlay.test.tsx src/features/chat/InlineQuestionCard.test.tsx src/features/tools/ToolExecution.test.tsx
```

预期：PASS。若 `status="error"` 用例因通用工具行仍输出了标题，收紧断言为「没有 `ask-user-pending`」，不要强求 `textContent === ''`。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/input/ComposerPromptOverlay.tsx electron-agent/src/features/chat/input/ComposerPromptOverlay.test.tsx electron-agent/src/features/chat/InlineQuestionCard.tsx electron-agent/src/features/tools/ToolExecution.tsx electron-agent/src/features/tools/ToolExecution.test.tsx
git commit -m @"
feat(chat): add composer-anchored prompt overlay

"@
```

---

### 任务 8：`send()` 发送即取消 + 挂到输入框

**文件：**
- 修改：`electron-agent/src/features/chat/ChatInput.tsx`
- 修改：`electron-agent/src/features/chat/input/ChatInputContext.tsx`
- 测试：`electron-agent/src/features/chat/ChatInput.test.tsx`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx`

- [ ] **步骤 1：写失败测试**

`ChatInput.test.tsx`：

```tsx
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { onSend, cancelPendingOverlay, getDocument, cleanDocument, toastError } = vi.hoisted(() => ({
  onSend: vi.fn(() => Promise.resolve()),
  cancelPendingOverlay: vi.fn(() => Promise.resolve('cancelled' as const)),
  getDocument: vi.fn(() => 'hello'),
  cleanDocument: vi.fn(),
  toastError: vi.fn(),
}));

// App.useApp() 在 <App> 外会退化成静态实例并告警，这里直接给掉，顺带能断言失败 toast。
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return { ...actual, App: { ...actual.App, useApp: () => ({ message: { error: toastError } }) } };
});
vi.mock('./input/overlayPrompt', () => ({ cancelPendingOverlay }));
vi.mock('@lobehub/editor/react', () => ({
  useEditor: () => ({
    getDocument,
    cleanDocument,
    focus: vi.fn(),
    setDocument: vi.fn(),
  }),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStore: () => ({
    useStore: (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ isStreaming: false, messages: [], steering: false, followUp: false }),
  }),
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../store', () => ({ useSessionStore: (sel: (s: { activeSessionPath: null }) => unknown) => sel({ activeSessionPath: null }) }));
vi.mock('../../stores/chatDraftStore', () => ({
  useChatDraftStore: { getState: () => ({ setDraft: vi.fn(), clearDraft: vi.fn(), getDraft: () => '' }) },
}));
vi.mock('./input/editor/MessageEditor', () => ({
  MessageEditor: () => {
    const { useChatInput } = require('./input/ChatInputContext');
    const { send } = useChatInput();
    return <button type="button" data-testid="do-send" onClick={() => void send()} />;
  },
}));

import { ChatInput } from './ChatInput';
import { fireEvent, screen } from '@testing-library/react';

afterEach(() => {
  cleanup();
  onSend.mockClear();
  cancelPendingOverlay.mockClear();
  toastError.mockClear();
  getDocument.mockReturnValue('hello');
});

describe('ChatInput send overlay cancel', () => {
  it('cancels then sends when there is text', async () => {
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() => expect(cancelPendingOverlay).toHaveBeenCalledWith('/ws'));
    expect(onSend).toHaveBeenCalled();
  });

  it('does not cancel on empty send', async () => {
    getDocument.mockReturnValue('');
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await Promise.resolve();
    expect(cancelPendingOverlay).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send when cancel fails', async () => {
    cancelPendingOverlay.mockResolvedValueOnce('failed');
    render(<ChatInput onSend={onSend} onAbort={vi.fn()} />);
    fireEvent.click(screen.getByTestId('do-send'));
    await vi.waitFor(() => expect(cancelPendingOverlay).toHaveBeenCalled());
    expect(onSend).not.toHaveBeenCalled();
    expect(cleanDocument).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
```

`MessageEditor` 用 `require` 读 context 在 vitest ESM 下可能不行。若失败，改成：

```tsx
vi.mock('./input/editor/MessageEditor', async () => {
  const { useChatInput } = await import('./input/ChatInputContext');
  return {
    MessageEditor: () => {
      const { send } = useChatInput();
      return <button type="button" data-testid="do-send" onClick={() => void send()} />;
    },
  };
});
```

失败 toast：mock `antd` 的 `App.useApp` 返回 `{ message: { error: vi.fn() } }`，失败用例断言 `error` 被调用。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/ChatInput.test.tsx
```

预期：FAIL（空输入之外的路径还没调 `cancelPendingOverlay`）。

- [ ] **步骤 3：改 `send()` 并挂浮层**

`ChatInputContext.tsx`：

```ts
send: () => void | Promise<void>;
```

`ChatInput.tsx` 的 `send` 改 `async`，空判之后：

```ts
if (!text && images.length === 0) return;
const cancel = await cancelPendingOverlay(workspace);
if (cancel === 'failed') {
  message.error('取消当前提问失败，请重试');
  return;
}
editor.cleanDocument();
// ...其余保持原样
```

`App.useApp()` 取 `message`。`void onSend(...)` 保持。

`MessageEditor.tsx`：在 `surface` 那个 `div` **之后**（`</div>` 闭合 surface 后、zone 结束前）插入：

```tsx
<ComposerPromptOverlay anchorRef={surfaceRef} />
```

`PromptRequestCard` 仍留在 surface **之前**（审批占位）。

`MessageEditor.test.tsx` 在现有 mock 旁加：

```ts
vi.mock('../ComposerPromptOverlay', () => ({ ComposerPromptOverlay: () => null }));
```

Enter 处理继续 `send();`，改成 `void send();`。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/ChatInput.test.tsx src/features/chat/input/editor/MessageEditor.test.tsx src/features/chat/input/ComposerPromptOverlay.test.tsx src/features/chat/input/PromptRequestCard.test.tsx
```

预期：PASS。

再跑回归：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/overlayPrompt.test.ts src/features/extensionUi/ExtensionUiHost.test.tsx src/features/chat/InlineQuestionCard.test.tsx src/features/tools/ToolExecution.test.tsx src/features/chat/ChatListView.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/features/chat/ChatInput.tsx electron-agent/src/features/chat/ChatInput.test.tsx electron-agent/src/features/chat/input/ChatInputContext.tsx electron-agent/src/features/chat/input/editor/MessageEditor.tsx electron-agent/src/features/chat/input/editor/MessageEditor.test.tsx
git commit -m @"
feat(chat): cancel overlay prompt before send

"@
```

---

## 自检

### 规格覆盖

| 规格 | 任务 |
| --- | --- |
| §4 关闭：确定 / 取消 / X | 6（卡）+ 7（不关 Esc / 点外） |
| §4 发送即取消、空输入不取消 | 1 + 8 |
| §4 发送不取消审批卡 | 1 `shouldRender` 返回 idle |
| §4 permission 回传不进浮层 | 1 `shouldRender` + 6 / 7 |
| §5.1 portal / 锚定 / 限高 / z-index 1050 | 7 |
| §5.1 挂在 surface 之后 | 8 |
| §5.1 审批并集排除 | 1 + 6 + 7 |
| §5.1 询问卡优先 | 7 |
| §5.2 工具行不再挂整卡 | 7 |
| §5.2 `error` 不占位 | 7 |
| §6.1 已取消 / 已回答 | 4 |
| §6.1 pending 占位随 store 收放 | 2 + 7 |
| §6.2 footer 三优先级 | 5 |
| §6.2 `ui-prompt-receipt` JSON + 渲染 | 1 + 3 + 6 |
| §6.2 发送取消不追加 notice | 1（`cancelPendingOverlay` 不调 append）；6 只在卡上确定/取消时 append |
| §7 插入点、async、失败不 send | 8 |
| §9 testid | 2 / 3 / 4 / 5 / 7 |
| 不改 ExtensionUiHost / 审批 / QuestionsCard | 动工前必读 |

### 占位符

无 TODO / 待定 /「类似任务 N」。

### 类型名

全程使用：`shouldRenderUiPromptInOverlay`、`cancelPendingOverlay`、`appendUiPromptReceipt`、`parseUiPromptReceipt`、`UiPromptReceipt`、`hasPendingQuestion`、`ask-user-pending`、`ask-user-cancelled`、`ui-prompt-pending`、`ui-prompt-receipt`、`composer-prompt-overlay`。

---

## 审查修订记录（2026-09-14）

对照 `electron-agent/src` 与修订后的规格逐条核对。分三级：**阻断** = 照原文写会实现错；**补漏** = 原文没写、实现时会卡住；**校准** = 与代码不符。

| # | 级别 | 位置 | 修订 |
| --- | --- | --- | --- |
| 1 | 阻断 | 任务 1（原） | 删掉 `inlineQuestionStore.suppressed` / `suppress()` 整个任务。`clear()` 之后 `byWorkspace` 已空，占位条件写成 `status === 'running' && 有条目` 就自然收掉，抑制标记从没机会生效；而且只让「发送取消」置位会造成「点完卡上取消、工具还没 done」期间占位继续显示呼吸中的「等待你选择」。 |
| 2 | 阻断 | 任务 6 | `appendUiPromptReceipt(useAgentStore().useStore.setState, ...)` 在事件回调里调 hook，违反 hook 规则。改为组件顶层取 `useStore`。 |
| 3 | 阻断 | 任务 3 | `MutedLine` 只有 `icon / text / count / open / onToggle / data-testid`，没有正文槽，且渲染成 `<button>`。计划里「value 作为可展开正文」做不到；改为把 `value` 拼进 `text`，且必须保持两个独立文本节点，否则 `getByText('已回答')` 匹配不到。 |
| 4 | 阻断 | 原任务 5 / 8 | 原顺序是「工具行改占位（5）」在「浮层落地（8）」之前，中间 commit 会没有任何地方渲染询问卡。重排为：浮层（7）在工具行占位（7 同任务内）之前；原任务 5 只做 `done` 分支的「已取消」。 |
| 5 | 阻断 | 任务 4 | 判定取消只能用 `parseAnswers(result).length === 0`，不能用 `AnsweredQuestionsCard` 的 `count`。`count = Math.max(qdata.length, answers.length)`，取消时 `args.questions` 仍在 → `count ≥ 1` → 现状渲染的是「有题目、答案为空」的卡，不是整行空白。 |
| 6 | 补漏 | 任务 7 | 测试直接改 `HTMLElement.prototype.getBoundingClientRect` 且从不恢复，会污染后续用例。改用 `vi.spyOn` + `rectSpy.mockRestore()`（不用 `restoreAllMocks`，会误伤 `vi.mock` 里的 `vi.fn()`）。 |
| 7 | 补漏 | 任务 7 | 步骤 3 要求「没有条目时不 portal 空壳」，但测试没覆盖。补一例。 |
| 8 | 补漏 | 任务 8 | `send()` 新增 `App.useApp()` 取 toast，测试没有对应 mock。补 antd `App` 的部分 mock（保留 actual 其它导出）与失败 toast 断言。 |
| 9 | 补漏 | 动工前必读 | 补「发送不取消审批卡」：`cancelPendingOverlay` 对 permission / 审批请求返回 `idle`，这是现状行为，别实现者误以为要补。 |
| 10 | 校准 | 任务 4 | `extractQData` 认的字段是 `questions[].question`（`AnsweredQuestionsCard.tsx:76-89`），测试 args 用 `question` 是对的，已加注说明别写成 `title`。 |

另：规格 §6.1 与 §12 #15 关于「取消后是整行空白」的表述随之修正（见规格文件）。

---

计划已完成并保存到 `docs/superpowers/plans/2026-09-14-composer-prompt-overlay.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
