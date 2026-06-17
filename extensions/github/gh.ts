import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<ExecResult>;

export const defaultExec: Exec = (cmd, args, cwd, signal) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, signal });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

export async function runGh(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  exec: Exec = defaultExec,
): Promise<string> {
  let r: ExecResult;
  try {
    r = await exec("gh", args, cwd, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("未找到 gh CLI，请安装 GitHub CLI 并执行 `gh auth login`");
    }
    throw err;
  }
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || `gh 退出码 ${r.code}`);
  }
  return r.stdout;
}
