// user_bash（用户自己敲的命令）由 pi 显示输出，pi 不认识沙箱事实。这层把事实按旧版的文字写回输出流，
// 用户看到的和改动前一样；只有拒绝行去掉了「去调 bash_escalate」那半句（工具已删）。
import { sandboxDenialMarker } from "./facts.js";
import type { ExecOptions, SandboxedBashOperations } from "./operations.js";
import type { SandboxRunFacts } from "./types.js";

const RUNNER_FAILED_TEXT = "[sandbox: runner failed] The command never started.\n";

/** 事实对应的那行文字；干净的运行没有。 */
export function sandboxTextMarker(facts: SandboxRunFacts): string | undefined {
  if (facts.runnerFailed === "unavailable") return `[sandbox: SANDBOX_UNAVAILABLE] ${facts.detail ?? ""}\n`;
  if (facts.runnerFailed === "runner") return RUNNER_FAILED_TEXT;
  if (facts.denied) return `${sandboxDenialMarker(facts.mode)}\n`;
  return undefined;
}

/** pi 的 BashOperations 形状：只要退出码。 */
export interface UserBashOperations {
  exec(command: string, cwd: string, options: ExecOptions): Promise<{ exitCode: number | null }>;
}

export function withTextMarkers(operations: SandboxedBashOperations): UserBashOperations {
  return {
    async exec(command, cwd, options) {
      const { exitCode, sandbox } = await operations.exec(command, cwd, options);
      const marker = sandboxTextMarker(sandbox);
      if (marker) options.onData?.(Buffer.from(marker));
      return { exitCode };
    },
  };
}
