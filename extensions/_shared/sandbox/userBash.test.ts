import { describe, expect, it, vi } from "vitest";
import type { SandboxedBashOperations } from "./operations.js";
import type { SandboxRunFacts } from "./types.js";
import { withTextMarkers } from "./userBash.js";

function opsReturning(exitCode: number | null, sandbox: SandboxRunFacts, output = ""): SandboxedBashOperations {
  return {
    exec: vi.fn(async (_command: string, _cwd: string, options: { onData?: (data: Buffer) => void }) => {
      if (output) options.onData?.(Buffer.from(output));
      return { exitCode, sandbox };
    }),
  };
}

async function run(ops: SandboxedBashOperations) {
  const chunks: string[] = [];
  const result = await withTextMarkers(ops).exec("echo hi", "D:/work", { onData: (d) => chunks.push(d.toString()) });
  return { result, text: chunks.join("") };
}

describe("withTextMarkers (user_bash)", () => {
  it("a clean run passes output through and adds nothing", async () => {
    const { result, text } = await run(opsReturning(0, { mode: "read-only", denied: false }, "hi\n"));
    expect(result).toEqual({ exitCode: 0 });
    expect(text).toBe("hi\n");
  });

  it("a denial appends the marker after the output, without the old bash_escalate sentence", async () => {
    const { result, text } = await run(
      opsReturning(1, { mode: "read-only", denied: true }, "touch: x: Read-only file system\n"),
    );
    expect(result).toEqual({ exitCode: 1 });
    expect(text).toBe("touch: x: Read-only file system\n[sandbox: file access denied under read-only mode]\n");
    expect(text).not.toContain("bash_escalate");
  });

  it("an unavailable sandbox reads exactly as before", async () => {
    const detail = "runner missing The command was not executed. Enable the OS runner or switch approval to 完全权限.";
    const { result, text } = await run(
      opsReturning(null, { mode: "read-only", denied: false, runnerFailed: "unavailable", detail }),
    );
    expect(result).toEqual({ exitCode: null });
    expect(text).toBe(`[sandbox: SANDBOX_UNAVAILABLE] ${detail}\n`);
  });

  it("a runner failure reads exactly as before", async () => {
    const { text } = await run(
      opsReturning(null, {
        mode: "read-only",
        denied: false,
        runnerFailed: "runner",
        detail: "the shell could not start (ENOENT)",
      }),
    );
    expect(text).toBe("[sandbox: runner failed] The command never started.\n");
  });
});
