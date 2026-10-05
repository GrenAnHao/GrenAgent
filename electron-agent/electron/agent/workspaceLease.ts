const leases = new Map<string, number>();

/** 同一项目可以同时有多个 handle。最后一个关掉时才拆 MCP / IM / 子代理控制面。 */
export function retainWorkspaceLease(workspace: string): void {
  leases.set(workspace, (leases.get(workspace) ?? 0) + 1);
}

export async function releaseWorkspaceLease(
  workspace: string,
  cleanup: () => Promise<void> | void,
): Promise<void> {
  const left = (leases.get(workspace) ?? 0) - 1;
  if (left > 0) {
    leases.set(workspace, left);
    return;
  }
  leases.delete(workspace);
  await cleanup();
}

export function __resetWorkspaceLeasesForTest(): void {
  leases.clear();
}
