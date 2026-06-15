# improve 适配层实现计划 — 子代理模型 / worktree 隔离 / 只读边界

> **面向 AI 代理的工作者：** 用 `superpowers:executing-plans` 逐任务**内联**实现本计划（本仓库**禁止子代理**）。步骤用复选框 `- [ ]` 跟踪进度，每个任务结尾 commit 一次。

**目标：** 为 GrenAgent 补齐 [`shadcn/improve`](https://github.com/shadcn/improve) 所需的三项底座能力。设计依据见 `docs/superpowers/specs/2026-06-14-improve-adapters-design.md`。

**三阶段（相互正交，可独立合并）：**
- **P1 子代理级模型指定** — `spawn_agent` 暴露并透传 per-task `model`。
- **P2 worktree 隔离执行** — 新增 `worktree.ts`，`spawn_agent` 增 `isolate`，隔离改文件 + 回收 diff。
- **P3 只读权限边界** — `safety` 增「只读 / 写白名单」模式，可经 `spawn_agent` 参数下发给子代理。

**架构约束：** 改动全部在 `extensions/`（编译进 sidecar）+ `tauri-agent` 的 GUI 设置；**不改** `cli/src/main.ts` 运行时装配、**不改** Rust/Tauri 后端、**不改** RPC 协议。所有新参数可选，默认行为 100% 不变。

**命令约定：**
- 扩展单测（node 环境，无需 config）：`cd extensions && npx vitest run <相对路径>`
- 前端单测：`cd tauri-agent && npx vitest run <相对路径>`
- 前端类型检查：`cd tauri-agent && npx tsc --noEmit`
- 集成构建（编译 cli+extensions 为二进制，最终验证门）：`cd tauri-agent && npm run build:sidecar`
- 子代理冒烟（构建后用产物二进制）：`pi --mode json -p --no-session --model <m> "say hi"`

> **STOP 条件（贯穿全程）：** 若 `cd extensions && npx vitest run` 因找不到 vitest 失败，改用 `npx -y vitest run <file>`；若仍失败，停止并报告（可能需要在 `extensions/package.json` 加 `vitest` devDependency），不要擅自改测试框架。

---

## 文件结构

**新建**
- `extensions/multi-agent/tasks.ts` — 任务归一化纯函数（P1）
- `extensions/multi-agent/tasks.test.ts` — 归一化单测（P1）
- `extensions/multi-agent/worktree.ts` — git worktree 封装（P2）
- `extensions/multi-agent/worktree.test.ts` — worktree argv 纯函数单测（P2）

**修改**
- `extensions/multi-agent/index.ts` — `spawn_agent` 参数与透传（P1/P2/P3）
- `extensions/multi-agent/runner.ts` — `spawnPiAgent` 支持注入 `env`（P3）
- `extensions/safety/rules.ts` — `matchWriteAllowed` / `isMutatingBash` 纯函数（P3）
- `extensions/safety/rules.test.ts` — 新规则单测（P3）
- `extensions/safety/index.ts` — 只读模式拦截（P3）
- `tauri-agent/src/features/panels/subagentUtils.ts` — `taskLabel` 兼容对象化 tasks（P1）
- `tauri-agent/src/features/settings/settingsSchema.ts` — 新增安全设置字段（P3）

---

# 阶段 P1 — 子代理级模型指定

> 现状：`runner.ts::spawnPiAgent` 已支持 `opts.model`→`--model`（见 `runner.ts:74-79`）。缺口仅在 `spawn_agent` 工具未暴露 / 未透传。本阶段补上工具层。

## 任务 T1.1：`tasks.ts` 归一化纯函数 + 单测

把「单任务 + 工具级 model」「并行 tasks（每项可带 model）」统一成 `{ task, model? }[]`，便于工具层透传与单测。

**文件：**
- 创建：`extensions/multi-agent/tasks.ts`
- 测试：`extensions/multi-agent/tasks.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `extensions/multi-agent/tasks.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { normalizeTasks } from "./tasks.js";

describe("normalizeTasks", () => {
  it("single task with tool-level model", () => {
    expect(normalizeTasks({ task: "  do X  ", model: " gpt-4o " })).toEqual([{ task: "do X", model: "gpt-4o" }]);
  });
  it("single task without model", () => {
    expect(normalizeTasks({ task: "do X" })).toEqual([{ task: "do X" }]);
  });
  it("string tasks keep default model (undefined)", () => {
    expect(normalizeTasks({ tasks: ["a", " b "] })).toEqual([{ task: "a" }, { task: "b" }]);
  });
  it("object tasks carry per-task model", () => {
    expect(normalizeTasks({ tasks: [{ task: "a", model: "m1" }, { task: "b" }] })).toEqual([
      { task: "a", model: "m1" },
      { task: "b" },
    ]);
  });
  it("mixes single + tasks, drops blanks", () => {
    expect(normalizeTasks({ task: "head", model: "m0", tasks: ["", "  ", { task: "tail", model: "m2" }] })).toEqual([
      { task: "head", model: "m0" },
      { task: "tail", model: "m2" },
    ]);
  });
  it("empty → []", () => {
    expect(normalizeTasks({})).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

`cd extensions && npx vitest run multi-agent/tasks.test.ts` — 预期 FAIL（无法解析 `./tasks`）。

- [ ] **步骤 3：实现 `tasks.ts`**

创建 `extensions/multi-agent/tasks.ts`：

```ts
// Normalize spawn_agent params into a uniform { task, model? }[] list.
export interface NormalizedTask {
  task: string;
  model?: string;
}

export type TaskInput = string | { task: string; model?: string };

export interface SpawnParams {
  task?: string;
  model?: string;
  tasks?: TaskInput[];
}

function clean(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

export function normalizeTasks(params: SpawnParams): NormalizedTask[] {
  const out: NormalizedTask[] = [];
  const single = clean(params.task);
  if (single) out.push({ task: single, model: clean(params.model) });
  for (const t of params.tasks ?? []) {
    if (typeof t === "string") {
      const task = clean(t);
      if (task) out.push({ task });
    } else if (t && typeof t.task === "string") {
      const task = clean(t.task);
      if (task) out.push({ task, model: clean(t.model) });
    }
  }
  return out;
}
```

- [ ] **步骤 4：运行测试验证通过**

`cd extensions && npx vitest run multi-agent/tasks.test.ts` — 预期 PASS（6 用例）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/tasks.ts extensions/multi-agent/tasks.test.ts
git commit -m "feat(multi-agent): add normalizeTasks for per-task model"
```

## 任务 T1.2：`spawn_agent` 暴露并透传 model + 前端 taskLabel 兼容

**文件：**
- 修改：`extensions/multi-agent/index.ts`
- 修改：`tauri-agent/src/features/panels/subagentUtils.ts`

- [ ] **步骤 1：改 `spawn_agent` 参数（`extensions/multi-agent/index.ts:21-24`）**

把：

```ts
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "A single task for one sub-agent" })),
      tasks: Type.Optional(Type.Array(Type.String(), { description: "Multiple tasks to run in parallel" })),
    }),
