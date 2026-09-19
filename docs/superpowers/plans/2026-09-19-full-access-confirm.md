# 完全权限切换二次确认 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 桌面端从其它审批档切到「完全权限」时，必须先过带风险勾选的确认弹窗；确认且 IPC 成功后才写入策略，选择器在此之前一直显示旧档。

**架构：** 全局 zustand 确认 store + `enableFullAccess(workspace)` 作为唯一界面启用入口。`FullAccessConfirmModal` 挂在 `App.tsx` 的 `ThemeProvider` 内。`ApprovalAction` 选 `full` 只调 `enableFullAccess`，不再抢先 `setLevel`。主进程 `agent_set_approval` 不改。

**技术栈：** TypeScript、React、antd 6（`Modal` / `Alert` / `Checkbox`）、zustand、vitest + testing-library。只改 `electron-agent` 渲染进程。

**规格：** `docs/superpowers/specs/2026-09-19-full-access-confirm-design.md`

**硬约束：** TDD；不要隔离 worktree，在当前仓库原地做（工作区很脏）。每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。用户未要求提交则跳过各任务的 Commit 步骤。不要改主进程、`extensions/_shared/approval.ts`、五档语义、Ask 锁定、sidecar `setStatus` 回读。禁止 emoji。

---

## 动工前必读

- 当前档默认是 `'auto'`（`approvalStore` 未写入时）。
- `enableFullAccess` 在弹窗打开期间会挂起 Promise；测试里必须先拿到 Promise，再 `confirmFullAccess` / `dismissFullAccessConfirm`，最后 `await`。直接 `await enableFullAccess(...)` 会挂死。
- 模块级 `pending` 用 `__resetFullAccessConfirmForTest()` 清掉，避免测试串扰。
- 弹窗挂在 `AgentStoreProvider` **外面**，工作区切换用 `useSessionStore` 的 `activeWorkspace`，不要调 `useAgentStoreContext`。
- antd 6 的 `Alert` 用 `title`，不用 `message`。
- Windows 测试命令见下。UI 以 vitest 为准，不要求点 Electron 真窗。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run <本任务列出的测试>
```

涉及类型的任务再加：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit -p tsconfig.json
```

**提交（仅当用户明确要求时）：**

```powershell
git add <本任务文件>
git commit -m @"
feat(审批): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/src/stores/fullAccessConfirmStore.ts` | 确认状态、`enableFullAccess` / `confirmFullAccess` / `dismissFullAccessConfirm` |
| `electron-agent/src/stores/fullAccessConfirmStore.test.ts` | 已是 full、取消、成功写入、失败不写、二次调用不抢占 |
| `electron-agent/src/features/chat/input/FullAccessConfirmModal.tsx` | 勾选门闩弹窗；busy 时不可关；切工作区则取消 |
| `electron-agent/src/features/chat/input/FullAccessConfirmModal.test.tsx` | 未勾选禁用、取消、重开清空勾选、失败保持打开、切工作区关闭 |
| `electron-agent/src/features/chat/input/actions/ApprovalAction.test.tsx` | 非 full 立刻写；full 先弹窗 |

修改：

| 文件 | 改动 |
| --- | --- |
| `electron-agent/src/features/chat/input/actions/ApprovalAction.tsx` | 选 `full` 走 `enableFullAccess` |
| `electron-agent/src/App.tsx` | 挂载 `<FullAccessConfirmModal />` |

不修改：`piRuntimeService.ts`、`extensions/_shared/approval.ts`、`approvalStore.ts` 的策略枚举、`ExtensionUiHost` 的 `setStatus` 回读。

---

### 任务 1：确认 store 与 enableFullAccess

