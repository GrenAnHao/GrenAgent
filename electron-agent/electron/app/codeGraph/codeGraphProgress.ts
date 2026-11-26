import type { IndexProgress } from '@colbymchenry/codegraph';

export interface IndexStageProgress { stage: string; processed?: number; total?: number }

const stages: Record<string, string> = {
  queued: '排队等待', scanning: '扫描文件', parsing: '解析代码', storing: '写入索引', resolving: '解析引用', linking: '关联符号',
};

/** SDK scanning reports files discovered so far with total=0 until discovery finishes. */
export function indexStageProgress({phase, current, total}: IndexProgress): IndexStageProgress {
  const stage = stages[phase] ?? phase;
  if (Number.isSafeInteger(current) && current >= 0) {
    if (Number.isSafeInteger(total) && total > 0 && current <= total) return {stage, processed:current, total};
    if (phase === 'scanning' && total === 0 && current > 0) return {stage, processed:current};
  }
  return {stage};
}
