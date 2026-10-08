import { getKernelFromEditor, IMarkdownShortCutService } from '@lobehub/editor';
import type { LexicalEditor, LexicalNode } from 'lexical';
import { $isCommandPillNode, CommandPillNode, PILL_MARKER } from './CommandPillNode';
import { registerCommandPillCommands } from './commands';

// IEditorKernel 未从包根导出，从 getKernelFromEditor 的返回类型推导。
type EditorKernel = NonNullable<ReturnType<typeof getKernelFromEditor>>;

export interface CommandPillPluginOptions {
  decorator: (node: CommandPillNode, editor: LexicalEditor) => unknown;
}

/** 注册 CommandPillNode、它的 React decorator，以及 markdown 写出（写占位标记，见 PILL_MARKER）。 */
export class CommandPillPlugin {
  static pluginName = 'CommandPillPlugin';

  config?: CommandPillPluginOptions;
  private kernel: EditorKernel;
  private clears: Array<() => void> = [];

  constructor(kernel: EditorKernel, config?: CommandPillPluginOptions) {
    this.kernel = kernel;
    this.config = config;
    kernel.registerNodes([CommandPillNode]);
    kernel.registerDecorator(CommandPillNode.getType(), (node: LexicalNode, editor: LexicalEditor) =>
      this.config?.decorator ? this.config.decorator(node as CommandPillNode, editor) : null,
    );
  }

  onInit(editor: LexicalEditor): void {
    this.clears.push(registerCommandPillCommands(editor));
    const markdown = this.kernel.requireService(IMarkdownShortCutService);
    markdown?.registerMarkdownWriter(
      CommandPillNode.getType(),
      (ctx: { appendLine: (line: string) => void }, node: LexicalNode) => {
        if ($isCommandPillNode(node)) ctx.appendLine(PILL_MARKER);
      },
    );
  }

  destroy(): void {
    this.clears.forEach((clear) => clear());
    this.clears = [];
    this.kernel.unregisterDecorator?.(CommandPillNode.getType());
  }
}