**文件：**
- 创建：`electron-agent/src/stores/fullAccessConfirmStore.ts`
- 测试：`electron-agent/src/stores/fullAccessConfirmStore.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setApproval } = vi.hoisted(() => ({
  setApproval: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/pi', () => ({ pi: { setApproval } }));

import { useApprovalStore } from './approvalStore';
import {
  confirmFullAccess,
  dismissFullAccessConfirm,
  enableFullAccess,
  useFullAccessConfirmStore,
  __resetFullAccessConfirmForTest,
} from './fullAccessConfirmStore';

beforeEach(() => {
  __resetFullAccessConfirmForTest();
  useApprovalStore.setState({ byWorkspace: {} });
  setApproval.mockReset();
  setApproval.mockResolvedValue(undefined);
});

afterEach(() => {
  __resetFullAccessConfirmForTest();
});

describe('enableFullAccess', () => {
  it('当前已是 full 时不打开弹窗、不调 IPC', async () => {
    useApprovalStore.getState().setLevel('/ws', 'full');
    await enableFullAccess('/ws');
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
    expect(setApproval).not.toHaveBeenCalled();
  });

  it('当前不是 full 时打开弹窗；取消后不写 IPC 也不改档', async () => {
    const pending = enableFullAccess('/ws');
    expect(useFullAccessConfirmStore.getState()).toMatchObject({
      open: true,
      workspace: '/ws',
      busy: false,
    });
    dismissFullAccessConfirm();
    await pending;
    expect(setApproval).not.toHaveBeenCalled();
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBeUndefined();
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
  });

  it('确认且 IPC 成功后才 setLevel 为 full', async () => {
    const pending = enableFullAccess('/ws');
    await confirmFullAccess();
    await pending;
    expect(setApproval).toHaveBeenCalledWith('/ws', 'full');
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('full');
    expect(useFullAccessConfirmStore.getState().open).toBe(false);
  });

  it('IPC 失败时不改档、弹窗保持打开', async () => {
    setApproval.mockRejectedValueOnce(new Error('RUNTIME_CONFIG_UNAVAILABLE'));
    const pending = enableFullAccess('/ws');
    await expect(confirmFullAccess()).rejects.toThrow('RUNTIME_CONFIG_UNAVAILABLE');
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBeUndefined();
    expect(useFullAccessConfirmStore.getState()).toMatchObject({ open: true, busy: false });
    dismissFullAccessConfirm();
    await pending;
  });

  it('弹窗已打开时第二次调用立即返回且不覆盖 workspace', async () => {
    const first = enableFullAccess('/a');
    const second = enableFullAccess('/b');
    await second;
    expect(useFullAccessConfirmStore.getState().workspace).toBe('/a');
    dismissFullAccessConfirm();
    await first;
    expect(setApproval).not.toHaveBeenCalled();
  });

  it('busy 时 dismiss 被忽略', async () => {
    let release: () => void = () => {};
    setApproval.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = enableFullAccess('/ws');
    const confirming = confirmFullAccess();
    await Promise.resolve();
    expect(useFullAccessConfirmStore.getState().busy).toBe(true);
    dismissFullAccessConfirm();
    expect(useFullAccessConfirmStore.getState().open).toBe(true);
    release();
    await confirming;
    await pending;
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/fullAccessConfirmStore.test.ts
```

预期：FAIL，找不到 `./fullAccessConfirmStore`。

- [ ] **步骤 3：编写最少实现代码**

`electron-agent/src/stores/fullAccessConfirmStore.ts`：

