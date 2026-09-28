import type { CodeGraphStatus } from '../../lib/agentData';

export interface CodeIndexView {
  label: string;
  color: 'default' | 'success' | 'warning' | 'error' | 'processing';
  banner?: { type: 'info' | 'warning' | 'error'; message: string; sync: boolean };
  canQuery: boolean;
  /** 页头主按钮：同步索引 / 建立索引 / 不显示可用按钮。 */
  primary: 'sync' | 'build' | 'none';
}

/** 把 CodeGraph 状态映射成页面呈现；检查中与读取失败优先。 */
export function codeIndexPresentation({ status, checking, error }: { status?: CodeGraphStatus; checking: boolean; error?: string }): CodeIndexView {
  if (error) return { label: '未获取', color: 'default', banner: { type: 'error', message: `${error}${status ? ' 当前保留上次成功读取的索引状态。' : ''}`, sync: false }, canQuery: false, primary: 'none' };
  if (checking || !status) return { label: '检查中', color: 'default', canQuery: false, primary: 'none' };
  const state = status.state?.toLowerCase().replace(/-/g, '_');
  if (status.sdkAvailable === false || state === 'sdk_unavailable') return { label: 'SDK 不可用', color: 'error', banner: { type: 'error', message: `内置 CodeGraph SDK 不可用，请检查安装包${status.message ? `：${status.message}` : ''}`, sync: false }, canQuery: false, primary: 'none' };
  if (state === 'indexing') return { label: '索引中', color: 'processing', banner: { type: 'info', message: '正在更新索引', sync: false }, canQuery: false, primary: 'none' };
  if (!status.indexed || state === 'unavailable') return { label: '未索引', color: 'default', canQuery: false, primary: 'build' };
  if (state === 'stale') return { label: '索引过期', color: 'warning', banner: { type: 'warning', message: '索引已过期，结果可能不准', sync: true }, canQuery: true, primary: 'sync' };
  if (state === 'partial') return { label: '索引不完整', color: 'warning', banner: { type: 'warning', message: '上次索引未完成，下次同步会全量重建', sync: true }, canQuery: true, primary: 'sync' };
  if (state === 'failed') return { label: '索引失败', color: 'error', banner: { type: 'error', message: status.message ?? '上次索引失败', sync: true }, canQuery: true, primary: 'sync' };
  return { label: '已索引', color: 'success', canQuery: true, primary: 'sync' };
}
