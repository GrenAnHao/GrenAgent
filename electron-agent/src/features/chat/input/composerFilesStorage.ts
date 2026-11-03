import type { StateStorage } from 'zustand/middleware';
import { createIdbStorage } from '../../../lib/idbStorage';

type Snapshot = { state?: { byKey?: Record<string, unknown> }; version?: number };

function snapshot(raw: string | null): Snapshot {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' ? value as Snapshot : {};
  } catch { return {}; }
}

/**
 * persist 仍收到 byKey 快照，但磁盘权威记录逐 owner 写。
 * 每个渲染进程只提交自己的差量，旧窗口的快照不能删掉另一个窗口新添的桶。
 * 旧整表保留为兼容投影；读取时以逐 owner 记录（含 null 删除遮罩）为准。
 */
export function createComposerFilesStorage(): StateStorage {
  const disk = createIdbStorage('pi-composer-files');
  let previous: Record<string, string> = {};
  const encode = (byKey: Record<string, unknown>) => Object.fromEntries(
    Object.entries(byKey).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  return {
    getItem: async (name) => {
      const legacy = snapshot(await disk.getItem(name));
      const byKey = { ...(legacy.state?.byKey ?? {}) };
      const prefix = `${name}:owner:`;
      const keys = (await disk.getKeys()).filter((key) => key.startsWith(prefix));
      const independentOwners = new Set<string>();
      await Promise.all(keys.map(async (key) => {
        try {
          const owner = decodeURIComponent(key.slice(prefix.length));
          independentOwners.add(owner);
          const raw = await disk.getItem(key);
          const value: unknown = raw ? JSON.parse(raw) : null;
          if (value === null) delete byKey[owner];
          else byKey[owner] = value;
        } catch { /* 坏的单个桶不影响其它对话。 */ }
      }));
      // 旧整表里尚未编辑过的桶也要迁出；add 是原子的，不会覆写升级期间别窗口的新值。
      await Promise.all(Object.entries(byKey)
        .filter(([owner]) => !independentOwners.has(owner))
        .map(([owner, value]) => disk.setItemIfAbsent(`${prefix}${encodeURIComponent(owner)}`, JSON.stringify(value))));
      previous = encode(byKey);
      return JSON.stringify({ state: { byKey }, version: legacy.version ?? 0 });
    },
    setItem: async (name, raw) => {
      const next = encode(snapshot(raw).state?.byKey ?? {});
      const before = previous;
      previous = next;
      const changed = [...new Set([...Object.keys(before), ...Object.keys(next)])]
        .filter((owner) => before[owner] !== next[owner]);
      await Promise.all(changed.map((owner) => disk.setItem(
        `${name}:owner:${encodeURIComponent(owner)}`, next[owner] ?? 'null',
      )));
      // 兼容旧版诊断/导出；跨窗口正确性由上面的独立桶保证。
      await disk.setItem(name, raw);
    },
    removeItem: async (name) => {
      const prefix = `${name}:owner:`;
      const keys = (await disk.getKeys()).filter((key) => key.startsWith(prefix));
      previous = {};
      await Promise.all([disk.removeItem(name), ...keys.map((key) => disk.removeItem(key))]);
    },
  };
}
