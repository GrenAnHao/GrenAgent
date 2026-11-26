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
const CONFIRM_ATTEMPTS = 3;

export interface SubAgentObservation {
  item?: SubAgentItem;
  generation: number;
  startedAt?: number;
  completedAt?: number;
  attempts: number;
  /** 下一次按 ID 对账的最早时间，失联时指数退避（全 workspace 共用轮询时钟）。 */
  nextLookupAt?: number;
  state: 'pending' | 'found' | 'not-found' | 'unavailable';
  error?: string;
}

interface PollerEntry {
  refCount: number;
  listRefs: number;
  stop: () => void;
  poll: () => Promise<void>;
}

interface SubAgentLiveState {
  itemsByWorkspace: Map<string, SubAgentItem[]>;
  listQueries: Map<string, { generation: number; startedAt: number; completedAt: number; error?: string }>;
  /** 按原父会话 + 稳定 ID 缓存；释放观察者不删除最后已确认事实。 */
  observations: Map<string, SubAgentObservation>;
  startPolling: (workspace: string, lookupOnly?: boolean) => () => void;
  watch: (workspace: string, parentSessionPath: string, agentId: string) => () => void;
}

export const observationKey = (workspace: string, parentSessionPath: string, agentId: string): string =>
  JSON.stringify([workspace, parentSessionPath.replace(/\\/g, '/').toLowerCase(), agentId]);

// 与 store 状态分离：所有卡片共享一个 workspace 轮询，单行查询也只由它发起。
const pollers = new Map<string, PollerEntry>();
const watchers = new Map<string, { workspace: string; parentSessionPath: string; agentId: string; refs: number }>();
const EMPTY_OBSERVATION: SubAgentObservation = { generation: 0, attempts: 0, state: 'pending' };

