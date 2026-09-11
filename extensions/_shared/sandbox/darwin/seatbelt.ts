function toPosixAbs(p: string): string {
  return p.replace(/\\/g, "/");
}

export function seatbeltProfile(
  policy: { mode: "read-only" | "workspace-write"; workspaceRoot: string },
  tempDir: string,
): string {
  const temp = toPosixAbs(tempDir);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow file-read*)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow signal (target same-sandbox))",
    '(allow mach-lookup (global-name "com.apple.system.logger"))',
    `(allow file-write* (subpath "${temp}"))`,
  ];
  if (policy.mode === "workspace-write") {
    lines.push(`(allow file-write* (subpath "${toPosixAbs(policy.workspaceRoot)}"))`);
  }
  return lines.join("\n");
}

export function seatbeltArgv(
  policy: { mode: "read-only" | "workspace-write"; workspaceRoot: string },
  argv: string[],
  tempDir: string,
): string[] {
  return ["sandbox-exec", "-p", seatbeltProfile(policy, tempDir), ...argv];
}
