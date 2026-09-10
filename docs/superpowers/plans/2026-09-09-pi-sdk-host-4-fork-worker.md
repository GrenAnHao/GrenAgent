# Pi SDK 宿主 · 第 4 份：pi-worker 与 fork 子进程 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 子代理改为 `spawn(process.execPath, [PI_WORKER_ENTRY, ...jsonModeArgs])` + `ELECTRON_RUN_AS_NODE=1`，从 ALS 装配 per-workspace env，登记 cwd→child 并在关项目 / 退出时回收；POSIX `killTree` 改为进程组杀。

**架构：** `cli/src/pi-worker.ts` 只跑官方 `main()`（`--mode json` / print），不实现 rpc。`resolvePiCommand` 直读 `process.env.PI_WORKER_ENTRY`（不走 `getConfig`，用户可写的 runtime 文件不能改宿主二进制路径）。删除 `PI_BIN`。`spawnPiAgent(cwd, task, opts)` 签名不变。新模块 `subagentProcessRegistry.ts` 与已有的 SQLite `SubAgentRegistry`（`registry.ts`）不是同一个东西。

**技术栈：** TypeScript、Electron `ELECTRON_RUN_AS_NODE`、vitest、`node --test`

**规格来源：** `docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design.md` 的「Fork 子进程」「验证 · Fork」，以及 review 第四节「第 4 份」。

**依赖：** 第 2 份之后（ALS config 必须能并入子进程 env）。与第 3 份无强依赖，建议其后执行。

---

## 前置知识（工作者必读）

### 审查已推翻的旧计划写法

- 测试签名 **`spawnPiAgent({ prompt, cwd }, { spawn })` 是错的**。真实是 `spawnPiAgent(cwd, task, opts)`（`runner.ts:193-208`），调用方 `multi-agent/index.ts:371,421,479,564` 与 `im-platforms/index.ts:284`。
- **`windowsHide` 今日 runner 没有**，不要加（Electron GUI 子系统二进制不会弹控制台）。
- 「逐字保持」漏了：`--skill` 在 `--mode` 前、task 末位、`explore_context` deny、hard idle×10、exit-grace 100ms、`partial`、`SUBAGENT_MODE=inherit`、`PI_IS_SUBAGENT` **末位不可覆盖**。
- 旧计划称「workerEnv 必须保留给子进程」却没有任务把 per-workspace 键接进 spawn env（审查一.3）。主进程没有 sidecar 的 env，必须 `...currentWorkspaceContext()?.config`。
- 缺 cwd→pid 登记与关项目 / 退出回收（审查一.4）。已有 `SubAgentRegistry` 是 SQLite 任务表，**不管杀进程**。
- POSIX `killTree` 今日只 `child.kill()`（`runner.ts:360`），收不掉 MCP 孙进程。

### 为什么不用 `utilityProcess.fork`

子代理需要独立 argv / cwd / env，且必须能被 `killTree` 连孙进程一起收掉。不要拿「stdout JSONL」当理由。

### 子进程里 ALS 不存在

`getConfig()` 在子进程回退「文件 → env」。这是期望行为。`resolveToolOrigin()` 靠 `PI_IS_SUBAGENT=1` 返回 `subagent`。`buildSubagentRuntimeConfig` 读 `process.env.PI_RUNTIME_CONFIG`（Q2-A 已保证主进程有值）。

### `jsonModeArgs` 真实顺序（`runner.ts:215-239`）

```
[...baseArgs, ...skillArgs, "--mode", "json", "-p", "--no-session", "--no-approve",
  ...optional --model / --tools / --append-system-prompt,
  task]   // task 末位
```

`--skill` 在 `--mode` 前。worker 走 `main()` + `allExtensions`（`runtime.ts:153`），不是 `createGrenRuntime` 的过滤列表。

### 测试命令

| 包 | 命令 |
| --- | --- |
| `extensions/` | `cd extensions && npx vitest run multi-agent/` |
| `cli/` | `cd cli && node --import tsx --test src/pi-worker.test.ts` |
| `electron-agent/` | `cd electron-agent && npx vitest run --project main` |

---

## 文件结构

**新建：**

