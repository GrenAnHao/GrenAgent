import { pi } from './pi';
import { pathsEquivalent } from './pathUtils';

// 已预热 / 预热中的工作区集合：避免对同一 cwd 重复 spawn。
const warmed = new Set<string>();
const inFlight = new Set<string>();
let queue: Promise<void> = Promise.resolve();

function isTracked(cwd: string, bucket: Set<string>): boolean {
  for (const item of bucket) {
    if (pathsEquivalent(item, cwd)) return true;
  }
  return false;
}

/**
 * 从最近会话里挑后台预热目标。当前工作区的运行时已经在建，不再排进去。
 * 路径比较与主进程工作区键一致，Windows 上大小写和斜杠不同也算同一个目录。
 */
export function selectPrewarmCwds(cwds: readonly string[], active = '', limit = 4): string[] {
  const picked: string[] = [];
  for (const cwd of cwds) {
    if (picked.length >= limit) break;
    if (!cwd) continue;
    if (active && pathsEquivalent(cwd, active)) continue;
    if (picked.some((item) => pathsEquivalent(item, cwd))) continue;
    if (isTracked(cwd, warmed) || isTracked(cwd, inFlight)) continue;
    picked.push(cwd);
  }
  return picked;
}

/** 首屏就绪后再隔这段时间才开始后台预热，避开加载页淡出和第一次操作。 */
export const PREWARM_AFTER_BOOT_MS = 1500;

/**
 * 后台预热每个目录前，要求用户已经停手这么久。建一个运行时要占住主进程 1~1.5 秒，
 * 用户正在切会话、切页面时插进来，那些 IPC 就跟着排队。
 */
export const PREWARM_IDLE_MS = 3000;

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
let lastInputAt = Number.NEGATIVE_INFINITY;
let watchingInput = false;

function watchInput(): void {
  if (watchingInput || typeof window === 'undefined') return;
  watchingInput = true;
  const touch = () => {
    lastInputAt = Date.now();
  };
  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, touch, { capture: true, passive: true });
}

async function waitForIdle(idleMs: number): Promise<void> {
  for (;;) {
    const remaining = lastInputAt + idleMs - Date.now();
    if (remaining <= 0) return;
    await wait(remaining);
  }
}

function warmWorkspace(cwd: string): Promise<void> {
  if (!cwd || isTracked(cwd, warmed) || isTracked(cwd, inFlight)) return Promise.resolve();
  inFlight.add(cwd);
  return pi
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

/** 后台预热单个工作区（幂等、不抛错、不阻塞），立即开始。 */
export function prewarmWorkspace(cwd: string): void {
  void warmWorkspace(cwd);
}

/**
 * 指针在同一行停这么久才预热。建运行时会同步占住主进程 1 秒左右，
 * 而 Electron 的鼠标事件要先经过主进程，鼠标划过一串项目时每行都建，整个窗口的悬停和点击都跟着卡。
 */
export const HOVER_PREWARM_DWELL_MS = 400;

let hoverTarget: string | undefined;
let hoverTimer: ReturnType<typeof setTimeout> | undefined;

function armHoverTimer(): void {
  hoverTimer = setTimeout(() => {
    hoverTimer = undefined;
    const cwd = hoverTarget;
    if (!cwd) return;
    // 已有运行时在建就再等一轮，不并发建第二个。
    if (inFlight.size > 0) {
      armHoverTimer();
      return;
    }
    hoverTarget = undefined;
    void warmWorkspace(cwd);
  }, HOVER_PREWARM_DWELL_MS);
}

/** 指针进入会话行。只记一个目标：换行就换目标并重新计时。 */
export function startHoverPrewarm(cwd: string): void {
  if (!cwd || isTracked(cwd, warmed) || isTracked(cwd, inFlight)) {
    cancelHoverPrewarm();
    return;
  }
  hoverTarget = cwd;
  if (hoverTimer) clearTimeout(hoverTimer);
  armHoverTimer();
}

/** 指针离开会话行。 */
export function cancelHoverPrewarm(): void {
  hoverTarget = undefined;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = undefined;
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 后台预热最近的若干工作区。串行：上一个运行时建完才开始下一个；每个开始前都等用户停手。
 * 传入按最近优先排序、可含重复的 cwd 列表。
 */
export function prewarmRecent(cwds: readonly string[], limit = 4, initialDelayMs = 0, active = ''): void {
  const targets = selectPrewarmCwds(cwds, active, limit);
  if (targets.length === 0) return;
  watchInput();
  queue = queue
    .then(() => wait(initialDelayMs))
    .then(async () => {
      for (const cwd of targets) {
        await waitForIdle(PREWARM_IDLE_MS);
        await warmWorkspace(cwd);
      }
    })
    .catch(() => {
      /* warmWorkspace 已吞掉单次失败；这里只避免队列断掉 */
    });
}

/** 仅测试。清掉去重集合，并让下一次预热不再挂在上一条队列后面。 */
export function resetPrewarmForTest(): void {
  warmed.clear();
  inFlight.clear();
  queue = Promise.resolve();
  lastInputAt = Number.NEGATIVE_INFINITY;
  cancelHoverPrewarm();
}
