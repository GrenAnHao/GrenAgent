# OS 沙箱规格 1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用官方 `createBashTool({ operations })` + `user_bash` 接管 Agent 的 bash，按五档审批做 `confine(argv)`；无 runner 失败关闭；三平台（Windows ACL / Linux bwrap / macOS Seatbelt）同期交付。

**架构：** 纯函数与 runner 放 `extensions/_shared/sandbox/`。扩展 `extensions/sandbox` 在 pi-worker 里注册包装后的 bash、`bash_escalate`，并覆盖 `user_bash`。审批五档键在 `_shared/approval`、渲染层 store、`piRuntimeService`、`toolPermission` 四处同步。`SandboxManager.prepare()` 仍只服务 PTY / 子代理路径校验，不引入失败关闭。

**技术栈：** TypeScript ESM、vitest、Node `child_process`、Win32 受限令牌 helper、Linux `bwrap`、macOS `sandbox-exec`。不引入 Cordis / dsh 包 / WSL2。

**上游规格：** `docs/superpowers/specs/2026-09-12-os-sandbox-design.md`

---

## 动工前必读

**五档线键（全仓库同一组字符串，禁止另造别名）：**

| 键 | 文案 | 文件模式 | safety 内置规则 |
| --- | --- | --- | --- |
| `readonly` | 仅查看 | `read-only` | 与 `ask` 相同（联网 / MCP / 危险命令要问） |
| `ask` | 请求批准 | `workspace-write` | 现有 ASK_EXTRA + GUARDS |
| `auto` | 替我审批 | `workspace-write` | 现有 GUARDS |
| `workspace` | 工作区编辑 | `workspace-write` | 只 deny 受保护路径，不问人 |
| `full` | 完全权限 | `danger-full-access` | 空集（与现状 full 等价） |

默认档仍是 `auto`。旧值 `ask` / `auto` / `full` 必须继续合法。

**两个包不能互相发明第二套键。** `extensions/_shared/approval.ts` 是线键真相源。`electron-agent/src/stores/approvalStore.ts` 与 `toolPermission/types.ts` 的 `ApprovalPreset` 必须逐字相同。主进程已能 `import { setApprovalPolicy } from '../../../extensions/_shared/approval.js'`。

**bash 在 pi-worker 里跑，** 不是 Electron 主进程。注入点只有：

```ts
import { createBashTool } from "@earendil-works/pi-coding-agent";
// 若包根未导出：从 @earendil-works/pi-coding-agent/dist/core/tools/bash.js 深导入，并在该任务 commit message 写明。
```

禁止 `spawnHook`。禁止复用 `createLocalBashOperations()`。禁止官方示例那种 `if (!ready) return localBash.execute(...)`。

**`SandboxManager.prepare()` 不得改成抛 UNAVAILABLE。** PTY 与子代理取消仍走它。bash 不经过这个类。

**拒写退出码** 常量 `SANDBOX_DENIAL_EXIT = 162`。Windows helper 拒写用它。Linux / macOS 若内核只给 1，靠 `denialSignatures` 兜底，且 `attribute()` 必须先匹配 `runnerFailureRules`。

**测试命令：**

```powershell
cd extensions; npx vitest run _shared/sandbox _shared/approval.test.ts sandbox safety/index.test.ts agent-mode/modes.test.ts
cd electron-agent; npx vitest run src/stores/approvalStore.test.ts src/features/chat/input/actions/ApprovalAction.tsx electron/app/piRuntimeService.test.ts electron/app/toolPermission/builtinRules.test.ts electron/app/sandbox/sandboxManager.test.ts
cd cli; node --test src/extension-profile.test.ts
```

**tauri-agent 冻结，本计划不改。**

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `extensions/_shared/sandbox/types.ts` | 规格 §4.1 类型 |
| `extensions/_shared/sandbox/errors.ts` | `SandboxUnavailableError` |
| `extensions/_shared/sandbox/resolvePreset.ts` | 五档 + Ask → `SandboxExecutionPolicy` |
| `extensions/_shared/sandbox/escalate.ts` | 加宽校验 |
| `extensions/_shared/sandbox/pendingDenial.ts` | 单次消费 pending |
| `extensions/_shared/sandbox/attribute.ts` | runner 失败 / 拒写 / 命令失败 |
| `extensions/_shared/sandbox/tempDirs.ts` | 每会话临时目录 + TTL |
| `extensions/_shared/sandbox/shellPath.ts` | 解析 bash.exe / 系统 bash |
| `extensions/_shared/sandbox/linux/bwrap.ts` | bwrap argv |
| `extensions/_shared/sandbox/darwin/seatbelt.ts` | Seatbelt profile + argv |
| `extensions/_shared/sandbox/windows/sids.ts` | 工作区 / 临时 SID |
| `extensions/_shared/sandbox/windows/runner.ts` | helper argv |
| `extensions/_shared/sandbox/windows/helper.c` | Win32 受限令牌 spawn |
| `extensions/_shared/sandbox/provider.ts` | 按平台探测 + `confine` |
| `extensions/_shared/sandbox/operations.ts` | `BashOperations.exec` |
| `extensions/_shared/sandbox/index.ts` | 对外导出 |
| `extensions/sandbox/index.ts` | 扩展：bash / user_bash / bash_escalate / dispose |
| 各文件旁 `*.test.ts` | 与实现同目录 |

修改：

