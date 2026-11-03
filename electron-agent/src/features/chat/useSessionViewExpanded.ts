import { useMemo, useState } from 'react';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import { canonicalOwnerKey, draftOwnerKey } from '../../lib/sessionPreferences';
import {
  isPersistableViewOwnerKey,
  useSessionViewStateStore,
} from '../../stores/sessionViewStateStore';

/**
 * 会话视图展开状态的读写 hook（browser-safe）。
 *
 * 身份优先级：
 *  1. `AgentStoreContext` 的可选 `sessionPath` / `draftId`：同一 renderer 里两个 Provider 各自
 *     有自己的选中身份，不能都退到全局 activeSessionPath；
 *  2. 全局会话 store：当前会话路径，或当前未落盘草稿的 `draft:<uuid>`；
 *  3. 都没有 → null：组件保留本地 state，不写任何全局 key（避免无身份组件共享一份展开状态）。
 *
 * 内容 ID（viewId）由调用方给，必须是「跨重载稳定」的：toolCallId、会话消息 timestamp 等，
 * 不能用数组下标（流式追加会让下标漂移）。
 */


/**
 * 当前渲染树的会话视图身份（owner key）；没有可持久化身份时返回 null。
 * 组件卸载/重挂、Provider 换 scope、切换会话或草稿都会重新计算。
 */
export function useSessionViewOwnerKey(): string | null {
  const ctx = useOptionalAgentStoreContext();
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const draftConversationCwd = useSessionStore((s) => s.draftConversationCwd);
  const draftConversationId = useSessionStore((s) => s.draftConversationId);

  const scoped =
    ctx && ctx.sessionPath === undefined && ctx.draftId === undefined ? undefined : ctx;

  return useMemo(() => {
    if (scoped) {
      if (scoped.draftId) return draftOwnerKey(scoped.draftId);
      if (scoped.sessionPath) return scoped.sessionPath;
      // 显式给了空 scope：这个视图没有会话身份，不能借用别的视图的当前会话。
      return null;
    }
    if (draftConversationCwd && draftConversationId) return draftOwnerKey(draftConversationId);
    return activeSessionPath || null;
  }, [scoped?.sessionPath, scoped?.draftId, draftConversationCwd, draftConversationId, activeSessionPath]);
  // scoped 对象每次渲染都会新建，依赖里用它的字段。
  // eslint-disable-next-line react-hooks/exhaustive-deps
}

/** React setter 的输入契约：直接给值，或按当前值计算。落盘的永远是布尔值。 */
export type ExpandedUpdater = boolean | ((previous: boolean) => boolean);

export interface SessionViewExpandedState {
  expanded: boolean;
  setExpanded: (next: ExpandedUpdater) => void;
  toggle: () => void;
  /** 当前是否按会话持久化（false = 只活在组件本地 state）。 */
  persisted: boolean;
}

/**
 * 单个视图项的展开状态。
 *
 * - 有身份：读该会话/草稿下这个内容 ID 的记录；没有用户记录时用 `defaultExpanded`
 *   （运行时自动展开就靠它），用户明确关掉后记录 false，**不会**因为流式追加或默认值变化再打开。
 * - 无身份：只保留组件本地 state，不写全局 key。
 */
export function useSessionViewExpandedState(
  viewId: string | null | undefined,
  defaultExpanded = false,
): SessionViewExpandedState {
  const ownerKey = useSessionViewOwnerKey();
  const persist = Boolean(ownerKey && viewId) && isPersistableViewOwnerKey(ownerKey);
  const key = persist && ownerKey && viewId ? canonicalOwnerKey(ownerKey) : null;
  const stored = useSessionViewStateStore((s) => (key && viewId ? s.byOwner[key]?.[viewId] : undefined));
  const [local, setLocal] = useState(defaultExpanded);

  const expanded = persist ? (stored ?? defaultExpanded) : local;

  return useMemo(
    () => ({
      expanded,
      persisted: persist,
      setExpanded: (next: ExpandedUpdater) => {
        if (persist && ownerKey && viewId) {
          const store = useSessionViewStateStore.getState();
          // previous 必须读调用瞬间的最新值：快速连续点击不能拿上次渲染的闭包值。
          const previous = store.isExpanded(ownerKey, viewId) ?? defaultExpanded;
          const value = typeof next === 'function' ? next(previous) : next;
          store.setExpanded(ownerKey, viewId, value);
        } else {
          setLocal((previous) => (typeof next === 'function' ? next(previous) : next));
        }
      },
      toggle: () => {
        if (persist && ownerKey && viewId) {
          const store = useSessionViewStateStore.getState();
          // previous 读调用瞬间的最新值（不是上次渲染的闭包值），同一 act 里连续两次翻转才正确；
          // 没有用户记录时生效值来自 defaultExpanded（运行时自动展开）。
          const previous = store.isExpanded(ownerKey, viewId) ?? defaultExpanded;
          store.setExpanded(ownerKey, viewId, !previous);
        } else setLocal((v) => !v);
      },
    }),
    [expanded, persist, ownerKey, viewId, defaultExpanded],
  );
}
