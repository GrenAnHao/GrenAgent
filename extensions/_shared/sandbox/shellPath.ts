/** 壳和它的参数；照 pi 的 getShellConfig。WSL 的 bash.exe 命令要走 stdin（pi 同样处理）。 */
export interface BashShell {
  shell: string;
  args: string[];
  commandTransport?: "stdin";
}

/** Windows Store / System32 bash.exe is the WSL launcher, not Git Bash. */
export function isLegacyWslBashPath(path: string): boolean {
  const normalized = path.replace(/\//g, "\\").toLowerCase();
  return (
    normalized.endsWith("\\system32\\bash.exe")
    || normalized.endsWith("\\syswow64\\bash.exe")
    || normalized.endsWith("\\sysnative\\bash.exe")
  );
}

/**
 * 和 pi 自己的 bash 工具同一套解析（utils/shell.js getShellConfig）：settings.json 的 shellPath →
 * Windows 上 Program Files 下的 Git Bash → PATH 上第一个 bash.exe → 报错并给出安装说明。Unix 上 /bin/bash → PATH 上的 bash → sh。
 * pi 包按需加载：sandbox 的共享模块本身不带上整个 SDK。
 */
export async function resolveBashShell(shellPath?: string): Promise<BashShell> {
  const { getShellConfig } = await import("@earendil-works/pi-coding-agent");
  const config = getShellConfig(shellPath || undefined) as BashShell;
  return { shell: config.shell, args: [...config.args], ...(config.commandTransport === "stdin" ? { commandTransport: "stdin" } : {}) };
}
