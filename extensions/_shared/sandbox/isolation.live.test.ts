import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import { createSandboxedBashOperations } from "./operations.js";
import { createSandboxProvider } from "./provider.js";
import { defaultIo, SANDBOX_GROUP, SANDBOX_USERNAME } from "./windows/account.js";
import { stampAmbientDenies } from "./windows/ambient.js";
import { ELEVATED_DONE, runElevated } from "./windows/elevate.js";

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

// Windows job hardening (docs: .agents/notes/implemented/architecture/2026-10-13-windows-sandbox-job-hardening.md)
interface ConfinedRun {
  root: string;
  exitCode: number | null;
  stderr: string;
  elapsedMs: number;
}

async function runConfinedWin(argv: string[], helperPath?: string): Promise<ConfinedRun> {
  const root = await mkdtemp(join(tmpdir(), "sbx-job-"));
  const provider = createSandboxProvider(helperPath ? { helperPath } : {});
  const confined = await provider.confine(
    argv,
    { mode: "workspace-write", network: "enabled", workspaceRoot: root, sessionId: "live-job" },
  );
  const started = Date.now();
  return await new Promise<ConfinedRun>((resolve, reject) => {
    const child = spawn(confined.argv[0], confined.argv.slice(1), { stdio: "pipe", cwd: root });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      void provider.dispose?.("live-job");
      resolve({ root, exitCode, stderr, elapsedMs: Date.now() - started });
    });
  });
}

async function pingProcessCount(): Promise<number> {
  const out = await new Promise<string>((resolve) => {
    const child = spawn("tasklist", ["/FI", "IMAGENAME eq ping.exe", "/FO", "CSV", "/NH"], { stdio: "pipe" });
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.on("close", () => resolve(text));
  });
  return out.split(/\r?\n/).filter((line) => line.toLowerCase().startsWith('"ping.exe"')).length;
}

describe.skipIf(!live || process.platform !== "win32")("live windows job hardening", () => {
  const comspec = process.env.ComSpec || "cmd.exe";

  it("still runs ordinary commands under the UI restrictions", async () => {
    const cmd = await runConfinedWin([comspec, "/c", "echo ok"], process.env.PI_SANDBOX_LIVE_HELPER);
    expect(cmd.exitCode).toBe(0);
    const ps = await runConfinedWin(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
      process.env.PI_SANDBOX_LIVE_HELPER,
    );
    expect(ps.exitCode).toBe(0);
    const failing = await runConfinedWin([comspec, "/c", "exit 7"], process.env.PI_SANDBOX_LIVE_HELPER);
    expect(failing.exitCode).toBe(7);
    // 受限令牌最容易误伤工具链：node 要能在它下面启动并把退出码带回来。
    const node = await runConfinedWin([process.execPath, "-e", "process.exit(3)"], process.env.PI_SANDBOX_LIVE_HELPER);
    expect(node.exitCode).toBe(3);
  });

  // 对照：旧 helper（无 UI 限制）下 `echo | clip` 退出码为 0，见笔记的验证段。
  it("blocks clipboard writes from inside the sandbox", async () => {
    const result = await runConfinedWin([comspec, "/c", "echo secret| clip"], process.env.PI_SANDBOX_LIVE_HELPER);
    expect(result.exitCode).not.toBe(0);
  });

  const failAssignHelper = process.env.PI_SANDBOX_LIVE_FAIL_ASSIGN_HELPER;
  // 钩子会让 launcher 先把命令拉起来再让分配失败：launcher 自己的 job 要把命令一起回收。
  it.skipIf(!failAssignHelper)("stops the launcher and exits 163 when the job cannot be joined", async () => {
    expect(await pingProcessCount()).toBe(0);
    const result = await runConfinedWin([comspec, "/c", "ping -n 30 127.0.0.1 >nul"], failAssignHelper);
    expect(result.exitCode).toBe(163);
    expect(result.stderr).toContain("AssignProcessToJobObject failed");
    expect(result.elapsedMs).toBeLessThan(15_000);
    await expect.poll(pingProcessCount, { timeout: 5_000 }).toBe(0);
  });
});

// 需要点一次 UAC：第一次 confine 会提权给 ProgramData、Public 等系统目录盖上写拒绝。
describe.skipIf(!live || process.platform !== "win32")("live windows ambient write-deny", () => {
  const comspec = process.env.ComSpec || "cmd.exe";
  const cases = [
    { name: "ProgramData", dir: process.env.ProgramData },
    { name: "Public", dir: process.env.PUBLIC },
  ];

  it("lets the sandbox write inside its workspace (control)", async () => {
    const result = await runConfinedWin([comspec, "/c", "echo x>ok.txt"]);
    await expect(readFile(join(result.root, "ok.txt"), "utf8")).resolves.toMatch(/x/);
  });

  for (const { name, dir } of cases) {
    it.skipIf(!dir)(`cannot write into ${name}`, async () => {
      const file = join(dir as string, `pi-probe-${Date.now()}.txt`);
      await runConfinedWin([comspec, "/c", `echo x>${file}`]);
      await expect(readFile(file, "utf8")).rejects.toThrow();
    });
  }
});

