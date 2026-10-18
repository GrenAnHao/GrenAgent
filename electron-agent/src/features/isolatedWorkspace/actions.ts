import { message as staticMessage } from 'antd';
import { pi } from '../../lib/pi';
import { isolatedErrorText } from '../../lib/isolatedWorkspace';
import { useIsolatedWorkspaceStore } from '../../stores/isolatedWorkspaceStore';
import { useSessionStore } from '../../store/session';
import { pathsEquivalent } from '../../lib/pathUtils';

/**
 * 打开会话前调用：会话所在的独立工作区已经删除（目录不在，运行时开不起来）时改成只读查看，返回 true；
 * 否则返回 false，调用方照常切会话。
 */
export function openReadonlyIfIsolatedGone(cwd: string, sessionPath: string): boolean {
  const store = useIsolatedWorkspaceStore.getState();
  if (store.kinds[cwd] !== 'missing') return false;
  const session = useSessionStore.getState().allSessions.find((s) => pathsEquivalent(s.path, sessionPath));
  store.openViewer(sessionPath, session?.name || '会话记录（只读）');
  return true;
}

interface MessageApi {
  success: (content: string) => unknown;
  error: (content: string) => unknown;
}

/** 回传：把 W 的 gren/<id> 快进到主仓同名分支。分叉、主仓检出了该分支时报 git 原文。 */
export async function syncBackIsolated(parentRoot: string, id: string, api?: Partial<MessageApi>): Promise<boolean> {
  // App.useApp() 在没有 antd <App> 包裹的地方返回空对象，退回静态 message。
  const message: MessageApi = api?.success && api.error ? (api as MessageApi) : staticMessage;
  try {
    const { branch, commit } = await pi.syncBackIsolatedWorkspace(parentRoot, id);
    message.success(`已回传：主仓分支 ${branch} → ${commit.slice(0, 7)}`);
    useIsolatedWorkspaceStore.getState().bump();
    return true;
  } catch (error) {
    message.error(`回传失败：${isolatedErrorText(error)}`);
    return false;
  }
}
