import { create } from 'zustand';
import { pi } from '../lib/pi';
import { readApprovalLevel, setComposerApprovalLevel } from './approvalStore';

interface FullAccessConfirmState {
  open: boolean;
  workspace: string | null;
  /** 要切到完全权限的会话；null = 草稿（改项目默认）。 */
  sessionPath: string | null;
  busy: boolean;
}

const initialState: FullAccessConfirmState = {
  open: false,
  workspace: null,
  sessionPath: null,
  busy: false,
};

export const useFullAccessConfirmStore = create<FullAccessConfirmState>(() => ({
  ...initialState,
}));

let pendingResolve: (() => void) | null = null;

function closeDialog(): void {
  useFullAccessConfirmStore.setState({ open: false, workspace: null, sessionPath: null, busy: false });
  pendingResolve?.();
  pendingResolve = null;
}

export function dismissFullAccessConfirm(): void {
  const { open, busy } = useFullAccessConfirmStore.getState();
  if (!open || busy) return;
  closeDialog();
}

export async function confirmFullAccess(): Promise<void> {
  const { open, workspace, sessionPath, busy } = useFullAccessConfirmStore.getState();
  if (!open || !workspace || busy) return;

  useFullAccessConfirmStore.setState({ busy: true });
  try {
    await pi.setApproval(workspace, 'full', sessionPath);
    setComposerApprovalLevel(workspace, sessionPath, 'full');
    closeDialog();
  } catch (err) {
    useFullAccessConfirmStore.setState({ busy: false });
    throw err;
  }
}

export async function enableFullAccess(workspace: string, sessionPath: string | null = null): Promise<void> {
  if (readApprovalLevel(workspace, sessionPath) === 'full') {
    return;
  }

  if (useFullAccessConfirmStore.getState().open) {
    return;
  }

  return new Promise<void>((resolve) => {
    pendingResolve = resolve;
    useFullAccessConfirmStore.setState({
      open: true,
      workspace,
      sessionPath,
      busy: false,
    });
  });
}

export function __resetFullAccessConfirmForTest(): void {
  pendingResolve?.();
  pendingResolve = null;
  useFullAccessConfirmStore.setState(initialState);
}
