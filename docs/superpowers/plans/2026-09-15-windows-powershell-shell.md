# Windows bash 改走 PowerShell 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** Windows 上 `bash` 工具默认启动 `pwsh.exe` / PowerShell 5.1（带 UTF-8 输出前缀），不再用 Git Bash 或 WSL `bash.exe`；模型按 PowerShell 写命令。

**架构：** `resolveShellPath` 只解析 PowerShell；`operations.exec` 用 `shellArgv` 拼 `-NoProfile -NonInteractive -Command` 并注入 `[Console]::OutputEncoding` 前缀；沙箱仍 `confine` 该 argv。工具 `description` / `promptSnippet` / `promptGuidelines` 与 fable 提示词改成 PowerShell 语法。`isSafeCommand` 补 cmdlet 与写别名。

**技术栈：** TypeScript、vitest、现有 `pi-sandbox-win.exe`、Windows PowerShell 5.1 / pwsh 7。

**上游规格：** `docs/superpowers/specs/2026-09-15-windows-powershell-shell-design.md`（含 §10 评审补记）。**不要按评审前的原稿实现。**

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- **按编号顺序执行，不要跳序。**
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。
- **不要改** `helper.c`、`patch-pi-shell.mjs`、PTY、子代理壳、工具名 `bash`、POSIX→PS 翻译、自动追加 `exit $LASTEXITCODE`。
- 本机 `process.platform === "win32"`。`operations.test.ts` 的 `makeOps` **必须默认 `platform: "linux"`**，否则现有 `-c` 断言会在 Windows 开发机上失败。新增 Windows 用例显式传 `platform: "win32"`。
- 调试埋点（`debugLog`、ingest `fetch`、`source` 变量、`operations.ts` 对 `isLegacyWslBashPath` 的导入）在任务 2 拆除。`isLegacyWslBashPath` 函数留在 `shellPath.ts`。
- `pendingDenial` / `bash_escalate` 比对的是原始 `command`，不要把 UTF-8 前缀写进工具入参。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run <本任务列出的测试>
```

**提交：**

```powershell
git add <本任务文件>
git commit -m @"
feat(sandbox): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `extensions/sandbox/windowsBashPrompt.ts` | 纯函数：win32 覆盖 bash 工具的 `description` / `promptSnippet` / `promptGuidelines` |
| `extensions/sandbox/windowsBashPrompt.test.ts` | 覆盖与否按 platform |
| `extensions/agent-mode/utils.test.ts` | `isSafeCommand` 的 POSIX 回归 + PowerShell cmdlet / 别名 |

修改：

| 文件 | 职责 |
| --- | --- |
| `extensions/_shared/sandbox/shellPath.ts` | win32 解析 pwsh → 5.1；删 Git Bash / WSL 回退 |
| `extensions/_shared/sandbox/shellPath.test.ts` | 重写 win32 用例 |
| `extensions/_shared/sandbox/operations.ts` | `shellArgv` + UTF-8 前缀；拆调试埋点 |
| `extensions/_shared/sandbox/operations.test.ts` | `makeOps` 默认 linux；新增 win32 argv / 前缀 |
| `extensions/sandbox/index.ts` | `registerTool(annotateWindowsBashTool(...))` |
| `extensions/sandbox/index.test.ts` | 注册后的 bash 工具带 PowerShell snippet（stub platform） |
| `extensions/fable-behavior/prompts/tier2/terminal-harness.md` | 分平台链式 |
| `extensions/fable-behavior/prompts/tier2/tool-discipline.md` | 分平台链式 |
| `extensions/agent-mode/utils.ts` | SAFE / DESTRUCTIVE 补 PowerShell |
| `docs/superpowers/specs/2026-09-12-os-sandbox-design.md` | §4.5 指针 |

---

### 任务 1：`resolveShellPath` 只解析 PowerShell

**文件：**
- 修改：`extensions/_shared/sandbox/shellPath.ts`
- 测试：`extensions/_shared/sandbox/shellPath.test.ts`

- [ ] **步骤 1：重写失败测试**

