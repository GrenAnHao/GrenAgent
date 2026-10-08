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
import type { PromptParam } from '@extensions/prompt-commands/syntax';
import { $createCommandPillNode } from './CommandPillNode';

export interface InsertCommandPillPayload {
  name: string;
  params: PromptParam[];
  /** 粘贴时已经解析出的参数值。 */
  values?: string[];
  /** 粘贴时参数之后的补充正文，接在胶囊后面。 */
  trailingText?: string;
}

export interface FocusPillArgPayload {
  key: string;
  index: number;
  /** 发送被拦下时为 true：参数段描边变红并抖一下。 */
  invalid: boolean;
}

export const INSERT_COMMAND_PILL_COMMAND: LexicalCommand<InsertCommandPillPayload> = createCommand('INSERT_COMMAND_PILL_COMMAND');
export const FOCUS_PILL_ARG_COMMAND: LexicalCommand<FocusPillArgPayload> = createCommand('FOCUS_PILL_ARG_COMMAND');

/** 刚插入的胶囊要聚焦哪个参数。节点挂载时由 CommandPillEditor 取走。 */
const pendingFocus = new Map<string, number>();

export function takePillFocus(key: string): number | undefined {
  const index = pendingFocus.get(key);
  pendingFocus.delete(key);
  return index;
}

export function registerCommandPillCommands(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    INSERT_COMMAND_PILL_COMMAND,
    (payload) => {
      editor.update(() => {
        const node = $createCommandPillNode(payload.name, payload.params, payload.values ?? []);
        $insertNodes([node]);
        if ($isRootOrShadowRoot(node.getParentOrThrow())) {
          $wrapNodeInElement(node, $createParagraphNode).selectEnd();
        }
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(payload.trailingText ? ` ${payload.trailingText}` : ' ');
        }
        const firstEmpty = node.values.findIndex((value) => value === '');
        if (firstEmpty !== -1) pendingFocus.set(node.getKey(), firstEmpty);
      });
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}