| 文件 | 职责 |
| --- | --- |
| `cli/src/pi-worker.ts` | 子进程入口：拒 rpc，调 `main(argv, { extensionFactories: allExtensions })`。 |
| `cli/src/pi-worker.test.ts` | `resolveWorkerMode`。 |
| `electron-agent/electron/pi-worker-entry.ts` | vite 入口，只调 `runWorker()`。 |
| `extensions/multi-agent/subagentProcessRegistry.ts` | cwd → child；`killSubagentsFor` / `killAllSubagents`。 |
| `extensions/multi-agent/subagentProcessRegistry.test.ts` | 登记、按 cwd 杀、killAll。 |

**修改：**

| 文件 | 改动 |
| --- | --- |
| `extensions/multi-agent/runner.ts` | `resolvePiCommand`、env 装配、POSIX 进程组、登记 child。 |
| `extensions/multi-agent/runner.test.ts` | 重写 `resolvePiCommand`；测 `buildSubagentLaunch`。 |
| `electron-agent/electron/main.ts` | 启动期设 `PI_WORKER_ENTRY`；quit 调 `killAllSubagents`。 |
| `electron-agent/electron/agent/createWorkspaceHandle.ts` | `onDispose` 接 `killSubagentsFor(cwd)`。 |
| `electron-agent/electron.vite.config.ts` | `main` input 改为 `{ index, 'pi-worker' }`。 |

**不要改：** `jsonModeArgs` 构造、`extractFinalText` / `isAgentEndLine`、节流 / idle / startup / quiet / hard / exit-grace、`cancel-requests.jsonl`、`MAX_CONCURRENCY` 4、`SUBAGENT_MAX_PER_SESSION` 6、memory-off 4 键、rc `0o600`、`deny spawn_agent + explore_context`。

---

## 任务 1：`pi-worker` 入口

**文件：**
- 创建：`cli/src/pi-worker.ts`、`cli/src/pi-worker.test.ts`
- 创建：`electron-agent/electron/pi-worker-entry.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWorkerMode } from "./pi-worker.js";

test("--mode json 被接受", () => {
  assert.equal(resolveWorkerMode(["--mode", "json", "-p"]), "json");
});

test("--mode rpc 被拒绝", () => {
  assert.throws(() => resolveWorkerMode(["--mode", "rpc"]), /does not support rpc/);
});

test("无 --mode 时按 print 路径", () => {
  assert.equal(resolveWorkerMode(["-p", "hello"]), "print");
});

test("--mode 后缺参数按 print", () => {
  assert.equal(resolveWorkerMode(["--mode"]), "print");
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd cli && node --import tsx --test src/pi-worker.test.ts`
预期：FAIL，无法解析。

- [ ] **步骤 3：实现**

`cli/src/pi-worker.ts`：

```ts
import { main } from "@earendil-works/pi-coding-agent";
import { allExtensions } from "../../extensions/index.js";
import { applyOfficialMainPackageDir } from "./official-package-dir.js";

export type WorkerMode = "json" | "print";

export function resolveWorkerMode(argv: string[]): WorkerMode {
  const i = argv.indexOf("--mode");
  if (i < 0 || argv[i + 1] === undefined) return "print";
  if (argv[i + 1] === "json") return "json";
  throw new Error(`pi-worker does not support rpc mode (got "${argv[i + 1]}").`);
}

function onPipeError(err: NodeJS.ErrnoException | undefined): void {
  if (err?.code === "EPIPE") process.exit(0);
}

export async function runWorker(): Promise<void> {
  const argv = process.argv.slice(2);
  process.stdout.on("error", onPipeError);
  process.stderr.on("error", onPipeError);
  process.on("uncaughtException", onPipeError);
  process.on("unhandledRejection", (reason) => onPipeError(reason as NodeJS.ErrnoException));
  resolveWorkerMode(argv);
  applyOfficialMainPackageDir(process.env);
  await main(argv, { extensionFactories: allExtensions });
}
```

**不要**在本文件底部自执行。vite 入口负责调用。

`electron-agent/electron/pi-worker-entry.ts`：

```ts
import { runWorker } from "../../cli/src/pi-worker.js";
void runWorker();
```

- [ ] **步骤 4：运行验证通过**

运行：`cd cli && node --import tsx --test src/pi-worker.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/pi-worker.ts cli/src/pi-worker.test.ts electron-agent/electron/pi-worker-entry.ts
git commit -m "feat(cli): add pi-worker entry that only runs official main() json/print"
```

