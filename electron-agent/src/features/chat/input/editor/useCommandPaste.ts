import { useCallback, useEffect, useRef } from 'react';
import type { IEditor } from '@lobehub/editor';
import type { PiCommand } from '../commandTypes';
import { loadCommands } from './commandLoader';
import { resolveCommandTag } from './commandPaste';
import { INSERT_CHAT_TAG_COMMAND } from './ChatTag/command';

/**
 * 让「复制 `/命令` 粘贴进输入框」自动转成命令标签——和手动输入 `/` 选择命令一致。
 *
 * slash 菜单依赖键盘输入 `/` 触发，粘贴不会触发，于是粘贴的 `/goal` 只会变成纯文本。
 * 这里预加载工作区命令（与 slash 菜单共用缓存），粘贴时同步校验：是已知 api 命令才
 * 转成标签（顺带把参数接在标签后）；命令未加载完或不是命令时返回 false，放行默认粘贴。
 */
export function useCommandPaste(workspace: string, editor: IEditor) {
  const commandsRef = useRef<PiCommand[]>([]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
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
      const tag = resolveCommandTag(commandsRef.current, text);
      if (!tag) return false;
      editor.dispatchCommand(INSERT_CHAT_TAG_COMMAND, tag);
      return true;
    },
    [editor],
  );

  return { tryCommandPaste };
}