```ts
import { create } from 'zustand';
import { pi } from '../lib/pi';
import { useApprovalStore } from './approvalStore';

interface FullAccessConfirmState {
  open: boolean;
  workspace: string | null;
  busy: boolean;
}

let pending: { resolve: () => void } | null = null;

export const useFullAccessConfirmStore = create<FullAccessConfirmState>(() => ({
  open: false,
  workspace: null,
  busy: false,
}));

function settle(): void {
  const resolve = pending?.resolve;
  pending = null;
  useFullAccessConfirmStore.setState({ open: false, workspace: null, busy: false });
  resolve?.();
}

export function dismissFullAccessConfirm(): void {
  const { open, busy } = useFullAccessConfirmStore.getState();
  if (!open || busy) return;
  settle();
}

export async function confirmFullAccess(): Promise<void> {
  const { open, workspace, busy } = useFullAccessConfirmStore.getState();
  if (!open || !workspace || busy) return;
  useFullAccessConfirmStore.setState({ busy: true });
  try {
    await pi.setApproval(workspace, 'full');
    useApprovalStore.getState().setLevel(workspace, 'full');
    settle();
  } catch (cause) {
    useFullAccessConfirmStore.setState({ busy: false });
    throw cause;
  }
}

export async function enableFullAccess(workspace: string): Promise<void> {
  const current = useApprovalStore.getState().byWorkspace[workspace] ?? 'auto';
  if (current === 'full') return;
  if (useFullAccessConfirmStore.getState().open) return;
  useFullAccessConfirmStore.setState({ open: true, workspace, busy: false });
  await new Promise<void>((resolve) => {
    pending = { resolve };
  });
}

export function __resetFullAccessConfirmForTest(): void {
  const resolve = pending?.resolve;
  pending = null;
  useFullAccessConfirmStore.setState({ open: false, workspace: null, busy: false });
  resolve?.();
}
```

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/fullAccessConfirmStore.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/stores/fullAccessConfirmStore.ts electron-agent/src/stores/fullAccessConfirmStore.test.ts
git commit -m @"
feat(审批): 完全权限启用改为先确认再写 IPC

"@
```

---

### 任务 2：确认弹窗

**文件：**
- 创建：`electron-agent/src/features/chat/input/FullAccessConfirmModal.tsx`
- 测试：`electron-agent/src/features/chat/input/FullAccessConfirmModal.test.tsx`

- [ ] **步骤 1：编写失败的测试**

把 antd 收成可点 DOM（对齐 `ModelSyncModal.test.tsx`）：

```tsx
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { setApproval } = vi.hoisted(() => ({
  setApproval: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/pi', () => ({ pi: { setApproval } }));

vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { error: vi.fn() } }) },
  Alert: ({ title }: { title?: ReactNode }) => <div>{title}</div>,
  Checkbox: ({
    children,
    checked,
    disabled,
    onChange,
  }: {
    children?: ReactNode;
    checked?: boolean;
    disabled?: boolean;
    onChange?: (e: { target: { checked: boolean } }) => void;
  }) => (
    <label>
      <input
        type="checkbox"
        aria-label="我已了解风险，并愿意继续"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange?.({ target: { checked: e.target.checked } })}
      />
      {children}
    </label>
  ),
  Modal: ({
    open,
    title,
    children,
    onOk,
    onCancel,
    okText,
    cancelText,
    okButtonProps,
    cancelButtonProps,
    closable,
  }: {
    open?: boolean;
    title?: ReactNode;
    children?: ReactNode;
    onOk?: () => void;
    onCancel?: () => void;
    okText?: ReactNode;
    cancelText?: ReactNode;
    okButtonProps?: { disabled?: boolean };
    cancelButtonProps?: { disabled?: boolean };
    closable?: boolean;
  }) =>
    open ? (
      <div data-testid="full-access-confirm-modal">
        <div>{title}</div>
        {children}
        {closable !== false ? (
          <button type="button" aria-label="关闭" onClick={onCancel}>
            x
          </button>
        ) : null}
        <button type="button" disabled={cancelButtonProps?.disabled} onClick={onCancel}>
          {cancelText}
        </button>
        <button type="button" disabled={okButtonProps?.disabled} onClick={onOk}>
          {okText}
        </button>
      </div>
    ) : null,
}));

import { useApprovalStore } from '../../../stores/approvalStore';
import {
  enableFullAccess,
  useFullAccessConfirmStore,
  __resetFullAccessConfirmForTest,
} from '../../../stores/fullAccessConfirmStore';
import { useSessionStore } from '../../../store/session';
import { FullAccessConfirmModal } from './FullAccessConfirmModal';

