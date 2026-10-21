import type { OpenWorkspaceResult, SessionInfo } from './pi';
import { pathsEquivalent } from './pathUtils';

/**
 * 决定切换工作区后应自动选中的会话 path；返回 null 表示"保持现状"——
 * 已有显式 active（删除/切换路径已设好目标）或无候选时不二次抢选，避免选中态回弹。
 * 已归档的会话不自动选中：pi 可能把它当作上次的会话恢复出来，但侧栏里没有它。
 */
export function pickAutoSelected(
  active: string | null,
  openResult: OpenWorkspaceResult | undefined,
  sessions: SessionInfo[],
): string | null {
  if (active) return null;
  const restored = openResult?.sessionFile;
  if (restored && !sessions.some((s) => s.archived && pathsEquivalent(s.path, restored))) return restored;
  return sessions.find((s) => !s.archived)?.path ?? null;
}