---

## 任务 2：`resolvePiCommand` 改读 `PI_WORKER_ENTRY`

**文件：**
- 修改：`extensions/multi-agent/runner.ts:49-65`
- 测试：`extensions/multi-agent/runner.test.ts` 的 `resolvePiCommand` describe

- [ ] **步骤 1：改测试（先红）**

替换 `describe("resolvePiCommand")` 全部用例：

```ts
describe("resolvePiCommand", () => {
  const prev = process.env.PI_WORKER_ENTRY;
  afterEach(() => {
    if (prev === undefined) delete process.env.PI_WORKER_ENTRY;
    else process.env.PI_WORKER_ENTRY = prev;
    delete process.env.PI_BIN;
  });

  it("reads PI_WORKER_ENTRY from process.env, not getConfig", () => {
    process.env.PI_WORKER_ENTRY = "C:/app/out/main/pi-worker.js";
    expect(resolvePiCommand()).toEqual({
      cmd: process.execPath,
      baseArgs: ["C:/app/out/main/pi-worker.js"],
    });
  });

  it("throws when PI_WORKER_ENTRY is missing", () => {
    delete process.env.PI_WORKER_ENTRY;
    expect(() => resolvePiCommand()).toThrow(/PI_WORKER_ENTRY/);
  });

  it("ignores PI_BIN (deleted override)", () => {
    process.env.PI_BIN = "/custom/pi";
    process.env.PI_WORKER_ENTRY = "C:/app/pi-worker.js";
    expect(resolvePiCommand().cmd).toBe(process.execPath);
    expect(resolvePiCommand().baseArgs).toEqual(["C:/app/pi-worker.js"]);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd extensions && npx vitest run multi-agent/runner.test.ts`
预期：FAIL，仍走 `PI_BIN` / 当前 argv[1]。

- [ ] **步骤 3：改实现**

替换 `resolvePiCommand`：

```ts
export function resolvePiCommand(): { cmd: string; baseArgs: string[] } {
  const entry = process.env.PI_WORKER_ENTRY?.trim();
  if (!entry) {
    throw new Error("PI_WORKER_ENTRY is not set; the Electron host must assign the worker entry at startup");
  }
  return { cmd: process.execPath, baseArgs: [entry] };
}
```

删除 `INTERPRETER_ENTRY` 常量（若不再被引用）。删除 `getConfig("PI_BIN")`。`runtime?` 参数删掉——今日测试是唯一调用方。

- [ ] **步骤 4：运行验证通过**

运行：`cd extensions && npx vitest run multi-agent/runner.test.ts`
预期：PASS（其它 describe 不调 `resolvePiCommand()` 或需在它们 `beforeEach` 设 `PI_WORKER_ENTRY`——若全量红，在文件顶 `beforeEach` 设一个假入口）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/runner.ts extensions/multi-agent/runner.test.ts
git commit -m "feat(extensions): resolve subagent command from PI_WORKER_ENTRY"
```

---

## 任务 3：抽出 `buildSubagentLaunch`（env 装配 + 启动参数）

规格 env 块必须逐字对齐。抽出纯函数才能在不改 `spawnPiAgent(cwd, task, opts)` 签名的前提下测启动计划。

**文件：**
- 修改：`extensions/multi-agent/runner.ts`
- 测试：`extensions/multi-agent/runner.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { runInWorkspace } from "../_shared/workspace-context.js";
import { buildSubagentLaunch } from "./runner.js";

