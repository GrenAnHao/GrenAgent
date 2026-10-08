import { useCallback, useEffect, useRef } from 'react';
import type { IEditor } from '@lobehub/editor';
import type { PiCommand } from '../commandTypes';
import { loadCommands } from './commandLoader';
import { resolveCommandTag, resolvePromptPill } from './commandPaste';
import { INSERT_CHAT_TAG_COMMAND } from './ChatTag/command';
import { loadPromptCommands } from './promptCommandCache';
import { INSERT_COMMAND_PILL_COMMAND } from './CommandPill/commands';
import { $caretAtDocumentStart } from './CommandPill/composerText';
import type { PromptCommandInfo } from '../../../../lib/promptLibraryIo';

/**
 * 让「复制 `/命令` 粘贴进输入框」自动转成命令标签——和手动输入 `/` 选择命令一致。
 *
 * slash 菜单依赖键盘输入 `/` 触发，粘贴不会触发，于是粘贴的 `/goal` 只会变成纯文本。
 * 这里预加载工作区命令（与 slash 菜单共用缓存），粘贴时同步校验：是已知 api 命令才
 * 转成标签（顺带把参数接在标签后）；命令未加载完或不是命令时返回 false，放行默认粘贴。
 */
export function useCommandPaste(workspace: string, editor: IEditor) {
  const commandsRef = useRef<PiCommand[]>([]);
  const templatesRef = useRef<PromptCommandInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadPromptCommands()
      .then((templates) => {
        if (!cancelled) templatesRef.current = templates;
      })
      .catch(() => {});
    if (!workspace) {
      return () => {
        cancelled = true;
      };
    }
    void loadCommands(workspace)
      .then((commands) => {
        if (!cancelled) commandsRef.current = commands;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const tryCommandPaste = useCallback(
    (text: string): boolean => {
      const pill = resolvePromptPill(templatesRef.current, text);
      const atStart = editor.getLexicalEditor()?.getEditorState().read($caretAtDocumentStart) ?? false;
      if (pill && atStart) {
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
