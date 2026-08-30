import { pi } from './pi';

// 已预热 / 预热中的工作区集合：避免对同一 cwd 重复 spawn。
const warmed = new Set<string>();
const inFlight = new Set<string>();

/** 后台预热单个工作区（幂等、不抛错、不阻塞）。 */
export function prewarmWorkspace(cwd: string): void {
  if (!cwd || warmed.has(cwd) || inFlight.has(cwd)) return;
  inFlight.add(cwd);
  void pi
    .warmWorkspace(cwd)
    .then(() => {
      warmed.add(cwd);
    })
    .catch(() => {
      /* 预热失败无害，下次仍可重试 */
    })
    .finally(() => {
      inFlight.delete(cwd);
    });
}

/**
 * 后台预热最近的若干工作区（错峰，避免一次性 spawn 抢占 CPU）。
 * 传入按最近优先排序、可含重复的 cwd 列表；自动去重并跳过已预热项。
 */
export function prewarmRecent(cwds: string[], limit = 4): void {
  const seen = new Set<string>();
  let scheduled = 0;
  for (const cwd of cwds) {
    if (scheduled >= limit) break;
    if (!cwd || seen.has(cwd) || warmed.has(cwd) || inFlight.has(cwd)) continue;
    seen.add(cwd);
    const delay = scheduled * 500;
    setTimeout(() => prewarmWorkspace(cwd), delay);
    scheduled += 1;
  }
}