describe("buildSubagentLaunch", () => {
  beforeEach(() => {
    process.env.PI_WORKER_ENTRY = "C:/app/out/main/pi-worker.js";
  });

  it("command 是 process.execPath，args[0] 是 worker，task 末位，--skill 在 --mode 前", () => {
    const launch = buildSubagentLaunch("D:/proj", "do the work", {});
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toBe("C:/app/out/main/pi-worker.js");
    expect(launch.args[launch.args.length - 1]).toBe("do the work");
    const mode = launch.args.indexOf("--mode");
    expect(launch.args[mode + 1]).toBe("json");
    expect(launch.args.join(" ")).not.toMatch(/pi\.exe/);
  });

  it("env 顺序：ALS config 进入，PI_IS_SUBAGENT 末位不可覆盖，含 ELECTRON_RUN_AS_NODE 与 NODE_NO_WARNINGS", () => {
    const launch = runInWorkspace(
      {
        origin: "main",
        workspace: "D:/a",
        cwd: "D:/a",
        config: { AGENT_DATA_ENDPOINT: "token-a", PI_IS_SUBAGENT: "0" },
      },
      () => buildSubagentLaunch("D:/a", "t", { env: { PI_IS_SUBAGENT: "0" } }),
    );
    expect(launch.env.AGENT_DATA_ENDPOINT).toBe("token-a");
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(launch.env.NODE_NO_WARNINGS).toBe("1");
    expect(launch.env.PI_IS_SUBAGENT).toBe("1");
    expect(launch.env.PI_RUNTIME_CONFIG).toBeDefined();
  });

  it("stdio 为 ignore/pipe/pipe，无 windowsHide；POSIX 设 detached", () => {
    const launch = buildSubagentLaunch("D:/a", "t", {});
    expect(launch.spawnOptions.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(launch.spawnOptions).not.toHaveProperty("windowsHide");
    if (process.platform !== "win32") expect(launch.spawnOptions.detached).toBe(true);
  });

  it("deny 列表含 spawn_agent 与 explore_context", () => {
    const launch = buildSubagentLaunch("D:/a", "t", {});
    const deny = launch.env.SAFETY_DENY_TOOLS ?? "";
    expect(deny.split(",")).toEqual(expect.arrayContaining(["spawn_agent", "explore_context"]));
  });
});
```

「`PI_RUNTIME_CONFIG` 有值」依赖测试环境：在用例里 `process.env.PI_RUNTIME_CONFIG = file` 或接受「无父文件时 rc.path 为空、env 仍有 ALS 键」。把断言改成：有 ALS 的 `AGENT_DATA_ENDPOINT`；若测试设了 `PI_RUNTIME_CONFIG` 文件则 launch.env 指向派生文件。

- [ ] **步骤 2：运行验证失败**

运行：`cd extensions && npx vitest run multi-agent/runner.test.ts`
预期：FAIL，`buildSubagentLaunch` 不存在。

- [ ] **步骤 3：实现并改 `spawnPiAgent` 使用它**

把今日 `resolvePiCommand` + args 数组 + `buildSubagentRuntimeConfig` + spawn options 抽成：

```ts
import { currentWorkspaceContext } from "../_shared/workspace-context.js";

export function buildSubagentLaunch(
  cwd: string,
  task: string,
  opts: Parameters<typeof spawnPiAgent>[2] = {},
): {
  command: string;
  args: string[];
  env: Record<string, string>;
  spawnOptions: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; detached?: boolean };
  cleanup: () => void;
} {
  const { cmd, baseArgs } = resolvePiCommand();
  const args = [
    ...baseArgs,
    ...buildSubagentSkillArgs(getConfig("SUBAGENT_SKILLS_ROOT")),
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-approve",
  ];
  const model = opts.model ?? resolveSubagentModel();
  if (model) args.push("--model", model);
  if (opts.tools && opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
  let promptFile: string | undefined;
  if (opts.systemPrompt?.trim()) {
    promptFile = join(tmpdir(), `pi-subagent-sp-${randomBytes(4).toString("hex")}.md`);
    try {
      writeFileSync(promptFile, opts.systemPrompt, { encoding: "utf8", mode: 0o600 });
      args.push("--append-system-prompt", promptFile);
    } catch {
      promptFile = undefined;
    }
  }
  args.push(task);

  const rc = buildSubagentRuntimeConfig(opts.mcp, opts.env);
  const als = currentWorkspaceContext()?.config ?? {};
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...als,
    ...rc.env,
    ...(rc.path ? { PI_RUNTIME_CONFIG: rc.path } : {}),
    NODE_NO_WARNINGS: "1",
    ELECTRON_RUN_AS_NODE: "1",
    PI_IS_SUBAGENT: "1",
  };
  const cleanup = (): void => {
    rc.cleanup();
    if (promptFile) {
      try { rmSync(promptFile, { force: true }); } catch { /* gone */ }
    }
  };
  return {
    command: cmd,
    args,
    env,
    spawnOptions: {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(process.platform !== "win32" ? { detached: true } : {}),
    },
    cleanup,
  };
}
```

`spawnPiAgent` 里把「拼 args + rc + spawn(...)」换成：

```ts
  const launch = buildSubagentLaunch(cwd, task, opts);
  const child = spawn(launch.command, launch.args, {
    ...launch.spawnOptions,
    env: launch.env,
  });
  const unregister = registerSubagentProcess(cwd, child);
  // finish() 里现有 rc.cleanup / cleanupPrompt 改为 launch.cleanup()；并 unregister()
