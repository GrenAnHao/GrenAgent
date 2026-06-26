import type { OpenWorkspaceResult, SessionInfo } from './pi';

/**
 * 决定切换工作区后应自动选中的会话 path；返回 null 表示"保持现状"——
 * 已有显式 active（删除/切换路径已设好目标）或无候选时不二次抢选，避免选中态回弹。
 */
export function pickAutoSelected(
  active: string | null,
  openResult: OpenWorkspaceResult | undefined,
  sessions: SessionInfo[],
): string | null {
  if (active) return null;
  if (openResult?.sessionFile) return openResult.sessionFile;
  return sessions.length > 0 ? sessions[0].path : null;
}
