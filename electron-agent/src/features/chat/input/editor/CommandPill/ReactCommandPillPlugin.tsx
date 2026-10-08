import { MarkdownPlugin, useLexicalComposerContext } from '@lobehub/editor';
import { type FC, useLayoutEffect } from 'react';
import { CommandPillEditor } from './CommandPillEditor';
import { CommandPillPlugin } from './CommandPillPlugin';

const ReactCommandPillPlugin: FC = () => {
  const [editor] = useLexicalComposerContext();

  useLayoutEffect(() => {
    // 先确保 markdown 服务就绪：CommandPillPlugin.onInit 要 requireService(IMarkdownShortCutService)。
    editor.registerPlugin(MarkdownPlugin);
    editor.registerPlugin(CommandPillPlugin, {
      decorator: (node, lexical) => (
        <CommandPillEditor
          editor={lexical}
          nodeKey={node.getKey()}
          name={node.name}
          params={node.params}
          values={node.values}
        />
      ),
    });
  }, [editor]);

  return null;
};

ReactCommandPillPlugin.displayName = 'ReactCommandPillPlugin';

export default ReactCommandPillPlugin;