```

`finish` 开头加 `unregister()`。任务 4 再实现 registry；本步骤先写一个空实现以免断编译：

若任务 4 尚未落地，本步骤 `registerSubagentProcess` 先不调用，任务 4 再接。为避免两次改 spawn，**本步骤就 import 任务 4 将创建的函数**——先做任务 4 再做本步骤的 spawn 接线。调整顺序：先做任务 4 的 registry 文件，再在本步骤调用。

把任务 4 的步骤 1-3 提前到本步骤之前，或本步骤只抽 `buildSubagentLaunch`、spawn 行暂不登记。推荐：**本步骤只抽 launch + 改 env，不登记**；任务 4 再加登记与 POSIX kill。

`spawn` 第三参不要加 `windowsHide`。

- [ ] **步骤 4：运行验证通过**

运行：`cd extensions && npx vitest run multi-agent/`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/runner.ts extensions/multi-agent/runner.test.ts
git commit -m "feat(extensions): assemble subagent env from ALS and pin Electron-as-Node"
```

---

## 任务 4：进程登记表 + POSIX 进程组 `killTree`

**文件：**
- 创建：`extensions/multi-agent/subagentProcessRegistry.ts`、`.test.ts`
- 修改：`extensions/multi-agent/runner.ts` 的 `killTree` 与 spawn 后登记
- 修改：`electron-agent/electron/agent/createWorkspaceHandle.ts`、`electron-agent/electron/main.ts`

- [ ] **步骤 1：编写 registry 失败测试**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerSubagentProcess,
  killSubagentsFor,
  killAllSubagents,
  __resetSubagentProcessesForTest,
} from "./subagentProcessRegistry.js";

afterEach(() => {
  __resetSubagentProcessesForTest();
});

function child(pid: number) {
  return {
    pid,
    killed: false,
    exitCode: null,
    kill: vi.fn(function (this: { killed: boolean }) { this.killed = true; }),
  };
}

describe("subagentProcessRegistry", () => {
  it("killSubagentsFor 只杀该 cwd", () => {
    const a = child(11);
    const b = child(22);
    registerSubagentProcess("D:/a", a as never);
    registerSubagentProcess("D:/b", b as never);
    killSubagentsFor("D:/a");
    expect(a.kill).toHaveBeenCalled();
    expect(b.kill).not.toHaveBeenCalled();
  });

  it("子进程 exit 后自动从登记表移除", () => {
    const a = child(11) as { pid: number; kill: ReturnType<typeof vi.fn>; on?: Function };
    const handlers: Record<string, () => void> = {};
    a.on = (ev: string, fn: () => void) => { handlers[ev] = fn; };
    registerSubagentProcess("D:/a", a as never);
    handlers.exit?.();
    killSubagentsFor("D:/a");
    expect(a.kill).not.toHaveBeenCalled();
  });

  it("killAllSubagents 杀全部", () => {
    const a = child(11);
    const b = child(22);
    registerSubagentProcess("D:/a", a as never);
    registerSubagentProcess("D:/b", b as never);
    killAllSubagents();
    expect(a.kill).toHaveBeenCalled();
    expect(b.kill).toHaveBeenCalled();
  });
});
```

registry 的 kill 应调用导出的 `killProcessTree(pid, child)`，测试里 mock 它或直接断言 `child.kill`——实现里 Windows 走 `taskkill`，测试环境用注入：

```ts
export function registerSubagentProcess(cwd: string, child: ChildProcess, kill = killProcessTree): () => void
```

更简单：registry 只 `child.kill()` / 调 `killProcessTree(child)`；`killProcessTree` 在 runner 与 registry 共用。把 `killProcessTree` 放在 `subagentProcessRegistry.ts` 并导出，runner 的内部 `killTree` 改调它。

- [ ] **步骤 2：运行验证失败**

运行：`cd extensions && npx vitest run multi-agent/subagentProcessRegistry.test.ts`
预期：FAIL。

- [ ] **步骤 3：实现 registry + `killProcessTree`**

```ts
import { spawn, type ChildProcess } from "node:child_process";

