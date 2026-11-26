import type { ComposerDraft } from '../chat/input/editor/composerDraft';
import { normalizeComposerDraft } from '../chat/input/editor/composerDraft';

/**
 * 迁移草稿里的文件出处：「移动到项目…」不搬文件，草稿里的文件 / 目录标签必须指向**原项目**里的那份，
 * 不能被目标项目的同名文件顶替。
 *
 * 做法：把 composer JSON 里相对路径的文件 / 目录标签换成来源项目下的绝对路径，并同步把纯文本回退串里
 * 对应的 `@相对路径` 一起换掉（JSON 恢复失败时会退回纯文本发送）。用户打的正文、命令胶囊的参数都不动。
 * 绝对路径标签本来就与项目无关，保持原样。
 */

const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/;

function slashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function isAbsolute(path: string): boolean {
  return ABSOLUTE.test(path.trim());
}

/** 相对引用在来源项目下的绝对路径；已经是绝对路径时原样（只统一分隔符）。 */
export function absolutizeComposerRef(root: string, value: string): string {
  const raw = value.trim();
  if (!raw) return value;
  if (isAbsolute(raw)) return slashes(raw);
  const joined = slashes(`${root.replace(/[\\/]+$/, '')}/${raw.replace(/^[\\/]+/, '')}`);
  // 去掉无意义的 `.` 段，但别碰 `..`（交给调用方/工具自己判断越界）。
  return joined
    .split('/')
    .filter((segment, index) => segment !== '.' || index === 0)
    .join('/');
}

interface ChatTagLike {
  type?: unknown;
  category?: unknown;
  value?: unknown;
  [key: string]: unknown;
}

function isFileTag(node: unknown): node is ChatTagLike & { category: 'file' | 'directory'; value: string } {
  if (!node || typeof node !== 'object') return false;
  const tag = node as ChatTagLike;
  return tag.type === 'chat-tag' && (tag.category === 'file' || tag.category === 'directory') && typeof tag.value === 'string';
}

export interface FileTagRewrite {
  /** 相对路径 → 绝对路径，按出现顺序；文本替换按它逐个替换。 */
  rewrites: Array<{ from: string; to: string }>;
}

/**
 * 深度遍历 Lexical 序列化 JSON，收集需要改写的文件标签，并返回改写后的副本（不改原对象）。
 * 结构不认识时原样保留，绝不臆造节点类型。
 */
export function rewriteComposerFileTags(json: unknown, root: string): { json: unknown; rewrites: FileTagRewrite['rewrites'] } {
  const rewrites: FileTagRewrite['rewrites'] = [];
  const seen = new Set<string>();
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    if (isFileTag(value)) {
      const original = value.value;
      const absolute = absolutizeComposerRef(root, original);
      if (absolute !== original && !seen.has(original)) {
        seen.add(original);
        rewrites.push({ from: original, to: absolute });
      }
      return absolute === original ? value : { ...value, value: absolute };
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = walk(child);
    return out;
  };
  return { json: walk(json), rewrites };
}

/**
 * 纯文本里的 `@相对路径` 换成 `@绝对路径`。只替换标签改写过的字符串，长路径优先，
 * 避免 `src/a` 把 `src/a.ts` 的前缀换了。
 */
export function rewriteComposerDraftText(text: string, rewrites: FileTagRewrite['rewrites']): string {
  if (!text || rewrites.length === 0) return text;
  let out = text;
  for (const { from, to } of [...rewrites].sort((a, b) => b.from.length - a.from.length)) {
    out = out.split(`@${from}`).join(`@${to}`);
  }
  return out;
}

/**
 * 把一份草稿的文件引用绝对化到来源项目。返回新对象；没有任何改写时返回原引用，
 * 便于调用方判断「要不要写回 store / 编辑器」。
 */
export function handoffComposerDraft(draft: ComposerDraft | string | null | undefined, sourceWorkspace: string): {
  draft: ComposerDraft;
  changed: boolean;
} {
  const normalized = normalizeComposerDraft(draft);
  if (!normalized.text || !sourceWorkspace.trim()) return { draft: normalized, changed: false };
  const { json, rewrites } = rewriteComposerFileTags(normalized.json, sourceWorkspace);
  if (rewrites.length === 0) return { draft: normalized, changed: false };
  return {
    draft: { text: rewriteComposerDraftText(normalized.text, rewrites), json },
    changed: true,
  };
}

export const EMPTY_HANDOFF: Readonly<{ draft: ComposerDraft; changed: false }> = Object.freeze({
  draft: normalizeComposerDraft(undefined),
  changed: false as const,
});

/** 待交接的草稿：sessionPath → 来源项目。移动成功后登记，第一次读/存这份草稿时转换。 */
const queued = new Map<string, string>();

type DraftHandoffListener = (sessionPath: string, sourceWorkspace: string) => void;
const listeners = new Set<DraftHandoffListener>();

/** 已经挂载的输入框据此把编辑器里的现行内容就地绝对化（否则它不会重新读草稿）。 */
export function subscribeDraftHandoff(listener: DraftHandoffListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function canonical(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function queueDraftHandoff(sessionPath: string, sourceWorkspace: string): void {
  if (!sessionPath.trim() || !sourceWorkspace.trim()) return;
  queued.set(canonical(sessionPath), sourceWorkspace);
  for (const listener of [...listeners]) listener(sessionPath, sourceWorkspace);
}

/** 登记过就把草稿里的相对文件标签绝对化；只在这份 sessionPath 上生效，绝不碰别的草稿。 */
export function applyQueuedDraftHandoff(sessionPath: string, draft: ComposerDraft | string | null | undefined): ComposerDraft {
  const normalized = normalizeComposerDraft(draft);
  if (!sessionPath.trim()) return normalized;
  const key = canonical(sessionPath);
  const source = queued.get(key);
  if (!source) return normalized;
  queued.delete(key);
  return handoffComposerDraft(normalized, source).draft;
}

export function hasQueuedDraftHandoff(sessionPath: string): boolean {
  return queued.has(canonical(sessionPath));
}

/** 已挂载的输入框直接转换现行草稿（不经过「下一次读/存」）。 */
export function handoffLiveDraft(draft: ComposerDraft | string | null | undefined, sourceWorkspace: string): ComposerDraft {
  return handoffComposerDraft(draft, sourceWorkspace).draft;
}

export function resetDraftHandoffs(): void {
  queued.clear();
}
