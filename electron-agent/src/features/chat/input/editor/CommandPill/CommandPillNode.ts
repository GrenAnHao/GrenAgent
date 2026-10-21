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
import { formatInvocation, type PromptParam } from '@extensions/prompt-commands/syntax';

/**
 * 读输入框正文（readComposerText）和 markdown 写出时，胶囊位置放这个私用区字符，
 * 再由 substitutePillMarker 换成调用文本并挪到最前面：扩展只认以 `/名` 开头的文本。
 */
export const PILL_MARKER = String.fromCharCode(0xe000);

export type SerializedCommandPillNode = Spread<
  { name: string; params: PromptParam[]; values: string[] },
  SerializedLexicalNode
>;

/** 输入框里的命令胶囊：命令名 + 每个参数的当前值。渲染交给注册的 decorator。 */
export class CommandPillNode extends DecoratorNode<unknown> {
  __name: string;
  __params: PromptParam[];
  __values: string[];

  static getType(): string {
    return 'command-pill';
  }

  static clone(node: CommandPillNode): CommandPillNode {
    return new CommandPillNode(node.__name, node.__params, node.__values, node.__key);
  }

  static importJSON(serialized: SerializedCommandPillNode): CommandPillNode {
    return $createCommandPillNode(serialized.name, serialized.params, serialized.values).updateFromJSON(serialized);
  }

  static importDOM(): null {
    return null;
  }

  constructor(name: string, params: PromptParam[], values: readonly string[], key?: string) {
    super(key);
    this.__name = name;
    this.__params = params;
    this.__values = params.map((_, index) => values[index] ?? '');
  }

  get name(): string {
    return this.__name;
  }

  get params(): PromptParam[] {
    return this.__params;
  }

  get values(): string[] {
    return this.__values;
  }

  setValue(index: number, value: string): this {
    const writable = this.getWritable();
    writable.__values = writable.__values.map((current, i) => (i === index ? value : current));
    return writable;
  }

  invocation(): string {
    return formatInvocation(this.__name, this.__values);
  }

  getTextContent(): string {
    return this.invocation();
  }

  exportDOM(): DOMExportOutput {
    return { element: document.createElement('span') };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    return document.createElement('span');
  }

  isInline(): true {
    return true;
  }

  updateDOM(): boolean {
    return false;
  }

  exportJSON(): SerializedCommandPillNode {
    return { ...super.exportJSON(), name: this.__name, params: this.__params, values: this.__values };
  }

  updateFromJSON(serialized: LexicalUpdateJSON<SerializedCommandPillNode>): this {
    return super.updateFromJSON(serialized);
  }

  decorate(editor: LexicalEditor): unknown {
    const decorator = getKernelFromEditor(editor)?.getDecorator(CommandPillNode.getType());
    if (!decorator) return null;
    if (typeof decorator === 'function') return decorator(this, editor);
    return { queryDOM: decorator.queryDOM, render: decorator.render(this, editor) };
  }
}

export function $createCommandPillNode(name: string, params: PromptParam[], values: readonly string[]): CommandPillNode {
  return $applyNodeReplacement(new CommandPillNode(name, params, values));
}

export function $isCommandPillNode(node: LexicalNode | null | undefined): node is CommandPillNode {
  return node?.getType() === CommandPillNode.getType();
}