const byCwd = new Map<string, Set<ChildProcess>>();

export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
      return;
    } catch {
      /* fall through */
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* 不是组长或已退：落到 child.kill */
    }
  }
  try { child.kill(); } catch { /* gone */ }
}

export function registerSubagentProcess(cwd: string, child: ChildProcess): () => void {
  let set = byCwd.get(cwd);
  if (!set) {
    set = new Set();
    byCwd.set(cwd, set);
  }
  set.add(child);
  const remove = (): void => {
    set!.delete(child);
    if (set!.size === 0) byCwd.delete(cwd);
  };
  child.once("exit", remove);
  return remove;
}

export function killSubagentsFor(cwd: string): void {
  const set = byCwd.get(cwd);
  if (!set) return;
  for (const child of [...set]) killProcessTree(child);
}

export function killAllSubagents(): void {
  for (const cwd of [...byCwd.keys()]) killSubagentsFor(cwd);
}

export function __resetSubagentProcessesForTest(): void {
  byCwd.clear();
}
```

`runner.ts` 的内部 `killTree` 改为 `() => killProcessTree(child)`。spawn 成功后 `const unregister = registerSubagentProcess(cwd, child)`，`finish` 调 `unregister()`。

- [ ] **步骤 4：`createWorkspaceHandle` / quit**

第 2 份的 `onDispose`：

```ts
    onDispose: async (workspace, cwd) => {
      disposeMcpManager(workspace);
      releaseImBinding(workspace);
      killSubagentsFor(cwd);
    },
```

`main.ts` 的 `before-quit`（第 1 份已有 `agentHost.closeAll()`）之后：

```ts
import { killAllSubagents } from "../../extensions/multi-agent/subagentProcessRegistry.js";
app.on("before-quit", () => { killAllSubagents(); });
```

若 `closeAll` 已经触发每个 handle 的 `onDispose` → `killSubagentsFor`，`killAllSubagents` 是兜底（没有 handle 的孤儿）。

- [ ] **步骤 5：POSIX kill 单测**

在 `subagentProcessRegistry.test.ts` 追加（只在非 win 跑进程组分支的 mock）：

```ts
  it("POSIX killProcessTree 先杀进程组", () => {
    if (process.platform === "win32") return;
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const c = { pid: 4242, kill: vi.fn() };
    killProcessTree(c as never);
    expect(spy).toHaveBeenCalledWith(-4242, "SIGKILL");
    spy.mockRestore();
  });
```

- [ ] **步骤 6：运行验证通过**

运行：`cd extensions && npx vitest run multi-agent/`  
`cd electron-agent && npx vitest run --project main electron/agent/workspaceHandle.test.ts`
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add extensions/multi-agent/subagentProcessRegistry.ts extensions/multi-agent/subagentProcessRegistry.test.ts extensions/multi-agent/runner.ts electron-agent/electron/agent/createWorkspaceHandle.ts electron-agent/electron/main.ts
git commit -m "feat(extensions): register subagent processes and kill POSIX process groups"
```

---

## 任务 5：vite worker chunk + 主进程注入 `PI_WORKER_ENTRY`

**文件：**
- 修改：`electron-agent/electron.vite.config.ts`
- 修改：`electron-agent/electron/main.ts`（Q2-A bootstrap 旁）

- [ ] **步骤 1：改 vite input**

今日 `input` 是字符串。改为对象，否则加第二入口会覆盖 main：

```ts
      input: {
        main: resolve(__dirname, "electron/main.ts"),
        "pi-worker": resolve(__dirname, "electron/pi-worker-entry.ts"),
      },
```

键名必须是 `main`，不能写成 `index`：`package.json` 的 `"main"` 是 `out/main/main.js`。electron-vite 用 input 对象的键当输出文件名。

`external` 保持原样（本份不处理 `@ast-grep`，第 5 份加）。

