# bash 沙箱事实与同调用升权 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 沙箱层把拒绝和 runner 失败作为结构化事实返回，bash 工具负责给模型渲染标记、给界面放 `details.sandbox`；升权并进 bash 的 `sandbox_permissions` + `justification`，删掉 `bash_escalate`。

**架构：** `operations.exec` 返回 `{ exitCode, sandbox }`，不再往输出流写 `[sandbox: …]`；`user_bash` 经一层适配器把事实写回原来的文字。bash 前台把标记接在输出后、退出码前，后台由 `processOutcome` 并进 job 结算 detail。升权在执行前按 DSH `approveEscalation` 的顺序裁决，批准后同一次调用带 `PI_SANDBOX_MODE_ONCE` 走正常的 job 路径；safety 已经问过并允许的调用留一张一次性许可，bash 不再问第二次。渲染层读 `details.sandbox` 画折叠行和底栏，后台任务底栏认出 `processOutcome` 写的标记换成中文。

**技术栈：** TypeScript、typebox、vitest（extensions 与 electron-agent 两套）、React + antd-style、ui-harness（Electron 离屏渲染）。

**规格：** `docs/superpowers/specs/2026-10-05-bash-sandbox-facts-escalation-design.md`
**参考实现：** DSH `D:\System Dir\Downloads\deepseek-harness`：`packages/sandbox/sandbox/src/escalation.ts`、`packages/shell/tool-pwsh/src/{index,background}.ts`、`packages/shell/shell/src/types.ts`

---

## 执行约定

- 工作区里有大量与本计划无关的未提交改动（Devin 账户、codemode 卡片、multi-agent、web-search 等）。其中 `extensions/safety/index.ts`、`extensions/sandbox/bashTool.ts`、`electron-agent/src/features/tools/ToolExecution.tsx`、`bashCardModel.ts`、整个 `electron-agent/ui-harness/` 本身就带着别的未提交改动。所以**每个任务结束不 commit**，只做检查点；全部完成后由用户决定怎么提交（任务 15）。不要 `git stash`、`git checkout --`、`git add -A`。
- 规格要求一次改完：只拿掉流里的标记而工具还没渲染，模型会看不到拒绝。中途不要重启应用去试。
- 命令都从仓库根 `D:\OneDrive\Project Files\Pi` 开始，PowerShell。原生程序结尾加 `; exit $LASTEXITCODE`。
- extensions 测试：`cd extensions; npx vitest run <路径>; exit $LASTEXITCODE`。
- extensions 类型检查（extensions 没有自己的 tsconfig，借 cli 的，它 include 了 `../extensions`）：`cd cli; npx tsc -p tsconfig.json > ../.tmp-tsc.log 2>&1; exit 0`，再用 search 工具在 `.tmp-tsc.log` 里找本任务改过的文件名。只看这些文件的报错，别的文件原本就可能有。
- 渲染层测试：`cd electron-agent; npx vitest run <路径>; exit $LASTEXITCODE`。
- 子代理里跑测试会继承 `PI_IS_SUBAGENT=1`，`resolveToolOrigin()` 会返回 `subagent`。本计划新写的测试在 `beforeEach` 里删掉它；safety 现有用例对它同样敏感，那是原有问题，不在本计划里修。
- 临时文件（`.tmp-tsc.log`、`.tmp-uicheck.log`）用完删掉。仓库根已有的 `.tmp-dup-send.cjs`、`.tmp-pkg.txt` 和 `electron-agent/.tmp-cdp-probe.mjs` 不是本计划的，不要动。

## 与规格的出入

以下几处是写计划时对照代码发现的，实现以本计划为准，决策笔记（任务 14）照此写。

1. **`user_bash` 的拒绝行。** 规格写「和现在完全相同的文字」，但现在那行在叫模型去调已删的 `bash_escalate`。改为只留 `[sandbox: file access denied under <mode> mode]`；`SANDBOX_UNAVAILABLE` 和 `runner failed` 两行逐字不变。
2. **`runnerFailed` 是 `"unavailable" | "runner"`，不是 `true`。** `user_bash` 适配器要据此写回两种不同的旧文字。
3. **safety 不改 `ToolCallFacts`。** 主进程 `electron-agent/electron/app/toolPermission/rpc.ts` 按白名单解析 facts，多出的 `escalation` 字段会被丢掉；升权参数本来就在 `rawArgs` 里进审计。safety 直接从 `event.input` 读升权参数写进询问文字。
4. **后台任务底栏不直接显示 detail。** detail 里是写给模型的英文标记和升权提示，直接给用户看不对。底栏认出 `processOutcome` 写的标记，显示「沙箱拒绝（只读）」「沙箱没有启动，命令没有执行」，完整 detail 留在现有的悬停提示 `title={job.detail}` 里。
5. **「没有界面」要看回合来源。** goal 回合 `ctx.hasUI` 仍是 true，但宿主对所有对话框立即返回取消（`electron-agent/electron/agent/sessionUiAdapter.ts:130`）。审批通道 = `ctx.hasUI && resolveToolOrigin() === "main"`，规格里「子代理和 goal 回合不提示」才成立。
6. **升权失败照 DSH 抛错。** pi 把抛出的错误变成 `isError` 结果，和现有的 `Invalid timeout` 一样，命令不执行。

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `extensions/_shared/sandbox/types.ts` | 改 | 加 `SandboxRunFacts`；删 `BashEscalationRequest` |
| `extensions/_shared/sandbox/facts.ts` | 新 | 纯模块：升权目标闭集、三种标记原文、`sandboxNotes`、`parseSandboxNote`。渲染层也引用 |
| `extensions/_shared/sandbox/operations.ts` | 改 | `exec` 返回 `{ exitCode, sandbox }`，不写标记，不记 pending |
| `extensions/_shared/sandbox/userBash.ts` | 新 | `withTextMarkers`：给 `user_bash` 把事实写回文字 |
| `extensions/_shared/sandbox/escalationGrant.ts` | 新 | safety 问过并允许的那次调用的一次性许可 |
| `extensions/_shared/sandbox/escalate.ts` | 改 | 删 `justifyOk` |
| `extensions/_shared/sandbox/index.ts` | 改 | 出口跟着改 |
| `extensions/_shared/sandbox/pendingDenial.ts`、`pendingDenial.test.ts` | 删 | |
| `extensions/sandbox/escalation.ts` | 新 | bash 的升权：参数校验、`canOfferEscalation`、`approveEscalation`、参数说明和 guideline 原文 |
| `extensions/sandbox/bashJob.ts` | 改 | `ExecFn` / `BashExit` 带事实；`processOutcome` 把说明并进 detail |
| `extensions/sandbox/bashTool.ts` | 改 | 前台渲染标记和 `details.sandbox`；升权参数与审批；`bashEnv` 去掉宿主环境里的单次放宽 |
| `extensions/sandbox/index.ts` | 改 | 接 `sandboxGate` 和 `user_bash` 适配器；删 `bash_escalate`；关会话清许可 |
| `extensions/safety/index.ts` | 改 | 询问时写明升权目标和理由；允许后留许可 |
| `extensions/agent-mode/modes.ts`、`index.ts` | 改 | 白名单和注释去掉 `bash_escalate` |
| `electron-agent/src/features/tools/bashCardModel.ts` | 改 | `bashSandboxFacts` 与文案；后台底栏认沙箱说明 |
| `electron-agent/src/features/tools/ToolExecution.tsx` | 改 | 折叠行 meta 与终端底栏 |
| `electron-agent/ui-harness/bashJobFixtures.ts`、`scenarios/bash-job-card.tsx`、`probes/bash-job-card.mjs` | 改 | 前台被拒、已升权、后台被拒三种情况 |
| `docs/decisions/extensions/2026-10-05-bash-sandbox-facts-and-escalation.md` | 新 | 决策笔记 |
| `docs/architecture.md`、`AGENTS.md` | 改 | 工具清单、场景说明 |

每个源文件旁的 `*.test.ts(x)` 跟着改或新建，具体见各任务。

---

### 任务 1：沙箱事实的词表

**文件：**
- 修改：`extensions/_shared/sandbox/types.ts`（`SandboxExecutionPolicy` 之后加 `SandboxRunFacts`）
- 创建：`extensions/_shared/sandbox/facts.ts`
- 测试：`extensions/_shared/sandbox/facts.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/_shared/sandbox/facts.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  ESCALATION_TARGETS,
  escalationHintMarker,
  parseSandboxNote,
  runnerFailedMarker,
  sandboxDenialMarker,
  sandboxNotes,
} from "./facts.js";

describe("sandbox fact markers (DSH escalation.ts verbatim)", () => {
  it("names the denied mode", () => {
    expect(sandboxDenialMarker("read-only")).toBe("[sandbox: file access denied under read-only mode]");
  });

  it("teaches the same-call escalation retry", () => {
    expect(escalationHintMarker()).toBe(
      "[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]",
    );
  });

  it("says the runner failed and the command did not run", () => {
    expect(runnerFailedMarker("workspace-write")).toBe(
      "[sandbox: the sandbox runner failed under workspace-write mode — the command did not run; this is a sandbox problem, not a command failure]",
    );
  });

  it("escalation targets are the closed wider-mode vocabulary", () => {
    expect([...ESCALATION_TARGETS]).toEqual(["workspace-write", "danger-full-access"]);
  });
});

describe("sandboxNotes", () => {
  it("a clean run has no notes", () => {
    expect(sandboxNotes({ mode: "read-only", denied: false }, true)).toEqual([]);
  });

  it("a denial carries the hint only when escalation is on offer", () => {
    expect(sandboxNotes({ mode: "read-only", denied: true }, true)).toEqual([
      sandboxDenialMarker("read-only"),
      escalationHintMarker(),
    ]);
    expect(sandboxNotes({ mode: "read-only", denied: true }, false)).toEqual([sandboxDenialMarker("read-only")]);
  });

  it("a runner failure names the mode and passes the reason through, never a hint", () => {
    expect(
      sandboxNotes({ mode: "read-only", denied: false, runnerFailed: "unavailable", detail: "runner missing" }, true),
    ).toEqual([runnerFailedMarker("read-only"), "runner missing"]);
    expect(sandboxNotes({ mode: "read-only", denied: false, runnerFailed: "runner" }, true)).toEqual([
      runnerFailedMarker("read-only"),
    ]);
  });
});

describe("parseSandboxNote", () => {
  it("reads back what processOutcome writes into a job detail", () => {
    expect(
      parseSandboxNote(`exit code: 1; ${sandboxDenialMarker("workspace-write")} ${escalationHintMarker()}`),
    ).toEqual({ kind: "denied", mode: "workspace-write" });
    expect(parseSandboxNote(`${runnerFailedMarker("read-only")} runner missing`)).toEqual({
      kind: "runner-failed",
      mode: "read-only",
    });
  });

  it("ignores details without a sandbox marker", () => {
    expect(parseSandboxNote(undefined)).toBeUndefined();
    expect(parseSandboxNote("exit code: 1")).toBeUndefined();
    expect(parseSandboxNote("killed before exit; cancelled by the user")).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run _shared/sandbox/facts.test.ts; exit $LASTEXITCODE`
预期：FAIL，报 `Failed to resolve import "./facts.js"`。

- [ ] **步骤 3：加事实类型**

在 `extensions/_shared/sandbox/types.ts` 的 `SandboxExecutionPolicy` 接口之后插入。这个文件不写分号，保持原样：

```ts
/**
 * 一次 exec 的沙箱事实（DSH ShellSandboxInfo）：执行器作为数据返回，和退出码互不影响。
 * 给模型的标记由工具层用 facts.ts 渲染，不进输出流。
 */
export interface SandboxRunFacts {
  /** 这次实际生效的模式（含 PI_SANDBOX_MODE_ONCE 单次放宽）。 */
  mode: FileSandboxMode
  /** 沙箱拦下了文件操作（attributeRun 判为 denial）。 */
  denied: boolean
  /** 命令没有执行：unavailable = 隔离起不来；runner = runner 或壳没起来。 */
  runnerFailed?: "unavailable" | "runner"
  /** runnerFailed 的原因，原样交给模型和界面。 */
  detail?: string
}
```

- [ ] **步骤 4：写词表**

创建 `extensions/_shared/sandbox/facts.ts`。只能有类型导入：渲染层会直接引用这个文件。

```ts
// 沙箱事实的词表，照 DSH packages/sandbox/sandbox/src/escalation.ts：拒绝标记、升权提示、runner 失败标记。
// 纯模块（只有类型导入）：bash 工具、user_bash 适配器、job 结算 detail 都从这里取原文；
// 渲染层用 parseSandboxNote 认后台任务 detail 里的说明。格式和解析放在一起，不会各写一份。
import type { FileSandboxMode, SandboxRunFacts } from "./types.js";

/** 能升权到的模式闭集（read-only 是底，没有谁升到它）。 */
export const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"] as const;
export type EscalationTarget = (typeof ESCALATION_TARGETS)[number];

export function sandboxDenialMarker(mode: FileSandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`;
}

/** 跟在拒绝后面的同回合提示：重试的办法放在决策点，不靠模型记得工具说明。 */
export function escalationHintMarker(): string {
  return "[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]";
}

export function runnerFailedMarker(mode: FileSandboxMode): string {
  return `[sandbox: the sandbox runner failed under ${mode} mode — the command did not run; this is a sandbox problem, not a command failure]`;
}

/**
 * 给模型的沙箱说明，按顺序：runner 失败（标记 + 原因），或拒绝（标记 + 可升权时的提示）。
 * 前台逐行接在输出后面，后台用空格并进 job 结算 detail。
 */
export function sandboxNotes(facts: SandboxRunFacts, offerEscalation: boolean): string[] {
  if (facts.runnerFailed) return [runnerFailedMarker(facts.mode), ...(facts.detail ? [facts.detail] : [])];
  if (facts.denied) return [sandboxDenialMarker(facts.mode), ...(offerEscalation ? [escalationHintMarker()] : [])];
  return [];
}

export interface SandboxNote {
  kind: "denied" | "runner-failed";
  mode: FileSandboxMode;
}

const MODE = "(read-only|workspace-write|danger-full-access)";
const RUNNER_FAILED_RE = new RegExp(`\\[sandbox: the sandbox runner failed under ${MODE} mode`);
const DENIED_RE = new RegExp(`\\[sandbox: file access denied under ${MODE} mode\\]`);

