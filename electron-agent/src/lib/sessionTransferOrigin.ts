/**
 * 迁移来源登记：sessionPath → 最近一次移动的 fromWorkspace。
 *
 * 只用于给**没有来源字段**的旧 ui-history 辅助条目兜底（它们没有 entryId，贴不回后端行）。
 * 已经有 sourceCwd / sourceRefs 的行永远优先，往返迁移不覆盖更早、更具体的来源。
 * 这份登记只在渲染进程内、当前运行期有效；真正的来源快照由宿主的迁移 metadata 持久化。
 */
const origins = new Map<string, string>();

function key(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function rememberTransferOrigin(sessionPath: string, sourceWorkspace: string): void {
  if (!sessionPath.trim() || !sourceWorkspace.trim()) return;
  origins.set(key(sessionPath), sourceWorkspace);
}

/** 该会话是否在本次运行期被移动过；返回最近一次移动的来源项目。 */
export function transferOriginOf(sessionPath: string | null | undefined): string | undefined {
  if (!sessionPath) return undefined;
  return origins.get(key(sessionPath));
}

export function forgetTransferOrigin(sessionPath: string): void {
  origins.delete(key(sessionPath));
}

export function resetTransferOriginsForTests(): void {
  origins.clear();
}
