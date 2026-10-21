import type { IEditor } from '@lobehub/editor';
import { readComposerText, writeComposerText } from './CommandPill/composerText';

/**
 * 输入框草稿：text 给发送、空态判断和老调用方用；json 是 lobehub `getDocument('json')` 的 `{ root }`，
 * 胶囊、@ 标签这类行内节点靠它原样恢复。文本为空时不带 json。
 * 见 .agents/notes/implemented/feature/2026-10-19-composer-draft-full-restore.md
 */
export interface ComposerDraft {
  text: string;
  json?: unknown;
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = Object.freeze({ text: '' }) as ComposerDraft;

/** 老草稿是纯字符串，统一成 ComposerDraft。 */
export function normalizeComposerDraft(draft: ComposerDraft | string | null | undefined): ComposerDraft {
  if (!draft) return EMPTY_COMPOSER_DRAFT;
  if (typeof draft === 'string') return draft ? { text: draft } : EMPTY_COMPOSER_DRAFT;
  if (!draft.text) return EMPTY_COMPOSER_DRAFT;
  return draft.json === undefined ? { text: draft.text } : draft;
}

function hasSerializedRoot(json: unknown): json is { root: unknown } {
  return typeof json === 'object' && json !== null && 'root' in json && typeof (json as { root: unknown }).root === 'object';
}

/** 读当前输入框：文本照 readComposerText，JSON 只在拿得到 Lexical 实例且有内容时带上。 */
export function readComposerDraft(editor: IEditor): ComposerDraft {
  const text = readComposerText(editor);
  if (!text) return EMPTY_COMPOSER_DRAFT;
  if (!editor.getLexicalEditor?.()) return { text };
  try {
    const json = editor.getDocument('json');
    return hasSerializedRoot(json) ? { text, json } : { text };
  } catch {
    return { text };
  }
}

/**
 * 写回输入框：有 json 先按 JSON 恢复（胶囊、标签都在）；解析失败（节点类型没注册、格式变了）
 * 或没有 json 时退回纯文本。
 */
export function writeComposerDraft(editor: IEditor, draft: ComposerDraft | string | null | undefined): void {
  const normalized = normalizeComposerDraft(draft);
  if (hasSerializedRoot(normalized.json) && editor.getLexicalEditor?.()) {
    try {
      editor.setDocument('json', normalized.json);
      return;
    } catch {
      /* 退回文本 */
    }
  }
  writeComposerText(editor, normalized.text);
}

/** 两份草稿内容相同（text 相同且 json 序列化相同）。 */
export function composerDraftEquals(a: ComposerDraft, b: ComposerDraft): boolean {
  if (a.text !== b.text) return false;
  if (a.json === b.json) return true;
  if (a.json === undefined || b.json === undefined) return false;
  try {
    return JSON.stringify(a.json) === JSON.stringify(b.json);
  } catch {
    return false;
  }
}