把 `shellPath.test.ts` 的 win32 三条（注入 Git Bash、git.exe 推导、WSL 回退）整段换成：

```ts
import { describe, expect, it } from "vitest";
import { isLegacyWslBashPath, resolveShellPath } from "./shellPath.js";

const PS51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const STORE = "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe";

describe("resolveShellPath", () => {
  it("returns bash on POSIX", async () => {
    expect(await resolveShellPath({ platform: "linux" })).toBe("bash");
    expect(await resolveShellPath({ platform: "darwin" })).toBe("bash");
  });

  it("prefers injected pwsh.exe on win32", async () => {
    const which = (name: string) => (name === "pwsh.exe" ? PWSH : undefined);
    const exists = (path: string) => path === PWSH;
    const statSize = (path: string) => (path === PWSH ? 200000 : 0);
    expect(await resolveShellPath({ platform: "win32", which, exists, statSize })).toBe(PWSH);
  });

  it("falls back to Windows PowerShell 5.1 when pwsh is absent", async () => {
    const which = () => undefined;
    const exists = (path: string) => path === PS51;
    const statSize = (path: string) => (path === PS51 ? 400000 : 0);
    expect(await resolveShellPath({ platform: "win32", which, exists, statSize })).toBe(PS51);
  });

  it("ignores System32 bash.exe even when which returns it", async () => {
    const wsl = "C:\\Windows\\System32\\bash.exe";
    const which = (name: string) => (name === "bash.exe" ? wsl : undefined);
    const exists = (path: string) => path === wsl || path === PS51;
    const statSize = () => 1;
    expect(await resolveShellPath({ platform: "win32", which, exists, statSize })).toBe(PS51);
  });

  it("skips WindowsApps pwsh stubs and uses 5.1", async () => {
    const which = (name: string) => (name === "pwsh.exe" ? STORE : undefined);
    const exists = (path: string) => path === STORE || path === PS51;
    const statSize = (path: string) => (path === STORE ? 0 : 400000);
    expect(await resolveShellPath({ platform: "win32", which, exists, statSize })).toBe(PS51);
  });

  it("returns the 5.1 path string when nothing exists", async () => {
    const which = () => undefined;
    const exists = () => false;
    const statSize = () => 0;
    const resolved = await resolveShellPath({ platform: "win32", which, exists, statSize });
    expect(resolved.replace(/\//g, "\\").toLowerCase()).toMatch(
      /\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/,
    );
  });
});

describe("isLegacyWslBashPath", () => {
  it("detects the Microsoft Bash launcher", () => {
    expect(isLegacyWslBashPath("C:\\Windows\\System32\\bash.exe")).toBe(true);
    expect(isLegacyWslBashPath("C:/Windows/SysWOW64/bash.exe")).toBe(true);
    expect(isLegacyWslBashPath("D:\\Kits\\Git\\bin\\bash.exe")).toBe(false);
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run _shared/sandbox/shellPath.test.ts
```

预期：FAIL（`ResolveShellPathDeps` 无 `statSize`，仍返回 Git Bash / WSL）。

- [ ] **步骤 3：实现最少代码**

`ResolveShellPathDeps` 增加 `statSize?: (path: string) => number`。

删除 `DEFAULT_BASH_PATHS`。保留 `spawnWhere` / `spawnWhereAll` / `getWindowsSearchPath` / `isLegacyWslBashPath`。

`resolveShellPath` 的 win32 分支改成下面这份（POSIX 仍 `return "bash"`）。**不要**再搜 `bash.exe`，**不要**从 `git.exe` 推 Git Bash，**不要** WSL 回退，**不要** `source` 变量，**不要** ingest `fetch`。