export const useSubAgentLiveStore = create<SubAgentLiveState>((set, get) => ({
  itemsByWorkspace: new Map(),
  listQueries: new Map(),
  observations: new Map(),

  watch: (workspace, parentSessionPath, agentId) => {
    if (!workspace || !parentSessionPath || !agentId) return () => {};
    const key = observationKey(workspace, parentSessionPath, agentId);
    const old = watchers.get(key);
    watchers.set(key, { workspace, parentSessionPath, agentId, refs: (old?.refs ?? 0) + 1 });
    const releasePoll = get().startPolling(workspace, true);
    if (old) void pollers.get(workspace)?.poll();
    return () => {
      const current = watchers.get(key);
      if (current && --current.refs === 0) watchers.delete(key);
      releasePoll();
    };
  },

  startPolling: (workspace: string, lookupOnly = false) => {
    if (!workspace) return () => {};

    const existing = pollers.get(workspace);
    if (existing) {
      existing.refCount++;
      if (!lookupOnly) existing.listRefs++;
      return makeCleanup(workspace, lookupOnly);
    }

    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const startedAt = Date.now();
      const generation = (get().listQueries.get(workspace)?.generation ?? 0) + 1;
      if ((pollers.get(workspace)?.listRefs ?? 0) > 0) try {
        const rows = await pi.subagentList(workspace);
        if (cancelled) return;
        set((s) => ({ listQueries: new Map(s.listQueries).set(workspace, { generation, startedAt, completedAt: Date.now() }) }));
        set((s) => {
          const previous = s.itemsByWorkspace.get(workspace);
          const byId = new Map(previous?.map((row) => [row.id, row]));
          // IPC 每次给新对象，复用未变化的行，让别的代理更新时已完成卡片不跟着重渲染。
          const stable = rows.map((row) => {
            const old = byId.get(row.id);
            if (!old) return row;
            const keys = Object.keys(row) as Array<keyof SubAgentItem>;
            return keys.length === Object.keys(old).length && keys.every((key) => row[key] === old[key]) ? old : row;
          });
          if (previous && previous.length === stable.length && stable.every((row, i) => row === previous[i])) return s;
          const next = new Map(s.itemsByWorkspace);
          next.set(workspace, stable);
          return { itemsByWorkspace: next };
        });
      } catch (error) {
        if (cancelled) return;
        set((s) => ({ listQueries: new Map(s.listQueries).set(workspace, {
          generation, startedAt, completedAt: Date.now(), error: error instanceof Error ? error.message : String(error),
        }) }));
      }
      // 开发期 renderer 热更新而主进程仍是旧 bundle 时，只有未知命令才退回已有的父会话列表接口。
      // 同一轮同 owner 共用一次回包；截断导致的缺行依然只是待确认。
      const fallbackLists = new Map<string, Promise<SubAgentItem[]>>();
      const lookupOwned = async (parentSessionPath: string, agentId: string) => {
        try {
          return await pi.subagentLookup(workspace, agentId, parentSessionPath);
        } catch (error) {
          if (!String(error).includes('Electron command is not registered: subagent_lookup')) throw error;
          let list = fallbackLists.get(parentSessionPath);
          if (!list) {
            list = pi.subagentList(workspace, parentSessionPath);
            fallbackLists.set(parentSessionPath, list);
          }
          const item = (await list).find((row) => row.id === agentId);
          return item ? { kind: 'found' as const, item } : { kind: 'not-found' as const };
        }
      };
      const targets = [...watchers.entries()].filter(([key, w]) => {
        if (w.workspace !== workspace) return false;
        const state = get().observations.get(key);
        return !state || (!isTerminal(state.item?.status) && (state.nextLookupAt ?? 0) <= Date.now());
      });
      await Promise.all(targets.map(async ([key, { parentSessionPath, agentId }]) => {
        const previous = get().observations.get(key);
        const generation = (previous?.generation ?? 0) + 1;
        const startedAt = Date.now();
        set((s) => {
          const next = new Map(s.observations);
          next.set(key, { ...(next.get(key) ?? EMPTY_OBSERVATION), generation, startedAt });
          return { observations: next };
        });
        try {
          const result = await lookupOwned(parentSessionPath, agentId);
          if (cancelled || !watchers.has(key)) return;
          set((s) => {
            const current = s.observations.get(key);
            if (!current || current.generation !== generation) return s;
            // 已确认终态不能被旧空列表、一次失败或迟到的运行快照抹掉。
            const item = result.kind === 'found' && result.item.id === agentId
              && (!current.item || result.item.updatedAt >= current.item.updatedAt || isTerminal(current.item.status))
              ? isTerminal(current.item?.status) && !isTerminal(result.item.status) ? current.item : result.item
              : current.item;
            const next = new Map(s.observations);
            const confirmed = result.kind === 'found' && item === result.item;
            const attempts = confirmed ? 0 : current.attempts + 1;
            next.set(key, { ...current, item, completedAt: Date.now(), attempts,
              nextLookupAt: confirmed ? undefined : Date.now() + backoffMs(attempts),
              state: confirmed || isTerminal(item?.status) ? 'found' : result.kind, error: undefined });
            return { observations: next };
          });
        } catch (error) {
          if (cancelled || !watchers.has(key)) return;
          set((s) => {
            const current = s.observations.get(key);
            if (!current || current.generation !== generation) return s;
            const next = new Map(s.observations);
            const attempts = current.attempts + 1;
            next.set(key, { ...current, attempts, nextLookupAt: Date.now() + backoffMs(attempts), completedAt: Date.now(),
              state: isTerminal(current.item?.status) ? 'found' : 'unavailable', error: error instanceof Error ? error.message : String(error) });
            return { observations: next };
          });
        }
      }));
      inFlight = false;
    };

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

    pollers.set(workspace, { refCount: 1, listRefs: lookupOnly ? 0 : 1, stop, poll });
    void poll();
    return makeCleanup(workspace, lookupOnly);
  },
}));

function isTerminal(status: string | undefined): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled' || status === 'interrupted';
}

