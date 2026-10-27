import { App, type MenuProps } from 'antd';
import { useCallback } from 'react';
import { revealInFolderLabel } from '../../lib/revealLabel';
import { revealItemInDir } from '../../platform/runtime';
import { addFileToComposer } from '../chat/input/composerBridge';
import { displayPath } from './filePathDisplay';
import type { TreeMenuTarget } from './FileTree';
import { relativeSegments } from './treeModel';

export type FileTreeMenuKey = 'add-to-chat' | 'reveal' | 'copy-path' | 'copy-relative-path';

/**
 * 文件树的右键菜单：添加到对话 / 在系统文件管理器中显示 / 复制路径 / 复制相对路径。
 * root 是文件树的根（realpath 后），相对路径相对它算，和路径栏一致；workspace 是标签的工作区，交给输入框判断该写相对还是绝对路径。
 */
export function useFileTreeMenu(root: string | null, workspace: string): (target: TreeMenuTarget) => MenuProps {
  const { message } = App.useApp();

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text).then(
        () => void message.success(`已复制：${text}`),
        () => void message.error('复制失败，剪贴板不可用'),
      );
    },
    [message],
  );

  return useCallback(
    (target: TreeMenuTarget): MenuProps => {
      const segments = root ? relativeSegments(root, target.path) : null;
      const relative = segments && segments.length > 0 ? segments.join('/') : null;
      const run = (key: FileTreeMenuKey) => {
        switch (key) {
          case 'add-to-chat': {
            const added = addFileToComposer({
              absolute: target.path,
              relative,
              workspace,
              name: target.name,
              isDirectory: target.isDir,
            });
            if (!added) void message.warning('当前没有可以添加的对话输入框');
            return;
          }
          case 'reveal':
            revealItemInDir(target.path).catch((err: unknown) => {
              void message.error(`无法在文件管理器中显示：${err instanceof Error ? err.message : String(err)}`);
            });
            return;
          case 'copy-path':
            copy(target.path);
            return;
          case 'copy-relative-path':
            copy(displayPath(root, target.path, 'relative'));
        }
      };
      return {
        items: [
          { key: 'add-to-chat', label: '添加到对话' },
          { type: 'divider' },
          { key: 'reveal', label: revealInFolderLabel() },
          { type: 'divider' },
          { key: 'copy-path', label: '复制路径' },
          { key: 'copy-relative-path', label: '复制相对路径' },
        ],
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          run(key as FileTreeMenuKey);
        },
      };
    },
    [root, workspace, message, copy],
  );
}
