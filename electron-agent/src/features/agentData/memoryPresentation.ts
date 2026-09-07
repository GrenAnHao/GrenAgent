import type { ManagedMemoryRecord } from '../../lib/agentData';
import type { SessionInfo } from '../../lib/pi';
import { pathsEquivalent } from '../../lib/pathUtils';

export const memoryLevelLabels = { 0: '历史记录 · L0', 1: '事实与偏好 · L1', 2: '场景摘要 · L2', 3: '长期画像 · L3' } as const;

export function memorySummary(content: string): string {
  const describe = (value: unknown): string => {
    if (Array.isArray(value)) return value.map(describe).join('、');
    if (value !== null && typeof value === 'object') return Object.entries(value).map(([key, entry]) => `${key}：${describe(entry)}`).join(' · ');
    return value === null ? 'null' : String(value);
  };
  try { return describe(JSON.parse(content)); } catch { return content; }
}

export function sourceSessionId(record: Partial<ManagedMemoryRecord>): string | undefined {
  return record.sourceSessionId ?? (record.origin === 'manual' ? undefined : /^session:(.+)$/.exec(record.source ?? '')?.[1]);
}

export function findSourceSession(record: Partial<ManagedMemoryRecord>, sessions: SessionInfo[]): SessionInfo | undefined {
  const id = sourceSessionId(record);
  return id ? sessions.find((session) => session.id === id && !!session.cwd && (!record.sourceWorkspace || pathsEquivalent(session.cwd, record.sourceWorkspace))) : undefined;
}
