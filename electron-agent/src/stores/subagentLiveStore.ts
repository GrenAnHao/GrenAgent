/**
 * 子代理列表单例轮询 store。
 *
 * 问题背景：原先每个 SubAgentCard / useSubAgentLive 各自启动一个 2500ms 定时器，N 张卡片就有
 * N 次并发 subagentList 调用，每次还携带全量 transcript（已在 Rust 侧去除）。即便去掉
 * transcript，N 并发查询本身仍是浪费。
 *
 * 解法：全局单例轮询，按 workspace 各起一个 setInterval，引用计数管理生命周期：最后一个
 * 消费者 unmount 时停止轮询；同一 workspace 有任意消费者时共享一份结果。
 */

import { create } from 'zustand';
import { pi, type SubAgentItem } from '../lib/pi';

const POLL_MS = 2500;

interface PollerEntry {
  refCount: number;
  stop: () => void;
}

interface SubAgentLiveState {
  /** 每个 workspace 的子代理列表（不含 transcript）。 */
  itemsByWorkspace: Map<string, SubAgentItem[]>;
  /** 启动对某 workspace 的轮询（引用计数）；返回清理函数。 */
  startPolling: (workspace: string) => () => void;
}

// 轮询实例注册表，与 store 状态分离，避免把 setInterval handle 存入 Zustand。
const pollers = new Map<string, PollerEntry>();

export const useSubAgentLiveStore = create<SubAgentLiveState>((set) => ({
  itemsByWorkspace: new Map(),

  startPolling: (workspace: string) => {
    if (!workspace) return () => {};

    const existing = pollers.get(workspace);
    if (existing) {
      existing.refCount++;
      return makeCleanup(workspace);
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const rows = await pi.subagentList(workspace);
        if (cancelled) return;
        set((s) => {
          const next = new Map(s.itemsByWorkspace);
          next.set(workspace, rows);
          return { itemsByWorkspace: next };
        });
      } catch {
        // 跨进程读 registry 偶发 SQLITE_BUSY：保留上次结果，下个 tick 再试。
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);

    const stop = () => {
      cancelled = true;
      clearInterval(timer);
      // 清理 store 中该 workspace 的数据
      set((s) => {
        const next = new Map(s.itemsByWorkspace);
        next.delete(workspace);
        return { itemsByWorkspace: next };
      });
    };

    pollers.set(workspace, { refCount: 1, stop });
    return makeCleanup(workspace);
  },
}));

function makeCleanup(workspace: string): () => void {
  return () => {
    const entry = pollers.get(workspace);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      entry.stop();
      pollers.delete(workspace);
    }
  };
}

/** 获取某 workspace 下指定 id 的子代理（用于卡片订阅）。 */
export function selectSubAgentById(
  workspace: string,
  agentId: string | null,
): (state: SubAgentLiveState) => SubAgentItem | undefined {
  return (s) => {
    if (!agentId) return undefined;
    return s.itemsByWorkspace.get(workspace)?.find((r) => r.id === agentId);
  };
}

/** 稳定的空数组回退，避免每次调用返回新引用导致 useSyncExternalStore 无限循环。 */
const EMPTY_ITEMS: SubAgentItem[] = [];

/** 获取某 workspace 下所有子代理列表（用于 SubAgentMenuButton）。 */
export function selectSubAgentList(
  workspace: string,
): (state: SubAgentLiveState) => SubAgentItem[] {
  return (s) => s.itemsByWorkspace.get(workspace) ?? EMPTY_ITEMS;
}