```ts
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export interface ResolveShellPathDeps {
  platform?: NodeJS.Platform;
  which?: (name: string) => string | undefined | null;
  exists?: (path: string) => boolean;
  statSize?: (path: string) => number;
}

function windowsPowershell51(): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function isWindowsAppsAlias(path: string): boolean {
  return path.replace(/\//g, "\\").toLowerCase().includes("\\microsoft\\windowsapps\\");
}

function defaultStatSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function isUsableWin32Exe(
  path: string,
  exists: (p: string) => boolean,
  statSize: (p: string) => number,
): boolean {
  if (isWindowsAppsAlias(path)) return false;
  if (!exists(path)) return false;
  return statSize(path) > 0;
}

export async function resolveShellPath(deps: ResolveShellPathDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return "bash";

  const which = deps.which ?? spawnWhere;
  const exists = deps.exists ?? existsSync;
  const statSize = deps.statSize ?? defaultStatSize;
  const ps51 = windowsPowershell51();

  const pwshHits: string[] = [];
  const fromWhich = which("pwsh.exe");
  if (fromWhich) pwshHits.push(fromWhich);
  if (!deps.which) {
    for (const hit of spawnWhereAll("pwsh.exe")) {
      if (!pwshHits.includes(hit)) pwshHits.push(hit);
    }
  }
  for (const hit of pwshHits) {
    if (isUsableWin32Exe(hit, exists, statSize)) return hit;
  }
  if (isUsableWin32Exe(ps51, exists, statSize)) return ps51;
  return ps51;
}
```

`winWhereExe` / `getWindowsSearchPath` / `spawnWhereAll` / `spawnWhere` / `isLegacyWslBashPath` 原样留在文件里（`getWindowsSearchPath` 仍用 5.1 查注册表 PATH，那是找 `pwsh` 用的，不是默认壳）。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run _shared/sandbox/shellPath.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "extensions/_shared/sandbox/shellPath.ts" "extensions/_shared/sandbox/shellPath.test.ts"
git commit -m @"
feat(sandbox): resolve Windows bash tool to PowerShell, not Git Bash or WSL

"@
```

---

### 任务 2：`shellArgv`、UTF-8 前缀、拆除调试埋点

**文件：**
- 修改：`extensions/_shared/sandbox/operations.ts`
- 测试：`extensions/_shared/sandbox/operations.test.ts`

- [ ] **步骤 1：改 `makeOps` 默认平台并加失败测试**

在 `makeOps` 里：

```ts
    platform: opts.platform ?? "linux",
