/**
 * React 19.2 的开发版在每次 props 有变化的组件渲染后调 `performance.measure`，给 DevTools 的
 * 「Components ⚛」轨道画条，detail 里带着 props 差异。measure 条目浏览器不设上限，也没人清：
 * 子代理卡片每秒刷新、弹层和流式消息一直重渲染时，半小时能攒到 50 多万条，渲染进程多占近 1GB，
 * 最后 OOM 崩溃，整个窗口白屏。
 *
 * 条目在创建那一刻已经进了正在录制的性能 trace，事后清掉不影响 DevTools 里看轨道。生产版 React
 * 不打这些 measure，只在开发构建里装。
 */
export const MEASURE_CLEAR_INTERVAL_MS = 5_000;

export function startClearingDevMeasures(
  perf: Pick<Performance, 'clearMeasures'> | undefined = globalThis.performance,
  intervalMs: number = MEASURE_CLEAR_INTERVAL_MS,
): () => void {
  if (!perf || typeof perf.clearMeasures !== 'function') return () => {};
  const timer = setInterval(() => perf.clearMeasures(), intervalMs);
  return () => clearInterval(timer);
}
