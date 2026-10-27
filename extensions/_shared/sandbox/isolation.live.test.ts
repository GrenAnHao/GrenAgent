import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSandboxedBashOperations } from "./operations.js";
import { createSandboxProvider } from "./provider.js";
import { defaultIo, grantKey, grantSandboxAccess, SANDBOX_GROUP, SANDBOX_USERNAME, type AccountIo } from "./windows/account.js";
import { stampAmbientDenies } from "./windows/ambient.js";
import { ELEVATED_DONE, runElevated, windowsPowerShellEnv, windowsPowerShellPath } from "./windows/elevate.js";
import { GRANT_MAX_IDLE_MS, revokeArgs, usedKey } from "./windows/reclaim.js";

const live = process.env.PI_SANDBOX_LIVE === "1";

/** 跟 bash 工具一样照 pi 解析壳：settings.json 的 shellPath，没有就按 pi 的默认顺序。 */
const liveShellPath = () => SettingsManager.create(process.cwd(), getAgentDir()).getShellPath();

// 每个测试建的目录都登记下来，整个文件跑完统一删掉：工作区会被授 PiSandbox 的修改权，留下来就是永久的授权。
const createdDirs: string[] = [];
async function scratchDir(parent: string, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(parent, prefix));
  createdDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

function writeProbeArgv(inside: string, outside: string): string[] {
  // cmd.exe as the Windows payload so the ACL check is what we measure, independent of
  // which bash is installed (Git Bash runs under the current token: see the Git Bash cases below).
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return [comspec, "/c", `echo in>${inside}& echo out>${outside}`];
  }
  const posix = (p: string) => p.replace(/\\/g, "/");
  return ["bash", "-c", `echo in > "${posix(inside)}"; echo out > "${posix(outside)}"`];
}

