export function bwrapArgv(
  policy: { mode: "read-only" | "workspace-write"; workspaceRoot: string },
  argv: string[],
  tempDir: string,
): string[] {
  const prefix = [
    "bwrap",
    "--die-with-parent",
    "--unshare-pid",
    "--proc", "/proc",
    "--dev", "/dev",
    "--ro-bind", "/", "/",
  ];
  prefix.push("--bind", tempDir, tempDir);
  if (policy.mode === "workspace-write") {
    prefix.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
  }
  return [...prefix, "--", ...argv];
}