```

现有 `-c` 用例不必逐条改 platform。然后在 `describe` 末尾、`refuses Windows bash.exe` **之前**插入：

```ts
  it("spawns PowerShell -Command with UTF-8 prefix on win32", async () => {
    const { ops, confine, spawnImpl } = makeOps({
      mode: "danger-full-access",
      platform: "win32",
      resolveShell: async () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    expect(confine).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expect.stringMatching(
          /^\[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8;\necho hi$/,
        ),
      ],
      expect.objectContaining({ cwd: CWD }),
    );
  });

  it("passes UTF-8-prefixed PowerShell argv into confine on win32", async () => {
    const confine = vi.fn(async (argv: string[]) => confined(["runner", "--", ...argv]));
    const { ops, spawnImpl } = makeOps({
      mode: "read-only",
      platform: "win32",
      resolveShell: async () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      confine,
    });
    const { onData } = collectOnData();
    await ops.exec(COMMAND, CWD, { onData, env: {} });
    const handed = confine.mock.calls[0]?.[0] as string[];
    expect(handed[0]).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(handed.slice(1, 4)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(handed[4]).toBe("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\necho hi");
    expect(spawnImpl).toHaveBeenCalledWith(
      "runner",
      ["--", ...handed],
      expect.objectContaining({ cwd: CWD }),
    );
  });
```

`refuses Windows bash.exe` 与 `decodes UTF-16LE` 两条保留。后者加 `platform: "linux"` 或保持默认 linux（`makeOps` 改默认后即可）。

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run _shared/sandbox/operations.test.ts
```

预期：新两条 FAIL（仍 spawn `-c`，无前缀）。

- [ ] **步骤 3：实现最少代码**

在 `operations.ts`：

1. 删除 `debugLog` 整函数及所有调用（exec 入口、stdout/stderr 首包、confined 结果、unconfined 结果）。
2. 删除 `import { isLegacyWslBashPath, resolveShellPath }` 里的 `isLegacyWslBashPath`，改回只 import `resolveShellPath`。
3. 增加并导出前缀与 `shellArgv`：

```ts
export const PS_UTF8_PREFIX = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\n";

export function shellArgv(platform: NodeJS.Platform, shell: string, command: string): string[] {
  if (platform === "win32") {
    return [shell, "-NoProfile", "-NonInteractive", "-Command", PS_UTF8_PREFIX + command];
  }
  return [shell, "-c", command];
}
```

4. `exec` 里把 `const base = [shell, "-c", command];` 换成 `const base = shellArgv(platform, shell, command);`。
5. **不要**把前缀拼进 `rememberPendingDenial` / `consumePendingDenial` 的 command。
6. 保留 `WINDOWS_BASH_UNAVAILABLE` 与 `isWindowsBashExe` 拒绝分支。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run _shared/sandbox/operations.test.ts _shared/sandbox/decodeSpawnChunk.test.ts
```

预期：PASS。

- [ ] **步骤 5：Windows 本机编码验收（规格成功标准 7）**

仅 `process.platform === "win32"` 时跑。在 `operations.test.ts` 末尾加：

```ts
describe.skipIf(process.platform !== "win32")("PowerShell UTF-8 prefix live", () => {
  it("emits UTF-8 中文 on stdout, not GBK", async () => {
    const { spawn } = await import("node:child_process");
    const { resolveShellPath } = await import("./shellPath.js");
    const { PS_UTF8_PREFIX } = await import("./operations.js");
    const shell = await resolveShellPath();
    const script = `${PS_UTF8_PREFIX}Write-Output "中文"`;
    const text: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.on("data", (d: Buffer) => text.push(d));
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    const buf = Buffer.concat(text);
    expect(buf.toString("hex")).toContain("e4b8ade69687");
    expect(buf.toString("hex")).not.toContain("d6d0cec4");
  });
});
```

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run _shared/sandbox/operations.test.ts
```

预期：PASS（含 live 条）。若 hex 仍是 GBK，停下来，不要靠 `decodeSpawnChunk` 假装修（它对 GBK 无效）。

- [ ] **步骤 6：Commit**

```powershell
git add "extensions/_shared/sandbox/operations.ts" "extensions/_shared/sandbox/operations.test.ts"
git commit -m @"
feat(sandbox): run Windows bash tool via PowerShell -Command with UTF-8 prefix

"@
```

---

### 任务 3：覆盖 bash 工具的 description / snippet / guidelines

**文件：**
- 创建：`extensions/sandbox/windowsBashPrompt.ts`
- 测试：`extensions/sandbox/windowsBashPrompt.test.ts`
- 修改：`extensions/sandbox/index.ts`
- 测试：`extensions/sandbox/index.test.ts`

- [ ] **步骤 1：编写失败测试**

`windowsBashPrompt.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { annotateWindowsBashTool } from "./windowsBashPrompt.js";

const base = {
  name: "bash",
  description: "Execute a bash command.",
  promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
  promptGuidelines: ["Do not leak PI_* environment variables."],
};

describe("annotateWindowsBashTool", () => {
  it("leaves POSIX definitions unchanged", () => {
    expect(annotateWindowsBashTool(base, "linux")).toEqual(base);
  });

  it("rewrites snippet and appends description plus guidelines on win32", () => {
    const next = annotateWindowsBashTool(base, "win32");
    expect(next.promptSnippet).toBe(
      "Execute PowerShell commands (Get-ChildItem, Select-String, Get-Content, etc.)",
    );
    expect(next.description).toContain("PowerShell");
    expect(next.description).toContain("exit $LASTEXITCODE");
    expect(next.description).not.toMatch(/ls -la/);
    expect(next.description).toContain("Get-ChildItem");
    expect(next.promptGuidelines).toHaveLength(2);
    expect(next.promptGuidelines[0]).toBe(base.promptGuidelines[0]);
    expect(next.promptGuidelines[1]).toContain("PowerShell");
    expect(next.promptGuidelines[1]).toContain("exit $LASTEXITCODE");
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run sandbox/windowsBashPrompt.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 `annotateWindowsBashTool`**

`windowsBashPrompt.ts`：

```ts
const WIN_SNIPPET =
  "Execute PowerShell commands (Get-ChildItem, Select-String, Get-Content, etc.)";

const WIN_GUIDELINE =
  "On Windows this tool runs PowerShell (pwsh or 5.1), not bash. Write PowerShell: Get-ChildItem, Select-String, Get-Content; chain with `;`. Do not use POSIX ls -la, grep, find, or `&&`. Native programs (tsc, git, vitest) must end with `; exit $LASTEXITCODE` or the process exit code will be 1.";

const WIN_DESCRIPTION_SUFFIX = `

Windows: this tool runs PowerShell (pwsh if present, otherwise Windows PowerShell 5.1). The command argument must be PowerShell, not POSIX. Use Get-ChildItem, Select-String, and Get-Content. Chain with semicolons. Do not use ls -la, grep, find, or &&. When running native programs (build, test, git), end with ; exit $LASTEXITCODE or the real exit code is lost (PowerShell reports 1).`;

export function annotateWindowsBashTool<
  T extends {
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: readonly string[];
  },
>(def: T, platform: NodeJS.Platform = process.platform): T {
  if (platform !== "win32") return def;
  return {
    ...def,
    description: `${def.description ?? ""}${WIN_DESCRIPTION_SUFFIX}`,
    promptSnippet: WIN_SNIPPET,
    promptGuidelines: [...(def.promptGuidelines ?? []), WIN_GUIDELINE],
  };
}
```

- [ ] **步骤 4：接到 `index.ts` 并加注册断言**

`index.ts` 在 `createBashToolDefinition` 之后：

```ts
import { annotateWindowsBashTool } from "./windowsBashPrompt.js";
// ...
pi.registerTool(annotateWindowsBashTool(createBashToolDefinition(cwd, { operations })));
```

扩展 `index.test.ts` 的 mock，让 `createBashToolDefinition` 带回 prompt 字段，并加一条：

```ts
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createBashToolDefinition: (_cwd: string, opts: object) => ({
    name: "bash",
    description: "Execute a bash command.",
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    promptGuidelines: ["Do not leak PI_* environment variables."],
    ...opts,
  }),
}));
```

```ts
  it("annotates the bash tool for PowerShell on win32", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const { tools } = load();
      const bash = tools.find((tool) => tool.name === "bash") as {
        promptSnippet?: string;
        description?: string;
        promptGuidelines?: string[];
      };
      expect(bash.promptSnippet).toContain("PowerShell");
      expect(bash.promptSnippet).not.toContain("ls, grep, find");
      expect(bash.description).toContain("exit $LASTEXITCODE");
      expect(bash.promptGuidelines?.some((g) => g.includes("PowerShell"))).toBe(true);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });
