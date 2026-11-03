import { realpathSync } from "node:fs";

function toPosixAbs(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * seatbelt 的 `subpath` 按内核看到的真实路径比对，不跟随符号链接。macOS 上 `/tmp`
 * 和 `/var` 都是指向 `/private/...` 的符号链接，`mkdtempSync(tmpdir())` 得到的
 * `/var/folders/…/sbx-xxx` 在 profile 里写着却匹配不上，工作区写入被拒。
 * 所以两种写法都放进去：原样的和解析后的。
 */
function spellings(root: string): string[] {
  const given = toPosixAbs(root);
  const out = [given];
  try {
    const real = toPosixAbs(realpathSync(root));
    if (real !== given) out.push(real);
  } catch {
    // 路径还不存在：只按原样写，行为与从前一致。
  }
  return out;
}

function writeAllowLines(root: string): string[] {
  return spellings(root).map((path) => `(allow file-write* (subpath "${path}"))`);
}

export function seatbeltProfile(
  policy: { mode: "read-only" | "workspace-write"; workspaceRoot: string },
  tempDir: string,
): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow file-read*)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow signal (target same-sandbox))",
    '(allow mach-lookup (global-name "com.apple.system.logger"))',
    "(allow network-outbound)",
    "(allow network-inbound)",
    "(allow system-socket)",
    '(allow file-write* (literal "/dev/null"))',
    ...writeAllowLines(tempDir),
  ];
  if (policy.mode === "workspace-write") {
    lines.push(...writeAllowLines(policy.workspaceRoot));
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