- [ ] **步骤 2：启动期设 env**

在 `runtimeConfigBootstrap` 之后、任何 `runInWorkspace` 之前：

```ts
function resolveWorkerEntry(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "app.asar.unpacked", "out", "main", "pi-worker.js");
  }
  return join(__dirname, "pi-worker.js");
}

process.env.PI_WORKER_ENTRY = resolveWorkerEntry();
```

**不**把该路径写入 ALS config / runtime-settings.json。`resolvePiCommand` 直读 env。

开发期 electron-vite 把 worker 打到 `out/main/pi-worker.js`，与 `__dirname`（main chunk 目录）一致。打包 asarUnpack 是第 5 份；本份先把路径函数写对。

- [ ] **步骤 3：验证构建产出 worker 文件**

```bash
cd electron-agent && npx electron-vite build --mode development
```

若该命令不存在，用项目已有的 `npm run build` 的 vite 阶段。预期 `electron-agent/out/main/pi-worker.js` 存在。

写一个 node 断言测试可选：`electron/agent/workerEntry.test.ts` 只测 `resolveWorkerEntry` 的打包 / 非打包分支（把 `app.isPackaged` / `__dirname` 做成纯函数入参）：

```ts
export function resolveWorkerEntry(input: { packaged: boolean; resourcesPath: string; mainDir: string }): string {
  return input.packaged
    ? join(input.resourcesPath, "app.asar.unpacked", "out", "main", "pi-worker.js")
    : join(input.mainDir, "pi-worker.js");
}
```

放进 `electron/agent/workerEntry.ts`，`main.ts` import 它。测试两分支。

- [ ] **步骤 4：Commit**

```bash
git add electron-agent/electron.vite.config.ts electron-agent/electron/main.ts electron-agent/electron/agent/workerEntry.ts electron-agent/electron/agent/workerEntry.test.ts
git commit -m "build(electron): emit pi-worker chunk and set PI_WORKER_ENTRY at boot"
```

---

## 任务 6：本份收尾

- [ ] **步骤 1：扫描必须保持的行为**

```bash
rg -n "explore_context|SUBAGENT_MODE|partial:|exitGraceMs|idleMs \\* 2|QUIET_MS|spawn_agent" extensions/multi-agent/runner.ts
```

预期：均仍在。`windowsHide` 在 `runner.ts` 中无匹配。`PI_IS_SUBAGENT` 赋值在 env 对象字面量最后一键。

- [ ] **步骤 2：全量**

```bash
cd extensions && npx vitest run multi-agent/
cd ../cli && node --import tsx --test src/pi-worker.test.ts
cd ../electron-agent && npx vitest run --project main
```

预期：PASS。

- [ ] **步骤 3：Commit（若有漏补）**

---

## 交付标准

- `resolvePiCommand()`：`cmd === process.execPath`，`baseArgs[0] === process.env.PI_WORKER_ENTRY`；无 `PI_BIN`。
- spawn env 含 `ELECTRON_RUN_AS_NODE` / `PI_IS_SUBAGENT` / `AGENT_DATA_ENDPOINT`（来自 ALS）/ `PI_RUNTIME_CONFIG` / `NODE_NO_WARNINGS`；`PI_IS_SUBAGENT` 不可被 ALS 或 `opts.env` 覆盖。
- args 含 worker 与 `--mode json`，`--skill` 在 `--mode` 前，task 末位；不含 `pi.exe`；无 `windowsHide`。
- 关 workspace 后该 cwd 子代理被杀；app quit 全部杀。
- POSIX `killProcessTree` 使用 `process.kill(-pid, "SIGKILL")` + `detached: true`。
- `pi-worker` 独立 chunk；`main()` + `allExtensions`。

**本份不可发布**：sidecar 二进制与 `resources/pi` 仍在（第 5 份删）。

## 已知风险（交给第 5 份）

1. **打包后 `pi-worker.js` 必须 asarUnpack**，否则 `ELECTRON_RUN_AS_NODE` spawn 读 asar 内入口可能失败。
2. **两套 SDK 副本**仍在，`registerProvider` 进程级分裂是第 5 份 `dedupe` 的工作。
3. **`import.meta.url` 相邻资源**（code-exec / fable-behavior）bundle 后路径，第 5 份复制。