```

改为：

```ts
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "A single task for one sub-agent" })),
      model: Type.Optional(Type.String({ description: "Model (provider/id) for `task`. Omit → SUBAGENT_MODEL or main default." })),
      tasks: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Object({ task: Type.String(), model: Type.Optional(Type.String()) }),
          ]),
          { description: "Multiple tasks in parallel; each item may be a string or { task, model }." },
        ),
      ),
    }),
```

- [ ] **步骤 2：改 execute 用 normalizeTasks 并透传 model（`index.ts:25-69`）**

在文件顶部 import 处（`import { spawnPiAgent } from "./runner.js";` 下一行）加：

```ts
import { normalizeTasks } from "./tasks.js";
```

把 `execute` 体（从 `const single = params.task?.trim();` 到并行返回结束）替换为：

```ts
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const list = normalizeTasks(params);
      if (!list.length) throw new Error("provide `task` or `tasks`");

      if (list.length === 1) {
        const { task, model } = list[0];
        const r = await spawnPiAgent(ctx.cwd, task, {
          model,
          signal: signal ?? undefined,
          onUpdate: onUpdate
            ? (u) =>
                onUpdate({
                  content: [{ type: "text", text: u.text }],
                  details: { streaming: true, transcript: u.transcript },
                })
            : undefined,
        });
        if (!r.ok) throw new Error(`sub-agent failed (exit ${r.exitCode}): ${r.error ?? "unknown error"}`);
        return {
          content: [{ type: "text", text: r.output || "(no output)" }],
          details: { exitCode: r.exitCode, transcript: r.transcript },
        };
      }

      const results: Array<{ task: string; ok: boolean; output: string; error?: string }> = [];
      for (let i = 0; i < list.length; i += MAX_CONCURRENCY) {
        const batch = list.slice(i, i + MAX_CONCURRENCY);
        const settled = await Promise.all(
          batch.map((t) => spawnPiAgent(ctx.cwd, t.task, { model: t.model, signal: signal ?? undefined })),
        );
        settled.forEach((r, j) => results.push({ task: batch[j].task, ok: r.ok, output: r.output, error: r.error }));
      }

      const body = results
        .map(
          (r, i) =>
            `## Sub-agent ${i + 1}${r.ok ? "" : " (failed)"}\nTask: ${r.task}\n\n${r.ok ? r.output || "(no output)" : `Error: ${r.error}`}`,
        )
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: body }],
        details: { count: results.length, failed: results.filter((r) => !r.ok).length },
      };
    },
