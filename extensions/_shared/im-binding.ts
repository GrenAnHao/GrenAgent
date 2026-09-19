export interface ImBinding {
  workspace: string;
  sessionId: string;
}

let binding: ImBinding | undefined;
/** 已提示过的 owner 键：session 重绑 / 双扩展不要反复弹同一条 toast。 */
let lastConflictKey: string | undefined;

export function normalizeImWorkspace(workspace: string): string {
  return workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function claimImBinding(
  workspace: string,
  sessionId: string,
): { claimed: true } | { claimed: false; owner: ImBinding } {
  const key = normalizeImWorkspace(workspace);
  if (!binding || normalizeImWorkspace(binding.workspace) === key) {
    binding = { workspace, sessionId };
    return { claimed: true };
  }
  return { claimed: false, owner: binding };
}

export function currentImBinding(): ImBinding | undefined {
  return binding;
}

export function notifyImBoundElsewhere(
  notify: ((message: string, level: "warning") => void) | undefined,
  owner: ImBinding,
): void {
  const key = normalizeImWorkspace(owner.workspace);
  if (!notify || lastConflictKey === key) return;
  lastConflictKey = key;
  notify(`IM 已绑定到 ${owner.workspace}`, "warning");
}

export function releaseImBinding(workspace: string): void {
  if (binding && normalizeImWorkspace(binding.workspace) === normalizeImWorkspace(workspace)) {
    binding = undefined;
  }
}

export function __resetImBindingForTest(): void {
  binding = undefined;
  lastConflictKey = undefined;
}