```

`Tool` 类型需允许这些可选字段（结构类型，直接断言即可）。

- [ ] **步骤 5：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run sandbox/windowsBashPrompt.test.ts sandbox/index.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```powershell
git add "extensions/sandbox/windowsBashPrompt.ts" "extensions/sandbox/windowsBashPrompt.test.ts" "extensions/sandbox/index.ts" "extensions/sandbox/index.test.ts"
git commit -m @"
feat(sandbox): teach Windows bash tool PowerShell via snippet and guidelines

"@
```

---

### 任务 4：fable 提示词分平台

**文件：**
- 修改：`extensions/fable-behavior/prompts/tier2/terminal-harness.md`
- 修改：`extensions/fable-behavior/prompts/tier2/tool-discipline.md`

无自动测试。对照规格 §5 改文案，不要扩写。

- [ ] **步骤 1：改 `terminal-harness.md`**

把

```
Bash: explain mutating commands; chain with `&&`; disable pagers; check terminals before duplicate servers; background long jobs without sleep-polling.
```

换成：

```
Shell: explain mutating commands; disable pagers; check terminals before duplicate servers; background long jobs without sleep-polling. On POSIX, chain with `&&`. On Windows the `bash` tool is PowerShell: chain with `;`, write cmdlets (Get-ChildItem, Select-String, Get-Content), and end native programs with `; exit $LASTEXITCODE`.
```

- [ ] **步骤 2：改 `tool-discipline.md`**

把

```
- Chain dependent bash with `&&`.
```

换成：

```
- Chain dependent POSIX bash with `&&`. On Windows (PowerShell) chain with `;` and end native programs with `; exit $LASTEXITCODE`.
```

- [ ] **步骤 3：Commit**

```powershell
git add "extensions/fable-behavior/prompts/tier2/terminal-harness.md" "extensions/fable-behavior/prompts/tier2/tool-discipline.md"
git commit -m @"
docs(prompts): tell the model Windows bash is PowerShell

