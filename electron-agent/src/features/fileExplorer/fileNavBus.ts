import { useEffect } from 'react';
import { listen, type UnlistenFn } from '../../platform/runtime';

export type NavDirection = 'back' | 'forward';

export interface NavTarget {
  /** 文件浏览器根元素，用来判断鼠标悬停 / 焦点在不在它里面，以及它现在看不看得见。 */
  element: () => HTMLElement | null;
  go: (direction: NavDirection) => void;
}

const targets = new Set<NavTarget>();

/** 同一次侧键可能既作为渲染进程的 button 3/4、又作为主进程的 app-command 送来；这个窗口内同方向只认一次。 */
const DEDUPE_MS = 250;
let last: { direction: NavDirection; at: number } | null = null;

export function registerNavTarget(target: NavTarget): () => void {
  targets.add(target);
  return () => void targets.delete(target);
}

const isShown = (el: HTMLElement) => el.getClientRects().length > 0;

/** 让 target 导航一次；同方向在去重窗口内的重复触发被吞掉。返回是否真的执行了。 */
export function triggerNavigation(target: NavTarget, direction: NavDirection, now = Date.now()): boolean {
  if (last && last.direction === direction && now - last.at < DEDUPE_MS) return false;
  last = { direction, at: now };
  target.go(direction);
  return true;
}

/**
 * 把前进 / 后退交给一个文件浏览器：鼠标正悬停在上面的优先，没有就取键盘焦点所在的。
 * 都没有（比如侧键在对话区、浏览器标签上按下）就什么都不做，不抢别处的侧键。
 * 返回是否有人认领。
 */
export function routeNavigation(direction: NavDirection, now = Date.now()): boolean {
  const active = document.activeElement;
  const visible = [...targets].filter((target) => {
    const el = target.element();
    return el !== null && isShown(el);
  });
  const claimant =
    visible.find((target) => target.element()?.matches(':hover')) ??
    visible.find((target) => active && target.element()?.contains(active));
  if (!claimant) return false;
  triggerNavigation(claimant, direction, now);
  return true;
}

/** 鼠标侧键：button 3 是后退、4 是前进（DOM 约定）。 */
export function directionOfMouseButton(button: number): NavDirection | null {
  if (button === 3) return 'back';
  if (button === 4) return 'forward';
  return null;
}

/** 订阅主进程转来的系统前进 / 后退（Windows / Linux 的 app-command）。挂一次就行。 */
export function useAppNavCommand(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<{ direction: NavDirection }>('app-nav', (event) => {
      routeNavigation(event.payload.direction);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/** 仅测试用：清掉去重状态。 */
export function resetNavBusForTest(): void {
  last = null;
  targets.clear();
}
