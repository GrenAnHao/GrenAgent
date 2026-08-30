import { getKernelFromEditor, IMarkdownShortCutService } from '@lobehub/editor';
import type { LexicalEditor, LexicalNode } from 'lexical';
import { $isChatTagNode, ChatTagNode } from './ChatTagNode';
import { registerChatTagCommand } from './command';
import { tagToText } from './tagText';

// IEditorKernel 未从包根导出，从 getKernelFromEditor 的返回类型推导。
type EditorKernel = NonNullable<ReturnType<typeof getKernelFromEditor>>;

export interface ChatTagPluginOptions {
  decorator: (node: ChatTagNode, editor: LexicalEditor) => unknown;
}

/** 注册 ChatTagNode、它的 React decorator，以及 markdown 序列化（@路径 / /命令）。 */
export class ChatTagPlugin {
  static pluginName = 'ChatTagPlugin';

  config?: ChatTagPluginOptions;
  private kernel: EditorKernel;
  private clears: Array<() => void> = [];

  constructor(kernel: EditorKernel, config?: ChatTagPluginOptions) {
    this.kernel = kernel;
    this.config = config;

    kernel.registerNodes([ChatTagNode]);
    kernel.registerDecorator(ChatTagNode.getType(), (node: LexicalNode, editor: LexicalEditor) =>
      this.config?.decorator ? this.config.decorator(node as ChatTagNode, editor) : null,
    );
  }

  onInit(editor: LexicalEditor): void {
    this.clears.push(registerChatTagCommand(editor));

    const markdown = this.kernel.requireService(IMarkdownShortCutService);
    markdown?.registerMarkdownWriter(
      ChatTagNode.getType(),
      (ctx: { appendLine: (line: string) => void }, node: LexicalNode) => {
        if ($isChatTagNode(node)) ctx.appendLine(tagToText(node.category, node.value));
      },
    );
  }

  destroy(): void {
    this.clears.forEach((clear) => clear());
    this.clears = [];
    this.kernel.unregisterDecorator?.(ChatTagNode.getType());
  }
}