describe.skipIf(!live)("live OS isolation", () => {
  it("blocks writes outside the workspace and allows inside", async () => {
    const root = await scratchDir(tmpdir(), "sbx-");
    const inside = join(root, "ok.txt");
    const outsideDir = await scratchDir(tmpdir(), "sbx-out-");
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
      const empty = await scratchDir(tmpdir(), "sbx-nopath-");
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
  const root = await scratchDir(tmpdir(), "sbx-job-");
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
    const workspace = await scratchDir(driveRoot, "sbx-bnd-ws-");
    const sibling = await scratchDir(driveRoot, "sbx-bnd-sib-");
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
    const root = await scratchDir(tmpdir(), "sbx-git-");
    const provider = createSandboxProvider();
    const ops = createSandboxedBashOperations({
      getPolicy: () => ({ mode: "workspace-write", network: "enabled", workspaceRoot: root, sessionId: "live-git" }),
      confine: (argv, policy) => provider.confine(argv, policy),
      shellPath: liveShellPath,
    });
    const env = { ...process.env };
    delete env.HOME;
    const chunks: string[] = [];
    const git = `'${liveGit}'`;
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

// bash 工具在 Windows 上照 pi 用 Git Bash：经真实的沙箱 operations 跑，和工具里走的是同一条路。
describe.skipIf(!live || process.platform !== "win32")("live Git Bash through the sandboxed bash operations", () => {
  const sleepProcesses = () => {
    const out = execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"), ["/FI", "IMAGENAME eq sleep.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
    return out.split(/\r?\n/).filter((line) => line.toLowerCase().includes("sleep.exe")).length;
  };
  async function sandboxed(sessionId: string) {
    const root = await scratchDir(tmpdir(), "sbx-gitbash-");
    const outsideDir = await scratchDir(tmpdir(), "sbx-gitbash-out-");
    const provider = createSandboxProvider();
    const ops = createSandboxedBashOperations({
      getPolicy: () => ({ mode: "workspace-write", network: "enabled", workspaceRoot: root, sessionId }),
      confine: (argv, policy) => provider.confine(argv, policy),
      shellPath: liveShellPath,
    });
    const exec = async (command: string, signal?: AbortSignal) => {
      const chunks: string[] = [];
      const result = await ops.exec(command, root, { onData: (data) => chunks.push(data.toString()), env: { ...process.env }, ...(signal ? { signal } : {}) });
      return { ...result, text: chunks.join("") };
    };
    return { root, outsideDir, exec, dispose: () => provider.dispose?.(sessionId) };
  }

  it("runs a long command in the workspace with UTF-8, the sandbox account's HOME and the exit code", async () => {
    const box = await sandboxed("live-gitbash-run");
    // 3000 多字符的命令：命令经环境变量带进去，命令行长度和它无关，不会再撞 CreateProcessWithLogonW 的上限。
    const padding = `: '${"x".repeat(3000)}'`;
    const result = await box.exec(`${padding}\necho 中文; pwd -W; echo "HOME=$HOME"; echo in > ok.txt && echo inside_ok; git --version; exit 7`);
    await box.dispose();
    expect(result.exitCode).toBe(7);
    expect(result.sandbox).toMatchObject({ mode: "workspace-write", denied: false });
    expect(result.sandbox.runnerFailed).toBeUndefined();
    expect(result.text).toContain("中文");
    expect(result.text).toContain(box.root.replace(/\\/g, "/"));
    expect(result.text).toContain("inside_ok");
    expect(result.text).toMatch(/git version \d/);
    // 登录用户的家目录不带进沙箱：msys 按令牌的账户取家目录（/c/Users/PiSandbox）。
    const userHome = homedir().replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
    expect(result.text).not.toContain(`HOME=${userHome}\n`);
    expect(result.text).toMatch(/HOME=\S+/);
    expect(result.text).not.toContain("command line too long");
    await expect(readFile(join(box.root, "ok.txt"), "utf8")).resolves.toMatch(/in/);
  }, 120_000);

  it("reports a write outside the workspace as a sandbox denial and creates nothing", async () => {
    const box = await sandboxed("live-gitbash-deny");
    const outside = join(box.outsideDir, "no.txt").replace(/\\/g, "/");
    const result = await box.exec(`echo out > '${outside}'`);
    await box.dispose();
    expect(result.exitCode).not.toBe(0);
    expect(result.sandbox).toMatchObject({ mode: "workspace-write", denied: true });
    expect(result.text).toMatch(/Permission denied/i);
    await expect(readFile(join(box.outsideDir, "no.txt"), "utf8")).rejects.toThrow();
  }, 120_000);

  it("stops the shell and its children when aborted", async () => {
    const box = await sandboxed("live-gitbash-abort");
    const before = sleepProcesses();
    const controller = new AbortController();
    const running = box.exec("sleep 300 & sleep 300; wait", controller.signal);
    running.catch(() => undefined);
    // 沙箱准备（授权、登录）要几秒，等 sleep 真的起来再停。
    const started = Date.now() + 60_000;
    while (Date.now() < started && sleepProcesses() <= before) await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sleepProcesses()).toBeGreaterThan(before);
    const startedAbort = Date.now();
    controller.abort();
    await expect(running).rejects.toThrow("aborted");
    const end = Date.now() + 10_000;
    while (Date.now() < end && sleepProcesses() > before) await new Promise((resolve) => setTimeout(resolve, 200));
    await box.dispose();
    expect(sleepProcesses()).toBe(before);
    expect(Date.now() - startedAbort).toBeLessThan(10_000);
  }, 120_000);
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
    await expect(defaultIo().grant(windowsTemp, SANDBOX_USERNAME, "RD1")).resolves.toBeUndefined();
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

// 用真的 icacls 在一棵临时目录树上验证回收：闲置超时的修改权被撤掉，在用的工作区不动。不需要提权。
describe.skipIf(!live || process.platform !== "win32")("live windows grant reclaim", () => {
  const aceCount = (path: string) => execFileSync("icacls", [path]).toString("latin1")
    .split(/\r?\n/).filter((line) => /PiSandbox/i.test(line)).length;

  it("revokes a long-idle modify grant on the whole tree and keeps the one in use", async () => {
    const root = await scratchDir(tmpdir(), "sbx-reclaim-");
    const workspace = join(root, "ws");
    const idle = join(root, "idle");
    const tempDir = join(root, "tmp");
    for (const dir of [workspace, idle, tempDir, join(idle, "sub")]) mkdirSync(dir);
    writeFileSync(join(idle, "sub", "f.txt"), "x");

    const io = defaultIo();
    await io.grant(idle, SANDBOX_USERNAME, "M");
    expect([aceCount(idle), aceCount(join(idle, "sub", "f.txt"))]).toEqual([1, 1]);

    const store: Record<string, string> = {
      // Already recorded, so the Windows Temp list grant is not attempted (it would elevate).
      [grantKey(join(process.env.SystemRoot || "C:\\Windows", "Temp"))]: "RD1",
      [grantKey(idle)]: "M",
      [usedKey(grantKey(idle))]: String(Date.now() - GRANT_MAX_IDLE_MS - 24 * 60 * 60 * 1000),
    };
    // Only what this test is about: no elevation, no PATH directories, nothing else granted on the real machine.
    const withStore: AccountIo = {
      ...io,
      stampAmbient: undefined,
      pathEnv: () => "",
      readGrants: async () => ({ ...store }),
      writeGrants: async (_path, next) => {
        for (const key of Object.keys(store)) delete store[key];
        Object.assign(store, next);
      },
    };
    await grantSandboxAccess(
      SANDBOX_USERNAME,
      { mode: "workspace-write", network: "enabled", workspaceRoot: workspace, sessionId: "reclaim-live" },
      tempDir,
      withStore,
    );

    expect(store[grantKey(idle)]).toBeUndefined();
    // 撤销在后台进程里跑，等它做完。
    await expect.poll(() => aceCount(idle) + aceCount(join(idle, "sub", "f.txt")), { timeout: 15_000 }).toBe(0);
    expect(aceCount(workspace)).toBeGreaterThan(0);
  });
});

// 撤销带 /T，闲置的祖先目录被撤销会连带摘掉在用的子目录的 ACE：回收必须挡住这种情况。
describe.skipIf(!live || process.platform !== "win32")("live windows grant reclaim of a parent", () => {
  const aceCount = (path: string) => execFileSync("icacls", [path]).toString("latin1")
    .split(/\r?\n/).filter((line) => /PiSandbox/i.test(line)).length;

  it("keeps the ACE of a workspace that sits under a long-idle directory", async () => {
    const parent = await scratchDir(tmpdir(), "sbx-parent-");
    const workspace = join(parent, "ws");
    const tempDir = await scratchDir(tmpdir(), "sbx-parent-tmp-");
    mkdirSync(workspace);

    const io = defaultIo();
    await io.grant(parent, SANDBOX_USERNAME, "M");
    expect(aceCount(workspace)).toBeGreaterThan(0);

    const store: Record<string, string> = {
      [grantKey(join(process.env.SystemRoot || "C:\Windows", "Temp"))]: "RD1",
      [grantKey(parent)]: "M",
      [usedKey(grantKey(parent))]: String(Date.now() - GRANT_MAX_IDLE_MS - 24 * 60 * 60 * 1000),
    };
    const withStore: AccountIo = {
      ...io,
      stampAmbient: undefined,
      pathEnv: () => "",
      readGrants: async () => ({ ...store }),
      writeGrants: async (_path, next) => {
        for (const key of Object.keys(store)) delete store[key];
        Object.assign(store, next);
      },
    };
    await grantSandboxAccess(
      SANDBOX_USERNAME,
      { mode: "workspace-write", network: "enabled", workspaceRoot: workspace, sessionId: "reclaim-parent" },
      tempDir,
      withStore,
    );
    // Give a (wrongly) started background revoke time to finish before looking.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(store[grantKey(parent)]).toBe("M");
    expect(aceCount(workspace)).toBeGreaterThan(0);
  });
});

// 工作区里几个配置目录（.pi、.vscode、.idea）对沙箱账户只读：改、新建、删、改名都不行，读不受影响，
// 沙箱自己建出来的也一样（它是所有者，不先收回所有权它能把权限加回去），而工作区里别的东西和 git 的日常操作照常。
describe.skipIf(!live || process.platform !== "win32")("live windows protection of workspace configuration", () => {
  const comspec = process.env.ComSpec || "cmd.exe";
  const liveGit = process.env.PI_SANDBOX_LIVE_GIT;
  const DENIED = /access is denied|拒绝访问|denied/i;

  async function workspaceWithConfig(): Promise<string> {
    const workspace = await scratchDir(tmpdir(), "sbx-protect-");
    mkdirSync(join(workspace, ".pi"));
    writeFileSync(join(workspace, ".pi", "keep.txt"), "original");
    mkdirSync(join(workspace, "src"));
    return workspace;
  }

  async function run(workspace: string, command: string): Promise<{ code: number | null; text: string }> {
    const provider = createSandboxProvider();
    const confined = await provider.confine(
      [comspec, "/c", command],
      { mode: "workspace-write", network: "enabled", workspaceRoot: workspace, sessionId: "live-protect" },
    );
    const result = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(confined.argv[0], confined.argv.slice(1), { stdio: "pipe", cwd: workspace });
      const chunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
      // cmd prints its messages in the console code page (GBK on a Chinese system).
      child.on("close", (code) => resolve({ code, text: new TextDecoder("gb18030").decode(Buffer.concat(chunks)) }));
    });
    await provider.dispose?.("live-protect");
    return result;
  }

  const read = (path: string) => readFile(path, "utf8");

  it("blocks changing, creating, deleting and renaming the protected directories, and nothing else", async () => {
    const workspace = await workspaceWithConfig();
    // The first command makes the grant and the protection happen, and proves ordinary writes still work.
    await run(workspace, "echo ok> src\\fine.txt");
    await expect(read(join(workspace, "src", "fine.txt"))).resolves.toMatch(/ok/);
    // Reading is untouched.
    expect((await run(workspace, "type .pi\\keep.txt")).text).toContain("original");

    expect((await run(workspace, "echo changed> .pi\\keep.txt")).text).toMatch(DENIED);
    await expect(read(join(workspace, ".pi", "keep.txt"))).resolves.toBe("original");
    expect((await run(workspace, "echo new> .pi\\added.txt")).text).toMatch(DENIED);
    expect(existsSync(join(workspace, ".pi", "added.txt"))).toBe(false);
    expect((await run(workspace, "del .pi\\keep.txt")).text).toMatch(DENIED);
    expect(existsSync(join(workspace, ".pi", "keep.txt"))).toBe(true);
    expect((await run(workspace, "ren .pi .pi-moved")).text).toMatch(DENIED);
    expect(existsSync(join(workspace, ".pi", "keep.txt"))).toBe(true);
    expect(existsSync(join(workspace, ".pi-moved"))).toBe(false);
    // The account cannot hand itself the access back.
    await run(workspace, "icacls .pi /grant PiSandbox:F");
    expect((await run(workspace, "echo changed> .pi\\keep.txt")).text).toMatch(DENIED);
    await expect(read(join(workspace, ".pi", "keep.txt"))).resolves.toBe("original");

    await run(workspace, "echo more> src\\more.txt");
    await expect(read(join(workspace, "src", "more.txt"))).resolves.toMatch(/more/);
  });

  it("takes a directory the sandbox created itself away from it, because the owner can always rewrite the access list", async () => {
    const workspace = await workspaceWithConfig();
    await run(workspace, "mkdir .vscode && echo {}> .vscode\\settings.json");
    await expect(read(join(workspace, ".vscode", "settings.json"))).resolves.toMatch(/\{\}/);
    // The next command protects what exists by now; the one after tries to undo it.
    await run(workspace, "echo ok> src\\fine.txt");
    await run(workspace, "icacls .vscode /grant PiSandbox:F /T");
    await run(workspace, "echo tampered> .vscode\\settings.json");
    await expect(read(join(workspace, ".vscode", "settings.json"))).resolves.toMatch(/\{\}/);
    // Windows PowerShell 5.1 by its absolute path, without a PSModulePath inherited from pwsh 7 (it cannot load the security module with it).
    const owner = execFileSync(windowsPowerShellPath(), ["-NoProfile", "-Command", `(Get-Acl -LiteralPath '${join(workspace, ".vscode")}').Owner`], { env: windowsPowerShellEnv() }).toString().trim();
    expect(owner.toLowerCase()).not.toContain("pisandbox");
  });

  it("leaves the user's own account able to change them, and files the user adds are readable in the sandbox", async () => {
    const workspace = await workspaceWithConfig();
    await run(workspace, "echo ok> src\\fine.txt");
    writeFileSync(join(workspace, ".pi", "keep.txt"), "edited by the user");
    await expect(read(join(workspace, ".pi", "keep.txt"))).resolves.toBe("edited by the user");
    writeFileSync(join(workspace, ".pi", "later.txt"), "added later");
    expect((await run(workspace, "type .pi\\later.txt")).text).toContain("added later");
  });

  it("protects a directory that was deleted and created again", async () => {
    const workspace = await workspaceWithConfig();
    await run(workspace, "echo ok> src\\fine.txt");
    rmSync(join(workspace, ".pi"), { recursive: true, force: true });
    mkdirSync(join(workspace, ".pi"));
    writeFileSync(join(workspace, ".pi", "keep.txt"), "second");
    await run(workspace, "echo ok> src\\again.txt");
    expect((await run(workspace, "echo changed> .pi\\keep.txt")).text).toMatch(DENIED);
    await expect(read(join(workspace, ".pi", "keep.txt"))).resolves.toBe("second");
  });

  it("protects again after a reclaim stripped the tree and the workspace is granted again", async () => {
    const workspace = await workspaceWithConfig();
    await run(workspace, "echo ok> src\\fine.txt");
    const aces = (path: string) => execFileSync("icacls", [path]).toString("latin1").split(/\r?\n/).filter((line) => /PiSandbox/i.test(line)).join(" ");
    expect(aces(join(workspace, ".pi", "keep.txt"))).toMatch(/\(RX\)/);

    const grantsFile = join(homedir(), ".pi", "sandbox", "grants.json");
    const original = readFileSync(grantsFile, "utf8");
    try {
      // Reclaim the workspace the way reclaim.ts does: drop the record and revoke with /T, which also strips the
      // read entry the protection put on .pi. The next command grants the root again (inherited, no /T) and has to
      // put the protection back, or the sandbox could not even read .pi.
      const grants = JSON.parse(original) as Record<string, string>;
      delete grants[grantKey(workspace)];
      writeFileSync(grantsFile, JSON.stringify(grants));
      execFileSync("icacls", revokeArgs(workspace, "PiSandbox"));
      const probe = join(workspace, "src", "fine.txt");
      expect(aces(probe)).toBe("");
      expect(aces(join(workspace, ".pi", "keep.txt"))).toBe("");
      await run(workspace, "echo again> src\\again.txt");
      expect(aces(probe)).toMatch(/\(I\)\(M\)/);
      expect(aces(join(workspace, ".pi", "keep.txt"))).toMatch(/\(RX\)/);
      expect(aces(join(workspace, ".pi", "keep.txt"))).not.toMatch(/\(M\)/);
      expect((await run(workspace, "echo changed> .pi\\keep.txt")).text).toMatch(DENIED);
    } finally {
      writeFileSync(grantsFile, original);
    }
  });

  it.skipIf(!liveGit)("keeps everyday git working with the directories protected", async () => {
    const workspace = await workspaceWithConfig();
    execFileSync(liveGit as string, ["init", "-q"], { cwd: workspace });
    writeFileSync(join(workspace, "a.txt"), "hello");
    const provider = createSandboxProvider();
    const ops = createSandboxedBashOperations({
      getPolicy: () => ({ mode: "workspace-write", network: "enabled", workspaceRoot: workspace, sessionId: "live-protect-git" }),
      confine: (argv, policy) => provider.confine(argv, policy),
      shellPath: liveShellPath,
    });
    const env = { ...process.env };
    delete env.HOME;
    const git = `'${liveGit}'`;
    const step = async (command: string) => {
      const chunks: string[] = [];
      const result = await ops.exec(command, workspace, { onData: (data) => chunks.push(data.toString()), env });
      return { code: result.exitCode, text: chunks.join("") };
    };
    expect((await step(`${git} add -A`)).code).toBe(0);
    expect((await step(`${git} -c user.name=t -c user.email=t@t commit -q -m first`)).code).toBe(0);
    expect((await step(`${git} log --oneline`)).text).toMatch(/[0-9a-f]{7} first/);
    expect((await step(`${git} checkout -q -b topic`)).code).toBe(0);
    expect((await step(`${git} status --short`)).code).toBe(0);
    // The sandbox may still write its own repository configuration: .git is deliberately not part of the protection.
    expect((await step(`${git} config user.name someone`)).code).toBe(0);
    await provider.dispose?.("live-protect-git");
  });
});
