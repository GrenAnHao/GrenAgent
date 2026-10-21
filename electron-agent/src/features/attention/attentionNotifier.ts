import type { AttentionNotifyInput, AttentionNotifyResult } from '../../lib/pi';
import { useSessionStore } from '../../store/session';
import { ATTENTION_LABEL, attentionCount, type AttentionKind } from '../../stores/attentionView';
import {
  isSessionVisible,
  sessionStates,
  useAttentionStore,
  type AttentionStoreState,
} from '../../stores/sessionAttention';

export interface AttentionTransition {
  key: string;
  path: string;
  workspace: string;
  kind: AttentionKind;
  body: string;
}

export interface ToastConfig {
  key: string;
  kind: AttentionKind;
  title: string;
  body: string;
  autoClose: boolean;
  onGo: () => void;
}

export interface ToastApi {
  open(cfg: ToastConfig): void;
  destroy(key: string): void;
}

export interface NotifierDeps {
  notify: (input: AttentionNotifyInput) => Promise<AttentionNotifyResult>;
  badge: (count: number, overlayDataUrl?: string) => Promise<void>;
  drawOverlay: (count: number) => string | undefined;
  toast: ToastApi;
  chime: () => void;
  /** 发过系统通知的会话状态清掉了：让主进程把行动中心里那条也收掉。 */
  clear: (path: string) => void;
  openSession: (workspace: string, path: string) => void;
  titleOf: (path: string) => string;
  listedKeys: () => ReadonlySet<string>;
}

const ALL_KINDS: AttentionKind[] = ['approval', 'choice', 'failed', 'blocked', 'done'];

/** 供应商报错可能是几 KB 的 JSON，提示和系统通知的正文都截到这么长。 */
const BODY_MAX = 200;

function clip(text: string): string {
  const chars = [...text];
  return chars.length > BODY_MAX ? `${chars.slice(0, BODY_MAX).join('')}…` : text;
}

const FALLBACK_BODY: Record<AttentionKind, string> = {
  approval: '有操作等待批准',
  choice: '有问题等你回答',
  failed: '回合出错',
  blocked: '需要你处理',
  // 标题已经写了「· 已完成」，正文不再重复
  done: '这一轮已经跑完',
};

/** 状态转变：opened 是该提醒的新状态，cleared 是该收起的提示（按会话、按种类）。 */
export function diffAttention(
  prev: AttentionStoreState,
  next: AttentionStoreState,
): { opened: AttentionTransition[]; cleared: Array<{ key: string; kinds: AttentionKind[] }> } {
  const opened: AttentionTransition[] = [];
  const cleared: Array<{ key: string; kinds: AttentionKind[] }> = [];

  for (const [key, pending] of Object.entries(next.pending)) {
    const before = prev.pending[key];
    if (before && before.kind === pending.kind) continue;
    opened.push({ key, path: pending.path, workspace: pending.workspace, kind: pending.kind, body: clip(pending.title ?? FALLBACK_BODY[pending.kind]) });
  }
  for (const [key, unread] of Object.entries(next.unread)) {
    const before = prev.unread[key];
    if (unread.outcome && unread.outcome.seq > (before?.outcome?.seq ?? 0)) {
      const kind = unread.outcome.kind;
      opened.push({ key, path: unread.path, workspace: unread.workspace, kind, body: clip(unread.outcome.message ?? FALLBACK_BODY[kind]) });
    }
    if (unread.blocked && !before?.blocked) {
      opened.push({ key, path: unread.path, workspace: unread.workspace, kind: 'blocked', body: clip(unread.blocked.message ?? FALLBACK_BODY.blocked) });
    }
  }

  for (const key of Object.keys(prev.pending)) {
    if (!next.pending[key]) cleared.push({ key, kinds: ['approval', 'choice'] });
  }
  for (const [key, before] of Object.entries(prev.unread)) {
    const after = next.unread[key];
    if (before.blocked && !after?.blocked) cleared.push({ key, kinds: ['blocked'] });
    if (before.outcome && !after?.outcome) cleared.push({ key, kinds: ['failed', 'done'] });
  }
  if (next.visibleKey && next.visibleKey !== prev.visibleKey) cleared.push({ key: next.visibleKey, kinds: [...ALL_KINDS] });

  return { opened, cleared };
}

