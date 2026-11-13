import type { CodeGraphStatus } from '../../lib/agentData';

export interface CodeIndexView {
  label: string;
  /** 索引相对源码的新鲜度，与“是否可用”分开表达。 */
  freshness: IndexFreshness;
  color: 'default' | 'success' | 'warning' | 'error' | 'processing';
  banner?: { type: 'info' | 'warning' | 'error'; message: string; sync: boolean };
  canQuery: boolean;
  /** 页头主按钮：同步索引 / 建立索引 / 不显示可用按钮。 */
  primary: 'sync' | 'build' | 'none';
}

const LOCKED = 'CODEGRAPH_LOCKED';

/**
 * 新鲜度：索引内容相对源码的时效。
 * - current：已跟上当前源码；
 * - stale：已知落后（同步失败、过期抽取器、监听降级、有未提交改动）；
 * - unknown：无法判断（读取失败、未索引、监听信息缺失）。
 * “可用”由 canQuery 表达，不因最近一次同步失败就判不可用。
 */
export type IndexFreshness = 'current' | 'stale' | 'unknown';

export function indexFreshness(status?: CodeGraphStatus, error?: string): IndexFreshness {
  if (error || !status || !status.indexed) return 'unknown';
  const state = status.state?.toLowerCase().replace(/-/g, '_');
  if (['failed', 'partial', 'stale'].includes(state ?? '')) return 'stale';
  if (typeof status.consecutiveFailures === 'number' && status.consecutiveFailures > 0) return 'stale';
  if (status.phase === 'backoff') return 'stale';
  if (status.watcher?.degraded && status.autoSync !== false) return 'stale';
  if (typeof status.pendingChanges === 'number' && status.pendingChanges > 0) return 'stale';
  // 监听未激活时无法确认是否落后；只有明确的“已同步完成”才算 current。
  if (status.watcher && status.watcher.active === false && status.autoSync !== false) return 'unknown';
  return 'current';
}

/**
 * 把 CodeGraph 状态映射成页面呈现；检查中与读取失败优先。
 * 增量同步（phase syncing / queued）期间照常可查，结果是上一次提交的索引；只有全量重建（state indexing）不可查。
 */
export function codeIndexPresentation({ status, checking, error, now = Date.now() }: { status?: CodeGraphStatus; checking: boolean; error?: string; now?: number }): CodeIndexView {
  const freshness = indexFreshness(status, error);
  if (error) return { label: '未获取', freshness, color: 'default', banner: { type: 'error', message: `${error}${status ? ' 当前保留上次成功读取的索引状态。' : ''}`, sync: false }, canQuery: false, primary: 'none' };
  if (checking || !status) return { label: '检查中', freshness, color: 'default', canQuery: false, primary: 'none' };
  const state = status.state?.toLowerCase().replace(/-/g, '_');
  if (status.sdkAvailable === false || state === 'sdk_unavailable') return { label: 'SDK 不可用', freshness, color: 'error', banner: { type: 'error', message: `内置 CodeGraph SDK 不可用，请检查安装包${status.message ? `：${status.message}` : ''}`, sync: false }, canQuery: false, primary: 'none' };
  if (state === 'indexing') return { label: '索引中', freshness, color: 'processing', banner: { type: 'info', message: '正在重建索引，完成前暂不能查询', sync: false }, canQuery: false, primary: 'none' };
  if (!status.indexed || state === 'unavailable') return { label: '未索引', freshness, color: 'default', canQuery: false, primary: 'build' };
  if (status.phase === 'syncing' || status.phase === 'queued') return { label: '同步中', freshness, color: 'processing', canQuery: true, primary: 'sync' };
  if (status.phase === 'backoff' && status.lastError?.code === LOCKED) {
    return { label: '等待重试', freshness, color: 'warning', banner: { type: 'warning', message: `另一个程序正在写这个项目的索引（codegraph.lock）${retryText(status.nextRetryAt, now)}`, sync: false }, canQuery: true, primary: 'sync' };
  }
  if (state === 'stale') return { label: '索引过期', freshness, color: 'warning', banner: { type: 'warning', message: '索引由旧版本建立，结果可能不准；手动同步会全量重建', sync: true }, canQuery: true, primary: 'sync' };
  if (state === 'partial') return { label: '索引不完整', freshness, color: 'warning', banner: { type: 'warning', message: '上次索引未完成，手动同步会全量重建', sync: true }, canQuery: true, primary: 'sync' };
  if (state === 'failed') return { label: '索引失败', freshness, color: 'error', banner: { type: 'error', message: `${status.message ?? '上次索引失败'}${failureText(status, now)}`, sync: true }, canQuery: true, primary: 'sync' };
  if (status.autoSync !== false && status.watcher?.degraded) {
    return { label: '已索引', freshness, color: 'success', banner: { type: 'warning', message: `文件监听不可用${status.watcher.reason ? `（${status.watcher.reason}）` : ''}，索引不会自动跟上改动，需要时请手动同步`, sync: true }, canQuery: true, primary: 'sync' };
  }
  return { label: '已索引', freshness, color: 'success', canQuery: true, primary: 'sync' };
}

/** 调度器正在推进的阶段：页面据此静默轮询状态，直到回到空闲。 */
export function codeIndexSyncActive(status?: CodeGraphStatus): boolean {
  return status?.phase === 'syncing' || status?.phase === 'queued' || status?.phase === 'rebuilding' || status?.phase === 'backoff';
}

/**
 * 监听还没落定：首次查询后 watch 异步挂载，status 里是 active:false/degraded:false 的中间态。
 * 页面若不继续轮询，缓存的「watcher 未激活」会把新鲜度永远判成 unknown。
 * 挂载要么 active 要么 degraded，几秒内落定，轮询自然停。
 */
export function codeIndexWatcherPending(status?: CodeGraphStatus): boolean {
  const watcher = status?.watcher;
  return Boolean(status?.indexed) && status?.autoSync !== false && Boolean(watcher) && watcher!.active === false && !watcher!.degraded;
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
