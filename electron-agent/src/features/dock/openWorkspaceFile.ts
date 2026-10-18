import { files } from '../../lib/files';
import { openPath } from '../../platform/runtime';
import { useFileOpenRequests } from '../../stores/fileOpenRequests';
import { fileKindOf } from '../fileExplorer/fileKinds';
import { openLauncherTab } from './openLauncherTab';

export type OpenWorkspaceFileResult = 'dock' | 'system';

/**
 * 「可读」沿用文件浏览器现有规则，不另立标准：图片扩展名直接进右侧预览；其余先读一次（`read_file_view`），
 * 含 NUL 的二进制或超过读取上限（truncated）的交给系统程序，其余在右侧「文件」标签里打开。
 * 读失败（不存在、权限不足）不回退系统打开，交给右侧标签显示内联错误态。
 *
 * path 是绝对路径，workspace 是能读到它的根目录（调用方用 resolveSessionFile 的 absolute / root）：
 * 文件在项目工作区之外（会话切过工作目录、绝对路径写到其它盘）时，这里传的是那个目录，
 * “文件”标签按它开（主进程的沙箱根就是这个值，读盘不会越界）。
 * 系统打开失败会抛错，由调用方展示。
 */
export async function openWorkspaceFile(path: string, workspace: string): Promise<OpenWorkspaceFileResult> {
  if (fileKindOf(path) !== 'image') {
    let needsSystem = false;
    try {
      const view = await files.readView(workspace, path);
      needsSystem = view.kind === 'binary' || view.truncated;
    } catch {
      needsSystem = false;
    }
    if (needsSystem) {
      await openPath(path);
      return 'system';
    }
  }
  const tabId = openLauncherTab({ region: 'right', kind: 'file', workspace });
  if (!tabId) {
    await openPath(path);
    return 'system';
  }
  useFileOpenRequests.getState().request(tabId, path);
  return 'dock';
}