beforeEach(() => {
  __resetFullAccessConfirmForTest();
  useApprovalStore.setState({ byWorkspace: {} });
  useSessionStore.setState({ activeWorkspace: '/ws' });
  setApproval.mockReset();
  setApproval.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  __resetFullAccessConfirmForTest();
});

describe('FullAccessConfirmModal', () => {
  it('打开时确认钮禁用；勾选后可点；未勾选不会启用', async () => {
    render(<FullAccessConfirmModal />);
    void enableFullAccess('/ws');
    expect(await screen.findByTestId('full-access-confirm-modal')).toBeTruthy();
    const enable = screen.getByRole('button', { name: '启用完全权限' });
    expect(enable).toBeDisabled();
    fireEvent.click(enable);
    expect(setApproval).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('我已了解风险，并愿意继续'));
    expect(enable).not.toBeDisabled();
  });

  it('取消不写 IPC，并关掉弹窗', async () => {
    const pending = enableFullAccess('/ws');
    render(<FullAccessConfirmModal />);
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    await pending;
    expect(setApproval).not.toHaveBeenCalled();
    expect(screen.queryByTestId('full-access-confirm-modal')).toBeNull();
  });

  it('重新打开时勾选被清空', async () => {
    render(<FullAccessConfirmModal />);
    const first = enableFullAccess('/ws');
    fireEvent.click(await screen.findByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await first;
    void enableFullAccess('/ws');
    expect(await screen.findByTestId('full-access-confirm-modal')).toBeTruthy();
    expect(screen.getByLabelText('我已了解风险，并愿意继续')).not.toBeChecked();
    expect(screen.getByRole('button', { name: '启用完全权限' })).toBeDisabled();
  });

  it('勾选并启用后调用 setApproval；IPC 失败时弹窗仍在', async () => {
    render(<FullAccessConfirmModal />);
    const pending = enableFullAccess('/ws');
    fireEvent.click(await screen.findByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByRole('button', { name: '启用完全权限' }));
    await waitFor(() => expect(setApproval).toHaveBeenCalledWith('/ws', 'full'));
    await pending;
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('full');

    setApproval.mockRejectedValueOnce(new Error('boom'));
    void enableFullAccess('/other');
    useApprovalStore.getState().setLevel('/other', 'auto');
    fireEvent.click(await screen.findByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByRole('button', { name: '启用完全权限' }));
    await waitFor(() => expect(useFullAccessConfirmStore.getState().open).toBe(true));
    expect(screen.getByTestId('full-access-confirm-modal')).toBeTruthy();
  });

  it('活动工作区变了且未 busy 时按取消关闭', async () => {
    render(<FullAccessConfirmModal />);
    const pending = enableFullAccess('/ws');
    await screen.findByTestId('full-access-confirm-modal');
    useSessionStore.getState().setActiveWorkspace('/other');
    await pending;
    expect(setApproval).not.toHaveBeenCalled();
    expect(screen.queryByTestId('full-access-confirm-modal')).toBeNull();
  });
});
```

注意：第四个用例里第一次成功后 `byWorkspace['/ws']` 已是 `full`。第二次 `enableFullAccess('/other')` 前把 `/other` 设成 `auto`（或缺省）。不要对 `/ws` 再调 `enableFullAccess`，否则会因已是 full 而不弹窗。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/FullAccessConfirmModal.test.tsx
```

预期：FAIL，找不到 `./FullAccessConfirmModal`。

- [ ] **步骤 3：编写最少实现代码**

`electron-agent/src/features/chat/input/FullAccessConfirmModal.tsx`：

