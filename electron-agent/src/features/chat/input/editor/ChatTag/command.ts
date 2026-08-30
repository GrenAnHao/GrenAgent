import { $wrapNodeInElement } from '@lexical/utils';
import {
  $createParagraphNode,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_HIGH,
  createCommand,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';
import { $createChatTagNode } from './ChatTagNode';
import type { ChatTagData } from './types';

export const INSERT_CHAT_TAG_COMMAND: LexicalCommand<ChatTagData> =
  createCommand('INSERT_CHAT_TAG_COMMAND');

export function registerChatTagCommand(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    INSERT_CHAT_TAG_COMMAND,
    (payload) => {
      editor.update(() => {
        const node = $createChatTagNode(
          payload.category,
          payload.label,
          payload.value,
          payload.commandGroup,
        );
        $insertNodes([node]);
        if ($isRootOrShadowRoot(node.getParentOrThrow())) {
          $wrapNodeInElement(node, $createParagraphNode).selectEnd();
        }
        // 尾随空格，便于继续输入且与后续文本分隔；粘贴带参数时把参数接在空格之后。
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(payload.trailingText ? ` ${payload.trailingText}` : ' ');
        }
      });
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}
