import { getKernelFromEditor } from '@lobehub/editor';
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { tagToText } from './tagText';
import type { ChatTagCategory, ChatTagCommandGroup } from './types';

export type SerializedChatTagNode = Spread<
  {
    category: ChatTagCategory;
    commandGroup?: ChatTagCommandGroup;
    label: string;
    value: string;
  },
  SerializedLexicalNode
>;

/** 行内彩色标签节点（文件/目录/命令）。渲染交给注册的 decorator，序列化交给 ChatTagPlugin。 */
export class ChatTagNode extends DecoratorNode<unknown> {
  __category: ChatTagCategory;
  __label: string;
  __value: string;
  __commandGroup?: ChatTagCommandGroup;

  static getType(): string {
    return 'chat-tag';
  }

  static clone(node: ChatTagNode): ChatTagNode {
    return new ChatTagNode(
      node.__category,
      node.__label,
      node.__value,
      node.__commandGroup,
      node.__key,
    );
  }

  static importJSON(serializedNode: SerializedChatTagNode): ChatTagNode {
    return $createChatTagNode(
      serializedNode.category,
      serializedNode.label,
      serializedNode.value,
      serializedNode.commandGroup,
    ).updateFromJSON(serializedNode);
  }

  static importDOM(): null {
    return null;
  }

  constructor(
    category: ChatTagCategory,
    label: string,
    value: string,
    commandGroup?: ChatTagCommandGroup,
    key?: string,
  ) {
    super(key);
    this.__category = category;
    this.__label = label;
    this.__value = value;
    this.__commandGroup = commandGroup;
  }

  get category(): ChatTagCategory {
    return this.__category;
  }

  get label(): string {
    return this.__label;
  }

  get value(): string {
    return this.__value;
  }

  get commandGroup(): ChatTagCommandGroup | undefined {
    return this.__commandGroup;
  }

  exportDOM(): DOMExportOutput {
    return { element: document.createElement('span') };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    return document.createElement('span');
  }

  getTextContent(): string {
    return tagToText(this.__category, this.__value);
  }

  isInline(): true {
    return true;
  }

  updateDOM(): boolean {
    return false;
  }

  exportJSON(): SerializedChatTagNode {
    return {
      ...super.exportJSON(),
      category: this.__category,
      commandGroup: this.__commandGroup,
      label: this.__label,
      value: this.__value,
    };
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedChatTagNode>): this {
    return super.updateFromJSON(serializedNode);
  }

  decorate(editor: LexicalEditor): unknown {
    const decorator = getKernelFromEditor(editor)?.getDecorator(ChatTagNode.getType());
    if (!decorator) return null;
    if (typeof decorator === 'function') return decorator(this, editor);
    return {
      queryDOM: decorator.queryDOM,
      render: decorator.render(this, editor),
    };
  }
}

export function $createChatTagNode(
  category: ChatTagCategory,
  label: string,
  value: string,
  commandGroup?: ChatTagCommandGroup,
): ChatTagNode {
  return $applyNodeReplacement(new ChatTagNode(category, label, value, commandGroup));
}

export function $isChatTagNode(node: LexicalNode | null | undefined): node is ChatTagNode {
  return node?.getType() === ChatTagNode.getType();
}
