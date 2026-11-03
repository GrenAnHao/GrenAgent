import { useMemo } from 'react';
import { useOptionalAgentStoreContext } from '../../../stores/AgentStoreContext';
import { useSessionStore } from '../../../store/session';
import { pathsEquivalent } from '../../../lib/pathUtils';
import {
  canonicalOwnerKey,
  draftOwnerKey,
  isDraftOwnerKey,
  sessionPathFromOwnerKey,
  type SessionPreferences,
} from '../../../lib/sessionPreferences';
import { useSessionPreferencesStore } from '../../../stores/sessionPreferencesStore';

/**
 * 输入栏当前作用的身份（owner key）。
 *
 * 会话用 JSONL 原路径（后端按它路由到目标 handle），未落盘草稿用 `draft:<uuid>`
 * （不能用 cwd 代替，否则同项目两份草稿互相覆盖）。最后才回退 workspace 兼容键
 * —— 它没有后端身份，只能当草稿处理。
 */
export interface ComposerOwnerScope {
  sessionPath?: string | null;
  draftId?: string | null;
}

/** 显式 scope 优先（多视图各有自己的选中身份）；缺省沿用「当前草稿 → 当前会话 → workspace」。 */
export function readComposerOwnerKey(
  workspace: string,
  scope?: ComposerOwnerScope,
  snapshot?: {
    draftConversationCwd?: string | null;
    draftConversationId?: string | null;
    activeSessionPath?: string | null;
  },
): string {
  if (scope) {
    if (scope.draftId) return draftOwnerKey(scope.draftId);
    if (scope.sessionPath) return scope.sessionPath;
    // 显式给了空 scope：这个视图没有会话身份，只能是草稿，不能借用别的视图的当前会话。
    return workspace;
  }
  const state = snapshot ?? useSessionStore.getState();
  const draftCwd = state.draftConversationCwd;
  const draftActive = Boolean(draftCwd && pathsEquivalent(draftCwd, workspace));
  if (draftActive) {
    if (state.draftConversationId) return draftOwnerKey(state.draftConversationId);
    // 旧宿主/旧持久化还没有 draftId：退回 workspace 这个没有后端身份的草稿键。
    return workspace;
  }
  return state.activeSessionPath || workspace;
}

function readScopeFromContext(workspace: string): ComposerOwnerScope | undefined {
  const ctx = useOptionalAgentStoreContext();
  if (!ctx || !pathsEquivalent(ctx.workspace, workspace)) return undefined;
  if (ctx.sessionPath === undefined && ctx.draftId === undefined) return undefined;
  return { sessionPath: ctx.sessionPath, draftId: ctx.draftId };
}

/** 订阅 store 的输入栏 owner：切换会话/草稿、Provider 换 scope 都会重新计算。 */
export function useComposerOwnerKey(workspace: string): string {
  const scoped = readScopeFromContext(workspace);
  const draftCwd = useSessionStore((s) => s.draftConversationCwd);
  const draftId = useSessionStore((s) => s.draftConversationId);
  const activeSessionPath = useSessionStore((s) => s.activeSessionPath);
  const scopeKey = `${scoped?.sessionPath ?? '\u0000'}\u0001${scoped?.draftId ?? '\u0000'}`;
  return useMemo(
    () =>
      readComposerOwnerKey(
        workspace,
        scoped,
        { draftConversationCwd: draftCwd, draftConversationId: draftId, activeSessionPath },
      ),
    // scopeKey 替代 scoped 对象本身：Provider 每次渲染都会新建对象。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace, scopeKey, draftCwd, draftId, activeSessionPath],
  );
}

export function useComposerSessionPath(workspace: string): string | null {
  const ownerKey = useComposerOwnerKey(workspace);
  return sessionPathFromOwnerKey(ownerKey);
}

export interface ComposerOwnerPreferences {
  ownerKey: string;
  preferences: SessionPreferences;
  loading: boolean;
  error: 'load' | 'save' | 'unavailable' | null;
}

/**
 * 输入栏四项偏好的展示值。
 * 草稿读本地（进草稿时由 ensureComposerPreferences 用项目默认初始化），会话读快照缓存；
 * 都没有时返回空偏好 + loading，由调用方决定占位，不把别的会话的值当自己的初值。
 *
 * 宿主 setStatus 的 agent-mode / approval-policy 推送（Plan 确认等自动切模式）
 * 由 ExtensionUiHost 单字段投影进本 store（applyStatus），所以这里不需要再读旧版 bySession。
 */
export function useComposerOwnerPreferences(workspace: string): ComposerOwnerPreferences {
  const ownerKey = useComposerOwnerKey(workspace);
  const key = canonicalOwnerKey(ownerKey);
  const entry = useSessionPreferencesStore((s) => s.byOwner[key]);
  const preferences = entry?.preferences;
  return useMemo(
    () => ({
      ownerKey,
      preferences: preferences ?? { revision: 0 },
      loading: entry ? entry.loading : true,
      error: entry?.error ?? null,
    }),
    [ownerKey, preferences, entry],
  );
}

/** 这个 owner 是不是草稿（没有后端会话身份，只能写本地）。 */
export function isDraftComposerOwner(ownerKey: string): boolean {
  return isDraftOwnerKey(ownerKey) || !sessionPathFromOwnerKey(ownerKey);
}