```

- [ ] **步骤 3：前端 `taskLabel` 兼容对象化 tasks（`tauri-agent/src/features/panels/subagentUtils.ts:4-9`）**

把：

```ts
export function taskLabel(args: unknown): string {
  const a = (args ?? {}) as { task?: string; tasks?: string[] };
  if (a.task?.trim()) return a.task.trim();
  if (a.tasks?.length) return `${a.tasks.length} 个并行任务`;
  return '子代理任务';
}
```

改为：

```ts
export function taskLabel(args: unknown): string {
  const a = (args ?? {}) as { task?: string; tasks?: Array<string | { task?: string }> };
  if (a.task?.trim()) return a.task.trim();
  if (a.tasks?.length) return `${a.tasks.length} 个并行任务`;
  return '子代理任务';
}
```

- [ ] **步骤 4：类型检查**

`cd extensions && npx tsc --noEmit`（若 extensions 无独立 tsconfig，则在 T1.5 集成构建统一验证）；`cd tauri-agent && npx tsc --noEmit` — 预期无错误。

- [ ] **步骤 5：前端测试无回归**

`cd tauri-agent && npx vitest run src/features/panels` — 预期 PASS（taskLabel 改的是类型，length 逻辑不变）。

- [ ] **步骤 6：Commit**

```bash
git add extensions/multi-agent/index.ts tauri-agent/src/features/panels/subagentUtils.ts
git commit -m "feat(multi-agent): expose per-task model on spawn_agent"
```

## 任务 T1.3：集成构建 + 子代理模型冒烟

- [ ] **步骤 1：集成构建**

`cd tauri-agent && npm run build:sidecar` — 预期成功产出 `src-tauri/binaries/pi-<triple>`（确认 tasks.ts / index.ts 改动可编译进二进制）。

- [ ] **步骤 2：冒烟（手动）**

用产物二进制跑一个指定模型的子任务（替换 `<m>` 为一个你已配置的便宜模型）：

```bash
# 从 binaries 目录或用 PI_BIN 指向产物
pi --mode json -p --no-session --model <m> "reply with the single word: ok"
```

预期：JSONL 流里出现 assistant 文本 `ok`，进程 exit 0。验证 `--model` 链路通。

> STOP 条件：若冒烟显示模型未生效（如仍用默认模型），停止并检查 `spawnPiAgent` 的 `args.push("--model", model)`（`runner.ts:79`）是否被命中。

- [ ] **步骤 3：Commit（如有构建脚本副产物，否则跳过）**

P1 完成 —— improve 审计 fan-out / 执行均可指定便宜模型。

---

# 阶段 P2 — worktree 隔离执行

> 让执行型子代理在 git worktree 中改文件、回收 diff、用后即焚，主工作区零污染。

## 任务 T2.1：`worktree.ts` argv 纯函数 + 单测

**文件：**
- 创建：`extensions/multi-agent/worktree.ts`
- 测试：`extensions/multi-agent/worktree.test.ts`

- [ ] **步骤 1：编写失败测试**

创建 `extensions/multi-agent/worktree.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { gitWorktreeAddArgs, gitWorktreeRemoveArgs } from "./worktree.js";