| 文件 | 改动 |
| --- | --- |
| `extensions/_shared/approval.ts` | 五档类型、parse、文案 |
| `extensions/_shared/desktop-control.ts` | `ApprovalPreset` 五档 |
| `extensions/safety/index.ts` | `collectFacts` 原样传递五档 |
| `extensions/agent-mode/modes.ts` | `ASK_TOOLS` 加 `bash`；更新注释与 gate 文案 |
| `extensions/index.ts` | 注册 sandbox 扩展（safety 之后） |
| `cli/src/extension-profile.ts` | `CORE_ALWAYS_ON` 加 `sandbox` |
| `electron-agent/src/stores/approvalStore.ts` | 五档 |
| `electron-agent/src/features/chat/input/actions/ApprovalAction.tsx` | 五档图标；Ask 时禁用 |
| `electron-agent/electron/app/piRuntimeService.ts` | `writeApprovalPolicy` 白名单 |
| `electron-agent/electron/app/toolPermission/types.ts` | `ApprovalPreset` |
| `electron-agent/electron/app/toolPermission/builtinRules.ts` | `readonly` / `workspace` |
| `electron-agent/electron/app/sandbox/sandboxManager.ts` | 注释：bash 不走此类；行为不变 |

---

### 任务 1：五档线键（approval 真相源）

**文件：**
- 修改：`extensions/_shared/approval.ts`
- 测试：`extensions/_shared/approval.test.ts`

- [ ] **步骤 1：先改测试让旧「只有三档」失败**

把 `has zh labels for all 3` 换成：

```ts
  it("has zh labels for all 5", () => {
    expect(Object.keys(APPROVAL_LABELS).sort()).toEqual([
      "ask", "auto", "full", "readonly", "workspace",
    ]);
  });
  it("parse accepts the two new keys", () => {
    expect(parseApproval("readonly")).toBe("readonly");
    expect(parseApproval("WORKSPACE")).toBe("workspace");
  });
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd extensions; npx vitest run _shared/approval.test.ts
```

预期：FAIL，keys 仍是三档。

- [ ] **步骤 3：最少实现**

`extensions/_shared/approval.ts` 整文件改为：

```ts
import { currentCwd } from "./workspace-context.js";

export type ApprovalPolicy = "readonly" | "ask" | "auto" | "workspace" | "full";

const POLICIES = new Set<ApprovalPolicy>(["readonly", "ask", "auto", "workspace", "full"]);
const byCwd = new Map<string, ApprovalPolicy>();

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function resolveCwd(cwd?: string): string {
  return normalizeCwd(cwd ?? currentCwd());
}

export function getApprovalPolicy(cwd?: string): ApprovalPolicy {
  return byCwd.get(resolveCwd(cwd)) ?? "auto";
}
export function setApprovalPolicy(p: ApprovalPolicy, cwd?: string): void {
  byCwd.set(resolveCwd(cwd), p);
}
export function hasApprovalPolicy(cwd?: string): boolean {
  return byCwd.has(resolveCwd(cwd));
}
export function approvalPolicyConfigKey(workspace: string): string {
  return `APPROVAL_POLICY:${normalizeCwd(workspace)}`;
}
export function parseApproval(s: string | undefined): ApprovalPolicy | undefined {
  const v = (s ?? "").trim().toLowerCase();
  return POLICIES.has(v as ApprovalPolicy) ? (v as ApprovalPolicy) : undefined;
}
export function isApprovalPolicy(v: unknown): v is ApprovalPolicy {
  return typeof v === "string" && POLICIES.has(v as ApprovalPolicy);
}

export const APPROVAL_LABELS: Record<ApprovalPolicy, string> = {
  readonly: "仅查看",
  ask: "请求批准",
  auto: "替我审批",
  workspace: "工作区编辑",
  full: "完全权限",
};

export function __resetApprovalForTest(): void {
  byCwd.clear();
}
```

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd extensions; npx vitest run _shared/approval.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/_shared/approval.ts extensions/_shared/approval.test.ts
git commit -m "feat(approval): 审批线键扩为五档"
```

---

### 任务 2：`resolvePreset`

**文件：**
- 创建：`extensions/_shared/sandbox/types.ts`
- 创建：`extensions/_shared/sandbox/resolvePreset.ts`
- 测试：`extensions/_shared/sandbox/resolvePreset.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { resolvePreset } from "./resolvePreset.js";