// 数据盘根上写权限来自 Authenticated Users:(M)，PiSandbox 靠这个组写进工作区的兄弟目录。
describe.skipIf(!live || process.platform !== "win32")("live windows write boundary on the data drive", () => {
  const comspec = process.env.ComSpec || "cmd.exe";
  const driveRoot = parse(process.cwd()).root;

  async function tryWrite(workspace: string, file: string): Promise<boolean> {
    const provider = createSandboxProvider(process.env.PI_SANDBOX_LIVE_HELPER ? { helperPath: process.env.PI_SANDBOX_LIVE_HELPER } : {});
    const confined = await provider.confine(
      [comspec, "/c", `echo x>${file}`],
      { mode: "workspace-write", network: "enabled", workspaceRoot: workspace, sessionId: "live-boundary" },
    );
    await new Promise<void>((resolve) => {
      const child = spawn(confined.argv[0], confined.argv.slice(1), { stdio: "pipe", cwd: workspace });
      child.on("close", () => resolve());
    });
    await provider.dispose?.("live-boundary");
    try {
      await readFile(file, "utf8");
      await rm(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  it("writes inside the workspace but not into a sibling directory on the same drive", async () => {
    const workspace = await mkdtemp(join(driveRoot, "sbx-bnd-ws-"));
    const sibling = await mkdtemp(join(driveRoot, "sbx-bnd-sib-"));
    try {
      expect(await tryWrite(workspace, join(workspace, "in.txt"))).toBe(true);
      expect(await tryWrite(workspace, join(sibling, "out.txt"))).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(sibling, { recursive: true, force: true });
    }
  });
});

// 沙箱以 PiSandbox 运行，工作区归真实用户所有；没有 safe.directory 注入时 git 会报 dubious ownership。
// 用 PI_SANDBOX_LIVE_GIT 指向一个机器级 git.exe（装在用户目录里的 git 读不到自己的 etc\gitconfig，是另一个问题）。
const liveGit = process.env.PI_SANDBOX_LIVE_GIT;
describe.skipIf(!live || process.platform !== "win32" || !liveGit)("live git in the sandbox account", () => {
  it("runs init, commit and log in a workspace owned by another user", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-git-"));
    const provider = createSandboxProvider();
    const ops = createSandboxedBashOperations({
      getPolicy: () => ({ mode: "workspace-write", network: "enabled", workspaceRoot: root, sessionId: "live-git" }),
      confine: (argv, policy) => provider.confine(argv, policy),
    });
    const env = { ...process.env };
    delete env.HOME;
    const chunks: string[] = [];
    const git = `& '${liveGit}'`;
    const result = await ops.exec(
      `${git} init -q; ${git} -c user.name=t -c user.email=t@t commit -q --allow-empty -m first; ${git} log --oneline`,
      root,
      { onData: (data) => chunks.push(data.toString()), env },
    );
    await provider.dispose?.("live-git");
    expect(chunks.join("")).not.toContain("dubious ownership");
    expect(chunks.join("")).toMatch(/[0-9a-f]{7} first/);
    expect(result.exitCode).toBe(0);
  });
});

// 会静默或弹窗提权，只在 PI_SANDBOX_LIVE_ELEVATE=1 时跑。提权全程不应在临时目录留下任何 pi-sandbox-* 文件。
const liveElevate = live && process.platform === "win32" && process.env.PI_SANDBOX_LIVE_ELEVATE === "1";
describe.skipIf(!liveElevate)("live elevation without temp files", () => {
  const tempEntries = () => readdirSync(tmpdir()).filter((name) => name.startsWith("pi-sandbox-") && !name.startsWith("pi-sandbox-launch"));

  it("reads the elevated script's result bits back, and null when it fails", async () => {
    const before = tempEntries();
    await expect(runElevated(`exit (${ELEVATED_DONE} -bor 5)`)).resolves.toBe(5);
    await expect(runElevated("$ErrorActionPreference = 'Stop'; throw 'boom'")).resolves.toBeNull();
    expect(tempEntries()).toEqual(before);
  });

  it("stamps the ambient write-deny and confirms it from the ACL", async () => {
    const publicDir = process.env.PUBLIC as string;
    const before = tempEntries();
    await expect(stampAmbientDenies([publicDir], SANDBOX_USERNAME)).resolves.toEqual([publicDir]);
    expect(tempEntries()).toEqual(before);
  });

  it("grants and confirms list on Windows Temp through the elevated path", async () => {
    const windowsTemp = join(process.env.SystemRoot || "C:\\Windows", "Temp");
    const before = tempEntries();
    await expect(defaultIo().grant(windowsTemp, SANDBOX_USERNAME, "RD1", false)).resolves.toBeUndefined();
    expect(tempEntries()).toEqual(before);
  });

  // 会把 PiSandbox 的密码重置成新的，再用新 blob 登录一次。只在 PI_SANDBOX_LIVE_PROVISION=1 时跑。
  it.skipIf(process.env.PI_SANDBOX_LIVE_PROVISION !== "1")("re-provisions the account and the sandbox still logs on with the new blob", async () => {
    const io = defaultIo();
    const before = tempEntries();
    await io.provision(SANDBOX_USERNAME, SANDBOX_GROUP, `Aa1!${randomBytes(18).toString("base64url")}`, io.blobPath());
    expect(tempEntries()).toEqual(before);
    const result = await runConfinedWin(["whoami.exe"]);
    expect(result.exitCode).toBe(0);
  });
});