```tsx
import { useEffect, useState } from 'react';
import { Alert, App, Checkbox, Modal } from 'antd';
import { useSessionStore } from '../../../store/session';
import {
  confirmFullAccess,
  dismissFullAccessConfirm,
  useFullAccessConfirmStore,
} from '../../../stores/fullAccessConfirmStore';

const WARNING =
  '启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。';

export function FullAccessConfirmModal() {
  const { message } = App.useApp();
  const open = useFullAccessConfirmStore((s) => s.open);
  const busy = useFullAccessConfirmStore((s) => s.busy);
  const confirmWorkspace = useFullAccessConfirmStore((s) => s.workspace);
  const activeWorkspace = useSessionStore((s) => s.activeWorkspace);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (open) setAcknowledged(false);
  }, [open]);

  useEffect(() => {
    const { open: isOpen, busy: isBusy, workspace } = useFullAccessConfirmStore.getState();
    if (isOpen && !isBusy && workspace && activeWorkspace && workspace !== activeWorkspace) {
      dismissFullAccessConfirm();
    }
  }, [activeWorkspace]);

  const onOk = async () => {
    if (!acknowledged || !confirmWorkspace) return;
    try {
      await confirmFullAccess();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Modal
      open={open}
      title="确认启用完全权限?"
      okText="启用完全权限"
      cancelText="取消"
      confirmLoading={busy}
      maskClosable={!busy}
      keyboard={!busy}
      closable={!busy}
      onCancel={dismissFullAccessConfirm}
      onOk={() => void onOk()}
      okButtonProps={{ disabled: !acknowledged || busy }}
      cancelButtonProps={{ disabled: busy }}
      destroyOnHidden
    >
      <div data-testid="full-access-confirm-modal">
        <Alert type="error" showIcon title={WARNING} />
        <Checkbox
          checked={acknowledged}
          disabled={busy}
          onChange={(e) => setAcknowledged(e.target.checked)}
        >
          我已了解风险，并愿意继续
        </Checkbox>
      </div>
    </Modal>
  );
}
```

antd 6 若没有 `destroyOnHidden`（旧名 `destroyOnClose`），改用已有的那一个；勾选重置已经靠 `open` 的 `useEffect`，不依赖销毁。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/FullAccessConfirmModal.test.tsx src/stores/fullAccessConfirmStore.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/chat/input/FullAccessConfirmModal.tsx electron-agent/src/features/chat/input/FullAccessConfirmModal.test.tsx
git commit -m @"
feat(审批): 增加完全权限风险确认弹窗

"@
```

---

### 任务 3：ApprovalAction 改走 enableFullAccess

**文件：**
- 修改：`electron-agent/src/features/chat/input/actions/ApprovalAction.tsx`
- 测试：`electron-agent/src/features/chat/input/actions/ApprovalAction.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const { setApproval } = vi.hoisted(() => ({
  setApproval: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../../lib/pi', () => ({ pi: { setApproval } }));

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: ({
    options,
    onChange,
    disabled,
    value,
  }: {
    options?: { label: string; value: string }[];
    onChange?: (value: string) => void;
    disabled?: boolean;
    value?: string;
  }) => (
    <div data-disabled={disabled ? 'true' : 'false'} data-value={value}>
      {options?.map((item) => (
        <button key={item.value} disabled={disabled} onClick={() => onChange?.(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@lobehub/ui', () => ({
  Icon: () => null,
}));

vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { error: vi.fn() } }) },
  Alert: ({ title }: { title?: ReactNode }) => <div>{title}</div>,
  Checkbox: ({
    children,
    checked,
    onChange,
  }: {
    children?: ReactNode;
    checked?: boolean;
    onChange?: (e: { target: { checked: boolean } }) => void;
  }) => (
    <label>
      <input
        type="checkbox"
        aria-label="我已了解风险，并愿意继续"
        checked={!!checked}
        onChange={(e) => onChange?.({ target: { checked: e.target.checked } })}
      />
      {children}
    </label>
  ),
  Modal: ({
    open,
    children,
    onOk,
    onCancel,
    okText,
    cancelText,
    okButtonProps,
  }: {
    open?: boolean;
    children?: ReactNode;
    onOk?: () => void;
    onCancel?: () => void;
    okText?: ReactNode;
    cancelText?: ReactNode;
    okButtonProps?: { disabled?: boolean };
  }) =>
    open ? (
      <div data-testid="full-access-confirm-modal">
        {children}
        <button type="button" onClick={onCancel}>
          {cancelText}
        </button>
        <button type="button" disabled={okButtonProps?.disabled} onClick={onOk}>
          {okText}
        </button>
      </div>
    ) : null,
}));

vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({
    workspace: '/ws',
    workspaceReady: true,
    store: { reset: vi.fn() },
    setWorkspaceReady: vi.fn(),
  }),
}));

import ApprovalAction from './ApprovalAction';
import { FullAccessConfirmModal } from '../FullAccessConfirmModal';
import { useApprovalStore } from '../../../../stores/approvalStore';
import { useModeStore } from '../../../../stores/modeStore';
import { __resetFullAccessConfirmForTest } from '../../../../stores/fullAccessConfirmStore';

function renderApproval() {
  return render(
    <>
      <ApprovalAction />
      <FullAccessConfirmModal />
    </>,
  );
}

beforeEach(() => {
  __resetFullAccessConfirmForTest();
  useApprovalStore.setState({ byWorkspace: {} });
  useModeStore.setState({ byWorkspace: {} });
  setApproval.mockReset();
  setApproval.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  __resetFullAccessConfirmForTest();
});

describe('ApprovalAction', () => {
  it('选非 full 立刻 setApproval，不出现确认窗', () => {
    renderApproval();
    fireEvent.click(screen.getByRole('button', { name: '替我审批' }));
    expect(setApproval).toHaveBeenCalledWith('/ws', 'auto');
    expect(screen.queryByTestId('full-access-confirm-modal')).toBeNull();
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('auto');
  });

  it('选完全权限时确认前不调用 setApproval，选择器仍是旧档', async () => {
    useApprovalStore.getState().setLevel('/ws', 'auto');
    renderApproval();
    fireEvent.click(screen.getByRole('button', { name: '完全权限' }));
    expect(await screen.findByTestId('full-access-confirm-modal')).toBeTruthy();
    expect(setApproval).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '完全权限' }).parentElement?.getAttribute('data-value')).toBe(
      'auto',
    );
  });

  it('勾选并确认后才 setApproval full', async () => {
    useApprovalStore.getState().setLevel('/ws', 'workspace');
    renderApproval();
    fireEvent.click(screen.getByRole('button', { name: '完全权限' }));
    fireEvent.click(await screen.findByLabelText('我已了解风险，并愿意继续'));
    fireEvent.click(screen.getByRole('button', { name: '启用完全权限' }));
    await waitFor(() => expect(setApproval).toHaveBeenCalledWith('/ws', 'full'));
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('full');
  });

  it('取消后不写 IPC，档位仍是旧值', async () => {
    useApprovalStore.getState().setLevel('/ws', 'ask');
    renderApproval();
    fireEvent.click(screen.getByRole('button', { name: '完全权限' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByTestId('full-access-confirm-modal')).toBeNull());
    expect(setApproval).not.toHaveBeenCalled();
    expect(useApprovalStore.getState().byWorkspace['/ws']).toBe('ask');
  });

  it('Ask 模式下选择器禁用，点完全权限不会弹窗', () => {
    useModeStore.getState().setMode('/ws', 'ask');
    renderApproval();
    expect(screen.getByRole('button', { name: '完全权限' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '完全权限' }));
    expect(screen.queryByTestId('full-access-confirm-modal')).toBeNull();
    expect(setApproval).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/actions/ApprovalAction.test.tsx
```

预期：FAIL。现有 `ApprovalAction` 会在点「完全权限」时立刻 `setApproval('/ws', 'full')`，确认窗不会出现。

- [ ] **步骤 3：编写最少实现代码**

只改 `onChange`。文件其余部分（图标、`optionRender`、Ask 禁用）不动。

```tsx
import { enableFullAccess } from '../../../../stores/fullAccessConfirmStore';

const onChange = (next: string) => {
  const target = next as ApprovalPolicy;
  if (target === 'full') {
    void enableFullAccess(workspace);
    return;
  }
  useApprovalStore.getState().setLevel(workspace, target);
  void pi.setApproval(workspace, target);
};
```

把 `enableFullAccess` 的 import 加到现有 `pi` / `approvalStore` import 旁边。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/chat/input/actions/ApprovalAction.test.tsx src/features/chat/input/FullAccessConfirmModal.test.tsx src/stores/fullAccessConfirmStore.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/chat/input/actions/ApprovalAction.tsx electron-agent/src/features/chat/input/actions/ApprovalAction.test.tsx
git commit -m @"
feat(审批): 选择器切到完全权限前先走确认弹窗

"@
```

---

### 任务 4：把弹窗挂到应用根

**文件：**
- 修改：`electron-agent/src/App.tsx`

- [ ] **步骤 1：挂载宿主**

在 `App.tsx` 顶部其它 feature import 旁增加：

```tsx
import { FullAccessConfirmModal } from './features/chat/input/FullAccessConfirmModal';
```

在 `ThemeProvider` > `ConfigProvider` 里、`<ExtensionUiHost />` 后面加一行（必须在 `ThemeProvider` 内，这样 antd Modal 能吃到主题；不要放进 `AgentStoreProvider`，弹窗用 session store 看活动工作区）：

```tsx
<ExtensionUiHost />
<FullAccessConfirmModal />
<MarkdownWarmup />
```

不要改 `ExtensionUiHost` 本身。

- [ ] **步骤 2：类型检查**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit -p tsconfig.json
```

预期：无因本任务引入的错误。

- [ ] **步骤 3：回归本规格测试**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/stores/fullAccessConfirmStore.test.ts src/features/chat/input/FullAccessConfirmModal.test.tsx src/features/chat/input/actions/ApprovalAction.test.tsx
```

预期：PASS。

不要跑整个 `piRuntimeService.test.ts` 的改动；它不在本规格范围内。若你本地想确认 IPC 未破，可额外跑：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/piRuntimeService.test.ts
```

预期：原有 `agent_set_approval` 用例仍 PASS（本任务不应改该文件）。

- [ ] **步骤 4：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/App.tsx
git commit -m @"
feat(审批): 在应用根挂载完全权限确认弹窗

"@
```

---

## 验收对照

| 规格条款 | 任务 |
| --- | --- |
| 界面切到 full 才确认；IPC 不拦 | 任务 1、3；不改 `piRuntimeService` |
| 未确认不写 store / IPC，选择器显示旧档 | 任务 1、3 |
| 勾选门闩、文案、取消 / Esc / 遮罩 | 任务 2 |
| 每次都确认、不记住 | 任务 1（无 persist） |
| IPC 失败 toast、弹窗不关、不抢先 setLevel | 任务 1、2 |
| 二次 `enableFullAccess` 不抢占 | 任务 1 |
| 已是 full 不弹 | 任务 1 |
| Ask 模式不弹 | 任务 3 |
| 工作区切换视为取消 | 任务 2 |
| 弹窗挂应用根 | 任务 4 |
| 以后快捷键走同一 `enableFullAccess` | 任务 1 导出该函数 |

---

## 自检

- 规格 §2–§10 均有对应任务；无「待定」/「类似任务 N」。
- 对外名字锁定为 `enableFullAccess` / `confirmFullAccess` / `dismissFullAccessConfirm` / `useFullAccessConfirmStore` / `FullAccessConfirmModal`。
- 未引入主进程或 CLI 改动。
