import type { IEditor } from '@lobehub/editor';
import { $dfs } from '@lexical/utils';
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import { $isCommandPillNode, PILL_MARKER, type CommandPillNode } from './CommandPillNode';
import { FOCUS_PILL_ARG_COMMAND } from './commands';

function $firstPill(): CommandPillNode | null {
  for (const { node } of $dfs($getRoot())) if ($isCommandPillNode(node)) return node;
  return null;
}

/** 输入里已经有胶囊：一个输入只允许一个。 */
export function $hasPill(): boolean {
  return $firstPill() !== null;
}

export function readPillInvocation(editor: LexicalEditor | null | undefined): string | null {
  if (!editor) return null;
  return editor.getEditorState().read(() => $firstPill()?.invocation() ?? null);
}

/**
 * 去掉胶囊标记，调用文本总是放在最前面，与剩余正文之间隔一个空格。
 * 扩展只认以 `/名` 开头的文本：用户用方向键把光标移到胶囊前打了字，命令也要仍然生效；
 * 标记后面直接跟文字（`/a "x"顺便`）时也要补上空格，不然最后一个参数会和正文粘在一起。
 * 没有调用文本时（拿不到 lexical 实例）只删标记，其余原样。
 */
export function substitutePillMarker(markdown: string, invocation: string | null): string {
  if (!markdown.includes(PILL_MARKER)) return markdown;
  const [head, ...tail] = markdown.split(PILL_MARKER);
  if (invocation === null) return `${head}${tail.join('')}`;
  const rest = [head.trim(), tail.join('').trim()].filter(Boolean).join(' ');
  return rest ? `${invocation} ${rest}` : invocation;
}

/**
 * 节点的纯文本：块之间一个换行，胶囊写 PILL_MARKER，其余用节点自己的 getTextContent
 * （文本原样、换行节点 `\n`、标签 `@路径` / `/命令` / URL）。
 * 和 Lexical 自带的 getTextContent 只差两处：块间不是两个换行，胶囊不直接写调用文本。
 */
function $plainText(node: LexicalNode): string {
  if ($isCommandPillNode(node)) return PILL_MARKER;
  if (!$isElementNode(node)) return node.getTextContent();
  const children = node.getChildren();
  return children
    .map((child, i) => {
      const text = $plainText(child);
      const blockEnd = $isElementNode(child) && !child.isInline() && i < children.length - 1;
      return blockEnd ? `${text}\n` : text;
    })
    .join('');
}

/**
 * 整个输入框的纯文本（胶囊位置是 PILL_MARKER）。
 *
 * 不走 getDocument('markdown')：@lobehub/editor 写出 markdown 后会再过一遍 remark-gfm 格式化，
 * `*` `[` `~` `_` 被加反斜杠，`* ` / `+ ` 开头的行改成 `- `，续行缩进被吃掉，`&amp;` 被解码成 `&`。
 * 这个输入框关了 markdown 格式（markdownOption: false），里面只有纯文本、标签和胶囊，用户打什么就该发什么。
 * Shift+Enter 在这个编辑器里是新段落，所以块之间写一个换行，和用户看到的行一致。
 * 见 .agents/notes/implemented/bug-fix/2026-10-19-composer-plain-text.md
 */
export function $readComposerPlainText(): string {
  return $plainText($getRoot()).replaceAll('\uFEFF', '');
}

/** 输入框正文：直接从 Lexical 树读纯文本，再把胶囊标记换成调用文本。发送和存草稿都用它。 */
export function readComposerText(editor: IEditor): string {
  const lexical = editor.getLexicalEditor?.();
  const text = lexical
    ? lexical.getEditorState().read(() => $readComposerPlainText())
    : String(editor.getDocument('text') || '');
  return substitutePillMarker(text, readPillInvocation(lexical));
}

/**
 * 把纯文本写回输入框（草稿恢复、发送失败回填、编辑消息、撤回引导）：每行一个段落，
 * 和 readComposerText 互逆。不用 setDocument('markdown')，否则 `* a` 这类文本会先被当成 markdown 解析。
 */
export function writeComposerText(editor: IEditor, text: string): void {
  if (text) editor.setDocument('text', text.replace(/\r\n?/g, '\n'));
  else editor.cleanDocument();
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
