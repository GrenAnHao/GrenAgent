import { useSessionStore } from '../../store/session';
import { useSidebarPrefsStore } from '../../stores/sidebarPrefsStore';
import {
  bumpSessionMutationEpoch,
  invalidateAllSessionsCache,
} from '../../lib/sessionCache';
import { pathsEquivalent } from '../../lib/pathUtils';
import { queueDraftHandoff } from './sessionProjectTransferDraft';
import { rememberTransferOrigin } from '../../lib/sessionTransferOrigin';
import {
  clearWorkspaceSessionBinding,
  detachTransferredSession,
  markTransferOpen,
  relocateSession,
} from './sessionProjectTransferScope';

export interface TransferOpenedInput {
  sourceWorkspace: string;
  targetWorkspace: string;
  sessionPath: string;
  /** retry-open 时草稿交接已经在第一次移动后登记过，不要重复。 */
  handoffDraft?: boolean;
  /** 目标项目已在主进程登记；retry-open 时幂等。 */
  registerProject?: boolean;
}

export interface TransferOpenedResult {
  /** 目标项目当前应展示的会话路径（同一 path，ID/标题/置顶都不变）。 */
  sessionPath: string;
  /** 这份会话原来的「上次打开」绑定已从源项目清掉。 */
  clearedSourceBinding: boolean;
}

/**
 * 提交成功后（含 retry-open）把这次移动投影到渲染层，不发起任何迁移请求：
 * - 两侧列表：同一 path 只保留一条，cwd 换成目标；作废在途旧列表（逻辑代次 + 缓存）。
 * - 打开目标：先登记「这次 workspace 跳转是迁移」，切 workspace 时不 resetWorkspaceTabs，
 *   旧文件标签 / 脏编辑 / 旧终端都留在原地；目标的新入口由上下文 workspace 决定。
 * - 源会话的旧 store：只有它内存里正好加载着这份会话、且没有实时活动时才清空画面。
 * - 草稿：登记按 sessionPath 的文件引用交接，由输入框在恢复/现行内容上绝对化。
 */
export function applyTransferOpened(input: TransferOpenedInput): TransferOpenedResult {
  const { sourceWorkspace, targetWorkspace, sessionPath } = input;
  const st = useSessionStore.getState();

  const boundSource = Object.entries(st.workspaceSessionPaths).find(
    ([cwd, path]) => pathsEquivalent(cwd, sourceWorkspace) && pathsEquivalent(path, sessionPath),
  );
  const clearedSourceBinding = Boolean(boundSource);

  detachTransferredSession(sourceWorkspace, sessionPath);
  // 旧 ui-history 里没有来源的辅助条目用本次移动的来源兜底；已有 sourceCwd 的行不覆盖。
  rememberTransferOrigin(sessionPath, sourceWorkspace);
  if (input.handoffDraft !== false) queueDraftHandoff(sessionPath, sourceWorkspace);

  // 先立标记再切 workspace：App 的切工作区 effect 靠它跳过 dock 重置。
  markTransferOpen({ sessionPath, sourceWorkspace, targetWorkspace });

  bumpSessionMutationEpoch();
  invalidateAllSessionsCache();

  useSessionStore.setState((s) => {
    const workspaceSessionPaths = clearWorkspaceSessionBinding(s.workspaceSessionPaths, sourceWorkspace, sessionPath);
    const optimistic = s.optimisticSessions.filter((o) => !pathsEquivalent(o.path, sessionPath));
    const inSource = pathsEquivalent(s.activeWorkspace, sourceWorkspace);
    return {
      allSessions: relocateSession(s.allSessions, sessionPath, targetWorkspace),
      optimisticSessions: optimistic,
      // `sessions` 是当前工作区的列表；源项目正在显示时立刻摘掉这一条，其余会话原样保留。
      sessions: inSource ? s.sessions.filter((session) => !pathsEquivalent(session.path, sessionPath)) : s.sessions,
      ...(clearedSourceBinding ? { workspaceSessionPaths } : {}),
    };
  });

  if (input.registerProject !== false) {
    useSessionStore.getState().registerProject(targetWorkspace);
    useSidebarPrefsStore.getState().keepProject(targetWorkspace);
  }

  // dock 视图按 sessionPath 计键（与项目无关），迁移不需要重绑；文件标签与终端各自固定原项目根，
  // 目标项目里的新入口另开，不把旧内容当成目标项目。

  return { sessionPath, clearedSourceBinding };
}

/** 提交前失败 / 状态回滚：只把这一条的 cwd 改回来源，不影响其它会话和已完成的移动。 */
export function restoreTransferProjection(sessionPath: string, sourceWorkspace: string): void {
  bumpSessionMutationEpoch();
  invalidateAllSessionsCache();
  useSessionStore.setState((s) => ({
    allSessions: relocateSession(s.allSessions, sessionPath, sourceWorkspace),
  }));
}