/** 已见过运行记录也可能失联；记录可留作元数据，但不能继续确证正在运行。 */
export function subAgentObservationUnconfirmed(observation: SubAgentObservation): boolean {
  return observation.attempts >= CONFIRM_ATTEMPTS && observation.state !== 'found' && !isTerminal(observation.item?.status);
}

/** 同一父会话的观察水位和最后一份确定记录；列表不参与缺失判断。 */
export function selectSubAgentObservation(
  workspace: string, parentSessionPath: string, agentId: string | null,
): (state: SubAgentLiveState) => SubAgentObservation {
  const key = agentId ? observationKey(workspace, parentSessionPath, agentId) : '';
  return (s) => s.observations.get(key) ?? EMPTY_OBSERVATION;
}

function backoffMs(attempts: number): number {
  return Math.min(30_000, POLL_MS * 2 ** Math.min(attempts - 1, 4));
}

function makeCleanup(workspace: string, lookupOnly: boolean): () => void {
  return () => {
    const entry = pollers.get(workspace);
    if (!entry) return;
    entry.refCount--;
    if (!lookupOnly) entry.listRefs--;
    if (entry.refCount <= 0) {
      entry.stop();
      pollers.delete(workspace);
    }
  };
}

function observedItems(state: SubAgentLiveState, workspace: string): Map<string, SubAgentObservation> {
  const result = new Map<string, SubAgentObservation>();
  const prefix = `${JSON.stringify([workspace]).slice(0, -1)},`;
  for (const [key, observation] of state.observations) {
    if (!key.startsWith(prefix) || !observation.item) continue;
    const previous = result.get(observation.item.id);
    if (!previous?.item || (!isTerminal(previous.item.status) &&
      (isTerminal(observation.item.status) || observation.item.updatedAt >= previous.item.updatedAt))) {
      result.set(observation.item.id, observation);
    }
  }
  return result;
}

function reconciledItem(listItem: SubAgentItem | undefined, observation: SubAgentObservation | undefined): SubAgentItem | undefined {
  const observed = observation?.item;
  if (!observed) return listItem;
  if (listItem && isTerminal(listItem.status) && !isTerminal(observed.status)) return listItem;
  if (listItem && !isTerminal(observed.status) && listItem.updatedAt > observed.updatedAt) return listItem;
  // The parent-scoped ID query is authoritative over a truncated or stale workspace list.
  return observed;
}

/** 获取某 workspace 下指定 id 的子代理（用于卡片订阅）。 */
export function selectSubAgentById(
  workspace: string,
  agentId: string | null,
): (state: SubAgentLiveState) => SubAgentItem | undefined {
  return (s) => agentId ? reconciledItem(
    s.itemsByWorkspace.get(workspace)?.find((row) => row.id === agentId), observedItems(s, workspace).get(agentId),
  ) : undefined;
}

/** 稳定的空数组回退，避免每次调用返回新引用导致 useSyncExternalStore 无限循环。 */
const EMPTY_ITEMS: SubAgentItem[] = [];

/** 合并父会话已确认的 ID 行；缓存 selector 结果，避免每次订阅返回新数组。 */
export function selectSubAgentList(workspace: string): (state: SubAgentLiveState) => SubAgentItem[] {
  let previousList: SubAgentItem[] | undefined;
  let previousObservations: SubAgentLiveState['observations'] | undefined;
  let previousResult: SubAgentItem[] = EMPTY_ITEMS;
  return (s) => {
    const list = s.itemsByWorkspace.get(workspace);
    if (list === previousList && s.observations === previousObservations) return previousResult;
    previousList = list;
    previousObservations = s.observations;
    const observed = observedItems(s, workspace);
    if (observed.size === 0) return previousResult = list ?? EMPTY_ITEMS;
    const byId = new Map((list ?? EMPTY_ITEMS).map((row) => [row.id, row]));
    for (const [id, observation] of observed) {
      const merged = reconciledItem(byId.get(id), observation);
      if (merged) byId.set(id, merged);
    }
    return previousResult = [...byId.values()];
  };
}
