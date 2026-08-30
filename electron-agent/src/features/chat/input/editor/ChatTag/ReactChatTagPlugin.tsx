import { MarkdownPlugin, useLexicalComposerContext } from '@lobehub/editor';
import { type FC, useLayoutEffect } from 'react';
import { ChatTagPlugin } from './ChatTagPlugin';
import { ChatTagView } from './ChatTagView';

const ReactChatTagPlugin: FC = () => {
  const [editor] = useLexicalComposerContext();

  useLayoutEffect(() => {
    // 先确保 markdown 服务就绪：ChatTagPlugin.onInit 要 requireService(IMarkdownShortCutService)。
    editor.registerPlugin(MarkdownPlugin);
    editor.registerPlugin(ChatTagPlugin, {
      decorator: (node) => (
        <ChatTagView
          category={node.category}
          commandGroup={node.commandGroup}
          label={node.label}
          value={node.value}
        />
      ),
    });
  }, [editor]);

  return null;
};

ReactChatTagPlugin.displayName = 'ReactChatTagPlugin';

export default ReactChatTagPlugin;
