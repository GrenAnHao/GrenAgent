export interface ImBinding {
  workspace: string;
  sessionId: string;
}

let binding: ImBinding | undefined;

export function claimImBinding(
  workspace: string,
  sessionId: string,
): { claimed: true } | { claimed: false; owner: ImBinding } {
  if (!binding || binding.workspace === workspace) {
    binding = { workspace, sessionId };
    return { claimed: true };
  }
  return { claimed: false, owner: binding };
}

export function currentImBinding(): ImBinding | undefined {
  return binding;
}

export function releaseImBinding(workspace: string): void {
  if (binding?.workspace === workspace) binding = undefined;
}

export function __resetImBindingForTest(): void {
  binding = undefined;
}