describe("resolvePreset", () => {
  it("Ask forces read-only even when approval is full", () => {
    const p = resolvePreset({
      approval: "full", agentMode: "ask", workspaceRoot: "D:/repo", sessionId: "s1",
    });
    expect(p).toMatchObject({
      mode: "read-only", network: "enabled", workspaceRoot: "D:/repo", sessionId: "s1",
    });
  });
  it("maps the five approvals when not Ask", () => {
    expect(resolvePreset({ approval: "readonly", agentMode: "agent", workspaceRoot: "/w" }).mode).toBe("read-only");
    expect(resolvePreset({ approval: "ask", agentMode: "agent", workspaceRoot: "/w" }).mode).toBe("workspace-write");
    expect(resolvePreset({ approval: "auto", agentMode: "plan", workspaceRoot: "/w" }).mode).toBe("workspace-write");
    expect(resolvePreset({ approval: "workspace", agentMode: "agent", workspaceRoot: "/w" }).mode).toBe("workspace-write");
    expect(resolvePreset({ approval: "full", agentMode: "agent", workspaceRoot: "/w" }).mode).toBe("danger-full-access");
  });
  it("always enables network in spec 1", () => {
    for (const approval of ["readonly", "ask", "auto", "workspace", "full"] as const) {
      expect(resolvePreset({ approval, agentMode: "agent", workspaceRoot: "/w" }).network).toBe("enabled");
    }
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd extensions; npx vitest run _shared/sandbox/resolvePreset.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现类型与函数**

`types.ts`：按规格 §4.1 原样写入 `FileSandboxMode`、`NetworkSandboxPolicy`、`SandboxEnforcement`、`SandboxExecutionPolicy`、`SandboxPolicy`、`RunnerFailureRule`、`ConfinedArgv`、`SandboxProvider`、`BashEscalationRequest`。另加：

```ts
export const SANDBOX_DENIAL_EXIT = 162;
```

`resolvePreset.ts`：

```ts
import type { ApprovalPolicy } from "../approval.js";
import type { AgentMode } from "../../agent-mode/modes.js";
import type { FileSandboxMode, SandboxExecutionPolicy } from "./types.js";

export function fileModeForApproval(approval: ApprovalPolicy): FileSandboxMode {
  if (approval === "readonly") return "read-only";
  if (approval === "full") return "danger-full-access";
  return "workspace-write";
}

export function resolvePreset(input: {
  approval: ApprovalPolicy;
  agentMode: AgentMode;
  workspaceRoot: string;
  sessionId?: string;
}): SandboxExecutionPolicy {
  const mode = input.agentMode === "ask" ? "read-only" : fileModeForApproval(input.approval);
  return {
    mode,
    network: "enabled",
    workspaceRoot: input.workspaceRoot,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

export function isConfined(mode: FileSandboxMode): mode is Exclude<FileSandboxMode, "danger-full-access"> {
  return mode !== "danger-full-access";
}
```

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd extensions; npx vitest run _shared/sandbox/resolvePreset.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/_shared/sandbox/types.ts extensions/_shared/sandbox/resolvePreset.ts extensions/_shared/sandbox/resolvePreset.test.ts
git commit -m "feat(sandbox): resolvePreset 五档与 Ask 锁定"
```

---

### 任务 3：升权校验与 pending denial

**文件：**
- 创建：`extensions/_shared/sandbox/escalate.ts`、`pendingDenial.ts`、`attribute.ts` 及对应 `*.test.ts`

- [ ] **步骤 1：写失败测试**

`escalate.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { isStrictWidening } from "./escalate.js";

describe("isStrictWidening", () => {
  it("allows the two legal widenings", () => {
    expect(isStrictWidening("read-only", "workspace-write")).toBe(true);
    expect(isStrictWidening("read-only", "danger-full-access")).toBe(true);
    expect(isStrictWidening("workspace-write", "danger-full-access")).toBe(true);
  });
  it("rejects narrow, equal, or unknown jumps", () => {
    expect(isStrictWidening("workspace-write", "read-only")).toBe(false);
    expect(isStrictWidening("read-only", "read-only")).toBe(false);
    expect(isStrictWidening("danger-full-access", "workspace-write")).toBe(false);
  });
});
```

`pendingDenial.test.ts`：消费一次后第二次失败；command 必须逐字节相同。

`attribute.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { attributeRun } from "./attribute.js";

const confined = {
  argv: ["bwrap", "--", "bash", "-c", "x"],
  enforcement: "full" as const,
  denialExitCodes: [162],
  denialSignatures: ["erofs", "read-only file system"],
  runnerFailureRules: [{
    kind: "runner-launch-failed" as const,
    exitCodes: [127],
    signatures: ["bwrap: executable not found"],
  }],
};

describe("attributeRun", () => {
  it("classifies runner failure before denial", () => {
    expect(attributeRun({ exitCode: 127, stderr: "bwrap: executable not found\n" }, confined).kind)
      .toBe("runner-failure");
  });
  it("classifies structured denial exit", () => {
    expect(attributeRun({ exitCode: 162, stderr: "" }, confined).kind).toBe("denial");
  });
  it("does not treat echoed denial text plus ordinary exit as denial", () => {
    expect(attributeRun({ exitCode: 1, stdout: "erofs is a string in my file\n", stderr: "" }, confined).kind)
      .toBe("command");
  });
  it("allows signature fallback only when exit is nonzero and not a runner failure", () => {
    expect(attributeRun({ exitCode: 1, stderr: "Read-only file system\n" }, confined).kind).toBe("denial");
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd extensions; npx vitest run _shared/sandbox/escalate.test.ts _shared/sandbox/pendingDenial.test.ts _shared/sandbox/attribute.test.ts
```

预期：FAIL。

- [ ] **步骤 3：实现**

`escalate.ts`：

```ts
import type { FileSandboxMode } from "./types.js";

const WIDEN: Record<FileSandboxMode, readonly FileSandboxMode[]> = {
  "read-only": ["workspace-write", "danger-full-access"],
  "workspace-write": ["danger-full-access"],
  "danger-full-access": [],
};

export function isStrictWidening(from: FileSandboxMode, to: FileSandboxMode): boolean {
  return WIDEN[from].includes(to);
}

export function justifyOk(text: string): boolean {
  return text.trim().length >= 20;
}
```

`pendingDenial.ts`：用 `Map<string, { mode: FileSandboxMode }>`，键为 `${workspace}\0${command}`。`remember` 覆盖同键。`consume(workspace, command)` 命中则删除并返回记录，否则 `undefined`。导出 `__resetPendingDenialsForTest`。

`attribute.ts`：

```ts
import type { ConfinedArgv } from "./types.js";

export type RunKind = "runner-failure" | "denial" | "command";

export function attributeRun(
  result: { exitCode: number | null; stdout?: string; stderr?: string },
  confined: Pick<ConfinedArgv, "denialExitCodes" | "denialSignatures" | "runnerFailureRules">,
): { kind: RunKind } {
  const code = result.exitCode ?? 1;
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  for (const rule of confined.runnerFailureRules) {
    if (rule.exitCodes.includes(code) && rule.signatures.some((s) => text.includes(s.toLowerCase()))) {
      return { kind: "runner-failure" };
    }
  }
  if (confined.denialExitCodes.includes(code)) return { kind: "denial" };
  if (code !== 0 && confined.denialSignatures.some((s) => text.includes(s.toLowerCase()))) {
    return { kind: "denial" };
  }
  return { kind: "command" };
}
```

签名回显误命中：退出码 1 且签名只在 stdout、语义上仍可能被判 denial。任务 3 测试要求「stdout 回显 + exit 1」为 `command`。因此 **签名兜底只看 stderr**：

把 `text` 拆开：runner 规则看 stdout+stderr；`denialSignatures` **只匹配 stderr**。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd extensions; npx vitest run _shared/sandbox/escalate.test.ts _shared/sandbox/pendingDenial.test.ts _shared/sandbox/attribute.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/_shared/sandbox/escalate.ts extensions/_shared/sandbox/escalate.test.ts extensions/_shared/sandbox/pendingDenial.ts extensions/_shared/sandbox/pendingDenial.test.ts extensions/_shared/sandbox/attribute.ts extensions/_shared/sandbox/attribute.test.ts
git commit -m "feat(sandbox): 升权加宽、pending denial 与退出归因"
```

---

### 任务 4：`confine` 失败关闭与 Linux bwrap

**文件：**
- 创建：`extensions/_shared/sandbox/errors.ts`
- 创建：`extensions/_shared/sandbox/linux/bwrap.ts`
- 创建：`extensions/_shared/sandbox/provider.ts`
- 测试：`errors` 可与 confine 测写在 `provider.test.ts`、`linux/bwrap.test.ts`

- [ ] **步骤 1：写失败测试**

`linux/bwrap.test.ts`：断言 `read-only` 含 `--ro-bind / /`、`--die-with-parent`、`--unshare-pid`，**不含** `--unshare-net`；`workspace-write` 另有 `--bind` 工作区与临时目录。分隔符 `--` 之后是调用方 argv。

`provider.test.ts`：

```ts
it("throws SANDBOX_UNAVAILABLE when the platform probe fails", async () => {
  const provider = createSandboxProvider({
    platform: "linux",
    probe: async () => ({ ok: false, reason: "no-bwrap" }),
  });
  await expect(provider.confine(["bash", "-c", "true"], {
    mode: "read-only", network: "enabled", workspaceRoot: "/w",
  })).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
});
it("never returns the caller's argv unwrapped", async () => {
  const provider = createSandboxProvider({
    platform: "linux",
    probe: async () => ({ ok: true }),
    build: (argv) => ({
      argv: ["bwrap", "--ro-bind", "/", "/", "--", ...argv],
      enforcement: "full",
      denialExitCodes: [],
      denialSignatures: ["erofs"],
      runnerFailureRules: [],
    }),
  });
  const out = await provider.confine(["bash", "-c", "true"], {
    mode: "read-only", network: "enabled", workspaceRoot: "/w",
  });
  expect(out.argv[0]).toBe("bwrap");
  expect(out.argv.slice(-3)).toEqual(["bash", "-c", "true"]);
});
```

不要写「传入 danger-full-access」的 confine 测试——类型上进不去；由 operations 保证不调用。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd extensions; npx vitest run _shared/sandbox/linux/bwrap.test.ts _shared/sandbox/provider.test.ts
```

预期：FAIL。

- [ ] **步骤 3：实现**

`errors.ts`：

```ts
export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE" as const;
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}
```

`linux/bwrap.ts` 的 `bwrapArgv(policy, argv, tempDir)`：

```ts
export function bwrapArgv(
  policy: { mode: "read-only" | "workspace-write"; workspaceRoot: string },
  argv: string[],
  tempDir: string,
): string[] {
  const prefix = [
    "bwrap",
    "--die-with-parent",
    "--unshare-pid",
    "--proc", "/proc",
    "--dev", "/dev",
    "--ro-bind", "/", "/",
  ];
  if (policy.mode === "workspace-write") {
    prefix.push("--bind", policy.workspaceRoot, policy.workspaceRoot, "--bind", tempDir, tempDir);
  } else {
    prefix.push("--bind", "/dev/null", "/dev/null");
  }
  return [...prefix, "--", ...argv];
}
```

注意：不得加入 `--unshare-net`。

`provider.ts`：`createSandboxProvider(deps?)` 默认按 `process.platform` 选 linux/darwin/win32 探测函数。探测失败抛 `SandboxUnavailableError`。成功则 `build` 出 `ConfinedArgv`。`dispose` 调 `tempDirs.dispose`。

默认探测：`linux` 用 `execFile("bwrap", ["--version"])`；失败即不可用。Landlock：`probeLandlockAbi()` 仅记录，缺 helper 时仍用 bwrap、`enforcement: "full"`（规格：缺 Landlock 时 bwrap 单独仍成立）。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd extensions; npx vitest run _shared/sandbox/linux/bwrap.test.ts _shared/sandbox/provider.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/_shared/sandbox/errors.ts extensions/_shared/sandbox/linux extensions/_shared/sandbox/provider.ts extensions/_shared/sandbox/provider.test.ts
git commit -m "feat(sandbox): confine 失败关闭与 Linux bwrap argv"
```

---

### 任务 5：macOS Seatbelt

**文件：**
- 创建：`extensions/_shared/sandbox/darwin/seatbelt.ts`
- 测试：`extensions/_shared/sandbox/darwin/seatbelt.test.ts`

- [ ] **步骤 1：写失败测试**

断言 profile 含 `(deny default)`、工作区写路径、临时目录写路径；`read-only` 不含工作区 `(allow file-write*)`。argv 为 `["sandbox-exec", "-p", profile, ...callerArgv]`。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd extensions; npx vitest run _shared/sandbox/darwin/seatbelt.test.ts
```

预期：FAIL。

- [ ] **步骤 3：实现**

生成 Seatbelt 文本，固定为这些字面量（测试钉住子串）：

```
(version 1)
(deny default)
(allow file-read*)
(allow process-exec)
(allow process-fork)
(allow sysctl-read)
(allow signal (target same-sandbox))
(allow mach-lookup (global-name "com.apple.system.logger"))
```

`workspace-write` 追加 `(allow file-write* (subpath "ROOT"))` 与临时目录的同样一条。路径用绝对 POSIX 形式。探测：`/usr/bin/sandbox-exec` 存在。

探测：`/usr/bin/sandbox-exec` 存在。`createSandboxProvider` 在 `darwin` 上走这条。`enforcement: "full"`。`denialSignatures`: `["operation not permitted", "sandbox"]`。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd extensions; npx vitest run _shared/sandbox/darwin/seatbelt.test.ts _shared/sandbox/provider.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/_shared/sandbox/darwin
git commit -m "feat(sandbox): macOS Seatbelt profile 与 confine"
```

---

### 任务 6：Windows SID 与 helper argv

**文件：**
- 创建：`extensions/_shared/sandbox/windows/sids.ts`
- 创建：`extensions/_shared/sandbox/windows/runner.ts`
- 创建：`extensions/_shared/sandbox/windows/helper.c`
- 测试：`sids.test.ts`、`runner.test.ts`

- [ ] **步骤 1：写失败测试**

`sids.test.ts`：同一规范化工作区路径（大小写、尾部分隔符折叠）得到同一 `S-1-4-…` SID；工作区 SID 与临时 SID 必须域分离（例如 `workspace` / `temp` 不同盐）。路径相等或互相包含临时根时，`assertWritableRootsDisjoint` 抛错。

`runner.test.ts`：`windowsHelperArgv` 以 helper 路径开头，含 `--workspace-sid`、`--temp-sid`、`--`，其后为调用方 argv；`enforcement` 为 `partial`；`denialExitCodes` 含 `162`。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd extensions; npx vitest run _shared/sandbox/windows
```

预期：FAIL。

- [ ] **步骤 3：实现 SID 与 argv；helper.c 按下面契约写**

SID：`sha256(\`${kind}:${resolvedPath.toLowerCase()}\`)` 取前 8 个 uint32 拼 `S-1-4-a-b-c-d`（与 Harness 一样用 S-1-4 能力 SID 空间）。

`helper.c` 契约（必须实现，不能只写注释）：

1. 解析 `--workspace-sid`、`--temp-sid`（workspace-write 两者都有；read-only 只有登录 SID + Everyone，无能力 SID）。
2. `OpenProcessToken` + `CreateRestrictedToken(..., WRITE_RESTRICTED | DISABLE_MAX_PRIVILEGE | LUA_TOKEN, ...)`。
3. `CreateProcessAsUserW` 启动 `--` 之后的命令，转发 stdio。
4. 子进程因写拒绝结束时，helper 以 `162` 退出；其它退出码透传。
5. 失败（API 调不通）以 `163` 退出，stderr 写 `pi-sandbox-win: CreateRestrictedToken failed`——这条进 `runnerFailureRules`。

`provider` 在 `win32`：helper 文件不存在 → `SANDBOX_UNAVAILABLE`。存在则 `enforcement: "partial"`。

win32 CI 用 `cl` 或 `gcc` 编 helper，输出到 `extensions/_shared/sandbox/windows/bin/pi-sandbox-win.exe`。该路径加入 `.gitignore`，源码入仓。任务 12 的真隔离测试在编不出 helper 时 skip，不得改成裸跑。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd extensions; npx vitest run _shared/sandbox/windows
```

预期：PASS（不依赖真编 helper）。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/_shared/sandbox/windows
git commit -m "feat(sandbox): Windows 能力 SID 与 helper argv"
```

---

### 任务 7：临时目录与 `BashOperations`

**文件：**
- 创建：`extensions/_shared/sandbox/tempDirs.ts`
- 创建：`extensions/_shared/sandbox/shellPath.ts`
- 创建：`extensions/_shared/sandbox/operations.ts`
- 测试：对应 `*.test.ts`

- [ ] **步骤 1：写失败测试**

`tempDirs.test.ts`：同一 `sessionId` 复用目录；`dispose` 后目录不存在；工作区等于临时根则拒绝。

`operations.test.ts`（注入 `confine` 与 `spawn`）：

1. `mode === danger-full-access` 时 spawn 的 argv 等于 `[shell, "-c", command]`，不调用 confine。
2. 其它模式 spawn 的是 confine 返回的 argv。
3. confine 抛 `SandboxUnavailableError` 时 spawn 不被调用，返回的 `exitCode` 为 `null`，`onData` 收到 UNAVAILABLE 英文说明（禁止教绕过）。
4. 退出 162 时 `onData` 含 `[sandbox: file access denied under ${mode} mode]`，并调用 `rememberPendingDenial`。
5. abort signal 触发后调用终止函数（POSIX 测 `kill(-pid)` 被调用；Windows 测 `taskkill` 参数含 `/t`）。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd extensions; npx vitest run _shared/sandbox/tempDirs.test.ts _shared/sandbox/operations.test.ts
```

预期：FAIL。

- [ ] **步骤 3：实现**

`shellPath.ts`：POSIX 用 `bash`；win32 复刻 `cli/scripts/patch-pi-shell.mjs` 的 `where bash.exe` + Git 安装根推导。测时注入 `which`。

`operations.ts` 的 `createSandboxedBashOperations({ getPolicy, confine, spawnImpl })`。`getPolicy()` 之后若 `env.PI_SANDBOX_MODE_ONCE` 是 `workspace-write` 或 `danger-full-access` 且 `isStrictWidening(policy.mode, once)`，用该 mode 覆盖，并 `delete env.PI_SANDBOX_MODE_ONCE`（只一次，不写会话档）。

```ts
async exec(command, cwd, { onData, signal, timeout, env }) {
  const policy = getPolicy();
  const shell = await resolveShellPath();
  const base = [shell, "-c", command];
  if (!isConfined(policy.mode)) {
    return run(base, cwd, { onData, signal, timeout, env });
  }
  let confined;
  try {
    confined = await confine(base, { ...policy, mode: policy.mode });
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      onData(Buffer.from(
        `[sandbox: SANDBOX_UNAVAILABLE] ${error.message} The command was not executed. Enable the OS runner or switch approval to 完全权限.\n`,
      ));
      return { exitCode: null };
    }
    throw error;
  }
  const result = await run(confined.argv, cwd, { onData, signal, timeout, env });
  const kind = attributeRun(result, confined);
  if (kind.kind === "denial") {
    rememberPendingDenial(cwd, command, policy.mode);
    onData(Buffer.from(
      `[sandbox: file access denied under ${policy.mode} mode]. Call bash_escalate with the exact same command, justification (>=20 chars), and a wider targetMode.\n`,
    ));
  }
  if (kind.kind === "runner-failure") {
    onData(Buffer.from(`[sandbox: runner failed] The command never started.\n`));
  }
  return { exitCode: result.exitCode };
}
```

`run`：`spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })`。Windows 终止：`spawn("taskkill", ["/pid", String(pid), "/t", "/f"])`。POSIX：`process.kill(-pid, "SIGTERM")`。超时与 `signal` 都走终止。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd extensions; npx vitest run _shared/sandbox/tempDirs.test.ts _shared/sandbox/operations.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/_shared/sandbox/tempDirs.ts extensions/_shared/sandbox/tempDirs.test.ts extensions/_shared/sandbox/shellPath.ts extensions/_shared/sandbox/shellPath.test.ts extensions/_shared/sandbox/operations.ts extensions/_shared/sandbox/operations.test.ts
git commit -m "feat(sandbox): 自持 spawn 的 BashOperations"
```

---

### 任务 8：sandbox 扩展（bash / user_bash / bash_escalate）

**文件：**
- 创建：`extensions/sandbox/index.ts`
- 测试：`extensions/sandbox/index.test.ts`
- 修改：`extensions/_shared/sandbox/index.ts` 导出
- 修改：`extensions/index.ts`、`cli/src/extension-profile.ts`

- [ ] **步骤 1：写失败测试**

`sandbox/index.test.ts` 用假 `pi`：

1. `registerTool` 被调用的名字含 `bash` 与 `bash_escalate`。
2. 订阅了 `user_bash`，其返回值带 `operations`。
3. `bash_escalate`：无 pending → 文本拒绝，不调 `ui.select`。
4. 有 pending、command 不同 → 拒绝。
5. justification 短于 20 → 拒绝。
6. 档位 `workspace` → 拒绝且不弹窗。
7. 档位 `auto` + 合法加宽 → 调用 `ui.select`；选允许则再 exec 一次（mock operations）。
8. `ui.select` 返回 `undefined` 或抛错 → 失败，pending 作废，不得再 spawn。
9. `session_shutdown` 调用 `dispose`。

同时先改 `agent-mode` 的测试会在任务 10 做；本任务不要改 ASK_TOOLS。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd extensions; npx vitest run sandbox/index.test.ts
```

预期：FAIL。

- [ ] **步骤 3：实现扩展并挂进清单**

`extensions/sandbox/index.ts`：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getApprovalPolicy } from "../_shared/approval.js";
import { getAgentMode } from "../agent-mode/modes.js";
import { createSandboxedBashOperations } from "../_shared/sandbox/operations.js";
import { resolvePreset, isConfined } from "../_shared/sandbox/resolvePreset.js";
import { createSandboxProvider } from "../_shared/sandbox/provider.js";
import { consumePendingDenial } from "../_shared/sandbox/pendingDenial.js";
import { isStrictWidening, justifyOk } from "../_shared/sandbox/escalate.js";
import type { FileSandboxMode } from "../_shared/sandbox/types.js";

export default function (pi: ExtensionAPI) {
  const provider = createSandboxProvider();
  const getPolicy = (cwd: string) =>
    resolvePreset({
      approval: getApprovalPolicy(cwd),
      agentMode: getAgentMode(cwd),
      workspaceRoot: cwd,
      sessionId: pi.sessionManager?.getSessionId?.(),
    });

  const operations = createSandboxedBashOperations({
    getPolicy: () => getPolicy(pi.cwd ?? process.cwd()),
    confine: (argv, policy) => provider.confine(argv, policy),
  });

  let cwd = process.cwd();
  pi.on("session_start", (_e, ctx) => { cwd = ctx.cwd; });
  pi.registerTool(createBashTool(cwd, { operations }));

  pi.on("user_bash", () => ({ operations }));

  pi.registerTool({
    name: "bash_escalate",
    label: "Escalate sandbox",
    description:
      "Retry the exact denied bash command under a wider file sandbox for this call only. Requires justification.",
    parameters: Type.Object({
      command: Type.String(),
      justification: Type.String(),
      targetMode: Type.Unsafe<FileSandboxMode>({ type: "string" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const policy = getPolicy(cwd);
      const pending = consumePendingDenial(cwd, params.command);
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
      if (!pending) return fail("bash_escalate: no pending denial for that command.");
      if (!justifyOk(params.justification)) return fail("bash_escalate: justification must be at least 20 characters.");
      if (!isStrictWidening(pending.mode, params.targetMode)) return fail("bash_escalate: targetMode is not a strict widening.");
      if (getApprovalPolicy(cwd) === "workspace") return fail("bash_escalate: workspace-edit preset rejects escalation.");
      if (!ctx.hasUI) return fail("bash_escalate: UI unavailable; denied.");
      let choice: string | undefined;
      try {
        choice = await ctx.ui.select(
          `Sandbox escalation\n\n${params.command}\n\n${params.justification}\n\n→ ${params.targetMode}`,
          ["允许本次", "拒绝"],
        );
      } catch {
        return fail("bash_escalate: cancelled.");
      }
      if (choice !== "允许本次") return fail("bash_escalate: rejected.");
      if (params.targetMode === "danger-full-access") {
        return operations.exec(params.command, cwd, { onData: () => {}, env: process.env });
      }
      // 一次性更宽 confine：用显式 mode 覆盖 getPolicy，只这一次。
      return operations.exec(params.command, cwd, {
        onData: () => {},
        env: { ...process.env, PI_SANDBOX_MODE_ONCE: params.targetMode },
      });
    },
  });

  pi.on("session_shutdown", async () => {
    const id = pi.sessionManager?.getSessionId?.();
    if (id) await provider.dispose?.(id);
  });
}
```

`operations.exec` 必须读 `PI_SANDBOX_MODE_ONCE`：若合法且比当前更宽，用完即删（只一次）。不要把它做成会话默认档。

`createBashTool` 若类型不兼容 `registerTool`，改用 `createBashToolDefinition`。以能通过 tsc / 单测为准。

`extensions/index.ts`：`import sandbox from "./sandbox/index.js"`，插入 `allExtensions` 与 `namedExtensions`，紧挨 `approval` 之后。

`cli/src/extension-profile.ts`：`CORE_ALWAYS_ON` 加 `"sandbox"`。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd extensions; npx vitest run sandbox/index.test.ts
cd cli; node --test src/extension-profile.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/sandbox extensions/_shared/sandbox/index.ts extensions/index.ts cli/src/extension-profile.ts
git commit -m "feat(sandbox): 扩展注册 bash、user_bash 与 bash_escalate"
```

---

### 任务 9：四处同步五档（主进程 + UI + 内置规则）

**文件：**
- 修改：`electron-agent/src/stores/approvalStore.ts` 及测试
- 修改：`electron-agent/src/features/chat/input/actions/ApprovalAction.tsx`
- 修改：`electron-agent/electron/app/piRuntimeService.ts` 及测试
- 修改：`electron-agent/electron/app/toolPermission/types.ts`
- 修改：`electron-agent/electron/app/toolPermission/builtinRules.ts` 及测试
- 修改：`extensions/_shared/desktop-control.ts`
- 修改：`extensions/safety/index.ts`

- [ ] **步骤 1：写失败测试**

`approvalStore.test.ts`：`isApprovalPolicy('readonly')` 与 `'workspace'` 为 true。

`piRuntimeService.test.ts` 追加：

```ts
await expect(service.send('C:/work', 'agent_set_approval', { level: 'readonly' }))
  .resolves.toEqual({ ok: true, level: 'readonly' });
await expect(service.send('C:/work', 'agent_set_approval', { level: 'workspace' }))
  .resolves.toEqual({ ok: true, level: 'workspace' });
```

`builtinRules.test.ts` 追加：

```ts
  it('readonly asks for network like ask', () => {
    expect(matchBuiltinRules(facts('readonly', { network: true }))?.id).toBe('builtin.network');
  });
  it('workspace denies protected paths but does not ask for dangerous commands', () => {
    expect(matchBuiltinRules(facts('workspace', { protectedPath: true, write: true }))?.effect).toBe('deny');
    expect(matchBuiltinRules(facts('workspace', { dangerousCommand: true }))).toBeUndefined();
  });
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd electron-agent; npx vitest run src/stores/approvalStore.test.ts electron/app/piRuntimeService.test.ts electron/app/toolPermission/builtinRules.test.ts
```

预期：FAIL（readonly 被 INVALID 或类型拒）。

- [ ] **步骤 3：实现**

`approvalStore.ts`：`ApprovalPolicy` 与 `_shared/approval` 五档一致；`APPROVAL_POLICIES` 顺序：`readonly`, `ask`, `auto`, `workspace`, `full`。HINTS：

```ts
readonly: '只读。写由 OS 沙箱拒绝；联网与升权会询问',
ask: '工作区内可写。越界 / 联网 / 危险命令 / 升权询问',
auto: '工作区内可写。仅危险命令询问；升权仍询问',
workspace: '工作区内可写且不问。越界由 OS 拒绝，升权直接拒绝',
full: '关闭 OS 沙箱，不询问（子代理能力限制仍生效）',
```

`ApprovalAction.tsx`：图标 `Eye / Hand / Shield / PencilLine / ShieldAlert`。`useModeStore` 在 `ask` 时 `disabled` 且 `value` 仍显示当前档（实际强制只读由 worker 的 resolvePreset 做）。宽度 `maxWidth` 提到 148。

`writeApprovalPolicy`：用 `parseApproval` / `isApprovalPolicy`，返回类型改为共享的 `ApprovalPolicy`。

`ApprovalPreset` 两侧改为五档联合。

`BUILTIN_RULES`：

```ts
export const BUILTIN_RULES: Record<ApprovalPreset, readonly BuiltinRule[]> = {
  full: [],
  workspace: [GUARDS[0]], // protected-path only
  auto: GUARDS,
  ask: [...GUARDS, ...ASK_EXTRA],
  readonly: [...GUARDS, ...ASK_EXTRA],
};
```

未知 preset 仍收敛到 `ask`。

`safety/index.ts` 的 `collectFacts` preset 参数改为 `ApprovalPreset`，调用处：

```ts
const preset = getApprovalPolicy();
```

不要再把 `workspace` 塌成 `auto`。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd electron-agent; npx vitest run src/stores/approvalStore.test.ts electron/app/piRuntimeService.test.ts electron/app/toolPermission/builtinRules.test.ts
cd extensions; npx vitest run safety/index.test.ts
```

预期：PASS。若 safety 单测因 preset 类型编译失败，把 mock 的返回值扩成五档即可，不要改安全语义。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/src/stores/approvalStore.ts electron-agent/src/stores/approvalStore.test.ts electron-agent/src/features/chat/input/actions/ApprovalAction.tsx electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/app/piRuntimeService.test.ts electron-agent/electron/app/toolPermission/types.ts electron-agent/electron/app/toolPermission/builtinRules.ts electron-agent/electron/app/toolPermission/builtinRules.test.ts extensions/_shared/desktop-control.ts extensions/safety/index.ts
git commit -m "feat(approval): 五档同步到 UI、IPC 与内置规则"
```

---

### 任务 10：Ask 放开 bash（裁决 B）

**文件：**
- 修改：`extensions/agent-mode/modes.ts`
- 修改：`extensions/agent-mode/modes.test.ts`
- 修改：`extensions/agent-mode/index.ts` 文件头注释

- [ ] **步骤 1：先改测试**

`toolWhitelist / activeToolsFor` 里 Ask 对 `bash` 的断言改为 `toContain("bash")`。

`gateToolCall` 的「ask blocks … exec」列表里删掉 `"bash"`。另加：

```ts
  it("ask allows bash and leaves writes blocked", () => {
    expect(gateToolCall("ask", "bash", { command: "ls" })).toBeUndefined();
    expect(gateToolCall("ask", "write", { path: "a" })?.block).toBe(true);
  });
```

Ask 拦截文案去掉「不能……执行命令行」，改为「不能修改文件或调用 MCP；命令行由只读 OS 沙箱执行」。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd extensions; npx vitest run agent-mode/modes.test.ts
```

预期：FAIL，Ask 仍不含 bash。

- [ ] **步骤 3：实现**

`ASK_TOOLS` 数组在 `"ls"` 后插入 `"bash"`。`PLAN_TOOLS` 仍是 `[...ASK_TOOLS, "bash"]`——去重：改成 `PLAN_TOOLS = ASK_TOOLS`（Ask 已含 bash），避免重复项。`isSafeCommand` 对 plan 的拦截保持不变。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd extensions; npx vitest run agent-mode/modes.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/agent-mode/modes.ts extensions/agent-mode/modes.test.ts extensions/agent-mode/index.ts
git commit -m "feat(mode): Ask 放开 bash，写由 read-only 沙箱拦"
```

---

### 任务 11：`SandboxManager` 隔离与导出收口

**文件：**
- 修改：`electron-agent/electron/app/sandbox/sandboxManager.ts`（只加注释，不改 `prepare` 语义）
- 修改：`electron-agent/electron/app/sandbox/sandboxManager.test.ts`（钉住「degraded 仍返回、不抛」）
- 创建：`extensions/_shared/sandbox/index.ts`（若任务 8 未写全）

- [ ] **步骤 1：加测试**

现有 `marks degradation without changing the requested profile` 保留。再加：

```ts
  it('prepare never throws SANDBOX_UNAVAILABLE', () => {
    const manager = new SandboxManager({});
    expect(() => manager.prepare({ profile: 'workspace' })).not.toThrow();
  });
```

- [ ] **步骤 2：跑测试确认通过（红灯只应来自你若误改了 throw）**

```powershell
cd electron-agent; npx vitest run electron/app/sandbox/sandboxManager.test.ts
```

- [ ] **步骤 3：在 `SandboxManager` 类注释写明**

bash / user_bash 由 `extensions/sandbox` confine；本类只给 PTY 与子代理做路径 / env 过滤。`degraded` 不是降级裸跑开关。

- [ ] **步骤 4：再跑测试**

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/electron/app/sandbox/sandboxManager.ts electron-agent/electron/app/sandbox/sandboxManager.test.ts extensions/_shared/sandbox/index.ts
git commit -m "docs(sandbox): SandboxManager 与 bash confine 分家"
```

---

### 任务 12：三平台真隔离（gating）

**文件：**
- 创建：`extensions/_shared/sandbox/isolation.live.test.ts`

- [ ] **步骤 1：写 gating 测试**

```ts
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxProvider } from "./provider.js";
import { spawn } from "node:child_process";

const live = process.env.PI_SANDBOX_LIVE === "1";

describe.skipIf(!live)("live OS isolation", () => {
  it("blocks writes outside the workspace and allows inside", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-"));
    const inside = join(root, "ok.txt");
    const outsideDir = await mkdtemp(join(tmpdir(), "sbx-out-"));
    const outside = join(outsideDir, "no.txt");
    const provider = createSandboxProvider();
    const confined = await provider.confine(
      [process.platform === "win32" ? "bash.exe" : "bash", "-c", `echo in > "${inside}"; echo out > "${outside}"`],
      { mode: "workspace-write", network: "enabled", workspaceRoot: root, sessionId: "live" },
    );
    expect(confined.argv[0]).not.toBe("bash");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(confined.argv[0], confined.argv.slice(1), { stdio: "pipe" });
      child.on("exit", () => resolve());
      child.on("error", reject);
    });
    await expect(readFile(inside, "utf8")).resolves.toMatch(/in/);
    await expect(readFile(outside, "utf8")).rejects.toThrow();
    expect(confined.enforcement).toBe(process.platform === "win32" ? "partial" : "full");
  });
});
```

无 `PI_SANDBOX_LIVE=1` 时整组 skip，CI 默认绿。各平台 CI 作业设置该变量，并保证：win32 已编 helper、linux 有 bwrap、darwin 有 sandbox-exec。探测失败必须抛 `SANDBOX_UNAVAILABLE`，测试里再加一条 `PI_SANDBOX_LIVE=1` 且故意藏起 bwrap 的 job（linux）断言抛错。

- [ ] **步骤 2：默认跑 skip**

```powershell
cd extensions; npx vitest run _shared/sandbox/isolation.live.test.ts
```

预期：PASS（skipped）。

- [ ] **步骤 3：在本机若具备 runner，手动 `PI_SANDBOX_LIVE=1` 跑一次并记录结果到 commit message**

- [ ] **步骤 4：Commit**

```powershell
git add extensions/_shared/sandbox/isolation.live.test.ts
git commit -m "test(sandbox): 三平台真隔离 live 套件"
```

---

## 规格覆盖自检

| 规格条目 | 任务 |
| --- | --- |
| 五档 + Ask 锁 read-only | 1、2、9、10 |
| `network` 恒 enabled | 2 |
| `confine` 异步、失败关闭、禁止透传 | 4 |
| Linux bwrap、无 unshare-net | 4 |
| macOS Seatbelt | 5 |
| Windows ACL partial + helper | 6、12 |
| `createBashTool` + `user_bash` | 7、8 |
| 禁止 spawnHook / localBash 降级 | 7、8 |
| `bash_escalate` + pending + 工作区拒升权 | 3、8 |
| UI / IPC / builtinRules 四处同步 | 9 |
| Ask 放开 bash | 10 |
| SandboxManager 不波及 PTY | 11 |
| 真隔离 gating | 12 |
| 不实现规格 2–5 | 未列任务 |

无 TODO / 「适当处理」占位。类型名与规格 §4.1 一致：`FileSandboxMode`、`SandboxUnavailableError.code === "SANDBOX_UNAVAILABLE"`、`bash_escalate`。
