import { useCallback } from 'react';
import type { IEditor } from '@lobehub/editor';
import { resolveUrlTag } from './urlPaste';
import { INSERT_CHAT_TAG_COMMAND } from './ChatTag/command';

/**
 * 让「粘贴一条 URL 进输入框」自动转成链接标签——与 /命令 粘贴同构。
 * 仅当整条粘贴文本就是单个 http(s) URL 时转标签；否则返回 false 放行默认粘贴。
 */
export function useUrlPaste(editor: IEditor) {
  const tryUrlPaste = useCallback(
    (text: string): boolean => {
      const tag = resolveUrlTag(text);
      if (!tag) return false;
      editor.dispatchCommand(INSERT_CHAT_TAG_COMMAND, tag);
      return true;
    },
    [editor],
  );
  return { tryUrlPaste };
}
