import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandboxProvider } from "./provider.js";

const live = process.env.PI_SANDBOX_LIVE === "1";

function writeProbeArgv(inside: string, outside: string): string[] {
  // Git bash / WSL bash cannot start under a WRITE_RESTRICTED token
  // (MSYS signal pipe / WSL CreateInstance → Win32 error 5). That is not
  // a probe failure and must not fall back to an unwrapped spawn. Use
  // cmd.exe as the Windows payload so the ACL check is what we measure.
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return [comspec, "/c", `echo in>${inside}& echo out>${outside}`];
  }
  const posix = (p: string) => p.replace(/\\/g, "/");
  return ["bash", "-c", `echo in > "${posix(inside)}"; echo out > "${posix(outside)}"`];
}

describe.skipIf(!live)("live OS isolation", () => {
  it("blocks writes outside the workspace and allows inside", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-"));
    const inside = join(root, "ok.txt");
    const outsideDir = await mkdtemp(join(tmpdir(), "sbx-out-"));
    const outside = join(outsideDir, "no.txt");
    const provider = createSandboxProvider();
    const confined = await provider.confine(
      writeProbeArgv(inside, outside),
      { mode: "workspace-write", network: "enabled", workspaceRoot: root, sessionId: "live" },
    );
    expect(confined.argv[0]).not.toBe("bash");
    expect(confined.argv[0]).not.toBe("bash.exe");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(confined.argv[0], confined.argv.slice(1), { stdio: "pipe" });
      child.on("exit", () => resolve());
      child.on("error", reject);
    });
    await expect(readFile(inside, "utf8")).resolves.toMatch(/in/);
    await expect(readFile(outside, "utf8")).rejects.toThrow();
    expect(confined.enforcement).toBe(process.platform === "win32" ? "partial" : "full");
    await provider.dispose?.("live");
  });

  // win32: point helperPath at a missing exe (real probeWinHelper).
  // linux: empty PATH so execFile("bwrap") fails (real probeBwrap).
  // darwin: sandbox-exec is hardcoded to /usr/bin/sandbox-exec; this host
  // cannot hide it without root. Left to task 14's linux negative job.
  it.skipIf(process.platform === "darwin")(
    "throws SANDBOX_UNAVAILABLE when the runner cannot be found",
    async () => {
      const shell = process.platform === "win32" ? "bash.exe" : "bash";
      const policy = {
        mode: "workspace-write" as const,
        network: "enabled" as const,
        workspaceRoot: tmpdir(),
        sessionId: "live-missing",
      };

      if (process.platform === "win32") {
        const isolated = join(tmpdir(), "pi-sandbox-missing");
        const provider = createSandboxProvider({
          helperPath: join(isolated, "pi-sandbox-win.exe"),
          helperLookup: {
            envHelper: undefined,
            moduleDir: isolated,
            resourcesPath: isolated,
            cwd: isolated,
          },
        });
        await expect(provider.confine([shell, "-c", "true"], policy)).rejects.toMatchObject({
          code: "SANDBOX_UNAVAILABLE",
        });
        return;
      }

      const prevPath = process.env.PATH;
      const empty = await mkdtemp(join(tmpdir(), "sbx-nopath-"));
      process.env.PATH = empty;
      try {
        const provider = createSandboxProvider();
        await expect(provider.confine([shell, "-c", "true"], policy)).rejects.toMatchObject({
          code: "SANDBOX_UNAVAILABLE",
        });
      } finally {
        process.env.PATH = prevPath;
      }
    },
  );
});
