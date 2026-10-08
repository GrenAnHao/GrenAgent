import type { IEditor } from '@lobehub/editor';
import { $dfs } from '@lexical/utils';
import { $getRoot, $getSelection, $isElementNode, $isRangeSelection, type LexicalEditor } from 'lexical';
import { unescapeComposerMarkdown } from '../../unescapeComposerMarkdown';
import { $isCommandPillNode, PILL_MARKER, type CommandPillNode } from './CommandPillNode';
import { FOCUS_PILL_ARG_COMMAND } from './commands';

function $firstPill(): CommandPillNode | null {
  for (const { node } of $dfs($getRoot())) if ($isCommandPillNode(node)) return node;
  return null;
}

export function readPillInvocation(editor: LexicalEditor | null | undefined): string | null {
  if (!editor) return null;
  return editor.getEditorState().read(() => $firstPill()?.invocation() ?? null);
}

export function substitutePillMarker(markdown: string, invocation: string | null): string {
  if (!markdown.includes(PILL_MARKER)) return markdown;
  const [head, ...tail] = markdown.split(PILL_MARKER);
  return `${head}${invocation ?? ''}${tail.join('')}`;
}

/** 输入框正文：markdown 去转义，再把胶囊标记换成调用文本。发送和存草稿都用它。 */
export function readComposerText(editor: IEditor): string {
  const markdown = unescapeComposerMarkdown(String(editor.getDocument('markdown') || ''));
  return substitutePillMarker(markdown, readPillInvocation(editor.getLexicalEditor?.()));
}

/** 发送前检查：有必填参数空着就把焦点送过去并返回 true，调用方不再发送。 */
export function focusMissingPillArg(editor: LexicalEditor | null | undefined): boolean {
  if (!editor) return false;
  const missing = editor.getEditorState().read(() => {
    const pill = $firstPill();
    if (!pill) return null;
    const index = pill.params.findIndex((param, i) => param.defaultValue === undefined && pill.values[i] === '');
    return index === -1 ? null : { key: pill.getKey(), index };
  });
  if (!missing) return false;
  editor.dispatchCommand(FOCUS_PILL_ARG_COMMAND, { ...missing, invalid: true });
  return true;
}

/** 光标在整个输入的最开头：胶囊只能放这里，扩展只认以 /名 开头的文本。 */
export function $caretAtDocumentStart(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  const first = $getRoot().getFirstChild();
  if (!first) return true;
  if (!$isElementNode(first)) return false;
  const anchor = selection.anchor;
  const node = anchor.getNode();
  if (anchor.type === 'element') return node.is(first) && anchor.offset === 0;
  const firstLeaf = first.getFirstDescendant();
  return firstLeaf !== null && node.is(firstLeaf) && anchor.offset === 0;
}

/** 斜杠菜单打开时：`/查询` 是不是整个输入的开头（前面只允许空白）。 */
export function $slashAtDocumentStart(query: string): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const first = $getRoot().getFirstChild();
  if (!first || !$isElementNode(first)) return false;
  const node = selection.anchor.getNode();
  if (!node.is(first.getFirstDescendant())) return false;
  return node.getTextContent().slice(0, selection.anchor.offset).trimStart() === `/${query}`;
}
