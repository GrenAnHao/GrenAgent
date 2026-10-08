import { useCallback, useEffect, useRef } from 'react';
import type { IEditor } from '@lobehub/editor';
import type { PiCommand } from '../commandTypes';
import { loadCommands } from './commandLoader';
import { resolveCommandTag, resolvePromptPill } from './commandPaste';
import { INSERT_CHAT_TAG_COMMAND } from './ChatTag/command';
import { getCachedPromptCommands, loadPromptCommands } from './promptCommandCache';
import { INSERT_COMMAND_PILL_COMMAND } from './CommandPill/commands';
import { $caretAtDocumentStart, $hasPill } from './CommandPill/composerText';

/**
 * 让「复制 `/命令` 粘贴进输入框」自动转成命令标签——和手动输入 `/` 选择命令一致。
 *
 * slash 菜单依赖键盘输入 `/` 触发，粘贴不会触发，于是粘贴的 `/goal` 只会变成纯文本。
 * 这里预加载工作区命令（与 slash 菜单共用缓存），粘贴时同步校验：是已知 api 命令才
 * 转成标签（顺带把参数接在标签后）；命令未加载完或不是命令时返回 false，放行默认粘贴。
 *
 * 带参数的命令模板转成命令胶囊：只能在整个输入的开头，且输入里还没有胶囊；
 * 不满足时按普通文本粘贴（返回 false），不退回命令标签。
 */
export function useCommandPaste(workspace: string, editor: IEditor) {
  const commandsRef = useRef<PiCommand[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadPromptCommands();
    if (workspace) {
      void loadCommands(workspace).then((commands) => {
        if (!cancelled) commandsRef.current = commands;
      });
    }
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const tryCommandPaste = useCallback(
    (text: string): boolean => {
      void loadPromptCommands();
      const pill = resolvePromptPill(getCachedPromptCommands(), text);
      if (pill) {
        const canInsert =
          editor.getLexicalEditor()?.getEditorState().read(() => $caretAtDocumentStart() && !$hasPill()) ?? false;
        if (!canInsert) return false;
        editor.dispatchCommand(INSERT_COMMAND_PILL_COMMAND, pill);
        return true;
      }
      const tag = resolveCommandTag(commandsRef.current, text);
      if (!tag) return false;
      editor.dispatchCommand(INSERT_CHAT_TAG_COMMAND, tag);
      return true;
    },
    [editor],
  );

  return { tryCommandPaste };
}
