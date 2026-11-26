import { Copy, MessageSquarePlus } from 'lucide-react';
import { addFileToComposer } from '../chat/input/composerBridge';
import { useModuleStore } from '../../stores/moduleStore';
import { sourcePath } from './codeSourcePath';
import { browseStyles as s } from './codeBrowseStyles';

export type IndexNotice = (kind: 'success' | 'error' | 'info', text: string) => void;
export function IndexFileActions({
  workspace,
  file,
  notice,
}: {
  workspace: string;
  file: string;
  notice: IndexNotice;
}) {
  const path = sourcePath(workspace, file);
  if (!path) return null;
  async function copy() {
    try {
      await navigator.clipboard.writeText(path!.relative);
      notice('success', '已复制相对路径');
    } catch (e) {
      notice('error', '无法复制路径：' + String(e));
    }
  }
  function attach() {
    const added = addFileToComposer({
      ...path!,
      workspace,
      name: path!.relative.split('/').pop()!,
      isDirectory: false,
    });
    if (!added) {
      notice('info', '请先打开一个对话，再添加文件。');
      return;
    }
    useModuleStore.getState().setActiveModule('chat');
  }
  return (
    <span data-file-actions className={s.fileActions}>
      <button type="button" aria-label="复制相对路径" title="复制相对路径" onClick={() => void copy()}>
        <Copy size={14} />
      </button>
      <button type="button" aria-label="添加到对话上下文" title="添加到当前对话的输入框" onClick={attach}>
        <MessageSquarePlus size={15} />
      </button>
    </span>
  );
}