describe("worktree argv", () => {
  it("add uses --detach into target dir with windows-safe flags", () => {
    const a = gitWorktreeAddArgs("/repo", "/tmp/wt");
    expect(a).toContain("worktree");
    expect(a).toContain("add");
    expect(a).toContain("--detach");
    expect(a.slice(-3)).toEqual(["-C", "/repo", "/tmp/wt"].slice(-3)); // ends with repo + dir context
    expect(a).toContain("core.autocrlf=false");
  });
  it("remove forces removal of the dir", () => {
    const r = gitWorktreeRemoveArgs("/repo", "/tmp/wt");
    expect(r).toContain("remove");
    expect(r).toContain("--force");
    expect(r).toContain("/tmp/wt");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

`cd extensions && npx vitest run multi-agent/worktree.test.ts` — 预期 FAIL（无法解析 `./worktree`）。

- [ ] **步骤 3：实现 `worktree.ts`**

创建 `extensions/multi-agent/worktree.ts`：

```ts
// Isolated execution via `git worktree`: a separate working dir + detached HEAD
// so a sub-agent can edit files without touching the user's main checkout.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Windows-safe flags mirroring extensions/checkpoint/snapshot.ts.
const FLAGS = ["-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", "core.quotepath=false"];

export interface Worktree {
  dir: string;
  cleanup: () => Promise<void>;
}

export function gitWorktreeAddArgs(repo: string, dir: string): string[] {
  return [...FLAGS, "-C", repo, "worktree", "add", "--detach", dir];
}

export function gitWorktreeRemoveArgs(repo: string, dir: string): string[] {
  return [...FLAGS, "-C", repo, "worktree", "remove", "--force", dir];
}

function git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Create an isolated worktree off `cwd`. Returns null if not a git repo or add fails (e.g. no commits yet). */
export async function createWorktree(cwd: string): Promise<Worktree | null> {
  if (!(await isGitRepo(cwd))) return null;
  const dir = mkdtempSync(join(tmpdir(), "grenagent-wt-"));
  const r = await git(gitWorktreeAddArgs(cwd, dir));
  if (r.code !== 0) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return null;
  }
  return {
    dir,
    cleanup: async () => {
      await git(gitWorktreeRemoveArgs(cwd, dir));
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* worktree remove may already have cleaned it */
      }
    },
  };
}

/** Unified diff of all changes (incl. new files) made inside the worktree. */
export async function worktreeDiff(dir: string): Promise<string> {
  await git(["-C", dir, "add", "-A"]);
  return (await git(["-C", dir, "diff", "--cached"])).stdout;
}
```

- [ ] **步骤 4：运行测试验证通过**

`cd extensions && npx vitest run multi-agent/worktree.test.ts` — 预期 PASS（2 用例）。

> 说明：`createWorktree`/`worktreeDiff` 是真实 git I/O，不做单测（避免脆弱的临时仓库 fixture）；靠 T2.3 集成验证。纯 argv 函数已覆盖。

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/worktree.ts extensions/multi-agent/worktree.test.ts
git commit -m "feat(multi-agent): add git worktree isolation helpers"
```

## 任务 T2.2：`spawn_agent` 接入 `isolate`（单任务）+ 返回 diff

> 隔离仅作用于**单任务**路径（improve `execute` 场景）。并行 + isolate 暂不支持（明确报错），避免多 worktree 复杂度。

**文件：**
- 修改：`extensions/multi-agent/index.ts`

- [ ] **步骤 1：加 `isolate` 参数**

在 T1.2 改好的 `parameters` 中，`tasks` 字段后追加：

```ts
      isolate: Type.Optional(
        Type.Boolean({ description: "Run a single task in an isolated git worktree; returns its diff. Main workspace untouched." }),
      ),
```

- [ ] **步骤 2：import worktree 助手**

在 `index.ts` 顶部 import 区追加：

```ts
import { createWorktree, worktreeDiff } from "./worktree.js";
```

- [ ] **步骤 3：单任务分支接入隔离**

把 T1.2 的单任务分支（`if (list.length === 1) { ... }`）替换为：

```ts
      if (list.length === 1) {
        const { task, model } = list[0];
        const isolate = params.isolate === true;

        if (isolate && list.length !== 1) {
          throw new Error("isolate only supports a single task");
        }

        const wt = isolate ? await createWorktree(ctx.cwd) : null;
        if (isolate && !wt) {
          if (process.env.ISOLATE_FALLBACK === "1") {
            // fall through to non-isolated run below
          } else {
            throw new Error(
              "cannot isolate: current dir is not a git repo (or has no commits). " +
                "Use isolate=false, run `git init` + an initial commit, or set ISOLATE_FALLBACK=1.",
            );
          }
        }

        const runCwd = wt?.dir ?? ctx.cwd;
        try {
          const r = await spawnPiAgent(runCwd, task, {
            model,
            signal: signal ?? undefined,
            onUpdate: onUpdate
              ? (u) =>
                  onUpdate({
                    content: [{ type: "text", text: u.text }],
                    details: { streaming: true, transcript: u.transcript },
                  })
              : undefined,
          });
          if (!r.ok) throw new Error(`sub-agent failed (exit ${r.exitCode}): ${r.error ?? "unknown error"}`);
          const diff = wt ? await worktreeDiff(wt.dir) : undefined;
          const text = wt
            ? `${r.output || "(no output)"}\n\n---\n### Diff (isolated worktree)\n\n${diff?.trim() ? "```diff\n" + diff + "\n```" : "(no file changes)"}`
            : r.output || "(no output)";
          return {
            content: [{ type: "text", text }],
            details: { exitCode: r.exitCode, transcript: r.transcript, isolated: !!wt, diff },
          };
        } finally {
          if (wt) await wt.cleanup();
        }
      }
```

> 注意：`isolate && list.length !== 1` 的守卫在单任务分支内恒为 false，真正拦截「并行 + isolate」在步骤 4。

- [ ] **步骤 4：并行分支拒绝 isolate**

在并行分支（`const results: ... = [];` 之前）加：

```ts
      if (params.isolate === true) {
        throw new Error("isolate is only supported with a single task, not parallel `tasks`");
      }
```

- [ ] **步骤 5：类型检查**

`cd tauri-agent && npx tsc --noEmit`；扩展侧靠 T2.6 集成构建验证。

- [ ] **步骤 6：Commit**

```bash
git add extensions/multi-agent/index.ts
git commit -m "feat(multi-agent): isolated worktree execution with diff return"
```

## 任务 T2.3：集成构建 + 隔离冒烟

- [ ] **步骤 1：集成构建**

`cd tauri-agent && npm run build:sidecar` — 预期成功。

- [ ] **步骤 2：隔离冒烟（手动，在一个有提交的 git 仓库里）**

通过主代理（GUI）或直接构造一次 `spawn_agent` 调用：`{ task: "create a file hello.txt with content hi", isolate: true }`。

预期：
1. 返回文本含「Diff (isolated worktree)」段，展示 `hello.txt` 新增。
2. **主工作区没有** `hello.txt`（已在 worktree 内、随 cleanup 销毁）。
3. `git worktree list` 无残留；`os.tmpdir()` 下无 `grenagent-wt-*` 残留。

- [ ] **步骤 3：非 git 仓库冒烟**

在非 git 目录 `{ task: "...", isolate: true }` → 预期返回明确错误「cannot isolate: ... not a git repo」。

> STOP 条件：若 worktree 残留或主工作区被改动，停止并检查 `finally { wt.cleanup() }` 与 `runCwd` 是否真的指向 `wt.dir`。

P2 完成 —— improve `execute` 可隔离执行并产出可审查 diff。

---

# 阶段 P3 — 只读权限边界

> 给 safety 增「只读 / 写白名单」模式（env 驱动），并让 `spawn_agent` 能把它下发给子代理：规划/审计子代理只读、execute 子代理（worktree 内）放开。

## 任务 T3.1：`rules.ts` 新增白名单 / mutating 纯函数 + 单测

**文件：**
- 修改：`extensions/safety/rules.ts`
- 修改：`extensions/safety/rules.test.ts`

- [ ] **步骤 1：在 `rules.test.ts` 追加失败用例**

在 `extensions/safety/rules.test.ts` 末尾追加（与现有 import 风格一致；若文件未 import 这两个函数，补到顶部 import）：

```ts
import { isMutatingBash, matchWriteAllowed, normalizePath } from "./rules.js";

describe("normalizePath", () => {
  it("converts backslashes and strips ./", () => {
    expect(normalizePath(".\\plans\\a.md")).toBe("plans/a.md");
  });
});

describe("matchWriteAllowed", () => {
  it("allows paths under an allowlisted prefix", () => {
    expect(matchWriteAllowed("plans/001.md", ["plans/"])).toBe(true);
    expect(matchWriteAllowed("plans", ["plans/"])).toBe(true);
  });
  it("rejects paths outside the allowlist", () => {
    expect(matchWriteAllowed("src/index.ts", ["plans/"])).toBe(false);
  });
  it("rejects path traversal", () => {
    expect(matchWriteAllowed("plans/../src/x.ts", ["plans/"])).toBe(false);
  });
  it("empty allowlist allows nothing", () => {
    expect(matchWriteAllowed("plans/001.md", [])).toBe(false);
  });
});

describe("isMutatingBash", () => {
  it("flags redirects, rm/mv, sed -i, git mutators", () => {
    expect(isMutatingBash("echo hi > out.txt")).toBe(true);
    expect(isMutatingBash("rm foo")).toBe(true);
    expect(isMutatingBash("sed -i 's/a/b/' f")).toBe(true);
    expect(isMutatingBash("git commit -m x")).toBe(true);
  });
  it("allows read-only commands", () => {
    expect(isMutatingBash("ls -la")).toBe(false);
    expect(isMutatingBash("git status")).toBe(false);
    expect(isMutatingBash("grep foo src")).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

`cd extensions && npx vitest run safety/rules.test.ts` — 预期 FAIL（未导出新函数）。

- [ ] **步骤 3：在 `rules.ts` 末尾追加实现**

向 `extensions/safety/rules.ts` 追加：

```ts
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True if `path` falls under any allowlisted prefix. Rejects `..` traversal. */
export function matchWriteAllowed(path: string, allowlist: string[]): boolean {
  if (!path) return false;
  const np = normalizePath(path);
  if (np.split("/").includes("..")) return false;
  return allowlist
    .map((a) => normalizePath(a.trim()).replace(/\/+$/, ""))
    .filter(Boolean)
    .some((prefix) => np === prefix || np.startsWith(prefix + "/"));
}

const MUTATING_BASH = [
  />>?/, // redirection writes
  /\b(rm|mv|cp|mkdir|rmdir|touch|tee|truncate|dd|ln)\b/,
  /\bsed\b[^\n]*\s-i/, // in-place edit
  /\bgit\b[^\n]*\b(commit|checkout|reset|merge|rebase|apply|stash|clean|restore)\b/,
  /\b(npm|pnpm|yarn|bun)\b[^\n]*\b(install|add|i|ci|remove|rm)\b/,
];

export function isMutatingBash(command: string): boolean {
  return MUTATING_BASH.some((re) => re.test(command));
}
```

- [ ] **步骤 4：运行测试验证通过**

`cd extensions && npx vitest run safety/rules.test.ts` — 预期 PASS（新增用例 + 原有用例全绿）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/safety/rules.ts extensions/safety/rules.test.ts
git commit -m "feat(safety): add write-allowlist and mutating-bash rules"
```

## 任务 T3.2：`safety/index.ts` 接入只读模式

**文件：**
- 修改：`extensions/safety/index.ts`

- [ ] **步骤 1：扩展 import 与 env 读取**

把 `extensions/safety/index.ts:2` 的：

```ts
import { extractPath, isDangerousBash, matchProtectedPath } from "./rules.js";
```

改为：

```ts
import { extractPath, isDangerousBash, isMutatingBash, matchProtectedPath, matchWriteAllowed } from "./rules.js";
```

在 `export default function (pi: ExtensionAPI) {` 体内、`const guardPaths = ...` 之后加：

```ts
  const on = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";
  const readonly = on(process.env.SAFETY_READONLY);
  const writeAllow = (process.env.SAFETY_WRITE_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
```

- [ ] **步骤 2：在 `tool_call` 钩子开头叠加只读拦截**

在 `pi.on("tool_call", async (event, ctx) => {` 之后、现有 `if (guardBash && ...)` 之前插入：

```ts
    if (readonly) {
      if (event.toolName === "write" || event.toolName === "edit") {
        const p = extractPath((event.input ?? {}) as Record<string, unknown>);
        if (!p || !matchWriteAllowed(p, writeAllow)) {
          return { block: true, reason: `只读模式：仅允许写 ${writeAllow.join(", ") || "(无)"}` };
        }
      }
      if (event.toolName === "bash" && isMutatingBash(String(event.input?.command ?? ""))) {
        return { block: true, reason: "只读模式：禁止会改动文件系统的命令" };
      }
    }
```

- [ ] **步骤 3：类型检查 / 集成构建**

`cd tauri-agent && npm run build:sidecar` — 预期成功（safety 改动编译通过）。

- [ ] **步骤 4：Commit**

```bash
git add extensions/safety/index.ts
git commit -m "feat(safety): readonly mode with write allowlist"
```

## 任务 T3.3：`spawnPiAgent` 支持注入 env

让调用方（`spawn_agent`）能把安全 env 下发给子进程。

**文件：**
- 修改：`extensions/multi-agent/runner.ts`

- [ ] **步骤 1：扩展 opts 类型（`runner.ts:74`）**

把：

```ts
  opts: { model?: string; signal?: AbortSignal; onUpdate?: (update: AgentUpdate) => void } = {},
```

改为：

```ts
  opts: { model?: string; signal?: AbortSignal; onUpdate?: (update: AgentUpdate) => void; env?: Record<string, string> } = {},
```

- [ ] **步骤 2：合并 env（`runner.ts:96-106`）**

在 `env: { ...process.env, KB_AUTO_INJECT: "0", ..., MCP_SERVERS: "" }` 对象的**末尾**（`MCP_SERVERS: "",` 之后）追加：

```ts
        ...(opts.env ?? {}),
```

使调用方注入的 env 覆盖默认（如 `SAFETY_READONLY`）。

- [ ] **步骤 3：单测无回归**

`cd extensions && npx vitest run multi-agent/runner.test.ts` — 预期 PASS（现有纯函数测试不受影响）。

- [ ] **步骤 4：Commit**

```bash
git add extensions/multi-agent/runner.ts
git commit -m "feat(multi-agent): allow env injection into spawned sub-agents"
```

## 任务 T3.4：`spawn_agent` 暴露 `readonly` / `writeAllow` 并下发

**文件：**
- 修改：`extensions/multi-agent/index.ts`

- [ ] **步骤 1：加参数**

在 `parameters` 中 `isolate` 字段后追加：

```ts
      readonly: Type.Optional(Type.Boolean({ description: "Run the sub-agent in safety read-only mode." })),
      writeAllow: Type.Optional(Type.Array(Type.String(), { description: "Write-allowlist prefixes for read-only mode (e.g. ['plans/'])." })),
```

- [ ] **步骤 2：构造安全 env helper**

在 `execute` 函数体顶部（`const list = normalizeTasks(params);` 之后）加：

```ts
      const safetyEnv: Record<string, string> = {};
      if (params.readonly === true) {
        safetyEnv.SAFETY_READONLY = "1";
        safetyEnv.SAFETY_WRITE_ALLOW = (params.writeAllow ?? []).join(",");
      }
```

- [ ] **步骤 3：把 `env: safetyEnv` 透传到所有 `spawnPiAgent(...)` 调用**

为单任务分支、隔离分支、并行分支的每个 `spawnPiAgent(runCwd ?? ctx.cwd, task, { ... })` 调用补 `env: safetyEnv`。例如并行：

```ts
          batch.map((t) => spawnPiAgent(ctx.cwd, t.task, { model: t.model, env: safetyEnv, signal: signal ?? undefined })),
```

单任务/隔离同理在 opts 里加 `env: safetyEnv`。

> 协同约定：当 `isolate=true` 时，worktree 自身即隔离边界，**通常不应再叠加 readonly**（否则执行子代理无法写）。本期由调用方（improve skill）自行决定：execute 用 `isolate:true`（不传 readonly），审计/规划用 `readonly:true`（不传 isolate）。如需强约束可在后续加「isolate 时忽略 readonly」逻辑（当前不加，保持参数语义直观）。

- [ ] **步骤 4：类型检查 + 集成构建**

`cd tauri-agent && npm run build:sidecar` — 预期成功。

- [ ] **步骤 5：只读冒烟（手动）**

`spawn_agent({ task: "create file hacked.txt with content x", readonly: true, writeAllow: ["plans/"] })`

预期：子代理尝试 write 被 block（返回文本含「只读模式：仅允许写 plans/」），`hacked.txt` 未创建。再试 `writeAllow: ["."]` 或不传 readonly → 可写。

> STOP 条件：若 readonly 未生效，检查 env 是否真传到子进程（`runner.ts` 的 `...(opts.env ?? {})`）以及 safety 是否读到（`SAFETY_READONLY`）。注意子进程继承父 env，若父进程已有 `SAFETY_READONLY`，行为可能叠加——冒烟前确认父环境干净。

- [ ] **步骤 6：Commit**

```bash
git add extensions/multi-agent/index.ts
git commit -m "feat(multi-agent): readonly/writeAllow passthrough to sub-agents"
```

## 任务 T3.5：GUI 设置字段

**文件：**
- 修改：`tauri-agent/src/features/settings/settingsSchema.ts`

- [ ] **步骤 1：safety 分类加字段（`settingsSchema.ts:108-115`）**

在 `id: 'safety'` 的 `fields` 数组末尾（`SAFETY_PROTECT_PATHS` 之后）追加：

```ts
      { key: 'SAFETY_READONLY', label: '只读模式（默认关；开启后仅允许写下方白名单目录）', type: 'boolean' },
      { key: 'SAFETY_WRITE_ALLOW', label: '只读写白名单（逗号分隔前缀，如 plans/,docs/）', type: 'text', placeholder: 'plans/' },
```

- [ ] **步骤 2：类型检查 + 前端测试**

`cd tauri-agent && npx tsc --noEmit` — 无错误。`cd tauri-agent && npx vitest run` — 预期全绿。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/settings/settingsSchema.ts
git commit -m "feat(settings): expose SAFETY_READONLY and write allowlist"
```

P3 完成 —— 子代理可被约束为只读 / 仅写白名单。

---

## 自检结果

**1. 规格覆盖度（逐项核对 spec）**

| spec 章节 | 对应任务 | 状态 |
|-----------|----------|------|
| §3 适配点① 子代理模型 | T1.1 normalizeTasks / T1.2 工具暴露+透传 / T1.3 冒烟 | ✅ |
| §3.3 tasks 用 Union 兼容 + taskLabel 同步 | T1.2 步骤 1/3 | ✅ |
| §4 适配点② worktree | T2.1 helper / T2.2 isolate+diff / T2.3 冒烟 | ✅ |
| §4.3 非 git 拒绝 + ISOLATE_FALLBACK | T2.2 步骤 3 | ✅ |
| §4.3 worktree 落 tmpdir + diff 口径(add -A) | T2.1 createWorktree / worktreeDiff | ✅ |
| §5 适配点③ 只读边界 | T3.1 规则 / T3.2 拦截 / T3.3 env 注入 / T3.4 下发 / T3.5 设置 | ✅ |
| §5.3 白名单规范化 + 拒绝 `..` | T3.1 matchWriteAllowed | ✅ |
| §6 三者协同闭环 | T3.4 步骤 3 协同约定（execute=isolate / 审计=readonly） | ✅ |
| §8 错误处理与边界 | T2.2 finally cleanup / T2.3 非 git / T3.4 STOP | ✅ |
| §9 实现顺序 P1→P2→P3 正交 | 三阶段无跨阶段依赖 | ✅ |

**2. 占位符扫描：** 全计划无「TODO/待补充/适当处理」空话；每个实现步骤含完整可粘贴代码或精确改动位置（文件:行）。

**3. 向后兼容核对：**
- `spawn_agent` 新增参数（`model`/`tasks` 对象项/`isolate`/`readonly`/`writeAllow`）全部 `Type.Optional`；不传时 `normalizeTasks` 退化为原「single / tasks(string[])」行为，`isolate`/`readonly` 默认关 → 行为与改动前一致。
- `spawnPiAgent` 新增 `opts.env` 可选；不传 = 原 env。
- safety 只读默认关（`SAFETY_READONLY` 未设）→ 原拦截逻辑不变。
- `taskLabel` 仅放宽类型，`length` 文案逻辑不变。

**4. 类型一致性：**
- `NormalizedTask`/`SpawnParams`（T1.1）被 index.ts execute 引用。
- `Worktree`/`createWorktree`/`worktreeDiff`（T2.1）被 index.ts 隔离分支引用。
- `matchWriteAllowed`/`isMutatingBash`/`normalizePath`（T3.1）被 safety/index.ts 引用。
- `spawnPiAgent` 的 `env` 选项（T3.3）被 T3.4 的 `safetyEnv` 透传使用。

> 一处刻意约定并记录：**isolate 与 readonly 不自动互斥**（T3.4 步骤 3）。语义保持直观（各自独立），由 improve skill 在调用层分别使用（execute→isolate、audit→readonly），不在本期加自动互斥逻辑。

---

## 执行交接

计划已保存到 `tauri-agent/docs/superpowers/plans/2026-06-14-improve-adapters-plan.md`，设计见同名 specs 目录文档。

本仓库**禁止子代理**，采用**内联执行**：
- **必需子技能：** `superpowers:executing-plans`
- 顺序：**P1（T1.1→T1.3）→ P2（T2.1→T2.3）→ P3（T3.1→T3.5）**，每任务末尾 commit。
- 审查检查点：T1.3 / T2.3 / T3.4 的集成构建 + 手动冒烟（模型生效、worktree 隔离零污染、只读拦截）。
- 三阶段正交，可只做其中任意一两个先行合并（如先 P1 立即给 improve 省成本）。

**完成后即可内置 improve：** `npx skills add shadcn/improve`（或放入 pi skill 目录），让其 `/improve` 审计用便宜模型（P1）、`execute` 走 worktree 隔离（P2）、规划阶段只读保护源码（P3）。
