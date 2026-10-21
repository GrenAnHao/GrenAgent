import type { CodeGraphStatus } from '../../lib/agentData';

export interface CodeIndexView {
  label: string;
  color: 'default' | 'success' | 'warning' | 'error' | 'processing';
  banner?: { type: 'info' | 'warning' | 'error'; message: string; sync: boolean };
  canQuery: boolean;
  /** 页头主按钮：同步索引 / 建立索引 / 不显示可用按钮。 */
  primary: 'sync' | 'build' | 'none';
}

const LOCKED = 'CODEGRAPH_LOCKED';

/**
 * 把 CodeGraph 状态映射成页面呈现；检查中与读取失败优先。
 * 增量同步（phase syncing / queued）期间照常可查，结果是上一次提交的索引；只有全量重建（state indexing）不可查。
 */
export function codeIndexPresentation({ status, checking, error, now = Date.now() }: { status?: CodeGraphStatus; checking: boolean; error?: string; now?: number }): CodeIndexView {
  if (error) return { label: '未获取', color: 'default', banner: { type: 'error', message: `${error}${status ? ' 当前保留上次成功读取的索引状态。' : ''}`, sync: false }, canQuery: false, primary: 'none' };
  if (checking || !status) return { label: '检查中', color: 'default', canQuery: false, primary: 'none' };
  const state = status.state?.toLowerCase().replace(/-/g, '_');
  if (status.sdkAvailable === false || state === 'sdk_unavailable') return { label: 'SDK 不可用', color: 'error', banner: { type: 'error', message: `内置 CodeGraph SDK 不可用，请检查安装包${status.message ? `：${status.message}` : ''}`, sync: false }, canQuery: false, primary: 'none' };
  if (state === 'indexing') return { label: '索引中', color: 'processing', banner: { type: 'info', message: '正在重建索引，完成前暂不能查询', sync: false }, canQuery: false, primary: 'none' };
  if (!status.indexed || state === 'unavailable') return { label: '未索引', color: 'default', canQuery: false, primary: 'build' };
  if (status.phase === 'syncing' || status.phase === 'queued') return { label: '同步中', color: 'processing', canQuery: true, primary: 'sync' };
  if (status.phase === 'backoff' && status.lastError?.code === LOCKED) {
    return { label: '等待重试', color: 'warning', banner: { type: 'warning', message: `另一个程序正在写这个项目的索引（codegraph.lock）${retryText(status.nextRetryAt, now)}`, sync: false }, canQuery: true, primary: 'sync' };
  }
  if (state === 'stale') return { label: '索引过期', color: 'warning', banner: { type: 'warning', message: '索引由旧版本建立，结果可能不准；手动同步会全量重建', sync: true }, canQuery: true, primary: 'sync' };
  if (state === 'partial') return { label: '索引不完整', color: 'warning', banner: { type: 'warning', message: '上次索引未完成，手动同步会全量重建', sync: true }, canQuery: true, primary: 'sync' };
  if (state === 'failed') return { label: '索引失败', color: 'error', banner: { type: 'error', message: `${status.message ?? '上次索引失败'}${failureText(status, now)}`, sync: true }, canQuery: true, primary: 'sync' };
  if (status.autoSync !== false && status.watcher?.degraded) {
    return { label: '已索引', color: 'success', banner: { type: 'warning', message: `文件监听不可用${status.watcher.reason ? `（${status.watcher.reason}）` : ''}，索引不会自动跟上改动，需要时请手动同步`, sync: true }, canQuery: true, primary: 'sync' };
  }
  return { label: '已索引', color: 'success', canQuery: true, primary: 'sync' };
}

/** 调度器正在推进的阶段：页面据此静默轮询状态，直到回到空闲。 */
export function codeIndexSyncActive(status?: CodeGraphStatus): boolean {
  return status?.phase === 'syncing' || status?.phase === 'queued' || status?.phase === 'rebuilding' || status?.phase === 'backoff';
}

function failureText(status: CodeGraphStatus, now: number): string {
  const count = status.consecutiveFailures ?? 0;
  if (status.phase === 'backoff' && status.nextRetryAt) return `（已连续失败 ${count} 次${retryText(status.nextRetryAt, now)}）`;
  if (status.phase === 'failed') return `（已连续失败 ${count} 次，自动同步已暂停；修改文件或手动同步后再试）`;
  return '';
}

function retryText(at: number | undefined, now: number): string {
  if (!at) return '';
  const seconds = Math.max(0, Math.round((at - now) / 1000));
  if (seconds < 60) return `，${seconds} 秒后自动重试`;
  const minutes = Math.round(seconds / 60);
  return `，约 ${minutes} 分钟后自动重试`;
}