/** 从 processOutcome 写的 job detail 里认出沙箱说明。只认上面两个函数写出的标记，不看命令输出。 */
export function parseSandboxNote(text: string | undefined): SandboxNote | undefined {
  if (!text) return undefined;
  const runner = RUNNER_FAILED_RE.exec(text);
  if (runner) return { kind: "runner-failed", mode: runner[1] as FileSandboxMode };
  const denied = DENIED_RE.exec(text);
  if (denied) return { kind: "denied", mode: denied[1] as FileSandboxMode };
  return undefined;
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd extensions; npx vitest run _shared/sandbox/facts.test.ts; exit $LASTEXITCODE`
预期：PASS，全部用例通过。

- [ ] **步骤 6：检查点**

`git diff -- extensions/_shared/sandbox/types.ts` 只有新增的 `SandboxRunFacts`；`git status --short extensions/_shared/sandbox` 多出 `facts.ts`、`facts.test.ts`。不 commit。

---

### 任务 2：operations 只交事实

**文件：**
- 修改：`extensions/_shared/sandbox/operations.ts`（第 1-53 行的导入、接口、常量；第 208-292 行的 `exec`）
- 测试：`extensions/_shared/sandbox/operations.test.ts`

- [ ] **步骤 1：改测试为断言事实**

`extensions/_shared/sandbox/operations.test.ts`：

(a) 第 6-18 行的导入和 `afterEach` 换成（去掉 `pendingDenial` 和 `afterEach`）：

```ts
import { describe, expect, it, vi } from "vitest";
import { SandboxUnavailableError } from "./errors.js";
import { createSandboxedBashOperations, PS_UTF8_PREFIX } from "./operations.js";
import type { ConfinedArgv, FileSandboxMode, SandboxExecutionPolicy } from "./types.js";
import { SANDBOX_DENIAL_EXIT } from "./types.js";
```

(b) 第一条 `spawns [shell, -c, command] and skips confine in danger-full-access` 末尾加一行：

```ts
    expect(result.sandbox).toEqual({ mode: "danger-full-access", denied: false });
```

(c) 从 `does not spawn when confine throws SandboxUnavailableError` 到 `does not treat the same denial phrase on stdout as a denial` 的五条（原第 151-228 行）整体换成：

```ts
  it("does not spawn when confine throws SandboxUnavailableError; reports it as a fact", async () => {
    const { ops, spawnImpl } = makeOps({
      confine: vi.fn(async () => {
        throw new SandboxUnavailableError("runner missing");
      }),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      exitCode: null,
      sandbox: {
        mode: "read-only",
        denied: false,
        runnerFailed: "unavailable",
        detail: "runner missing The command was not executed. Enable the OS runner or switch approval to 完全权限.",
      },
    });
    expect(text()).toBe("");
  });

  it("does not tell the user to drop the sandbox when a grant fails", async () => {
    const { ops, spawnImpl } = makeOps({
      confine: vi.fn(async () => {
        throw new SandboxUnavailableError("failed to grant PiSandbox access to C:/work: icacls exited 5");
      }),
    });
    const result = await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.sandbox.runnerFailed).toBe("unavailable");
    expect(result.sandbox.detail).toMatch(/failed to grant PiSandbox/);
    expect(result.sandbox.detail).toMatch(/The command was not executed\.$/);
    expect(result.sandbox.detail).not.toMatch(/完全权限/);
  });

  it("reports a denial on exit 162 as a fact, not as output", async () => {
    const { ops } = makeOps({
      mode: "read-only",
      spawnImpl: vi.fn(() => fakeChild({ exitCode: SANDBOX_DENIAL_EXIT })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result).toEqual({ exitCode: SANDBOX_DENIAL_EXIT, sandbox: { mode: "read-only", denied: true } });
    expect(text()).toBe("");
  });

  it("reports a denial from stderr Read-only file system on exit 1; the output is only the command's", async () => {
    const { ops } = makeOps({
      mode: "read-only",
      spawnImpl: vi.fn(() => fakeChild({ exitCode: 1, stderr: "touch: foo: Read-only file system\n" })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result).toEqual({ exitCode: 1, sandbox: { mode: "read-only", denied: true } });
    expect(text()).toBe("touch: foo: Read-only file system\n");
  });

  it("does not treat the same denial phrase on stdout as a denial", async () => {
    const { ops } = makeOps({
      mode: "read-only",
      spawnImpl: vi.fn(() => fakeChild({ exitCode: 1, stdout: "Read-only file system\n" })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result).toEqual({ exitCode: 1, sandbox: { mode: "read-only", denied: false } });
    expect(text()).toBe("Read-only file system\n");
  });

  it("reports a runner launch failure matched by its exit code and signature", async () => {
    const { ops } = makeOps({
      mode: "read-only",
      spawnImpl: vi.fn(() => fakeChild({ exitCode: 127, stderr: "bwrap: executable not found\n" })),
    });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result).toEqual({ exitCode: 127, sandbox: { mode: "read-only", denied: false, runnerFailed: "runner" } });
    expect(text()).toBe("bwrap: executable not found\n");
  });
```

(d) `applies a legal PI_SANDBOX_MODE_ONCE widening without mutating the caller env`：把 `await ops.exec(COMMAND, CWD, { onData, env });` 改成 `const result = await ops.exec(COMMAND, CWD, { onData, env });`，末尾加：

```ts
    expect(result.sandbox).toEqual({ mode: "workspace-write", denied: false });
```

(e) `writes spawnError and attributes runner-failure` 和 `reports runner-failure for spawnError without confine` 两条（原第 361-383 行）换成：

```ts
  it("reports a shell that cannot spawn as a runner failure", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const { ops } = makeOps({ spawnImpl: vi.fn(() => fakeChild({ spawnError: err })) });
    const { onData, text } = collectOnData();
    const result = await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(result).toEqual({
      exitCode: null,
      sandbox: { mode: "read-only", denied: false, runnerFailed: "runner", detail: "the shell could not start (ENOENT)" },
    });
    expect(text()).toBe("");
  });

  it("reports runner-failure for spawnError without confine", async () => {
    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    const { ops, confine } = makeOps({
      mode: "danger-full-access",
      spawnImpl: vi.fn(() => fakeChild({ spawnError: err })),
    });
    const result = await ops.exec(COMMAND, CWD, { onData: () => {}, env: {} });
    expect(confine).not.toHaveBeenCalled();
    expect(result).toEqual({
      exitCode: null,
      sandbox: { mode: "danger-full-access", denied: false, runnerFailed: "runner", detail: "the shell could not start (ENOENT)" },
    });
  });
```

(f) `refuses Windows bash.exe under the restricted-token helper`：`const result = ...` 之后的断言换成：

```ts
    expect(confine).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(result.exitCode).toBeNull();
    expect(result.sandbox).toMatchObject({ mode: "read-only", denied: false, runnerFailed: "unavailable" });
    expect(result.sandbox.detail).toContain("Git Bash or WSL bash");
    expect(result.sandbox.detail).toContain("完全权限");
    expect(text()).toBe("");
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run _shared/sandbox/operations.test.ts; exit $LASTEXITCODE`
预期：FAIL。新用例拿到的是 `{ exitCode }`，没有 `sandbox`；`text()` 里还有 `[sandbox: …]`。

- [ ] **步骤 3：改导入、接口和常量**

`extensions/_shared/sandbox/operations.ts`：

删掉第 6 行 `import { rememberPendingDenial } from "./pendingDenial.js";`。第 9 行改成：

```ts
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxPolicy, SandboxRunFacts } from "./types.js";
```

`SandboxedBashOperations` 换成：

```ts
/**
 * 沙箱事实作为数据返回（DSH ShellSandboxInfo）：拒绝、runner 失败、隔离起不来都不写进 onData，
 * onData 里只有命令自己的输出。给模型的标记由 bash 工具渲染（facts.ts），user_bash 经 userBash.ts 写回文字。
 */
export interface SandboxedBashOperations {
  exec: (
    command: string,
    cwd: string,
    options: ExecOptions,
  ) => Promise<{ exitCode: number | null; sandbox: SandboxRunFacts }>;
}
```

第 51-53 行的 `RUNNER_FAILED`、`WINDOWS_BASH_UNAVAILABLE` 换成下面一个常量（`RUNNER_FAILED` 的旧文字搬到任务 3 的 `userBash.ts`）：

```ts
/** 受限模式下 Windows 的 bash.exe 起不来。去掉了旧版的 `[sandbox: SANDBOX_UNAVAILABLE] ` 前缀和换行，user_bash 适配器会加回去。 */
const WINDOWS_BASH_UNAVAILABLE =
  "Windows OS sandbox cannot start Git Bash or WSL bash under a restricted token (Win32 error 5). The command was not executed. Switch approval to 完全权限.";
```

- [ ] **步骤 4：`exec` 返回事实**

把 `return {` 开始的 `exec`（原第 208-292 行）整体换成：

```ts
  return {
    async exec(command, cwd, options) {
      const policy = { ...deps.getPolicy() };
      const env = { ...(options.env ?? process.env) };
      const once = env.PI_SANDBOX_MODE_ONCE;
      if (
        (once === "workspace-write" || once === "danger-full-access")
        && isStrictWidening(policy.mode, once)
      ) {
        policy.mode = once;
      }
      delete env.PI_SANDBOX_MODE_ONCE;
      if (!env.NO_COLOR) env.NO_COLOR = "1";
      // 管道上的 Python 会把 stdout 整块缓冲到退出，卡片里看不到过程。
      if (env.PYTHONUNBUFFERED === undefined) env.PYTHONUNBUFFERED = "1";
      const facts = (extra: Partial<SandboxRunFacts> = {}): SandboxRunFacts => ({
        mode: policy.mode,
        denied: false,
        ...extra,
      });
      const shellFailed = (result: RunResult) =>
        facts({ runnerFailed: "runner", detail: `the shell could not start (${String(result.spawnError)})` });

      const shell = await resolveShell();
      let base = shellArgv(platform, shell, command);
      let scriptFile: string | undefined;
      if (platform === "win32" && isConfined(policy.mode) && isWindowsBashExe(shell)) {
        return { exitCode: null, sandbox: facts({ runnerFailed: "unavailable", detail: WINDOWS_BASH_UNAVAILABLE }) };
      }
      if (!isConfined(policy.mode)) {
        const result = await run(base, cwd, { ...options, env });
        forgetShellOnSpawnError(result);
        return { exitCode: result.exitCode, sandbox: result.spawnError ? shellFailed(result) : facts() };
      }

      // CreateProcessWithLogonW passes lpCommandLine through the Secondary Logon
      // Service RPC which has a ~1024 character limit. When the user command
      // exceeds the threshold, write it to a temp .ps1 file and invoke via -File.
      //
      // The script MUST live inside the workspace (not acquireTempDir) because
      // acquireTempDir resolves under the host user's %TEMP% which the sandbox
      // account cannot reach. The workspace is always granted to the sandbox
      // user before the process starts. (defect 8)
      if (platform === "win32" && command.length > WIN_COMMAND_FILE_THRESHOLD) {
        const name = `pi-cmd-${randomBytes(4).toString("hex")}.ps1`;
        scriptFile = join(policy.workspaceRoot, name);
        // UTF-8 BOM so both PowerShell 5.1 and 7 read the file correctly.
        writeFileSync(scriptFile, "\ufeff" + PS_UTF8_PREFIX + command, "utf8");
        base = [shell, "-NoProfile", "-NonInteractive", "-File", scriptFile];
      }

      let confined: ConfinedArgv;
      try {
        if (options.signal?.aborted) throw new Error("aborted");
        confined = await deps.confine(base, { ...policy, mode: policy.mode }, options.signal);
        if (options.signal?.aborted) throw new Error("aborted");
      } catch (error) {
        if (error instanceof Error && error.message === "aborted") throw error;
        if (error instanceof SandboxUnavailableError) {
          const hint = error.message.includes("failed to grant ")
            ? "The command was not executed."
            : "The command was not executed. Enable the OS runner or switch approval to 完全权限.";
          return { exitCode: null, sandbox: facts({ runnerFailed: "unavailable", detail: `${error.message} ${hint}` }) };
        }
        throw error;
      }

      const result = await run(confined.argv, cwd, { ...options, env });
      forgetShellOnSpawnError(result);
      if (scriptFile) {
        try { unlinkSync(scriptFile); } catch { /* cleaned by 24h sweep */ }
      }
      const kind = attributeRun(result, confined);
      if (kind.kind === "denial") return { exitCode: result.exitCode, sandbox: facts({ denied: true }) };
      if (kind.kind === "runner-failure") {
        return {
          exitCode: result.exitCode,
          sandbox: result.spawnError ? shellFailed(result) : facts({ runnerFailed: "runner" }),
        };
      }
      return { exitCode: result.exitCode, sandbox: facts() };
    },
  };
```

只有第一段（`facts` / `shellFailed`）和所有 `return` 变了，长命令脚本、`confine`、清理这些原样保留。

- [ ] **步骤 5：运行测试验证通过**

运行：`cd extensions; npx vitest run sandbox; exit $LASTEXITCODE`
预期：PASS。路径里带 `sandbox` 的都会跑：`operations.test.ts` 全绿；`extensions/sandbox/*` 不受影响（bash 工具暂时忽略多出的 `sandbox` 字段，`index.test.ts` 的 operations 是桩）。`pendingDenial.test.ts` 自己测自己，仍然通过，任务 8 再删。

- [ ] **步骤 6：检查点**

用 search 工具在 `extensions/_shared/sandbox/operations.ts` 里搜 `onData\?\.\(Buffer\.from`，应该没有匹配（只剩 `run()` 里转发进程输出的两处 `options.onData?.(decoded)`）。类型检查看 `operations.ts` 没有新报错。不 commit。

---

### 任务 3：user_bash 的文字适配器

`user_bash`（用户自己敲的命令）由 pi 显示输出，pi 不认识沙箱事实。任务 2 之后流里不再有标记，这层把它们按旧文字写回去。

**文件：**
- 创建：`extensions/_shared/sandbox/userBash.ts`
- 测试：`extensions/_shared/sandbox/userBash.test.ts`
- 修改：`extensions/sandbox/index.ts:50`（`pi.on("user_bash", …)`）
- 修改：`extensions/sandbox/index.test.ts`（`beforeEach` 和 `subscribes to user_bash and returns operations`）

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/_shared/sandbox/userBash.test.ts`：

```ts
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run _shared/sandbox/userBash.test.ts; exit $LASTEXITCODE`
预期：FAIL，报 `Failed to resolve import "./userBash.js"`。

- [ ] **步骤 3：写适配器**

创建 `extensions/_shared/sandbox/userBash.ts`：

```ts
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run _shared/sandbox/userBash.test.ts; exit $LASTEXITCODE`
预期：PASS。

- [ ] **步骤 5：扩展接上适配器（先改测试）**

`extensions/sandbox/index.test.ts`：

`beforeEach` 里的 `mocks.exec.mockReset().mockResolvedValue({ exitCode: 0 });` 改成：

```ts
  mocks.exec.mockReset().mockResolvedValue({ exitCode: 0, sandbox: { mode: "read-only", denied: false } });
```

`subscribes to user_bash and returns operations` 整条换成：

```ts
  it("hands user_bash the sandbox operations with the facts written back as text", async () => {
    const { handlers } = load();
    mocks.exec.mockResolvedValue({ exitCode: 1, sandbox: { mode: "read-only", denied: true } });
    const { operations } = handlers.user_bash?.({}, {}) as {
      operations: { exec: (c: string, cwd: string, o: { onData?: (d: Buffer) => void }) => Promise<unknown> };
    };
    const chunks: string[] = [];
    const result = await operations.exec(COMMAND, CWD, { onData: (d) => chunks.push(d.toString()) });
    expect(mocks.exec).toHaveBeenCalledWith(COMMAND, CWD, expect.anything());
    expect(result).toEqual({ exitCode: 1 });
    expect(chunks.join("")).toBe("[sandbox: file access denied under read-only mode]\n");
  });
```

运行：`cd extensions; npx vitest run sandbox/index.test.ts; exit $LASTEXITCODE`
预期：FAIL，这条新用例拿到的 `operations.exec` 就是桩本身，返回里带着 `sandbox`，也没有写出标记。

- [ ] **步骤 6：接线**

`extensions/sandbox/index.ts`：导入里加

```ts
import { withTextMarkers } from "../_shared/sandbox/userBash.js";
```

把 `pi.on("user_bash", () => ({ operations }));` 换成：

```ts
  // user_bash 由 pi 显示输出：沙箱事实经适配器写回文字。
  const userBashOperations = withTextMarkers(operations);
  pi.on("user_bash", () => ({ operations: userBashOperations }));
```

- [ ] **步骤 7：运行测试验证通过**

运行：`cd extensions; npx vitest run _shared/sandbox/userBash.test.ts sandbox/index.test.ts; exit $LASTEXITCODE`
预期：PASS。`index.test.ts` 里 `bash_escalate` 的旧用例也还是绿的，任务 8 再换。

- [ ] **步骤 8：检查点**

类型检查看 `userBash.ts`、`sandbox/index.ts` 没有新报错（`UserBashOperations` 要能当 pi 的 `BashOperations` 用）。不 commit。

---

### 任务 4：bash job 结算带上沙箱说明

后台和转后台的命令没有前台结果可以写标记，照 DSH `tool-pwsh/src/background.ts` 的 `sandboxNotes`，把说明并进 job 结算 detail。结算通知和 `job_output` 的状态行本来就带 detail（`extensions/jobs/render.ts` 的 `statusLine`）。

**文件：**
- 修改：`extensions/sandbox/bashJob.ts`
- 测试：`extensions/sandbox/bashTool.test.ts`（`scriptedExec`、`bash job helpers`、新 describe）

- [ ] **步骤 1：让测试替身能带事实**

`extensions/sandbox/bashTool.test.ts` 顶部导入加：

```ts
import { escalationHintMarker, runnerFailedMarker, sandboxDenialMarker } from "../_shared/sandbox/facts.js";
import type { SandboxRunFacts } from "../_shared/sandbox/types.js";
```

`scriptedExec` 整个换成（`exit` 多一个可选的事实参数）：

```ts
/** 由测试驱动的假 exec：write 推输出，exit 结束（可带沙箱事实）；abort 时按 operations 的约定 reject "aborted"。 */
function scriptedExec() {
  let onData: ((data: Buffer) => void) | undefined;
  let settle: ((r: { exitCode: number | null; sandbox?: SandboxRunFacts }) => void) | undefined;
  let fail: ((e: Error) => void) | undefined;
  const calls: Array<{ command: string; options: Parameters<ExecFn>[2] }> = [];
  const exec = vi.fn<ExecFn>((command, _cwd, options) => {
    calls.push({ command, options });
    onData = options.onData;
    return new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  return {
    exec,
    calls,
    write: (text: string) => onData?.(Buffer.from(text)),
    exit: (exitCode: number | null, sandbox?: SandboxRunFacts) => settle?.({ exitCode, ...(sandbox ? { sandbox } : {}) }),
    crash: (error: Error) => fail?.(error),
  };
}
```

- [ ] **步骤 2：编写失败的测试**

在 `describe("bash job helpers", …)` 里加：

```ts
  it("processOutcome: a sandbox denial stays completed and carries the marker, plus the hint when on offer", () => {
    const exit = { kind: "exited" as const, exitCode: 1, sandbox: { mode: "read-only" as const, denied: true } };
    expect(processOutcome(exit, () => true)).toEqual({
      status: "completed",
      detail: `exit code: 1; ${sandboxDenialMarker("read-only")} ${escalationHintMarker()}`,
    });
    expect(processOutcome(exit)).toEqual({ status: "completed", detail: `exit code: 1; ${sandboxDenialMarker("read-only")}` });
  });

  it("processOutcome: a runner failure is failed with the runner marker and reason, never a hint", () => {
    const exit = {
      kind: "exited" as const,
      exitCode: null,
      sandbox: { mode: "read-only" as const, denied: false, runnerFailed: "unavailable" as const, detail: "runner missing" },
    };
    expect(processOutcome(exit, () => true)).toEqual({
      status: "failed",
      detail: `${runnerFailedMarker("read-only")} runner missing`,
    });
  });

  it("processOutcome: a clean run with facts reads as before", () => {
    expect(
      processOutcome({ kind: "exited", exitCode: 0, sandbox: { mode: "workspace-write", denied: false } }, () => true),
    ).toEqual({ status: "completed", detail: "exit code: 0" });
  });
```

文件末尾（`bash on a real shell` 之前）加：

```ts
describe("bash · sandbox facts in background jobs", () => {
  it("a denied background job settles completed with the marker in its detail", async () => {
    const fake = scriptedExec();
    await run(tool(fake), { command: "touch x", run_in_background: true });
    await started(fake);
    fake.exit(1, { mode: "read-only", denied: true });
    const read = await jobs.read("bash-1", "s1", { wait: true, timeoutMs: 2000 });
    expect(read.status).toBe("completed");
    expect(read.job.detail).toBe(`exit code: 1; ${sandboxDenialMarker("read-only")}`);
  });

  it("a background job whose sandbox never started settles failed with the runner marker", async () => {
    const fake = scriptedExec();
    await run(tool(fake), { command: "echo hi", run_in_background: true });
    await started(fake);
    fake.exit(null, { mode: "read-only", denied: false, runnerFailed: "unavailable", detail: "runner missing" });
    const read = await jobs.read("bash-1", "s1", { wait: true, timeoutMs: 2000 });
    expect(read.status).toBe("failed");
    expect(read.job.detail).toBe(`${runnerFailedMarker("read-only")} runner missing`);
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd extensions; npx vitest run sandbox/bashTool.test.ts; exit $LASTEXITCODE`
预期：FAIL。新加的 5 条里 4 条失败：detail 只有 `exit code: 1`，runner 失败的是 `no exit code (…)`。`a clean run with facts reads as before` 本来就通过，它钉的是干净运行不变。旧用例仍绿。

- [ ] **步骤 4：`bashJob.ts` 带上事实**

`extensions/sandbox/bashJob.ts`，从文件开头到 `processOutcome` 结束（原第 1-35 行）换成：

```ts
// 把一条 bash 命令注册成 jobs 里的 bash job。移植自 DSH packages/shell/tool-bash/src/background.ts：
// 进程在 run() 里起（注册表准入之后），输出经 BashOutput.readFrom 由注册表泵进环，
// 非零退出记 completed + `exit code: N`，被取消记 killed，拿不到退出码记 failed。
// 前台命令也走这里（DSH：每次调用都是 job，前台只是等它），所以命令从起来那一刻就可见、可停，等待超时后原样转后台。
// 沙箱事实（拒绝、runner 失败）随退出码一起回来，照 DSH tool-pwsh 的 sandboxNotes 并进结算 detail。
// 与 DSH 的差别：沙箱 exec 把 stdout / stderr 合成一路回调，这里不分通道，顺序和前台卡片一致。
import { sandboxNotes } from "../_shared/sandbox/facts.js";
import type { ExecOptions } from "../_shared/sandbox/operations.js";
import type { FileSandboxMode, SandboxRunFacts } from "../_shared/sandbox/types.js";
import type { JobsService } from "../jobs/service.js";
import type { JobHooks, JobOutcome } from "../jobs/types.js";
import type { BashOutput } from "./bashOutput.js";

/** 模型每次读取 bash job 的上限，与前台 bash 的 50KB 截断一致。 */
export const BASH_JOB_OUTPUT_LIMIT_BYTES = 50 * 1024;
const LABEL_MAX_CHARS = 160;

/** 沙箱 exec 的结果：退出码加沙箱事实。测试替身可以不给事实。 */
export interface ExecResult {
  exitCode: number | null;
  sandbox?: SandboxRunFacts;
}

export type ExecFn = (command: string, cwd: string, options: ExecOptions) => Promise<ExecResult>;

/** 进程怎么结束的；前台按 pi 的格式渲染它。 */
export type BashExit =
  | { kind: "exited"; exitCode: number | null; sandbox?: SandboxRunFacts }
  | { kind: "aborted" }
  | { kind: "error"; error: unknown };

/** 被拒后要不要提示模型可以升权，按这次实际生效的模式算（bashTool 用 canOfferEscalation 给）。 */
export type OfferEscalation = (mode: FileSandboxMode) => boolean;
const NO_OFFER: OfferEscalation = () => false;

/**
 * 进程结束映射到通用 job 结局（DSH processOutcome）：非零退出照常是 completed，detail 报 exit code，
 * 沙箱拒绝的标记接在后面；沙箱 runner 没起来是 failed，detail 是 runner 标记和原因；拿不到退出码也是 failed。
 */
export function processOutcome(exit: BashExit, offerEscalation: OfferEscalation = NO_OFFER): JobOutcome {
  if (exit.kind === "aborted") return { status: "killed", detail: "killed before exit" };
  if (exit.kind === "error") {
    const message = exit.error instanceof Error ? exit.error.message : String(exit.error);
    return { status: "failed", detail: message };
  }
  const facts = exit.sandbox;
  if (facts?.runnerFailed) return { status: "failed", detail: sandboxNotes(facts, false).join(" ") };
  if (exit.exitCode === null) return { status: "failed", detail: "no exit code (the command did not run or was terminated)" };
  const notes = facts ? sandboxNotes(facts, offerEscalation(facts.mode)) : [];
  const code = `exit code: ${exit.exitCode}`;
  return { status: "completed", detail: notes.length > 0 ? `${code}; ${notes.join(" ")}` : code };
}
```

`BashJobRequest` 末尾加一个字段：

```ts
  /** 结算 detail 里要不要带升权提示；不给就不带。 */
  offerEscalation?: OfferEscalation;
```

`processJob` 换成（签名多一个参数，结果带事实）：

```ts
function processJob(
  start: (signal: AbortSignal) => Promise<ExecResult>,
  output: BashOutput,
  onExit: (exit: BashExit) => void,
  onCancel: (reason?: string) => void,
  offerEscalation: OfferEscalation,
): JobHooks {
  const controller = new AbortController();
  const done: Promise<JobOutcome> = (async () => {
    let exit: BashExit;
    try {
      const { exitCode, sandbox } = await start(controller.signal);
      exit = controller.signal.aborted
        ? { kind: "aborted" }
        : { kind: "exited", exitCode, ...(sandbox ? { sandbox } : {}) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      exit = controller.signal.aborted || message === "aborted" ? { kind: "aborted" } : { kind: "error", error };
      if (exit.kind === "error") output.append(Buffer.from(`${message}\n`));
    }
    output.finish();
    await output.closeTempFile();
    onExit(exit);
    return processOutcome(exit, offerEscalation);
  })();
  return {
    cancel: (reason) => {
      if (controller.signal.aborted) return;
      onCancel(reason);
      controller.abort(reason);
    },
    done,
  };
}
```

`startBashJob` 里 `processJob(` 的调用，在 `(reason) => { stopped = reason; },` 之后加最后一个实参：

```ts
        req.offerEscalation ?? NO_OFFER,
```

- [ ] **步骤 5：前台不受管路径也带上事实**

`extensions/sandbox/bashTool.ts` 里不受管前台（`if (!started) {` 分支）的

```ts
            exit = { kind: "exited", exitCode: r.exitCode };
```

改成

```ts
            exit = { kind: "exited", exitCode: r.exitCode, ...(r.sandbox ? { sandbox: r.sandbox } : {}) };
```

这一步只是把事实传到 `finishResult`，前台怎么渲染是任务 6 的事。

- [ ] **步骤 6：运行测试验证通过**

运行：`cd extensions; npx vitest run sandbox jobs; exit $LASTEXITCODE`
预期：PASS。

- [ ] **步骤 7：检查点**

类型检查看 `bashJob.ts`、`bashTool.ts`、`bashTool.test.ts` 没有新报错：`operations.exec`（返回必有的 `sandbox`）要能赋给 `ExecFn`（可选的 `sandbox`）。不 commit。

---

### 任务 5：升权的纯逻辑和一次性许可

照 DSH `packages/sandbox/sandbox/src/escalation.ts`：参数校验、严格更宽、审批顺序和错误原文。许可模块放 `_shared/sandbox`，safety 和 sandbox 两个扩展都用；扩展经 `extensions/index.ts` 静态编进同一个包，模块级的 Map 是共享的。

**文件：**
- 创建：`extensions/sandbox/escalation.ts`
- 测试：`extensions/sandbox/escalation.test.ts`
- 创建：`extensions/_shared/sandbox/escalationGrant.ts`
- 测试：`extensions/_shared/sandbox/escalationGrant.test.ts`

- [ ] **步骤 1：编写失败的测试（升权）**

创建 `extensions/sandbox/escalation.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { approveEscalation, canOfferEscalation, readEscalationArgs, type SandboxGate } from "./escalation.js";

describe("readEscalationArgs (DSH validateEscalationArgs)", () => {
  it("returns nothing when neither field is given", () => {
    expect(readEscalationArgs({})).toBeUndefined();
  });

  it("returns the pair with the reason trimmed", () => {
    expect(readEscalationArgs({ sandbox_permissions: "workspace-write", justification: "  需要写构建产物  " })).toEqual({
      mode: "workspace-write",
      justification: "需要写构建产物",
    });
  });

  it.each([
    [{ sandbox_permissions: "workspace-write" }, "invalid escalation: sandbox_permissions requires a justification"],
    [{ justification: "需要写入" }, "invalid escalation: justification is only valid together with sandbox_permissions"],
    [{ sandbox_permissions: "workspace-write", justification: "   " }, "invalid justification: expected a non-empty sentence"],
    [
      { sandbox_permissions: "read-only", justification: "需要写入" },
      "invalid escalation: sandbox_permissions must be one of workspace-write, danger-full-access",
    ],
  ])("rejects %j", (params, message) => {
    expect(() => readEscalationArgs(params)).toThrow(message);
  });
});

describe("canOfferEscalation", () => {
  const gate: SandboxGate = { mode: "read-only", presetBlocksEscalation: false };

  it("offers when a wider mode exists, the preset allows it, and someone can approve", () => {
    expect(canOfferEscalation(gate, "read-only", true)).toBe(true);
    expect(canOfferEscalation(gate, "workspace-write", true)).toBe(true);
  });

  it("does not offer at the top, under a blocking preset, or without an approval channel", () => {
    expect(canOfferEscalation(gate, "danger-full-access", true)).toBe(false);
    expect(canOfferEscalation({ mode: "workspace-write", presetBlocksEscalation: true }, "workspace-write", true)).toBe(false);
    expect(canOfferEscalation(gate, "read-only", false)).toBe(false);
  });
});

describe("approveEscalation (DSH order)", () => {
  const gate: SandboxGate = { mode: "read-only", presetBlocksEscalation: false };
  const request = { mode: "workspace-write" as const, justification: "需要写构建产物" };
  const ask = (answer: string | undefined) => vi.fn(async () => answer);

  it("asking for the current mode is not an escalation and asks nobody", async () => {
    const select = ask("允许本次");
    await expect(
      approveEscalation("x", request, { mode: "workspace-write", presetBlocksEscalation: false }, { channel: true, select, preApproved: false }),
    ).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("asks once with the command, the reason and the target, and grants this call only", async () => {
    const select = ask("允许本次");
    const signal = new AbortController().signal;
    await expect(
      approveEscalation("npm run build", request, gate, { channel: true, select, preApproved: false, signal }),
    ).resolves.toBe("workspace-write");
    expect(select).toHaveBeenCalledWith(
      "沙箱升权\n\nnpm run build\n\n需要写构建产物\n\n→ workspace-write",
      ["允许本次", "拒绝"],
      { signal },
    );
  });

  it("a rejection tells the model to stop and explain", async () => {
    await expect(approveEscalation("x", request, gate, { channel: true, select: ask("拒绝"), preApproved: false })).rejects.toThrow(
      'the user rejected escalating this command to "workspace-write"; it stays denied, so stop and explain instead of working around it',
    );
  });

  it.each([
    ["dismissed", ask(undefined)],
    ["closed with an error", vi.fn(async () => { throw new Error("closed"); })],
  ])("a %s prompt is a cancellation", async (_name, select) => {
    await expect(approveEscalation("x", request, gate, { channel: true, select, preApproved: false })).rejects.toThrow(
      'approval for escalating to "workspace-write" was cancelled',
    );
  });

  it("a safety pre-approval skips the second prompt", async () => {
    const select = ask("拒绝");
    await expect(approveEscalation("x", request, gate, { channel: true, select, preApproved: true })).resolves.toBe("workspace-write");
    expect(select).not.toHaveBeenCalled();
  });

  it("fails before asking when the target is not strictly wider", async () => {
    const select = ask("允许本次");
    await expect(
      approveEscalation("x", request, { mode: "danger-full-access", presetBlocksEscalation: false }, { channel: true, select, preApproved: false }),
    ).rejects.toThrow('sandbox escalation to "workspace-write" is not strictly wider than this call\'s current "danger-full-access" mode');
    expect(select).not.toHaveBeenCalled();
  });

  it("the workspace-edit preset refuses even a pre-approved call", async () => {
    const select = ask("允许本次");
    await expect(
      approveEscalation(
        "x",
        { mode: "danger-full-access", justification: "需要写工作区外" },
        { mode: "workspace-write", presetBlocksEscalation: true },
        { channel: true, select, preApproved: true },
      ),
    ).rejects.toThrow("the workspace-edit approval preset keeps commands inside the workspace");
    expect(select).not.toHaveBeenCalled();
  });

  it("without an approval channel nothing is asked", async () => {
    const select = ask("允许本次");
    await expect(approveEscalation("x", request, gate, { channel: false, select, preApproved: false })).rejects.toThrow(
      'sandbox escalation to "workspace-write" requires approval, but no approval channel is available',
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("without a sandbox policy there is nothing to widen", async () => {
    await expect(
      approveEscalation("x", request, undefined, { channel: true, select: ask("允许本次"), preApproved: false }),
    ).rejects.toThrow("this bash runs without a sandbox policy");
  });
});
```

- [ ] **步骤 2：编写失败的测试（许可）**

创建 `extensions/_shared/sandbox/escalationGrant.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetEscalationGrantsForTest,
  clearEscalationGrants,
  grantEscalation,
  takeEscalationGrant,
} from "./escalationGrant.js";

beforeEach(() => __resetEscalationGrantsForTest());

describe("escalation grants", () => {
  it("a grant is used once, for its call and mode", () => {
    grantEscalation("s1", "call-1", "workspace-write");
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(true);
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });

  it("another session or call does not match", () => {
    grantEscalation("s1", "call-1", "workspace-write");
    expect(takeEscalationGrant("s2", "call-1", "workspace-write")).toBe(false);
    expect(takeEscalationGrant("s1", "call-2", "workspace-write")).toBe(false);
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(true);
  });

  it("a different mode does not match and still spends the grant", () => {
    grantEscalation("s1", "call-1", "workspace-write");
    expect(takeEscalationGrant("s1", "call-1", "danger-full-access")).toBe(false);
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });

  it("closing a session drops only its grants", () => {
    grantEscalation("s1", "call-1", "workspace-write");
    grantEscalation("s2", "call-1", "workspace-write");
    clearEscalationGrants("s1");
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
    expect(takeEscalationGrant("s2", "call-1", "workspace-write")).toBe(true);
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd extensions; npx vitest run sandbox/escalation.test.ts _shared/sandbox/escalationGrant.test.ts; exit $LASTEXITCODE`
预期：FAIL，两个文件都报 `Failed to resolve import`。

- [ ] **步骤 4：写升权模块**

创建 `extensions/sandbox/escalation.ts`：

```ts
// bash 的同调用升权，照 DSH packages/sandbox/sandbox/src/escalation.ts：sandbox_permissions + justification 成对出现，
// 执行前裁决完（严格更宽、审批档、审批通道、用户批准），批准的模式只给这一次调用。
// 不要求「先被拒才能申请」：每次升权都要用户批准。给模型的标记原文在 _shared/sandbox/facts.ts。
import { isStrictWidening } from "../_shared/sandbox/escalate.js";
import { ESCALATION_TARGETS, type EscalationTarget } from "../_shared/sandbox/facts.js";
import type { FileSandboxMode } from "../_shared/sandbox/types.js";

export const SANDBOX_PERMISSIONS_DESCRIPTION =
  "The narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; the retry asks the user for approval.";
export const JUSTIFICATION_DESCRIPTION =
  "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. Use the language of the user's current request.";
export const ESCALATION_GUIDELINE =
  "Use bash with sandbox_permissions + justification only to retry the exact command the sandbox just denied, choosing the narrowest wider mode; the user approves every retry, and a rejection means stop and explain.";

export const ESCALATION_ALLOW = "允许本次";
export const ESCALATION_REJECT = "拒绝";

export interface EscalationRequest {
  mode: EscalationTarget;
  justification: string;
}

/** DSH validateEscalationArgs：成对出现、理由非空、模式在闭集里。两个都没给返回 undefined。 */
export function readEscalationArgs(params: {
  sandbox_permissions?: unknown;
  justification?: unknown;
}): EscalationRequest | undefined {
  const { sandbox_permissions: mode, justification } = params;
  if (mode !== undefined && justification === undefined) {
    throw new Error("invalid escalation: sandbox_permissions requires a justification");
  }
  if (justification !== undefined && mode === undefined) {
    throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");
  }
  if (mode === undefined) return undefined;
  if (typeof justification !== "string" || justification.trim().length === 0) {
    throw new Error("invalid justification: expected a non-empty sentence");
  }
  if (!(ESCALATION_TARGETS as readonly unknown[]).includes(mode)) {
    throw new Error(`invalid escalation: sandbox_permissions must be one of ${ESCALATION_TARGETS.join(", ")}`);
  }
  return { mode: mode as EscalationTarget, justification: justification.trim() };
}

/** 一次调用起步的沙箱事实：审批档 + agent 模式解析出来的模式，以及审批档是否拒绝从它升权。 */
export interface SandboxGate {
  mode: FileSandboxMode;
  /** 沿用 bash_escalate 的规则：「工作区编辑」档下的 workspace-write 拒绝升权。 */
  presetBlocksEscalation: boolean;
}

/** 被拒后要不要提示模型可以升权：还有更宽的模式、审批档不拒绝、这次调用有审批通道。 */
export function canOfferEscalation(gate: SandboxGate, effectiveMode: FileSandboxMode, approvalChannel: boolean): boolean {
  return approvalChannel && !gate.presetBlocksEscalation && effectiveMode !== "danger-full-access";
}

export interface EscalationApproval {
  /** 能弹审批：有界面，且是主会话回合（子代理、goal 回合没有人能批）。 */
  channel: boolean;
  select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  /** safety 已经为这次调用问过并允许（一次性许可），不再问第二次。 */
  preApproved: boolean;
  signal?: AbortSignal;
}

/**
 * DSH approveEscalation：执行前把升权请求裁决完。返回这次调用要用的单次模式；
 * 申请的就是当前模式时返回 undefined（不算升权，照常执行）。不过就抛错，pi 把它变成 isError 结果，命令不执行。
 */
export async function approveEscalation(
  command: string,
  request: EscalationRequest,
  gate: SandboxGate | undefined,
  approval: EscalationApproval,
): Promise<EscalationTarget | undefined> {
  const { mode, justification } = request;
  if (!gate) throw new Error(`sandbox escalation to "${mode}" is not available: this bash runs without a sandbox policy`);
  if (mode === gate.mode) return undefined;
  if (!isStrictWidening(gate.mode, mode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${gate.mode}" mode`);
  }
  if (gate.presetBlocksEscalation) {
    throw new Error(
      `sandbox escalation to "${mode}" is rejected: the workspace-edit approval preset keeps commands inside the workspace`,
    );
  }
  if (approval.preApproved) return mode;
  if (!approval.channel || !approval.select) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`);
  }
  let choice: string | undefined;
  try {
    choice = await approval.select(
      `沙箱升权\n\n${command}\n\n${justification}\n\n→ ${mode}`,
      [ESCALATION_ALLOW, ESCALATION_REJECT],
      approval.signal ? { signal: approval.signal } : undefined,
    );
  } catch {
    choice = undefined;
  }
  if (choice === ESCALATION_ALLOW) return mode;
  if (choice === ESCALATION_REJECT) {
    throw new Error(
      `the user rejected escalating this command to "${mode}"; it stays denied, so stop and explain instead of working around it`,
    );
  }
  throw new Error(`approval for escalating to "${mode}" was cancelled`);
}
```

- [ ] **步骤 5：写许可模块**

创建 `extensions/_shared/sandbox/escalationGrant.ts`：

```ts
// safety 的审批已经为某次 bash 调用问过用户并得到允许时，留一张只对这次调用、这个模式有效的许可，
// bash 执行时消费它，不再弹第二次升权提示。tool_call 钩子和工具执行拿到的是同一个 toolCallId
// （pi dist/core/agent-session.js 的 _beforeToolCall）。内存里，用一次即删；
// 会话关闭时清掉这个会话剩下的（被后面的钩子拦下、没走到执行的调用）。
const grants = new Map<string, string>();

const key = (sessionId: string, toolCallId: string) => `${sessionId.trim()}\0${toolCallId}`;

export function grantEscalation(sessionId: string, toolCallId: string, mode: string): void {
  grants.set(key(sessionId, toolCallId), mode);
}

/** 有这次调用、这个模式的许可就消费并返回 true。模式不同也删掉：许可只给用户看到的那个请求。 */
export function takeEscalationGrant(sessionId: string, toolCallId: string, mode: string): boolean {
  const k = key(sessionId, toolCallId);
  const granted = grants.get(k);
  grants.delete(k);
  return granted === mode;
}

export function clearEscalationGrants(sessionId: string): void {
  const prefix = `${sessionId.trim()}\0`;
  for (const k of [...grants.keys()]) if (k.startsWith(prefix)) grants.delete(k);
}

export function __resetEscalationGrantsForTest(): void {
  grants.clear();
}
```

- [ ] **步骤 6：运行测试验证通过**

运行：`cd extensions; npx vitest run sandbox/escalation.test.ts _shared/sandbox/escalationGrant.test.ts; exit $LASTEXITCODE`
预期：PASS。

- [ ] **步骤 7：检查点**

类型检查看 `escalation.ts`、`escalationGrant.ts` 没有新报错。这两个模块此时还没有调用方，任务 6、7、9 接上。不 commit。

---

### 任务 6：bash 前台渲染沙箱事实

照 DSH `tool-pwsh`：标记接在输出（含截断说明）之后、`Command exited with code N` 之前。事实另放进 `details.sandbox` 给界面，只在被拒、runner 失败（任务 7 加上已升权）时出现，普通成功的 `details` 仍是 `undefined`，pi 契约测试不变。

**文件：**
- 修改：`extensions/sandbox/bashTool.ts`
- 测试：`extensions/sandbox/bashTool.test.ts`

- [ ] **步骤 1：测试工具函数支持沙箱依赖和界面上下文**

`extensions/sandbox/bashTool.test.ts`：

导入加：

```ts
import { runInWorkspace } from "../_shared/workspace-context.js";
import type { FileSandboxMode } from "../_shared/sandbox/types.js";
import type { SandboxGate } from "./escalation.js";
```

把 `./bashTool.js` 的导入改成 `import { BASH_PROMPT_SNIPPET, createGrenBashTool, type GrenBashDeps } from "./bashTool.js";`。

顶部 `beforeEach` 改成：

```ts
beforeEach(() => {
  // 子代理里跑测试会继承 PI_IS_SUBAGENT=1，bash 会把审批通道判成没有。
  delete process.env.PI_IS_SUBAGENT;
  __resetJobsForTest();
  jobs.configure({ pumpPollMs: 5 });
});
```

`tool` 和 `run` 换成（可以传额外依赖、覆盖 ctx 字段、指定 toolCallId）：

```ts
function tool(fake: ReturnType<typeof scriptedExec>, foregroundSec = 120, extra: Partial<GrenBashDeps> = {}) {
  return createGrenBashTool({ jobs, exec: fake.exec, foregroundTimeoutSec: () => foregroundSec, tempDir, ...extra });
}

function run(
  t: ReturnType<typeof tool>,
  params: Record<string, unknown>,
  opts: {
    signal?: AbortSignal;
    onUpdate?: (u: unknown) => void;
    sessionId?: string;
    ctx?: Record<string, unknown>;
    callId?: string;
  } = {},
): Promise<Result> {
  const c = { ...ctx(opts.sessionId), ...opts.ctx };
  return t.execute(opts.callId ?? "call-1", params as never, opts.signal, opts.onUpdate as never, c as never) as Promise<Result>;
}
```

`no exit code throws 'Command terminated without an exit code'` 里的假输出还是旧版写进流里的 runner 标记，改成普通输出：

```ts
  it("no exit code throws 'Command terminated without an exit code'", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake), { command: "x" });
    await started(fake);
    fake.write("Killed\n");
    fake.exit(null);
    await expect(pending).rejects.toThrow("Killed\n\n\nCommand terminated without an exit code");
  });
```

- [ ] **步骤 2：编写失败的测试**

在 `describe("bash · sandbox facts in background jobs", …)` 之前加：

```ts
describe("bash · sandbox facts in the foreground (DSH tool-pwsh rendering)", () => {
  const READ_ONLY: SandboxGate = { mode: "read-only", presetBlocksEscalation: false };
  const withUi = { hasUI: true, ui: { select: vi.fn() } };

  it("a denial: marker and hint after the output, the exit status last; facts for the UI; structured result kept", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "touch x" }, { ctx: withUi });
    await started(fake);
    fake.write("touch: x: Read-only file system\n");
    fake.exit(1, { mode: "read-only", denied: true });
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe(
      `touch: x: Read-only file system\n\n\n${sandboxDenialMarker("read-only")}\n${escalationHintMarker()}\n\nCommand exited with code 1`,
    );
    expect(r.details).toEqual({ sandbox: { mode: "read-only", denied: true } });
    expect(r.structuredContent).toMatchObject({ output: "touch: x: Read-only file system\n", exit_code: 1 });
  });

  it.each([
    ["the preset blocks escalation", { mode: "workspace-write", presetBlocksEscalation: true } as SandboxGate, withUi, "workspace-write"],
    ["there is no approval channel", READ_ONLY, { hasUI: false }, "read-only"],
    ["no sandbox gate is configured", undefined, withUi, "read-only"],
  ] as const)("no escalation hint when %s", async (_name, gate, extraCtx, mode) => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, gate ? { sandboxGate: () => gate } : {}), { command: "touch x" }, { ctx: extraCtx });
    await started(fake);
    fake.exit(1, { mode: mode as FileSandboxMode, denied: true });
    const text = (await pending).content[0]?.text ?? "";
    expect(text).toContain(sandboxDenialMarker(mode as FileSandboxMode));
    expect(text).not.toContain(escalationHintMarker());
  });

  it("a goal turn has no one to approve, so no hint", async () => {
    const fake = scriptedExec();
    const t = tool(fake, 120, { sandboxGate: () => READ_ONLY });
    const pending = runInWorkspace({ origin: "goal", workspace: tempDir, cwd: tempDir, config: {} }, () =>
      run(t, { command: "touch x" }, { ctx: withUi }),
    );
    await started(fake);
    fake.exit(1, { mode: "read-only", denied: true });
    expect((await pending).content[0]?.text).not.toContain(escalationHintMarker());
  });

  it("a runner failure: isError, the runner marker and reason instead of an exit status, no structured result", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "echo hi" }, { ctx: withUi });
    await started(fake);
    fake.exit(null, { mode: "read-only", denied: false, runnerFailed: "unavailable", detail: "runner missing" });
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe(`${runnerFailedMarker("read-only")}\nrunner missing`);
    expect(r.structuredContent).toBeUndefined();
    expect(r.details).toEqual({
      sandbox: { mode: "read-only", denied: false, runnerFailed: "unavailable", detail: "runner missing" },
    });
  });

  it("a clean run with facts has no notes and no details (pi contract)", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "echo hi" }, { ctx: withUi });
    await started(fake);
    fake.write("hi\n");
    fake.exit(0, { mode: "read-only", denied: false });
    const r = await pending;
    expect(r.content).toEqual([{ type: "text", text: "hi\n" }]);
    expect(r.details).toBeUndefined();
  });

  it("the unmanaged fallback renders facts too", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "touch x" }, { sessionId: "", ctx: withUi });
    await started(fake);
    fake.exit(1, { mode: "read-only", denied: true });
    const r = await pending;
    expect(r.content[0]?.text).toContain(sandboxDenialMarker("read-only"));
    expect(r.details).toEqual({ sandbox: { mode: "read-only", denied: true } });
  });
});
```

并在 `describe("bash · sandbox facts in background jobs", …)` 里加一条：

```ts
  it("a denied background job's detail carries the hint when escalation is on offer", async () => {
    const fake = scriptedExec();
    const gate: SandboxGate = { mode: "read-only", presetBlocksEscalation: false };
    await run(tool(fake, 120, { sandboxGate: () => gate }), { command: "touch x", run_in_background: true }, {
      ctx: { hasUI: true, ui: { select: vi.fn() } },
    });
    await started(fake);
    fake.exit(1, { mode: "read-only", denied: true });
    const read = await jobs.read("bash-1", "s1", { wait: true, timeoutMs: 2000 });
    expect(read.job.detail).toBe(`exit code: 1; ${sandboxDenialMarker("read-only")} ${escalationHintMarker()}`);
  });
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd extensions; npx vitest run sandbox/bashTool.test.ts; exit $LASTEXITCODE`
预期：FAIL。前台这组里只有 `a clean run with facts has no notes and no details` 和三条「没有提示」里的部分断言会碰巧通过，其余都失败：正文里没有标记，`details` 是 `undefined`，runner 失败仍抛 `Command terminated without an exit code`。后台新加的那条也失败（detail 里没有提示）。

- [ ] **步骤 4：类型、依赖和两个小函数**

`extensions/sandbox/bashTool.ts`：

导入加：

```ts
import { sandboxNotes } from "../_shared/sandbox/facts.js";
import type { FileSandboxMode, SandboxRunFacts } from "../_shared/sandbox/types.js";
import { resolveToolOrigin } from "../_shared/workspace-context.js";
import { canOfferEscalation, type SandboxGate } from "./escalation.js";
```

`BashToolDetails` 换成（前面加 `BashSandboxDetails`）：

```ts
/** 前台结果里的沙箱事实：只在被拒、沙箱没启动、已升权时出现，界面据此画折叠行和底栏。 */
export interface BashSandboxDetails {
  mode: FileSandboxMode;
  denied: boolean;
  runnerFailed?: SandboxRunFacts["runnerFailed"];
  detail?: string;
  /** 这次调用经用户批准，从这个模式升上来。 */
  escalatedFrom?: FileSandboxMode;
}

export type BashToolDetails =
  | { truncation?: BashSnapshot["truncation"]; fullOutputPath?: string; sandbox?: BashSandboxDetails }
  | (BashJobRef & { background: true; logPath?: string })
  | (BashJobRef & { promoted: true; fullOutputPath?: string });
```

`GrenBashDeps` 末尾加：

```ts
  /** 这次调用起步的沙箱模式和审批档；不给（测试、无沙箱）就不提示升权。 */
  sandboxGate?: (cwd: string) => SandboxGate;
```

`ToolCtx` 加两个字段：

```ts
type ToolCtx = {
  cwd: string;
  sessionManager: { getSessionId: () => string; getSessionFile?: () => string | undefined };
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  hasUI?: boolean;
  ui?: { select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined> };
};
```

在 `appendStatus` 下面加：

```ts
/** DSH tool-pwsh：沙箱标记接在输出（含截断说明）后面、退出码状态行前面。 */
const appendNotes = (text: string, notes: readonly string[]) =>
  notes.length === 0 ? text : `${text ? `${text}\n\n` : ""}${notes.join("\n")}`;

/** 沙箱事实里界面要的那部分；干净的运行不给。 */
function sandboxDetails(facts: SandboxRunFacts | undefined): BashSandboxDetails | undefined {
  if (!facts || (!facts.denied && !facts.runnerFailed)) return undefined;
  return {
    mode: facts.mode,
    denied: facts.denied,
    ...(facts.runnerFailed ? { runnerFailed: facts.runnerFailed } : {}),
    ...(facts.detail ? { detail: facts.detail } : {}),
  };
}
```

- [ ] **步骤 5：`execute` 算出门槛，传给 job**

`execute` 里 `const job = { jobs: deps.jobs, exec: deps.exec };` 之后加：

```ts
      // 沙箱：这次调用起步的模式和审批档。审批通道 = 有界面且是主会话回合；
      // goal 回合 hasUI 仍为 true，但宿主对所有对话框立即返回取消（electron-agent sessionUiAdapter）。
      const gate = deps.sandboxGate?.(ctx.cwd);
      const approvalChannel = ctx.hasUI === true && ctx.ui !== undefined && resolveToolOrigin() === "main";
      const offerEscalation = (mode: FileSandboxMode) =>
        gate !== undefined && canOfferEscalation(gate, mode, approvalChannel);
```

两处 `startBashJob(job, { … })` 的请求对象都加上 `offerEscalation`：

```ts
        const started = startBashJob(job, { command, cwd: ctx.cwd, owner, workspace: ctx.cwd, env, output, offerEscalation });
```

```ts
            started = startBashJob(job, {
              command,
              cwd: ctx.cwd,
              owner,
              workspace: ctx.cwd,
              env,
              output,
              onData: scheduleOutputUpdate,
              offerEscalation,
            });
```

- [ ] **步骤 6：`finishResult` 渲染事实**

`finishResult` 里，从 `if (exit.kind === "error") { … }` 之后到 `if (exit.exitCode !== 0) {` 之前这一段（原来是 `const { text: outputText, details } = formatOutput(output, snapshot);` 和 `if (exit.exitCode === null) throw …`）换成：

```ts
        const facts = exit.sandbox;
        const sandbox = sandboxDetails(facts);
        if (facts?.runnerFailed) {
          // 命令没有执行：不是命令失败，不报退出码；和原来抛错时一样没有 codemode 的结构化结果。
          const { text, details: formatted } = formatOutput(output, snapshot, "");
          return {
            content: [{ type: "text" as const, text: appendNotes(text, sandboxNotes(facts, false)) }],
            details: { ...(formatted ?? {}), sandbox },
            isError: true,
          };
        }
        const { text: formattedText, details: formatted } = formatOutput(output, snapshot);
        const outputText = appendNotes(formattedText, facts ? sandboxNotes(facts, offerEscalation(facts.mode)) : []);
        const details = sandbox ? { ...(formatted ?? {}), sandbox } : formatted;
        if (exit.exitCode === null) throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
```

后面 `wallTimeSeconds`、`structuredContent` 和两个 `return` 不动，它们引用的 `outputText`、`details` 就是上面新的两个变量。`structuredContent.output` 仍是完整输出，不含标记。

- [ ] **步骤 7：运行测试验证通过**

运行：`cd extensions; npx vitest run sandbox jobs; exit $LASTEXITCODE`
预期：PASS。pi 契约那组（`success: tail text …`、`non-zero exit …`、`truncation …`）不变。

- [ ] **步骤 8：检查点**

类型检查看 `bashTool.ts`、`bashTool.test.ts` 没有新报错。不 commit。

---

### 任务 7：bash 接上升权参数

照 DSH `tool-pwsh/src/index.ts`：bash 加可选的 `sandbox_permissions`（闭集枚举）和 `justification`。执行前用任务 5 的 `approveEscalation` 裁决，批准后这一次调用的环境带 `PI_SANDBOX_MODE_ONCE`，其余完全走普通命令的路径。

**文件：**
- 修改：`extensions/sandbox/bashTool.ts`
- 测试：`extensions/sandbox/bashTool.test.ts`

- [ ] **步骤 1：改契约测试**

`extensions/sandbox/bashTool.test.ts`：

导入加：

```ts
import { __resetEscalationGrantsForTest, grantEscalation } from "../_shared/sandbox/escalationGrant.js";
import { ESCALATION_GUIDELINE } from "./escalation.js";
```

顶部 `beforeEach` 里加一行 `__resetEscalationGrantsForTest();`。

`keeps name, command/timeout, the pi output schema, and strict-prefer sampling; adds run_in_background` 这条：标题末尾改成 `adds run_in_background and the escalation pair`；参数清单那行改成

```ts
    expect(Object.keys(params.properties)).toEqual(["command", "timeout", "run_in_background", "sandbox_permissions", "justification"]);
```

并在 `promptGuidelines?.[1]` 那行后面加：

```ts
    expect(t.promptGuidelines?.[2]).toBe(ESCALATION_GUIDELINE);
    const sp = params.properties.sandbox_permissions as { anyOf?: Array<{ const?: string }> };
    expect(sp.anyOf?.map((s) => s.const)).toEqual(["workspace-write", "danger-full-access"]);
```

- [ ] **步骤 2：编写失败的升权测试**

在 `describe("bash · sandbox facts in background jobs", …)` 之前加：

```ts
describe("bash · same-call escalation (DSH sandbox_permissions)", () => {
  const READ_ONLY: SandboxGate = { mode: "read-only", presetBlocksEscalation: false };
  const JUSTIFY = "需要把构建产物写进工作区";
  const ask = (answer: string | undefined) => ({ hasUI: true, ui: { select: vi.fn(async () => answer) } });
  const widen = (command: string, extra: Record<string, unknown> = {}) => ({
    command,
    sandbox_permissions: "workspace-write",
    justification: JUSTIFY,
    ...extra,
  });

  it("asks, then runs this one call widened through the normal job path", async () => {
    const fake = scriptedExec();
    const c = ask("允许本次");
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("npm run build"), { ctx: c });
    await started(fake);
    expect(c.ui.select).toHaveBeenCalledWith(
      `沙箱升权\n\nnpm run build\n\n${JUSTIFY}\n\n→ workspace-write`,
      ["允许本次", "拒绝"],
      undefined,
    );
    expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBe("workspace-write");
    // 和普通命令一样是 job：可见、可停。
    expect(jobs.list("s1")).toMatchObject([{ id: "bash-1", status: "running" }]);
    fake.write("built\n");
    fake.exit(0, { mode: "workspace-write", denied: false });
    const r = await pending;
    expect(r.isError).toBeUndefined();
    expect(r.content[0]?.text).toBe("built\n");
    expect(r.details).toEqual({ sandbox: { mode: "workspace-write", denied: false, escalatedFrom: "read-only" } });
  });

  it("output beyond the limit is truncated like any other command", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("seq"), { ctx: ask("允许本次") });
    await started(fake);
    for (let i = 1; i <= 2100; i++) fake.write(`line ${i}\n`);
    fake.exit(0, { mode: "workspace-write", denied: false });
    const r = await pending;
    expect(r.content[0]?.text).toMatch(/\[Showing lines 101-2100 of 2100\. Full output: .+\]$/);
    expect(r.details).toMatchObject({ sandbox: { escalatedFrom: "read-only" } });
  });

  it("a widened run that is still denied reports the widened mode", async () => {
    const fake = scriptedExec();
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("touch ../x"), { ctx: ask("允许本次") });
    await started(fake);
    fake.exit(1, { mode: "workspace-write", denied: true });
    const r = await pending;
    expect(r.details).toEqual({ sandbox: { mode: "workspace-write", denied: true, escalatedFrom: "read-only" } });
    expect(r.content[0]?.text).toContain(`${sandboxDenialMarker("workspace-write")}\n${escalationHintMarker()}`);
  });

  it.each([
    ["the user rejects", "拒绝", 'the user rejected escalating this command to "workspace-write"; it stays denied, so stop and explain instead of working around it'],
    ["the prompt is dismissed", undefined, 'approval for escalating to "workspace-write" was cancelled'],
  ] as const)("nothing runs when %s", async (_name, answer, message) => {
    const fake = scriptedExec();
    await expect(
      run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("touch x"), { ctx: ask(answer) }),
    ).rejects.toThrow(message);
    expect(fake.exec).not.toHaveBeenCalled();
    expect(jobs.list("s1")).toEqual([]);
  });

  it.each([
    [{ sandbox_permissions: "workspace-write" }, "requires a justification"],
    [{ sandbox_permissions: "workspace-write", justification: "  " }, "expected a non-empty sentence"],
    [{ justification: JUSTIFY }, "only valid together with sandbox_permissions"],
  ])("malformed escalation %j fails before asking", async (extra, message) => {
    const fake = scriptedExec();
    const c = ask("允许本次");
    await expect(
      run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), { command: "touch x", ...extra }, { ctx: c }),
    ).rejects.toThrow(message);
    expect(c.ui.select).not.toHaveBeenCalled();
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it("asking for the current mode runs normally without a prompt", async () => {
    const fake = scriptedExec();
    const c = ask("允许本次");
    const gate: SandboxGate = { mode: "workspace-write", presetBlocksEscalation: false };
    const pending = run(tool(fake, 120, { sandboxGate: () => gate }), widen("echo hi"), { ctx: c });
    await started(fake);
    fake.exit(0, { mode: "workspace-write", denied: false });
    const r = await pending;
    expect(c.ui.select).not.toHaveBeenCalled();
    expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBeUndefined();
    expect(r.details).toBeUndefined();
  });

  it("a safety pre-approval for this call is used instead of a second prompt", async () => {
    const fake = scriptedExec();
    const c = ask("拒绝");
    grantEscalation("s1", "call-7", "workspace-write");
    const pending = run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("touch x"), { ctx: c, callId: "call-7" });
    await started(fake);
    fake.exit(0, { mode: "workspace-write", denied: false });
    await pending;
    expect(c.ui.select).not.toHaveBeenCalled();
    expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBe("workspace-write");
  });

  it("a goal turn cannot escalate", async () => {
    const fake = scriptedExec();
    const c = ask("允许本次");
    const t = tool(fake, 120, { sandboxGate: () => READ_ONLY });
    await expect(
      runInWorkspace({ origin: "goal", workspace: tempDir, cwd: tempDir, config: {} }, () =>
        run(t, widen("touch x"), { ctx: c }),
      ),
    ).rejects.toThrow("no approval channel is available");
    expect(c.ui.select).not.toHaveBeenCalled();
  });

  it("a background escalation asks first, then starts the job widened", async () => {
    const fake = scriptedExec();
    const c = ask("允许本次");
    const r = await run(tool(fake, 120, { sandboxGate: () => READ_ONLY }), widen("npm run dev", { run_in_background: true }), {
      ctx: c,
    });
    expect(r.details).toMatchObject({ background: true, jobId: "bash-1" });
    await started(fake);
    expect(c.ui.select).toHaveBeenCalledTimes(1);
    expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBe("workspace-write");
    jobs.kill("bash-1", "s1");
  });

  it("the host environment cannot widen a call on its own", async () => {
    process.env.PI_SANDBOX_MODE_ONCE = "danger-full-access";
    try {
      const fake = scriptedExec();
      const pending = run(tool(fake), { command: "echo hi" });
      await started(fake);
      fake.exit(0);
      await pending;
      expect(fake.calls[0]?.options.env?.PI_SANDBOX_MODE_ONCE).toBeUndefined();
    } finally {
      delete process.env.PI_SANDBOX_MODE_ONCE;
    }
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd extensions; npx vitest run sandbox/bashTool.test.ts; exit $LASTEXITCODE`
预期：FAIL。契约测试的参数清单对不上；升权这组里 `select` 没被调用、环境里没有 `PI_SANDBOX_MODE_ONCE`、校验不抛错。

- [ ] **步骤 4：schema 和 guideline**

`extensions/sandbox/bashTool.ts`：

导入里的 `./escalation.js` 改成并新增许可模块：

```ts
import { takeEscalationGrant } from "../_shared/sandbox/escalationGrant.js";
import {
  approveEscalation,
  canOfferEscalation,
  ESCALATION_GUIDELINE,
  JUSTIFICATION_DESCRIPTION,
  readEscalationArgs,
  SANDBOX_PERMISSIONS_DESCRIPTION,
  type SandboxGate,
} from "./escalation.js";
```

`BASH_PROMPT_GUIDELINES` 末尾加第三条：

```ts
export const BASH_PROMPT_GUIDELINES = [
  "You can inspect PI_* environment variables for current model and session details.",
  "Use bash with run_in_background: true for builds, test suites, or servers that run longer than a minute, then keep working; a foreground command still running after its timeout moves to the background on its own. Collect output with job_output and stop it with job_kill instead of sleeping or polling.",
  ESCALATION_GUIDELINE,
];
```

`bashSchema` 在 `run_in_background` 之后加两个字段：

```ts
  sandbox_permissions: Type.Optional(
    Type.Union([Type.Literal("workspace-write"), Type.Literal("danger-full-access")], {
      description: SANDBOX_PERMISSIONS_DESCRIPTION,
    }),
  ),
  justification: Type.Optional(Type.String({ description: JUSTIFICATION_DESCRIPTION })),
```

文件头注释里「工具名 bash、参数 command / timeout」那句后面补一句：

```ts
// 参数在 pi 的 command / timeout 之外加了 run_in_background，以及 DSH 的 sandbox_permissions + justification（同调用升权，见 escalation.ts）。
```

- [ ] **步骤 5：`bashEnv` 不继承宿主的单次放宽**

`bashEnv` 里 `delete env.PI_REASONING_LEVEL;` 之后加：

```ts
  // 单次放宽只来自这次调用批准的升权，不继承宿主环境。
  delete env.PI_SANDBOX_MODE_ONCE;
```

- [ ] **步骤 6：`execute` 开头裁决升权**

`async execute(_toolCallId, params: BashParams, signal, onUpdate, rawCtx) {` 到任务 6 加的 `offerEscalation` 为止这一段整体换成（第一个参数改名 `toolCallId`；`env` 挪到审批之后）：

```ts
    async execute(toolCallId, params: BashParams, signal, onUpdate, rawCtx) {
      const ctx = rawCtx as unknown as ToolCtx;
      const { command } = params;
      const timeoutSec = resolveTimeoutSec(params.timeout);
      const request = readEscalationArgs(params);
      const owner = ctx.sessionManager.getSessionId()?.trim() ?? "";
      const job = { jobs: deps.jobs, exec: deps.exec };
      // 沙箱：这次调用起步的模式和审批档。审批通道 = 有界面且是主会话回合；
      // goal 回合 hasUI 仍为 true，但宿主对所有对话框立即返回取消（electron-agent sessionUiAdapter）。
      const gate = deps.sandboxGate?.(ctx.cwd);
      const approvalChannel = ctx.hasUI === true && ctx.ui !== undefined && resolveToolOrigin() === "main";
      const offerEscalation = (mode: FileSandboxMode) =>
        gate !== undefined && canOfferEscalation(gate, mode, approvalChannel);
      // 升权在执行前裁决完（DSH approveEscalation），不过就抛错、什么都不起；
      // 批准的模式只给这一次调用，走下面同一条 job 路径。
      const ui = ctx.ui;
      const granted = request
        ? await approveEscalation(command, request, gate, {
            channel: approvalChannel,
            ...(ui
              ? {
                  select: (title: string, options: string[], opts?: { signal?: AbortSignal }) =>
                    ui.select(title, options, opts),
                }
              : {}),
            preApproved: takeEscalationGrant(owner, toolCallId, request.mode),
            ...(signal ? { signal } : {}),
          })
        : undefined;
      const escalatedFrom = granted !== undefined ? gate?.mode : undefined;
      const env = bashEnv(ctx);
      if (granted !== undefined) env.PI_SANDBOX_MODE_ONCE = granted;
```

- [ ] **步骤 7：`details.sandbox` 带上升权前的模式**

`sandboxDetails` 换成：

```ts
/** 沙箱事实里界面要的那部分；干净且没升权时不给。 */
function sandboxDetails(
  facts: SandboxRunFacts | undefined,
  escalatedFrom: FileSandboxMode | undefined,
): BashSandboxDetails | undefined {
  if (!facts || (!facts.denied && !facts.runnerFailed && !escalatedFrom)) return undefined;
  return {
    mode: facts.mode,
    denied: facts.denied,
    ...(facts.runnerFailed ? { runnerFailed: facts.runnerFailed } : {}),
    ...(facts.detail ? { detail: facts.detail } : {}),
    ...(escalatedFrom ? { escalatedFrom } : {}),
  };
}
```

`finishResult` 里 `const sandbox = sandboxDetails(facts);` 改成 `const sandbox = sandboxDetails(facts, escalatedFrom);`。

- [ ] **步骤 8：运行测试验证通过**

运行：`cd extensions; npx vitest run sandbox jobs; exit $LASTEXITCODE`
预期：PASS。`index.test.ts` 里 `bash_escalate` 的旧用例此时仍绿（工具还在），任务 8 换掉。

- [ ] **步骤 9：检查点**

类型检查看 `bashTool.ts`、`bashTool.test.ts` 没有新报错。特别看 `BashParams`（`Static<typeof bashSchema>`）能传给 `readEscalationArgs`。不 commit。

---

### 任务 8：扩展接线，删掉 bash_escalate 和 pendingDenial

**文件：**
- 修改：`extensions/sandbox/index.ts`
- 重写：`extensions/sandbox/index.test.ts`
- 删除：`extensions/_shared/sandbox/pendingDenial.ts`、`extensions/_shared/sandbox/pendingDenial.test.ts`
- 修改：`extensions/_shared/sandbox/escalate.ts`、`escalate.test.ts`（删 `justifyOk`）
- 修改：`extensions/_shared/sandbox/types.ts`（删 `BashEscalationRequest`）
- 修改：`extensions/_shared/sandbox/index.ts`（出口）

- [ ] **步骤 1：重写扩展测试**

`extensions/sandbox/index.test.ts` 整个换成下面的内容。`bash_escalate` 的用例改成经 bash 升权的用例，覆盖原来的三种审批档情形；不再用的 `createBashToolDefinition` 桩一起去掉。

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setApprovalPolicy, __resetApprovalForTest } from "../_shared/approval.js";
import {
  grantEscalation,
  takeEscalationGrant,
  __resetEscalationGrantsForTest,
} from "../_shared/sandbox/escalationGrant.js";
import { setAgentMode, __resetAgentModeForTest } from "../agent-mode/modes.js";
import { __resetJobsForTest } from "../jobs/service.js";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  dispose: vi.fn(async () => {}),
  getPolicy: undefined as undefined | (() => {
    mode: string;
    workspaceRoot: string;
    sessionId?: string;
  }),
}));

vi.mock("../_shared/sandbox/operations.js", () => ({
  createSandboxedBashOperations: (deps: {
    getPolicy: () => { mode: string; workspaceRoot: string; sessionId?: string };
  }) => {
    mocks.getPolicy = deps.getPolicy;
    return { exec: mocks.exec };
  },
}));

vi.mock("../_shared/sandbox/provider.js", () => ({
  createSandboxProvider: () => ({
    confine: vi.fn(),
    dispose: mocks.dispose,
  }),
}));

import sandbox from "./index.js";

const CWD = "D:/repo";
const SESSION = "sess-1";
const COMMAND = "echo denied";
const JUSTIFY = "需要把构建产物写进工作区";
const CLEAN = { exitCode: 0, sandbox: { mode: "read-only", denied: false } };

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean };
type ExecCtx = {
  cwd: string;
  hasUI: boolean;
  ui: { select: ReturnType<typeof vi.fn> };
  sessionManager: { getSessionId: () => string };
};
type Tool = {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  execute?: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: ExecCtx) => Promise<ToolResult>;
};

function load() {
  const tools: Tool[] = [];
  const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
  sandbox({
    registerTool: (tool: Tool) => {
      tools.push(tool);
    },
    on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
      handlers[event] = handler;
    },
  } as never);
  return { tools, handlers };
}

function sessionCtx(cwd = CWD, sessionId = SESSION) {
  return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

function execCtx(overrides: Partial<ExecCtx> = {}): ExecCtx {
  return {
    cwd: CWD,
    hasUI: true,
    ui: { select: vi.fn() },
    sessionManager: { getSessionId: () => SESSION },
    ...overrides,
  };
}

async function start(handlers: ReturnType<typeof load>["handlers"], cwd = CWD, sessionId = SESSION) {
  await handlers.session_start?.({}, sessionCtx(cwd, sessionId));
}

function bash(tools: Tool[]): Tool {
  const tool = tools.find((item) => item.name === "bash");
  if (!tool?.execute) throw new Error("bash not registered");
  return tool;
}

/** 带升权参数调一次 bash（和模型的调用一样带 description）。 */
function escalate(tools: Tool[], ctx: ExecCtx, mode: string) {
  return bash(tools).execute!(
    "call-1",
    { command: COMMAND, description: "Write build output", sandbox_permissions: mode, justification: JUSTIFY },
    undefined,
    undefined,
    ctx,
  );
}

beforeEach(() => {
  // 子代理里跑测试会继承 PI_IS_SUBAGENT=1，bash 会把审批通道判成没有。
  delete process.env.PI_IS_SUBAGENT;
  mocks.exec.mockReset().mockResolvedValue(CLEAN);
  mocks.dispose.mockReset().mockResolvedValue(undefined);
  mocks.getPolicy = undefined;
  __resetEscalationGrantsForTest();
  __resetApprovalForTest();
  __resetAgentModeForTest();
  __resetJobsForTest();
});

describe("sandbox extension", () => {
  it("registers bash and no separate escalation tool", () => {
    const names = load().tools.map((tool) => tool.name);
    expect(names).toContain("bash");
    expect(names).not.toContain("bash_escalate");
  });

  it("bash carries the escalation pair", () => {
    const properties = bash(load().tools).parameters?.properties ?? {};
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(["sandbox_permissions", "justification"]));
  });

  it("annotates the bash tool for PowerShell on win32", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const tool = bash(load().tools);
      expect(tool.promptSnippet).toContain("PowerShell");
      expect(tool.promptSnippet).not.toContain("ls, grep, find");
      expect(tool.description).toContain("exit $LASTEXITCODE");
      expect(tool.promptGuidelines?.some((g) => g.includes("PowerShell"))).toBe(true);
      expect(tool.parameters?.properties?.description).toBeTruthy();
      expect(tool.parameters?.required).toContain("description");
      expect(tool.promptGuidelines?.some((g) => g.includes("shown in the UI"))).toBe(true);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });

  it("hands user_bash the sandbox operations with the facts written back as text", async () => {
    const { handlers } = load();
    mocks.exec.mockResolvedValue({ exitCode: 1, sandbox: { mode: "read-only", denied: true } });
    const { operations } = handlers.user_bash?.({}, {}) as {
      operations: { exec: (c: string, cwd: string, o: { onData?: (d: Buffer) => void }) => Promise<unknown> };
    };
    const chunks: string[] = [];
    const result = await operations.exec(COMMAND, CWD, { onData: (d) => chunks.push(d.toString()) });
    expect(mocks.exec).toHaveBeenCalledWith(COMMAND, CWD, expect.anything());
    expect(result).toEqual({ exitCode: 1 });
    expect(chunks.join("")).toBe("[sandbox: file access denied under read-only mode]\n");
  });

  it("auto: asks before a one-shot widening, then runs it through the sandbox operations", async () => {
    setApprovalPolicy("auto", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    expect(mocks.getPolicy?.()).toMatchObject({ mode: "workspace-write" });
    const ctx = execCtx();
    ctx.ui.select.mockResolvedValue("允许本次");
    const result = await escalate(tools, ctx, "danger-full-access");
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledWith(
      COMMAND,
      CWD,
      expect.objectContaining({ env: expect.objectContaining({ PI_SANDBOX_MODE_ONCE: "danger-full-access" }) }),
    );
    expect(result.isError).toBeUndefined();
  });

  it("workspace-edit preset rejects escalation without a prompt", async () => {
    setApprovalPolicy("workspace", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    expect(mocks.getPolicy?.()).toMatchObject({ mode: "workspace-write", workspaceRoot: CWD });
    const ctx = execCtx();
    await expect(escalate(tools, ctx, "danger-full-access")).rejects.toThrow(/workspace-edit approval preset/);
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("Ask plus workspace approval forces read-only and still asks the user", async () => {
    setApprovalPolicy("workspace", CWD);
    setAgentMode("ask", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    expect(mocks.getPolicy?.()).toMatchObject({ mode: "read-only", workspaceRoot: CWD });
    const ctx = execCtx();
    ctx.ui.select.mockResolvedValue("拒绝");
    await expect(escalate(tools, ctx, "workspace-write")).rejects.toThrow(/the user rejected/);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("full: asking for the current mode just runs", async () => {
    setApprovalPolicy("full", CWD);
    const { tools, handlers } = load();
    await start(handlers);
    const ctx = execCtx();
    await escalate(tools, ctx, "danger-full-access");
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec.mock.calls[0]?.[2]?.env?.PI_SANDBOX_MODE_ONCE).toBeUndefined();
  });

  it("disposes the provider and drops the session's escalation grants on session_shutdown", async () => {
    const { handlers } = load();
    await start(handlers);
    grantEscalation(SESSION, "call-9", "workspace-write");
    await handlers.session_shutdown?.({}, sessionCtx());
    expect(mocks.dispose).toHaveBeenCalledWith(SESSION);
    expect(takeEscalationGrant(SESSION, "call-9", "workspace-write")).toBe(false);
  });

  it("uses session_start ctx.cwd and sessionManager.getSessionId for getPolicy", async () => {
    const { handlers } = load();
    await start(handlers, "D:/a", "sid-from-ctx");
    expect(mocks.getPolicy).toEqual(expect.any(Function));
    expect(mocks.getPolicy?.()).toMatchObject({
      workspaceRoot: "D:/a",
      sessionId: "sid-from-ctx",
    });
    expect(mocks.getPolicy?.().workspaceRoot).not.toBe(process.cwd());
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run sandbox/index.test.ts; exit $LASTEXITCODE`
预期：FAIL。还注册着 `bash_escalate`；没有 `sandboxGate`，升权一律报 `without a sandbox policy`；关会话不清许可。

- [ ] **步骤 3：扩展接上 `sandboxGate`，删掉 `bash_escalate`**

`extensions/sandbox/index.ts` 整个换成：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApprovalPolicy } from "../_shared/approval.js";
import { getAgentMode } from "../agent-mode/modes.js";
import { clearEscalationGrants } from "../_shared/sandbox/escalationGrant.js";
import { createSandboxedBashOperations } from "../_shared/sandbox/operations.js";
import { createSandboxProvider } from "../_shared/sandbox/provider.js";
import { resolvePreset } from "../_shared/sandbox/resolvePreset.js";
import { withTextMarkers } from "../_shared/sandbox/userBash.js";
import { jobs } from "../jobs/service.js";
import { createGrenBashTool } from "./bashTool.js";
import { withBashUiDescription } from "./bashUiDescription.js";
import type { SandboxGate } from "./escalation.js";
import { annotateWindowsBashTool } from "./windowsBashPrompt.js";

export default function (pi: ExtensionAPI) {
  const provider = createSandboxProvider();

  // ExtensionAPI 没有 cwd / sessionManager，只能从 ExtensionContext 写入闭包。
  // 不要退化到 process.cwd() 当可写根——多工作区会绑错 workspaceRoot。
  let cwd = "";
  let sessionId: string | undefined;

  const getPolicy = (override?: string) => {
    const root = override ?? cwd;
    return resolvePreset({
      approval: getApprovalPolicy(root),
      agentMode: getAgentMode(root),
      workspaceRoot: root,
      ...(sessionId ? { sessionId } : {}),
    });
  };

  /** 一次 bash 调用起步的模式，以及审批档是否拒绝从它升权（「工作区编辑」档下的 workspace-write）。 */
  const sandboxGate = (root: string): SandboxGate => {
    const mode = getPolicy(root).mode;
    return { mode, presetBlocksEscalation: mode === "workspace-write" && getApprovalPolicy(root) === "workspace" };
  };

  const operations = createSandboxedBashOperations({
    getPolicy: () => getPolicy(),
    confine: (argv, policy) => provider.confine(argv, policy),
  });

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    sessionId = ctx.sessionManager.getSessionId();
  });

  // 自有 bash（不再用 pi 的 createBashToolDefinition）：契约照 pi 1.0.2，执行照 DSH——每次调用都是 jobs 里的 bash job，
  // 前台等到 timeout 仍在跑就转后台。进程走同一套沙箱 operations。
  // 升权并进 bash 的 sandbox_permissions + justification（DSH），没有单独的升权工具。
  pi.registerTool(
    withBashUiDescription(annotateWindowsBashTool(createGrenBashTool({ jobs, exec: operations.exec, sandboxGate }))),
  );

  // user_bash 由 pi 显示输出：沙箱事实经适配器写回文字。
  const userBashOperations = withTextMarkers(operations);
  pi.on("user_bash", () => ({ operations: userBashOperations }));

  pi.on("session_shutdown", async (_event, ctx) => {
    const id = sessionId ?? ctx.sessionManager.getSessionId();
    if (!id) return;
    await provider.dispose?.(id);
    clearEscalationGrants(id);
  });
}
```

- [ ] **步骤 4：删掉没人用的东西**

删文件（普通删除，不要 `git rm`，不暂存任何东西）：

运行：`Remove-Item extensions/_shared/sandbox/pendingDenial.ts, extensions/_shared/sandbox/pendingDenial.test.ts`

`extensions/_shared/sandbox/escalate.ts` 删掉 `justifyOk`（文件末尾 4 行），只留 `WIDEN` 和 `isStrictWidening`。

`extensions/_shared/sandbox/escalate.test.ts`：导入改成 `import { isStrictWidening } from "./escalate.js";`，删掉整个 `describe("justifyOk", …)`。

`extensions/_shared/sandbox/types.ts` 删掉 `BashEscalationRequest` 接口（原第 35-39 行）。

`extensions/_shared/sandbox/index.ts` 整个换成：

```ts
export type {
  ConfinedArgv,
  FileSandboxMode,
  NetworkSandboxPolicy,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxPolicy,
  SandboxProvider,
  SandboxRunFacts,
} from "./types.js";
export { SANDBOX_DENIAL_EXIT } from "./types.js";
export { SandboxUnavailableError } from "./errors.js";
export { fileModeForApproval, isConfined, resolvePreset } from "./resolvePreset.js";
export { isStrictWidening } from "./escalate.js";
export {
  ESCALATION_TARGETS,
  escalationHintMarker,
  parseSandboxNote,
  runnerFailedMarker,
  sandboxDenialMarker,
  sandboxNotes,
} from "./facts.js";
export type { EscalationTarget, SandboxNote } from "./facts.js";
export { clearEscalationGrants, grantEscalation, takeEscalationGrant } from "./escalationGrant.js";
export { attributeRun } from "./attribute.js";
export type { RunKind } from "./attribute.js";
export { createSandboxProvider } from "./provider.js";
export type { SandboxProbeResult, SandboxProviderDeps } from "./provider.js";
export { createSandboxedBashOperations } from "./operations.js";
export type {
  ExecOptions,
  SandboxedBashOperations,
  SandboxedBashOperationsDeps,
  SpawnImpl,
} from "./operations.js";
export { withTextMarkers } from "./userBash.js";
export { acquireTempDir, dispose as disposeTempDir } from "./tempDirs.js";
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd extensions; npx vitest run sandbox jobs prompt-metadata.test.ts; exit $LASTEXITCODE`
预期：PASS。`prompt-metadata.test.ts` 仍要求每个静态注册的工具有 `promptSnippet`，少了 `bash_escalate` 不影响。

- [ ] **步骤 6：检查点**

用 search 工具在 `extensions` 里搜 `bash_escalate|pendingDenial|justifyOk|BashEscalationRequest`：只剩 `extensions/agent-mode/` 里的白名单和注释（任务 10 处理）。类型检查看 `extensions/_shared/sandbox/`、`extensions/sandbox/` 下没有新报错。不 commit。

---

### 任务 9：safety 审批去重

safety 的 `tool_call` 钩子在某些审批档会问 bash 调用。带升权的调用如果在这里已经问过并允许，就把目标模式和理由写进同一次询问，并给这次调用留一张许可。规则自动放行（没问人）时不留，bash 照常弹升权提示。`ToolCallFacts` 不动（见「与规格的出入」第 3 条）。

**文件：**
- 修改：`extensions/safety/index.ts`（`refuse` 之后加 `escalationOf`；`tool_call` 里的询问段）
- 测试：`extensions/safety/index.test.ts`

- [ ] **步骤 1：编写失败的测试**

`extensions/safety/index.test.ts`：

导入加：

```ts
import { __resetEscalationGrantsForTest, takeEscalationGrant } from "../_shared/sandbox/escalationGrant.js";
```

`beforeEach` 末尾加 `__resetEscalationGrantsForTest();`。

文件末尾加：

```ts
describe("safety · bash sandbox escalation", () => {
  const input = { command: "npm run build", sandbox_permissions: "workspace-write", justification: "需要写构建产物" };
  const sessionManager = { getSessionId: () => "s1" };
  const askVerdict = () => mocks.evaluateToolCall.mockResolvedValue({ decision: "ask", auditId: "a1" });

  it("the ask names the target mode and the reason; allowing leaves a grant for this call", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    askVerdict();
    const ui = { select: vi.fn().mockResolvedValue("允许本次") };
    const r = await setup()({ toolName: "bash", toolCallId: "call-1", input }, { hasUI: true, cwd, ui, sessionManager });
    expect(r).toBeUndefined();
    expect(ui.select.mock.calls[0]?.[0]).toBe(
      "请求批准：\n\n  npm run build\n\n  沙箱升权 → workspace-write\n  理由：需要写构建产物",
    );
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(true);
  });

  it("always-allow also grants this call, and only remembers the command rule", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    askVerdict();
    const ui = { select: vi.fn().mockResolvedValue("总是允许") };
    await setup()({ toolName: "bash", toolCallId: "call-1", input }, { hasUI: true, cwd, ui, sessionManager });
    expect(mocks.rememberToolRule).toHaveBeenCalledTimes(1);
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(true);
  });

  it("a rejection leaves no grant", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    askVerdict();
    const ui = { select: vi.fn().mockResolvedValue("拒绝") };
    const r = await setup()({ toolName: "bash", toolCallId: "call-1", input }, { hasUI: true, cwd, ui, sessionManager });
    expect(r).toMatchObject({ block: true });
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });

  it("an auto-allowed call leaves no grant, so bash still asks", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
    const ui = { select: vi.fn() };
    const r = await setup()({ toolName: "bash", toolCallId: "call-1", input }, { hasUI: true, cwd, ui, sessionManager });
    expect(r).toBeUndefined();
    expect(ui.select).not.toHaveBeenCalled();
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });

  it("a plain bash ask reads as before and leaves no grant", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("ask");
    askVerdict();
    const ui = { select: vi.fn().mockResolvedValue("允许本次") };
    await setup()(
      { toolName: "bash", toolCallId: "call-1", input: { command: "rm foo" } },
      { hasUI: true, cwd, ui, sessionManager },
    );
    expect(ui.select.mock.calls[0]?.[0]).toBe("请求批准：\n\n  rm foo");
    expect(takeEscalationGrant("s1", "call-1", "workspace-write")).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run safety/index.test.ts; exit $LASTEXITCODE`
预期：FAIL。前两条的询问文字里没有升权行，也没有许可；后三条本来就通过，钉住不该变的行为。

- [ ] **步骤 3：实现**

`extensions/safety/index.ts`：

导入加：

```ts
import { grantEscalation } from "../_shared/sandbox/escalationGrant.js";
```

`refuse` 函数之后加：

```ts
/** bash 带升权参数时的目标模式和理由，写进询问文字；bash 工具执行前还会自己校验一遍。 */
function escalationOf(event: { toolName: string; input?: unknown }): { mode: string; justification: string } | undefined {
  if (event.toolName !== "bash") return undefined;
  const input = (event.input ?? {}) as Record<string, unknown>;
  const mode = input.sandbox_permissions;
  const justification = input.justification;
  if (typeof mode !== "string" || typeof justification !== "string") return undefined;
  return { mode, justification: justification.trim() };
}
```

`tool_call` 里从 `const detail = facts.command ?? facts.path ?? event.toolName;` 到 `return undefined;`（钩子末尾）这一段换成：

```ts
    const detail = facts.command ?? facts.path ?? event.toolName;
    // 带升权的 bash：同一次询问里写明目标模式和理由，允许后给这次调用留一张许可，bash 不再问第二次。
    const escalation = escalationOf(event);
    const question = escalation
      ? `${detail}\n\n  沙箱升权 → ${escalation.mode}\n  理由：${escalation.justification}`
      : detail;
    let choice: string | undefined;
    try {
      // 0.85+：用户取消 select 返回 undefined，不再保证抛错。
      choice = await ctx.ui.select(`请求批准：\n\n  ${question}`, ["允许本次", "总是允许", "拒绝"]);
    } catch {
      await settleToolCall(control, verdict.auditId, "aborted");
      return refuse("授权请求已取消");
    }
    if (choice == null) {
      await settleToolCall(control, verdict.auditId, "aborted");
      return refuse("授权请求已取消");
    }

    if (choice === "拒绝") {
      await settleToolCall(control, verdict.auditId, "user_deny");
      return refuse(`用户拒绝：${event.toolName}`);
    }
    if (choice === "总是允许") await rememberToolRule(control, draftRule(facts));
    await settleToolCall(control, verdict.auditId, "user_allow");
    // 「总是允许」只记命令规则；许可只给这一次调用，以后的升权仍由 bash 自己问。
    if (escalation && event.toolCallId !== undefined) {
      grantEscalation(ctx.sessionManager?.getSessionId?.() ?? "", event.toolCallId, escalation.mode);
    }
    return undefined;
```

只有 `question` 的构造、`select` 的标题和末尾的许可是新的，其余和原来一字不差。`ctx.sessionManager` 用可选链：现有测试的 ctx 不带它。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run safety; exit $LASTEXITCODE`
预期：PASS。如果是在子代理里跑、现有的 `terminate: true` 断言失败，先看环境里是不是有 `PI_IS_SUBAGENT=1`（见「执行约定」），不是本任务引起的。

- [ ] **步骤 5：检查点**

`git diff -- extensions/safety/index.ts` 里除了这次的改动，还会看到工作区里原有的未提交改动，不要动它们。类型检查看 `safety/index.ts` 没有新报错。不 commit。

---

### 任务 10：agent-mode 白名单

ask 模式照旧允许升权（经 bash 自己的审批）；plan 模式不加新规则，所有 bash 调用照旧过 `isSafeCommand`。

**文件：**
- 修改：`extensions/agent-mode/modes.ts:60-61`、`:78`、`:116`
- 修改：`extensions/agent-mode/index.ts:5`（注释）
- 测试：`extensions/agent-mode/modes.test.ts:111-118`

- [ ] **步骤 1：改测试**

`extensions/agent-mode/modes.test.ts` 的 `ask allows bash and leaves writes blocked`，把

```ts
    expect(gateToolCall("ask", "bash_escalate", {})).toBeUndefined();
```

换成

```ts
    // 升权并进了 bash：ask 照旧放行，由 bash 自己的审批把关；bash_escalate 已删除，不在白名单里。
    expect(
      gateToolCall("ask", "bash", { command: "touch a.txt", sandbox_permissions: "workspace-write", justification: "需要写入" }),
    ).toBeUndefined();
    expect(gateToolCall("ask", "bash_escalate", {})?.block).toBe(true);
```

并在同一个 `describe("gateToolCall", …)` 里加：

```ts
  it("plan checks every bash command for safety, escalation or not", () => {
    const pair = { sandbox_permissions: "workspace-write", justification: "需要写入" };
    expect(gateToolCall("plan", "bash", { command: "git status", ...pair })).toBeUndefined();
    expect(gateToolCall("plan", "bash", { command: "touch a.txt", ...pair })?.block).toBe(true);
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions; npx vitest run agent-mode/modes.test.ts; exit $LASTEXITCODE`
预期：FAIL，`gateToolCall("ask", "bash_escalate", {})` 还是 `undefined`。plan 那条本来就通过。

- [ ] **步骤 3：改白名单和注释**

`extensions/agent-mode/modes.ts`：

删掉 `ASK_TOOLS` 里的 `"bash_escalate",` 一行。

第 60-61 行改成：

```ts
// ask：只读问答。白名单为经核实存在的只读工具 + bash（写由只读 OS 沙箱拦；被拦后可用 bash 的
// sandbox_permissions 在同一次调用里升权，用户批准）：
//   - pi 内置：read / grep / find / ls / bash
```

第 116 行改成：

```ts
// plan：与 ask 共用白名单（含 bash）；bash 再由 isSafeCommand 限定为只读命令，带不带 sandbox_permissions 都一样。
```

`extensions/agent-mode/index.ts` 第 5 行改成：

```ts
//   - Ask   ：只读问答。只读检索 + bash（写由只读 OS 沙箱执行，升权经用户批准）；禁 写/编辑/MCP。
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions; npx vitest run agent-mode; exit $LASTEXITCODE`
预期：PASS。

- [ ] **步骤 5：检查点**

用 search 工具在 `extensions`、`electron-agent/src`、`electron-agent/electron`、`cli/src` 里搜 `bash_escalate|pendingDenial|justifyOk`，应该只剩 `modes.test.ts` 里新加的注释和断言它被拦的那一行。不 commit。

---

### 任务 11：渲染层卡片模型

前台结果读 `details.sandbox`，不匹配正文。后台任务只有结算 detail 一个字符串，用 `facts.ts` 的 `parseSandboxNote` 认出 `processOutcome` 写的标记（格式和解析在同一个文件）。渲染层已经在用 `@extensions/...` 引纯模块（如 `agentReducer.ts` 引 `@extensions/multi-agent/tasks`），`vitest.config.ts` 的 renderer project 和 ui-harness 都配了这个别名。

**文件：**
- 修改：`electron-agent/src/features/tools/bashCardModel.ts`
- 测试：`electron-agent/src/features/tools/bashCardModel.test.ts`

- [ ] **步骤 1：编写失败的测试**

`electron-agent/src/features/tools/bashCardModel.test.ts`：顶部导入改成

```ts
import { describe, expect, it } from 'vitest';
import { escalationHintMarker, runnerFailedMarker, sandboxDenialMarker } from '@extensions/_shared/sandbox/facts';
import {
  bashJobRef,
  bashRowSummary,
  bashSandboxFacts,
  bashSandboxMeta,
  bashSandboxNote,
  foregroundJobRef,
  formatRunDuration,
  jobFooterText,
  jobRowStatus,
  jobTiming,
  terminalCommandHead,
  terminalCommandLines,
  terminalCopyText,
  terminalOutputEmpty,
  terminalPromptLabel,
} from './bashCardModel';
```

文件末尾加：

```ts
describe('bash sandbox facts', () => {
  const result = (sandbox: unknown) => ({ content: [], details: { sandbox } });

  it('reads details.sandbox and drops malformed fields', () => {
    expect(bashSandboxFacts(result({ mode: 'read-only', denied: true }))).toEqual({ mode: 'read-only', denied: true });
    expect(bashSandboxFacts(result({ mode: 'workspace-write', denied: false, escalatedFrom: 'read-only' }))).toEqual({
      mode: 'workspace-write',
      denied: false,
      escalatedFrom: 'read-only',
    });
    expect(bashSandboxFacts(result({ mode: 'root', denied: true }))).toBeNull();
    expect(
      bashSandboxFacts(result({ mode: 'read-only', denied: false, runnerFailed: 'weird', escalatedFrom: 7 })),
    ).toEqual({ mode: 'read-only', denied: false });
    expect(bashSandboxFacts({ content: [] })).toBeNull();
  });

  it('row meta: runner failure, then denial, then escalation', () => {
    expect(bashSandboxMeta({ mode: 'read-only', denied: false, runnerFailed: 'unavailable', detail: 'x' })).toBe('沙箱未启动');
    expect(bashSandboxMeta({ mode: 'read-only', denied: true })).toBe('沙箱拒绝 · 只读');
    expect(bashSandboxMeta({ mode: 'workspace-write', denied: true, escalatedFrom: 'read-only' })).toBe('沙箱拒绝 · 工作区写入');
    expect(bashSandboxMeta({ mode: 'danger-full-access', denied: false, escalatedFrom: 'workspace-write' })).toBe('已升权 · 完全权限');
    expect(bashSandboxMeta(null)).toBeUndefined();
  });

  it('footer note says what happened in plain words', () => {
    expect(bashSandboxNote({ mode: 'read-only', denied: false, runnerFailed: 'unavailable', detail: 'runner missing' })).toBe(
      '沙箱没有启动，命令没有执行：runner missing',
    );
    expect(bashSandboxNote({ mode: 'read-only', denied: false, runnerFailed: 'runner' })).toBe('沙箱没有启动，命令没有执行');
    expect(bashSandboxNote({ mode: 'read-only', denied: true })).toBe('沙箱拦下了文件访问（只读模式）');
    expect(bashSandboxNote({ mode: 'workspace-write', denied: false, escalatedFrom: 'read-only' })).toBe(
      '本次已获批准，以工作区写入权限运行',
    );
    expect(bashSandboxNote(null)).toBeUndefined();
  });
});

describe('jobFooterText with sandbox notes', () => {
  it('a denied background job says so in Chinese instead of the model-facing markers', () => {
    const detail = `exit code: 1; ${sandboxDenialMarker('read-only')} ${escalationHintMarker()}`;
    expect(jobFooterText({ id: 'bash-3', status: 'completed', detail })).toBe('后台任务 bash-3 · 已结束，退出码 1 · 沙箱拒绝（只读）');
    expect(jobFooterText({ id: 'bash-3', status: 'completed', detail }, true)).toBe('已结束，退出码 1 · 沙箱拒绝（只读）');
  });

  it('a runner failure replaces the raw reason', () => {
    expect(
      jobFooterText({ id: 'bash-3', status: 'failed', detail: `${runnerFailedMarker('read-only')} runner missing` }),
    ).toBe('后台任务 bash-3 · 失败 · 沙箱没有启动，命令没有执行');
  });

  it('other details read as before', () => {
    expect(jobFooterText({ id: 'bash-3', status: 'completed', detail: 'exit code: 0' })).toBe('后台任务 bash-3 · 已完成');
    expect(jobFooterText({ id: 'bash-3', status: 'killed', detail: 'killed before exit; cancelled by the user' })).toBe(
      '后台任务 bash-3 · 已停止 · killed before exit; cancelled by the user',
    );
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run src/features/tools/bashCardModel.test.ts; exit $LASTEXITCODE`
预期：FAIL，`bashSandboxFacts` 等没有导出；后台底栏那组的前两条失败（没有沙箱说明，失败那条贴的是英文原文）。

- [ ] **步骤 3：实现**

`electron-agent/src/features/tools/bashCardModel.ts`：

导入加：

```ts
import { parseSandboxNote, type SandboxNote } from '@extensions/_shared/sandbox/facts';
import type { FileSandboxMode } from '@extensions/_shared/sandbox/types';
```

在 `foregroundJobRef` 之后加：

```ts
const SANDBOX_MODES: readonly FileSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const isSandboxMode = (value: unknown): value is FileSandboxMode => SANDBOX_MODES.includes(value as FileSandboxMode);

/** bash 结果里的沙箱事实（extensions/sandbox/bashTool.ts 的 details.sandbox）：只在被拒、沙箱没启动、已升权时有。 */
export interface BashSandboxFacts {
  mode: FileSandboxMode;
  denied: boolean;
  runnerFailed?: 'unavailable' | 'runner';
  detail?: string;
  escalatedFrom?: FileSandboxMode;
}

export function bashSandboxFacts(result: unknown): BashSandboxFacts | null {
  const raw = getDetails(result)?.sandbox;
  if (!raw || typeof raw !== 'object') return null;
  const { mode, denied, runnerFailed, detail, escalatedFrom } = raw as Record<string, unknown>;
  if (!isSandboxMode(mode) || typeof denied !== 'boolean') return null;
  return {
    mode,
    denied,
    ...(runnerFailed === 'unavailable' || runnerFailed === 'runner' ? { runnerFailed } : {}),
    ...(typeof detail === 'string' && detail ? { detail } : {}),
    ...(isSandboxMode(escalatedFrom) ? { escalatedFrom } : {}),
  };
}

/** 沙箱模式的中文名。 */
export function sandboxModeLabel(mode: FileSandboxMode): string {
  if (mode === 'read-only') return '只读';
  if (mode === 'workspace-write') return '工作区写入';
  return '完全权限';
}

/** 折叠行 meta：沙箱没启动 > 被拒 > 已升权。升权后仍被拒按被拒显示，模式是升权后的。 */
export function bashSandboxMeta(facts: BashSandboxFacts | null): string | undefined {
  if (!facts) return undefined;
  if (facts.runnerFailed) return '沙箱未启动';
  if (facts.denied) return `沙箱拒绝 · ${sandboxModeLabel(facts.mode)}`;
  if (facts.escalatedFrom) return `已升权 · ${sandboxModeLabel(facts.mode)}`;
  return undefined;
}

/** 展开后终端底栏的一句说明，优先级同上。终端正文仍是给模型的文本。 */
export function bashSandboxNote(facts: BashSandboxFacts | null): string | undefined {
  if (!facts) return undefined;
  if (facts.runnerFailed) return `沙箱没有启动，命令没有执行${facts.detail ? `：${facts.detail}` : ''}`;
  if (facts.denied) return `沙箱拦下了文件访问（${sandboxModeLabel(facts.mode)}模式）`;
  if (facts.escalatedFrom) return `本次已获批准，以${sandboxModeLabel(facts.mode)}权限运行`;
  return undefined;
}

function sandboxNoteLabel(note: SandboxNote): string {
  return note.kind === 'runner-failed' ? '沙箱没有启动，命令没有执行' : `沙箱拒绝（${sandboxModeLabel(note.mode)}）`;
}
```

`jobFooterText` 整个换成：

```ts
/**
 * 底栏：停止和失败带上原因（`killed before exit; cancelled by the user`），其余只给状态。
 * 结算 detail 里有 processOutcome 写的沙箱标记时换成中文说明（标记是写给模型的），完整 detail 留在悬停提示里。
 */
export function jobFooterText(
  job: Pick<JobLiveView, 'id' | 'status' | 'detail'>,
  /** 匿名前台命令：模型没拿到这个 id，它也不是后台任务，底栏只说状态。 */
  anonymous = false,
): string {
  const note = parseSandboxNote(job.detail);
  const reason = note
    ? ` · ${sandboxNoteLabel(note)}`
    : (job.status === 'killed' || job.status === 'failed') && job.detail
      ? ` · ${job.detail}`
      : '';
  return anonymous ? `${jobStatusShort(job)}${reason}` : `后台任务 ${job.id} · ${jobStatusShort(job)}${reason}`;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run src/features/tools/bashCardModel.test.ts src/features/tools/BashJobTerminal.test.tsx; exit $LASTEXITCODE`
预期：PASS。`BashJobTerminal.test.tsx` 里现有的底栏断言不带沙箱标记，不受影响。

- [ ] **步骤 5：检查点**

渲染层没有 tsc 工程（`electron-agent/tsconfig.json` 的 `files` 是空的）。临时写 `electron-agent/.tmp-tsc.json`：

```json
{ "extends": "./tsconfig.json", "files": ["src/features/tools/bashCardModel.ts"], "compilerOptions": { "noEmit": true } }
```

运行：`cd electron-agent; npx tsc -p .tmp-tsc.json > ../.tmp-tsc.log 2>&1; exit 0`，用 search 工具在 `.tmp-tsc.log` 里找 `bashCardModel` 和 `_shared/sandbox/facts`，没有报错即可。然后删掉 `electron-agent/.tmp-tsc.json` 和 `.tmp-tsc.log`。不 commit。

---

### 任务 12：渲染层接线

折叠行的 meta 位显示「沙箱拒绝 · 只读」「已升权 · 工作区写入」「沙箱未启动」，展开后终端底栏一句说明。行图标不变：被拒和沙箱没启动是 ✗（`isError`），升权后成功是 ✓。后台任务行仍由 `BashJobMeta` 和 `BashJobTerminal` 负责，底栏已在任务 11 处理。

**文件：**
- 修改：`electron-agent/src/features/tools/ToolExecution.tsx`（第 9 行导入；bash 标题约第 225-243 行；bash 展开体约第 369-377 行）
- 测试：`electron-agent/src/features/tools/ToolExecution.test.tsx`（`describe('ToolExecution bash row', …)`）

- [ ] **步骤 1：编写失败的测试**

在 `describe('ToolExecution bash row', …)` 末尾（`展开 bash 输出按命令行排版，长行可横向滚动` 之后）加：

```tsx
  it('沙箱拒绝：折叠行写明被拒和模式，展开后底栏一句说明', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'touch x', description: 'Create a file' }}
        result={{
          content: [
            {
              type: 'text',
              text: 'touch: x: Read-only file system\n\n\n[sandbox: file access denied under read-only mode]\n\nCommand exited with code 1',
            },
          ],
          details: { sandbox: { mode: 'read-only', denied: true } },
          isError: true,
        }}
        status="error"
      />,
    );
    expect(screen.getByTestId('bash-sandbox-meta').textContent).toBe('沙箱拒绝 · 只读');
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByTestId('bash-sandbox-note').textContent).toBe('沙箱拦下了文件访问（只读模式）');
    // 终端正文仍是给模型的文本。
    expect(screen.getByTestId('terminal-output').textContent).toContain('[sandbox: file access denied under read-only mode]');
  });

  it('已升权：折叠行和底栏都说明这次用的权限', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{
          command: 'npm run build',
          description: 'Build',
          sandbox_permissions: 'workspace-write',
          justification: '需要写构建产物',
        }}
        result={{
          content: [{ type: 'text', text: 'built\n' }],
          details: { sandbox: { mode: 'workspace-write', denied: false, escalatedFrom: 'read-only' } },
        }}
        status="done"
      />,
    );
    expect(screen.getByTestId('bash-sandbox-meta').textContent).toBe('已升权 · 工作区写入');
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByTestId('bash-sandbox-note').textContent).toBe('本次已获批准，以工作区写入权限运行');
  });

  it('普通命令没有沙箱 meta 和底栏', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'echo hi', description: 'Say hi' }}
        result={{ content: [{ type: 'text', text: 'hi\n' }] }}
        status="done"
      />,
    );
    expect(screen.queryByTestId('bash-sandbox-meta')).toBeNull();
    fireEvent.click(screen.getByText('bash'));
    expect(screen.queryByTestId('bash-sandbox-note')).toBeNull();
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run src/features/tools/ToolExecution.test.tsx -t "bash row"; exit $LASTEXITCODE`
预期：FAIL，前两条找不到 `bash-sandbox-meta`。第三条本来就通过。

- [ ] **步骤 3：接线**

`electron-agent/src/features/tools/ToolExecution.tsx`：

第 9 行导入改成：

```ts
import {
  bashJobRef,
  bashRowSummary,
  bashSandboxFacts,
  bashSandboxMeta,
  bashSandboxNote,
  foregroundJobRef,
  jobRowStatus,
  jobTiming,
} from './bashCardModel';
```

bash 标题分支（`if (lname === 'bash' || lname === 'shell' || lname === 'run_terminal_cmd') {`）里，`const jobRef = …` 之后加：

```ts
    // 前台结果里的沙箱事实（details.sandbox）：被拒 / 沙箱没启动 / 已升权。后台任务行跟着 job 走。
    const sandboxMeta = jobRef ? undefined : bashSandboxMeta(bashSandboxFacts(result));
```

同一分支返回对象里的 `meta` 改成：

```tsx
      meta: jobRef ? (
        <BashJobMeta jobRef={jobRef} />
      ) : sandboxMeta ? (
        <span data-testid="bash-sandbox-meta">{sandboxMeta}</span>
      ) : undefined,
```

bash 展开体分支末尾的普通终端（`return ( <TerminalBlock … isError={isError} /> );`）换成：

```tsx
    const sandboxNote = bashSandboxNote(bashSandboxFacts(result));
    return (
      <TerminalBlock
        command={getArgString(args, 'command')}
        cwd={workspace}
        output={text}
        running={status === 'running'}
        isError={isError}
        footer={sandboxNote ? <span data-testid="bash-sandbox-note">{sandboxNote}</span> : undefined}
      />
    );
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run src/features/tools; exit $LASTEXITCODE`
预期：PASS。

- [ ] **步骤 5：检查点**

`git diff -- electron-agent/src/features/tools/ToolExecution.tsx` 里还会看到工作区里原有的未提交改动（codemode、后台任务行），不要动它们。不 commit。

---

### 任务 13：ui-harness 场景

工具卡的改动要有真实渲染的验收（AGENTS.md「UI 检查」）。在现有的 `bash-job-card` 场景里加三种情况：前台被拒、已升权、后台任务被拒。数据形状照任务 6、7 的工具结果造，标记原文直接引 `facts.ts`。

**文件：**
- 修改：`electron-agent/ui-harness/bashJobFixtures.ts`
- 修改：`electron-agent/ui-harness/scenarios/bash-job-card.tsx`
- 修改：`electron-agent/ui-harness/probes/bash-job-card.mjs`

- [ ] **步骤 1：假数据**

`electron-agent/ui-harness/bashJobFixtures.ts`（这个目录不写分号）：

顶部导入加：

```ts
import { escalationHintMarker, sandboxDenialMarker } from '@extensions/_shared/sandbox/facts'
```

`FOREGROUND_GONE` 之后加：

```ts
/** 后台任务被沙箱拒绝：结算 detail 由 processOutcome 写（带给模型的标记和升权提示） */
export const SANDBOX_JOB: JobKey = { jobId: 'bash-909', jobStartedAt: 1791258599963 }
export const SANDBOX_JOB_DETAIL = `exit code: 1; ${sandboxDenialMarker('read-only')} ${escalationHintMarker()}`
export const SANDBOX_JOB_OUTPUT = "Set-Content: Access to the path 'D:\\outside.txt' is denied.\n"
```

文件末尾加：

```ts
const DENIED_ARGS = { command: 'Set-Content -Path ..\\outside.txt -Value x', description: 'Write a file outside the workspace' }
const DENIED_TEXT =
  "Set-Content: Access to the path 'D:\\outside.txt' is denied.\n\n\n" +
  `${sandboxDenialMarker('read-only')}\n${escalationHintMarker()}\n\nCommand exited with code 1`

/** 前台命令被沙箱拒绝：最终结果 isError，details.sandbox 带事实（extensions/sandbox/bashTool.ts）。 */
export function deniedEvents(callId: string): AgentEvent[] {
  return [
    { type: 'tool_execution_start', toolCallId: callId, toolName: 'bash', args: DENIED_ARGS },
    {
      type: 'tool_execution_end',
      toolCallId: callId,
      toolName: 'bash',
      result: { content: [{ type: 'text', text: DENIED_TEXT }], details: { sandbox: { mode: 'read-only', denied: true } } },
      isError: true
    }
  ] as unknown as AgentEvent[]
}

const ESCALATED_ARGS = {
  command: 'npm run build',
  description: 'Build into the workspace',
  sandbox_permissions: 'workspace-write',
  justification: '需要把构建产物写进工作区'
}

/** 同一次调用经用户批准升权后跑完：details.sandbox 带 escalatedFrom。 */
export function escalatedEvents(callId: string): AgentEvent[] {
  return [
    { type: 'tool_execution_start', toolCallId: callId, toolName: 'bash', args: ESCALATED_ARGS },
    {
      type: 'tool_execution_end',
      toolCallId: callId,
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: 'built in 3.2s\n' }],
        details: { sandbox: { mode: 'workspace-write', denied: false, escalatedFrom: 'read-only' } }
      },
      isError: false
    }
  ] as unknown as AgentEvent[]
}
```

- [ ] **步骤 2：场景**

`electron-agent/ui-harness/scenarios/bash-job-card.tsx`：

从 `../bashJobFixtures` 的导入里加上 `SANDBOX_JOB`、`SANDBOX_JOB_DETAIL`、`SANDBOX_JOB_OUTPUT`、`deniedEvents`、`escalatedEvents`。

顶部注释「三种情况：…」一句改成：

```ts
 * 实时（注册表里在跑）、历史回放（注册表里已结束）、任务已不在、前台匿名 job，
 * 以及沙箱事实：前台被拒、已升权、后台任务被拒。
```

`register(DONE_JOB, …)` 之后加：

```ts
// 后台任务被沙箱拒绝：非零退出，detail 里是写给模型的标记。
register(SANDBOX_JOB, 'completed', SANDBOX_JOB_OUTPUT, SANDBOX_JOB_DETAIL, 4_000)
```

`exposeData` 换成：

```ts
exposeData({
  cases: ['live', 'history', 'gone', 'foreground', 'foreground-gone', 'denied', 'escalated', 'job-denied'],
  live: LIVE_JOB.jobId,
  done: DONE_JOB.jobId,
  gone: GONE_JOB.jobId,
  foreground: FOREGROUND_JOB.jobId,
  foregroundGone: FOREGROUND_GONE.jobId,
  sandboxJob: SANDBOX_JOB.jobId
})
```

`CASES` 末尾加三项：

```ts
  { id: 'denied', title: '前台 · 沙箱拒绝', messages: replay(deniedEvents('call-denied')) },
  { id: 'escalated', title: '前台 · 已升权', messages: replay(escalatedEvents('call-escalated')) },
  { id: 'job-denied', title: '后台 · 沙箱拒绝', messages: replay(liveEvents('call-job-denied', SANDBOX_JOB)) }
```

- [ ] **步骤 3：probe**

`electron-agent/ui-harness/probes/bash-job-card.mjs`：

开头的解构改成 `const { cases, live, done, gone, foreground, sandboxJob } = await t.data()`。

在最后一行 `t.check('页面没有错误边界兜底', …)` 之前加：

```js
  // —— 沙箱事实：前台被拒 ——
  const denied = at('denied')
  t.check('沙箱拒绝：行图标是 error', await glyphOf(t, 'denied'), 'error')
  t.check('沙箱拒绝：折叠行写明被拒和模式', await t.text(`${denied} [data-testid="bash-sandbox-meta"]`), '沙箱拒绝 · 只读')
  if ((await t.count(`${denied} [data-testid="bash-sandbox-note"]`)) === 0) {
    await clickRow(t, `${denied} [data-testid="tool-execution"] > div`)
  }
  await t.waitFor(`${denied} [data-testid="bash-sandbox-note"]`, 5000)
  t.check('沙箱拒绝：底栏一句中文说明', await t.text(`${denied} [data-testid="bash-sandbox-note"]`), '沙箱拦下了文件访问（只读模式）')
  t.ok('沙箱拒绝：终端正文仍是给模型的文本', ((await t.text(denied)) ?? '').includes('[sandbox: file access denied under read-only mode]'))
  await t.shot('sandbox-denied')

  // —— 沙箱事实：已升权 ——
  const escalated = at('escalated')
  t.check('已升权：行图标是 done', await glyphOf(t, 'escalated'), 'done')
  t.check('已升权：折叠行写明这次用的权限', await t.text(`${escalated} [data-testid="bash-sandbox-meta"]`), '已升权 · 工作区写入')
  if ((await t.count(`${escalated} [data-testid="bash-sandbox-note"]`)) === 0) {
    await clickRow(t, `${escalated} [data-testid="tool-execution"] > div`)
  }
  await t.waitFor(`${escalated} [data-testid="bash-sandbox-note"]`, 5000)
  t.check('已升权：底栏说明本次已获批准', await t.text(`${escalated} [data-testid="bash-sandbox-note"]`), '本次已获批准，以工作区写入权限运行')

  // —— 沙箱事实：后台任务被拒，底栏不直接贴给模型的英文标记 ——
  const jobDenied = at('job-denied')
  await t.waitFor(`${jobDenied} [data-testid="bash-job-meta"]`, 5000)
  t.check('后台被拒：非零退出，行图标是 error', await glyphOf(t, 'job-denied'), 'error')
  await clickRow(t, `${jobDenied} [data-testid="tool-execution"] > div`)
  await t.waitFor(`${jobDenied} [data-testid="bash-job-status"]`, 5000)
  t.check(
    '后台被拒：底栏是中文说明',
    await t.text(`${jobDenied} [data-testid="bash-job-status"]`),
    `后台任务 ${sandboxJob} · 已结束，退出码 1 · 沙箱拒绝（只读）`
  )
  t.check(
    '后台被拒：底栏不出现升权提示原文',
    ((await t.text(`${jobDenied} [data-testid="bash-job-status"]`)) ?? '').includes('escalation available'),
    false
  )
  await t.shot('sandbox-job-denied')
```

- [ ] **步骤 4：跑场景**

后台跑（输出重定向到文件，不用管道）：

运行：`cd electron-agent; npm run ui:check -- bash-job-card > ../.tmp-uicheck.log 2>&1; exit $LASTEXITCODE`
预期：退出码 0，日志里没有 FAIL。原有 43 条加上新的 10 条全部 PASS。截图在 `%TEMP%\grenagent-ui-shots\` 下，看一眼 `bash-job-card-sandbox-denied.png` 和 `bash-job-card-sandbox-job-denied.png`。

有失败时先单独复跑一次再下结论；展开体里什么都没有就查 `[data-testid="error-boundary-fallback"]`。

- [ ] **步骤 5：看波及范围**

运行：`cd electron-agent; npm run ui:check -- --changed --dry-run > ../.tmp-uicheck.log 2>&1; exit $LASTEXITCODE`
如果列出了 `codemode-card`：它的嵌套调用也走 `ToolExecution.tsx` 的 bash 分支，这次改了那里的 meta 和底栏，跑一次 `npm run ui:check -- codemode-card > ../.tmp-uicheck.log 2>&1; exit $LASTEXITCODE`，全部 PASS，并在汇报里说明跑了哪些、为什么。没列出就不跑。完了删掉 `.tmp-uicheck.log`。

- [ ] **步骤 6：检查点**

`electron-agent/ui-harness/` 整个目录本来就是未跟踪的，不要单独 `git add`。不 commit。

---

### 任务 14：文档

改了工具参数、删了一个工具、推翻了 2026-09-12 OS 沙箱设计里「`bash_escalate` 是唯一的模型侧升权通道」的结论，按 AGENTS.md 要写决策笔记。`docs/decisions/` 里没有关于 `bash_escalate` / `pendingDenial` 的旧笔记（开工前已 grep），所以 `supersedes` 留空，正文点名那份设计。

**文件：**
- 创建：`docs/decisions/extensions/2026-10-05-bash-sandbox-facts-and-escalation.md`
- 修改：`docs/architecture.md:79`
- 修改：`AGENTS.md`（「现有场景」里 `bash-job-card` 那条）

- [ ] **步骤 1：决策笔记**

创建 `docs/decisions/extensions/2026-10-05-bash-sandbox-facts-and-escalation.md`：

````markdown
---
title: 沙箱拒绝作为事实返回，升权并进 bash 的同一次调用
status: active
date: 2026-10-05
scope: extensions
files:
  - extensions/_shared/sandbox/operations.ts
  - extensions/_shared/sandbox/facts.ts
  - extensions/_shared/sandbox/userBash.ts
  - extensions/_shared/sandbox/escalationGrant.ts
  - extensions/sandbox/bashTool.ts
  - extensions/sandbox/bashJob.ts
  - extensions/sandbox/escalation.ts
  - extensions/sandbox/index.ts
  - extensions/safety/index.ts
  - extensions/agent-mode/modes.ts
  - electron-agent/src/features/tools/bashCardModel.ts
  - electron-agent/src/features/tools/ToolExecution.tsx
supersedes:
superseded_by:
---

## 背景

沙箱拒绝、runner 失败、`SANDBOX_UNAVAILABLE` 原来由 `operations.ts` 当输出字节写进流里：它们进完整日志、后台任务输出环和 50KB 截断额度，后台任务被拒时结算通知只写 `exit code: 1`，界面认不出被拒。升权走单独的 `bash_escalate`，靠 `pendingDenial` 按命令文本配对，批准后直接调 `operations.exec` 重跑：不注册任务、不截断、超时不转后台、非零退出不标错。`docs/superpowers/specs/2026-09-12-os-sandbox-design.md` 把 `bash_escalate` 定为唯一的模型侧升权通道，这次推翻它。DSH（`packages/shell/tool-pwsh`、`packages/sandbox/sandbox/src/escalation.ts`）是执行器返回 `sandbox: { mode, denied, runnerFailed }`，工具层渲染标记，升权是同一个工具的 `sandbox_permissions` + `justification`。

## 决定

照 DSH 分层。`exec` 返回 `{ exitCode, sandbox }`，不往 `onData` 写任何标记。bash 前台把拒绝标记（可升权时加一行提示）接在输出和截断说明之后、`Command exited with code N` 之前，结构化事实放进 `details.sandbox`（只在被拒、沙箱没启动、已升权时有）；runner 失败返回 `isError`，不报退出码。后台和转后台的任务由 `processOutcome` 把说明并进结算 detail。`user_bash` 由 pi 显示输出，经 `withTextMarkers` 把事实写回原来的文字，只有拒绝行去掉了指向 `bash_escalate` 的半句。标记原文和解析放在纯模块 `facts.ts`，渲染层用 `parseSandboxNote` 认后台任务 detail，底栏显示中文说明。

升权：bash 加可选的 `sandbox_permissions`（`workspace-write` / `danger-full-access`）和 `justification`，执行前按 DSH `approveEscalation` 的顺序裁决：成对、理由非空、同模式不算升权、必须严格更宽、「工作区编辑」档拒绝、需要审批通道（有界面且是主会话回合）、用户批准。批准后这一次调用带 `PI_SANDBOX_MODE_ONCE` 走正常的 job 路径。理由只要求非空，去掉了至少 20 个字符的规则：中文一句完整的理由常常不到 20 个字，门槛是审批。safety 的 `tool_call` 审批对同一次调用已经问过并允许时，留一张按会话 + toolCallId + 模式的一次性许可，bash 不再弹第二次。删掉 `bash_escalate`、`pendingDenial`、`justifyOk`。

## 放弃的方案

- 保留 `bash_escalate`，只把它的执行改走 bash 同一条路径：两个工具、两套校验；「先被拒才能申请」靠命令文本配对，带最后一行的模糊匹配，命令稍有出入就失败。
- 只做事实结构化、升权维持现状：提示里还得指向 `bash_escalate`，批准后的重跑仍然不是 job。
- 把事实放进 `structuredContent`：pi 的包都不把它给模型（codemode 只在声明了 `outputSchema` 时交给脚本），模型只读正文，标记必须在正文里；bash 的 `outputSchema` 钉在 pi 1.0.2，加字段会破契约。
- 拆 stdout / stderr 成 `[stderr]` 段：pi 的输出约定是两路按时间顺序合一，分段后看不出报错在哪一步之后；DSH 分开是因为它的执行器本来就是两路。
- 后台任务卡底栏直接显示 detail：detail 里是写给模型的英文标记和升权提示，改成认出标记后显示中文，原文留在悬停提示里。
- safety 把升权写进 `ToolCallFacts` 发给主进程：`toolPermission/rpc.ts` 按白名单解析 facts，多的字段会被丢掉，升权参数本来就在 `rawArgs` 里进审计。
- 只看 `ctx.hasUI` 判断有没有审批通道：goal 回合它仍是 true，宿主却对所有对话框立即返回取消，模型会被提示去升权、又立刻被取消。

## 后果

bash 的参数变了、少了一个工具，系统提示前缀缓存重建一次。旧会话里的 `bash_escalate` 调用回放成普通工具卡。

模型可以不经拒绝就申请升权，门槛只剩用户审批和提示词约束。如果出现频繁预先申请，再考虑恢复「最近一次被拒」的校验，按 toolCallId 记，不按命令文本。

safety 按规则自动放行的调用没有许可，bash 照常弹升权提示；「总是允许」只记 safety 的命令规则，不会让以后的升权变成静默。被后面的钩子拦下、没走到执行的调用留下的许可，会在会话关闭时清掉。

审批通道靠 `resolveToolOrigin() === "main"` 判断；宿主以后让 goal 回合也能弹审批，这里要跟着改。
````

- [ ] **步骤 2：架构文档**

`docs/architecture.md` 第 79 行（`| \`sandbox\` |` 那一行）末尾的

```
无会话或超并发上限时退回不受管前台（timeout 到点杀） | `bash`、`bash_escalate` |
```

改成

```
无会话或超并发上限时退回不受管前台（timeout 到点杀）。沙箱拒绝和 runner 失败由 operations 作为事实返回（`{ exitCode, sandbox }`），bash 把标记接在输出后、退出码前并放进 `details.sandbox`，后台任务并进结算 detail；被拒后用 `sandbox_permissions` + `justification` 在同一次调用里升权，经用户批准 | `bash` |
```

- [ ] **步骤 3：AGENTS.md 的场景说明**

`AGENTS.md`「现有场景」里 `bash-job-card` 那条末尾的

```
找不到 job 时静默回退到 partial 文本）
```

改成

```
找不到 job 时静默回退到 partial 文本；沙箱事实：前台被拒的行写「沙箱拒绝 · 只读」、展开后底栏一句中文、终端正文保留给模型的标记，已升权的行和底栏写明权限，后台任务被拒时底栏换成中文、不贴升权提示原文）
```

- [ ] **步骤 4：笔记检查**

运行：`node scripts/check-notes.mjs; exit $LASTEXITCODE`
预期：`notes OK`，数量比之前多 1。

- [ ] **步骤 5：检查点**

不 commit。

---

### 任务 15：总验收与提交

**文件：** 不改代码，只跑验证、清理、问用户怎么提交。

- [ ] **步骤 1：extensions 全套**

运行：`cd extensions; npx vitest run _shared/sandbox sandbox safety agent-mode jobs prompt-metadata.test.ts; exit $LASTEXITCODE`
预期：PASS。

- [ ] **步骤 2：渲染层**

运行：`cd electron-agent; npx vitest run src/features/tools; exit $LASTEXITCODE`
预期：PASS。

- [ ] **步骤 3：类型**

运行：`cd cli; npx tsc -p tsconfig.json > ../.tmp-tsc.log 2>&1; exit 0`
用 search 工具在 `.tmp-tsc.log` 里搜本计划动过的文件：`_shared/sandbox/(facts|operations|userBash|escalationGrant|escalate|types|index)`、`sandbox/(bashTool|bashJob|escalation|index)`、`safety/index`、`agent-mode/modes`。预期没有匹配。有匹配就对照 `git diff` 看报错的行是不是本计划改的，只修本计划引入的。完了删掉 `.tmp-tsc.log`。

- [ ] **步骤 4：残留引用**

用 search 工具在 `extensions`、`electron-agent/src`、`electron-agent/electron`、`cli/src`、`docs/architecture.md`、`AGENTS.md` 里搜 `bash_escalate|pendingDenial|justifyOk|BashEscalationRequest|Call bash_escalate`。预期只剩 `extensions/agent-mode/modes.test.ts` 里任务 10 加的注释和断言。`docs/decisions/` 和 `docs/superpowers/` 下的历史文档不改。

- [ ] **步骤 5：UI 与笔记**

确认任务 13 的 `bash-job-card` 结果是全 PASS（代码在那之后没改过就不重跑），`node scripts/check-notes.mjs` 通过。

- [ ] **步骤 6：清理**

`git status --short` 里不应有本计划产生的 `.tmp-*` 文件。仓库根的 `.tmp-dup-send.cjs`、`.tmp-pkg.txt` 和 `electron-agent/.tmp-cdp-probe.mjs` 不是本计划的，保留。

- [ ] **步骤 7：问用户怎么提交**

这次动到的文件里，`extensions/safety/index.ts`、`extensions/sandbox/bashTool.ts`、`bashTool.test.ts`、`ToolExecution.tsx`、`bashCardModel.ts`、`bashCardModel.test.ts`、`AGENTS.md`、`docs/architecture.md` 本来就带着别的未提交改动，`electron-agent/ui-harness/` 整个目录未跟踪。用 ask_user 让用户选：和工作区里已有的改动一起提交、用 `git add -p` 只挑本计划的块单独提交、或先不提交。不要自作主张。

提交前 `.git/hooks/pre-commit` 会跑 `node scripts/check-notes.mjs`。决策笔记要和代码在同一次提交里。

- [ ] **步骤 8：告诉用户要重启应用**

扩展跑在主进程里，`electron-vite dev` 不会热重启主进程。汇报时说明：重启应用后新 bash 才生效；可以在「请求批准」档、ask 模式下让模型写工作区文件，看到被拒、升权提示、弹窗和「已升权 · 工作区写入」这一套。

---

## 规格覆盖

| 规格章节 | 任务 |
| --- | --- |
| 沙箱层：只交事实（类型、各分支对应、不写 onData） | 1、2 |
| `user_bash` 适配器 | 3 |
| bash 工具：标记原文、升权提示的三个条件 | 1、5、6 |
| bash 工具：前台位置、runner 失败的 `isError`、`details.sandbox` 只在三种情况出现 | 6、7 |
| bash 工具：后台和转后台的结算 detail | 4、6 |
| 升权：参数、校验顺序、批准后走 job 路径 | 5、7 |
| 升权：和 safety 审批去重 | 5、9 |
| 删除和联动（`bash_escalate`、`pendingDenial`、`justifyOk`、白名单、guideline） | 7、8、10 |
| 界面：折叠行、底栏、后台底栏 | 11、12 |
| 测试：单测、`prompt-metadata`、ui-harness | 各任务、任务 13 |
| 决策笔记、`architecture.md` | 14 |
| 一次改完再提交 | 执行约定、任务 15 |
| 不做：不拆 stdout / stderr、不改判定和 runner、不剥掉终端里的模型标记、不做全局任务入口 | 没有任务碰这些 |
