import { create } from 'zustand';
import { pi } from '../lib/pi';
import { writeComposerPreference } from '../features/chat/input/actions/composerPreferences';
import { useSessionPreferencesStore } from './sessionPreferencesStore';

interface FullAccessConfirmState {
  open: boolean;
  workspace: string | null;
  /**
   * 要切到完全权限的输入栏 owner（会话原路径或 `draft:<uuid>`）。
   * 必须在发起时捕获：确认期间用户可能已经切到别的会话，回执仍只能落到这里。
   */
  ownerKey: string | null;
  busy: boolean;
}

const initialState: FullAccessConfirmState = {
  open: false,
  workspace: null,
  ownerKey: null,
  busy: false,
};

export const useFullAccessConfirmStore = create<FullAccessConfirmState>(() => ({
  ...initialState,
}));

let pendingResolve: (() => void) | null = null;

function closeDialog(): void {
  useFullAccessConfirmStore.setState({ open: false, workspace: null, ownerKey: null, busy: false });
  pendingResolve?.();
  pendingResolve = null;
}

export function dismissFullAccessConfirm(): void {
  const { open, busy } = useFullAccessConfirmStore.getState();
  if (!open || busy) return;
  closeDialog();
}

export async function confirmFullAccess(): Promise<void> {
  const { open, workspace, ownerKey, busy } = useFullAccessConfirmStore.getState();
  if (!open || !workspace || busy) return;

  useFullAccessConfirmStore.setState({ busy: true });
  if (!ownerKey) {
    // 没有捕获 owner 的旧调用（尚未迁到输入栏 owner 的地方）：保持旧语义，交给宿主按前景会话处理。
    // 新入口（ApprovalAction）总是传 ownerKey，草稿不会走这一支。
    try {
      await pi.setApproval(workspace, 'full', null);
      closeDialog();
    } catch (err) {
      useFullAccessConfirmStore.setState({ busy: false });
      throw err;
    }
    return;
  }

  // 用捕获的 owner 写：草稿只写本地、会话带原始路径，都不碰项目默认。
  const result = await writeComposerPreference(workspace, ownerKey, 'approval', 'full');
  if (!result.ok) {
    useFullAccessConfirmStore.setState({ busy: false });
    throw new Error(result.message ?? '启用完全权限失败');
  }
  closeDialog();
}

/** 当前 owner 已经是完全权限（草稿看本地，会话看快照）时直接返回，不再弹确认。 */
export async function enableFullAccess(workspace: string, ownerKey?: string | null): Promise<void> {
  const target = ownerKey ?? null;
  const level = useSessionPreferencesStore.getState().peek(target ?? workspace)?.approval;
  if (level === 'full') return;

  if (useFullAccessConfirmStore.getState().open) {
    return;
  }

  return new Promise<void>((resolve) => {
    pendingResolve = resolve;
    useFullAccessConfirmStore.setState({
      open: true,
      workspace,
      // 不传 owner 的旧调用保留 null：确认时走旧语义（由宿主按前景会话处理）。
      ownerKey: target,
      busy: false,
    });
  });
}

export function __resetFullAccessConfirmForTest(): void {
  pendingResolve?.();
  pendingResolve = null;
  useFullAccessConfirmStore.setState(initialState);
}