"@
```

---

### 任务 5：`isSafeCommand` 补 PowerShell cmdlet 与写别名

**文件：**
- 修改：`extensions/agent-mode/utils.ts`
- 创建：`extensions/agent-mode/utils.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { isSafeCommand } from "./utils.js";

describe("isSafeCommand", () => {
  it("still allows POSIX read-only commands", () => {
    expect(isSafeCommand("ls -la")).toBe(true);
    expect(isSafeCommand("git status")).toBe(true);
    expect(isSafeCommand("rm -rf /")).toBe(false);
  });

  it("allows PowerShell read cmdlets", () => {
    expect(isSafeCommand("Get-ChildItem")).toBe(true);
    expect(isSafeCommand("Get-Content .\\a.txt | Select-String \"x\"")).toBe(true);
    expect(isSafeCommand("write-output hi")).toBe(true);
  });

  it("blocks PowerShell write cmdlets and aliases", () => {
    expect(isSafeCommand("Remove-Item .\\a.txt")).toBe(false);
    expect(isSafeCommand("del .\\a.txt")).toBe(false);
    expect(isSafeCommand("Set-Content .\\a.txt -Value x")).toBe(false);
    expect(isSafeCommand("Out-File .\\a.txt")).toBe(false);
    expect(isSafeCommand("copy .\\a.txt .\\b.txt")).toBe(false);
    expect(isSafeCommand("Set-Location ..")).toBe(false);
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run agent-mode/utils.test.ts
```

预期：FAIL（`Get-ChildItem` 为 false，因不在 `SAFE_PATTERNS`）。

- [ ] **步骤 3：实现最少代码**

在 `DESTRUCTIVE_PATTERNS` 末尾追加（全文 `\b`，与现有风格一致）：

```ts
  /\bRemove-Item\b/i,
  /\bMove-Item\b/i,
  /\bCopy-Item\b/i,
  /\bNew-Item\b/i,
  /\bRename-Item\b/i,
  /\bSet-Content\b/i,
  /\bAdd-Content\b/i,
  /\bSet-Item\b/i,
  /\bNew-ItemProperty\b/i,
  /\bStop-Process\b/i,
  /\bStart-Process\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bInvoke-RestMethod\b/i,
  /\bOut-File\b/i,
  /\bSet-Location\b/i,
  /\bClear-Content\b/i,
  /\bClear-Item\b/i,
  /\bRemove-ItemProperty\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /\bStart-Service\b/i,
  /\bStop-Service\b/i,
  /\bRestart-Computer\b/i,
  /^\s*del\b/i,
  /^\s*erase\b/i,
  /^\s*rd\b/i,
  /^\s*copy\b/i,
  /^\s*move\b/i,
  /^\s*ni\b/i,
  /^\s*sc\b/i,
  /^\s*ac\b/i,
  /^\s*ri\b/i,
  /^\s*mi\b/i,
  /^\s*ci\b/i,
  /^\s*clc\b/i,
  /^\s*cli\b/i,
```

别名用 **行首** `^\s*`，不要对 `sc` / `ni` 用全文 `\b`（会误伤句子）。`rd` 不要写两遍。`rm` / `rmdir` 已在文件里。

在 `SAFE_PATTERNS` 末尾追加：

```ts
  /^\s*Get-ChildItem\b/i,
  /^\s*Get-Content\b/i,
  /^\s*Get-Item\b/i,
  /^\s*Select-String\b/i,
  /^\s*Get-Location\b/i,
  /^\s*Get-Command\b/i,
  /^\s*Get-Help\b/i,
  /^\s*Test-Path\b/i,
  /^\s*Resolve-Path\b/i,
  /^\s*Get-Date\b/i,
  /^\s*Get-Process\b/i,
  /^\s*Write-Output\b/i,
  /^\s*Write-Host\b/i,
  /^\s*Measure-Object\b/i,
```

判定顺序已经是「先破坏再只读」：`return !isDestructive && isSafe;`。`Get-Content ... | Select-String` 行首是 `Get-Content`，会放行。

- [ ] **步骤 4：跑测试确认通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run agent-mode/utils.test.ts agent-mode/plan.test.ts agent-mode/modes.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add "extensions/agent-mode/utils.ts" "extensions/agent-mode/utils.test.ts"
git commit -m @"
feat(agent-mode): allow read PowerShell cmdlets and block write aliases

"@
```

---

### 任务 6：OS 沙箱规格 §4.5 指针

**文件：**
- 修改：`docs/superpowers/specs/2026-09-12-os-sandbox-design.md`

- [ ] **步骤 1：改 §4.5 第 1 步**

把

```
1. 解析 shell 绝对路径，组 `baseArgv = [shellPath, "-c", command]`（Windows 上是 `bash.exe` / Git Bash 或 `pwsh.exe`；POSIX 上是 `bash` / 系统 shell）。Windows 侧 shell 定位自维护，逻辑与 `cli/scripts/patch-pi-shell.mjs` 保持一致。
```

换成：

```
1. 解析 shell 绝对路径并组 argv。POSIX：`[shellPath, "-c", command]`。Windows 默认壳与 argv 以 `docs/superpowers/specs/2026-09-15-windows-powershell-shell-design.md` 为准：`pwsh.exe` 或 Windows PowerShell 5.1，`[shell, "-NoProfile", "-NonInteractive", "-Command", UTF-8 前缀 + command]`，不是 Git Bash `-c`。`operations.exec` 自己解析壳并 spawn，**不经** `cli/scripts/patch-pi-shell.mjs`（该补丁只打 SDK `dist/utils/shell.js` / 官方 `createLocalBashOperations`）。若将来启用官方 `powershell` 工具，必须接入同一 `operations`，否则构成绕过。
```

在「代价与约束」里 `patch-pi-shell` 那条后面补一句：本仓库 `bash` 工具的 Windows 壳定位已改走 `_shared/sandbox/shellPath.ts`，升级 SDK 时仍检查 patch，但不要假设它影响 `operations.exec`。

- [ ] **步骤 2：Commit**

```powershell
git add "docs/superpowers/specs/2026-09-12-os-sandbox-design.md"
git commit -m @"
docs(sandbox): point Windows bash argv at the PowerShell shell spec

"@
```

---

## 规格覆盖自检

| 规格 | 任务 |
| --- | --- |
| §3 解析顺序、WindowsApps 存根、禁止 WSL/Git 回退、删 DEFAULT_BASH_PATHS / git 分支 / source / operations 对 isLegacyWslBashPath 导入 | 1、2 |
| §4 `shellArgv` + UTF-8 前缀、pendingDenial 用原始 command、bash.exe 拒绝保留 | 2 |
| §1 成功标准 7 中文 UTF-8 字节 | 2 步骤 5 |
| §5 description / promptSnippet / promptGuidelines | 3 |
| §5 terminal-harness / tool-discipline | 4 |
| §6 SAFE + DESTRUCTIVE + 别名 + 新建 utils.test.ts | 5 |
| §7 OS 沙箱 §4.5 指针与 patch-pi-shell 边界 | 6 |
| §1.6 拆调试埋点 | 2 |
| 非目标：不改 helper、不翻译 POSIX、不自动 exit LASTEXITCODE、不 EncodedCommand | 各任务「不要改」 |

未单独立项：live isolation 加 PowerShell `Set-Content` 拒写（规格写「非必须」）。
