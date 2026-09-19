import { create } from 'zustand';
import { pi } from '../lib/pi';
import { useApprovalStore } from './approvalStore';

interface FullAccessConfirmState {
  open: boolean;
  workspace: string | null;
  busy: boolean;
}

const initialState: FullAccessConfirmState = {
  open: false,
  workspace: null,
  busy: false,
};

export const useFullAccessConfirmStore = create<FullAccessConfirmState>(() => ({
  ...initialState,
}));

let pendingResolve: (() => void) | null = null;

function closeDialog(): void {
  useFullAccessConfirmStore.setState({ open: false, workspace: null, busy: false });
  pendingResolve?.();
  pendingResolve = null;
}

export function dismissFullAccessConfirm(): void {
  const { open, busy } = useFullAccessConfirmStore.getState();
  if (!open || busy) return;
  closeDialog();
}

export async function confirmFullAccess(): Promise<void> {
  const { open, workspace, busy } = useFullAccessConfirmStore.getState();
  if (!open || !workspace || busy) return;

  useFullAccessConfirmStore.setState({ busy: true });
  try {
    await pi.setApproval(workspace, 'full');
    useApprovalStore.getState().setLevel(workspace, 'full');
    closeDialog();
  } catch (err) {
    useFullAccessConfirmStore.setState({ busy: false });
    throw err;
  }
}

export async function enableFullAccess(workspace: string): Promise<void> {
  if (useApprovalStore.getState().byWorkspace[workspace] === 'full') {
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
      busy: false,
    });
  });
}

export function __resetFullAccessConfirmForTest(): void {
  pendingResolve?.();
  pendingResolve = null;
  useFullAccessConfirmStore.setState(initialState);
}