/** 主进程回话期间状态可能已经变了（审批秒答、用户刚好点开）：还成立才弹。 */
function stillHolds(t: AttentionTransition): boolean {
  if (isSessionVisible(t.path)) return false;
  const s = useAttentionStore.getState();
  if (t.kind === 'approval' || t.kind === 'choice') return s.pending[t.key]?.kind === t.kind;
  if (t.kind === 'blocked') return Boolean(s.unread[t.key]?.blocked);
  return s.unread[t.key]?.outcome?.kind === t.kind;
}

const toastKey = (key: string) => `attention:${key}`;

/**
 * 观察注意状态：新状态出现时问主进程怎么提醒（关着 / 应用内 / 系统通知），应用内就弹提示；
 * 状态消失或会话被打开时收起对应的提示；待处理数变化时同步任务栏。
 */
export function createAttentionNotifier(deps: NotifierDeps): { stop(): void } {
  const openToasts = new Map<string, AttentionKind>();
  /** 发过系统通知的会话：键 → { 种类, 路径 }。状态清掉时让主进程收回。 */
  const osSent = new Map<string, { kind: AttentionKind; path: string }>();
  // -1：启动时一定发一次。渲染层重载后计数是 0 也要发，否则主进程的覆盖图标停在旧数字上。
  let lastCount = -1;
  let stopped = false;

  const syncBadge = () => {
    const count = attentionCount(sessionStates(useAttentionStore.getState()), deps.listedKeys());
    if (count === lastCount) return;
    lastCount = count;
    void deps.badge(count, count > 0 ? deps.drawOverlay(count) : undefined).catch(() => {});
  };

  const close = (key: string) => {
    openToasts.delete(key);
    deps.toast.destroy(toastKey(key));
  };

  const announce = (t: AttentionTransition) => {
    if (isSessionVisible(t.path)) return;
    const title = `${deps.titleOf(t.path)} · ${ATTENTION_LABEL[t.kind]}`;
    void deps
      .notify({ kind: t.kind, workspace: t.workspace, sessionPath: t.path, title, body: t.body })
      .then((result) => {
        if (stopped) return;
        if (result.route === 'os') {
          if (stillHolds(t)) osSent.set(t.key, { kind: t.kind, path: t.path });
          else deps.clear(t.path);
          return;
        }
        if (result.route !== 'in-app' || !stillHolds(t)) return;
        openToasts.set(t.key, t.kind);
        deps.toast.open({
          key: toastKey(t.key),
          kind: t.kind,
          title,
          body: t.body,
          autoClose: t.kind === 'done' || t.kind === 'failed',
          onGo: () => {
            close(t.key);
            deps.openSession(t.workspace, t.path);
          },
        });
        if (result.sound) deps.chime();
      })
      .catch(() => {});
  };

  const unsubAttention = useAttentionStore.subscribe((next, prev) => {
    const { opened, cleared } = diffAttention(prev, next);
    for (const c of cleared) {
      const kind = openToasts.get(c.key);
      if (kind && c.kinds.includes(kind)) close(c.key);
      const sent = osSent.get(c.key);
      if (sent && c.kinds.includes(sent.kind)) {
        osSent.delete(c.key);
        deps.clear(sent.path);
      }
    }
    for (const t of opened) announce(t);
    syncBadge();
  });
  const unsubSessions = useSessionStore.subscribe((next, prev) => {
    if (
      next.allSessions !== prev.allSessions ||
      next.optimisticSessions !== prev.optimisticSessions ||
      next.deletedSessionPaths !== prev.deletedSessionPaths
    ) {
      syncBadge();
    }
  });
  syncBadge();

  return {
    stop() {
      stopped = true;
      unsubAttention();
      unsubSessions();
    },
  };
}
