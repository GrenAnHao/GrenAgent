# self-evolve（dream + distill）实现计划

> **面向 AI 代理的工作者：** 推荐用 superpowers:subagent-driven-development（每任务一子代理 + 审查）或 superpowers:executing-plans 逐任务实现。步骤用复选框（`- [ ]`）跟踪。

**目标：** 新增 Pi 扩展 `extensions/self-evolve/`：dream（回顾近期会话固化知识进 long-term-memory + MEMORY.md）与 distill（把重复工作流打包成 skill/agent/command），均以专用 subagent + session_start 间隔自动触发 + 手动命令运行。

**架构：** 纯逻辑（间隔判定 schedule.ts、MEMORY.md 注入 memory-file.ts）单测覆盖；persona 文本常量（personas.ts）经 seed.ts 播种到 `~/.pi/agent/agents/`（可改）；runner.ts 读 persona 拼任务、fire-and-forget spawn `pi --mode json -p --no-session`；index.ts 装配命令 + session_start 调度 + before_agent_start 注入。真相源 `SessionManager.list(cwd)`，子进程置 `SELF_EVOLVE_CHILD=1` 防递归。

**技术栈：** TypeScript Pi 扩展（`ExtensionAPI`）、vitest（`cd extensions && bunx vitest run <file>`）、bun --compile sidecar、复用 `_shared/runtime-config`、`SessionManager`、`getAgentDir`、long-term-memory 工具。

设计来源：`docs/superpowers/specs/2026-06-26-self-evolve-dream-distill-design.md`。

---

## 文件结构

- 创建：`extensions/self-evolve/schedule.ts` — 纯间隔判定 + 标记文件 IO。
- 创建：`extensions/self-evolve/schedule.test.ts` — schedule 单测。
- 创建：`extensions/self-evolve/memory-file.ts` — MEMORY.md 读取 + 注入格式化。
- 创建：`extensions/self-evolve/memory-file.test.ts` — memory-file 单测。
- 创建：`extensions/self-evolve/personas.ts` — dream/distill persona 文本 + task 常量。
- 创建：`extensions/self-evolve/seed.ts` — 播种 persona 到 `~/.pi/agent/agents/`。
- 创建：`extensions/self-evolve/runner.ts` — 读 persona、spawn 子代理。
- 创建：`extensions/self-evolve/index.ts` — 扩展装配。
- 创建：`extensions/self-evolve/package.json` — 扩展依赖声明。
- 修改：`extensions/index.ts` — 注册新扩展（import + `allExtensions` + `namedExtensions`）。

---

## 任务 1：schedule.ts（纯间隔判定 + 标记 IO）

**文件：**
- 创建：`extensions/self-evolve/schedule.ts`
- 测试：`extensions/self-evolve/schedule.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/self-evolve/schedule.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldRun, daysToMs, readMarker, writeMarker, MIN_SPAWN_GAP_MS } from "./schedule.js";

const base = {
  enabled: true,
  intervalMs: daysToMs(7),
  lastRunMs: undefined as number | undefined,
  earliestSessionMs: undefined as number | undefined,
  now: 1_000_000_000_000,
  lastSpawnMs: 0,
};

describe("shouldRun", () => {
  it("disabled → false", () => {
    expect(shouldRun({ ...base, enabled: false, earliestSessionMs: base.now - daysToMs(30) })).toBe(false);
  });
  it("within spawn debounce → false", () => {
    expect(shouldRun({ ...base, earliestSessionMs: base.now - daysToMs(30), lastSpawnMs: base.now - 1000 })).toBe(false);
  });
  it("first run + project too young → false", () => {
    expect(shouldRun({ ...base, earliestSessionMs: base.now - daysToMs(3) })).toBe(false);
  });
  it("first run + no sessions → false", () => {
    expect(shouldRun({ ...base, earliestSessionMs: undefined })).toBe(false);
  });
  it("first run + project old enough → true", () => {
    expect(shouldRun({ ...base, earliestSessionMs: base.now - daysToMs(10) })).toBe(true);
  });
  it("last run too recent → false", () => {
    expect(shouldRun({ ...base, lastRunMs: base.now - daysToMs(3) })).toBe(false);
  });
  it("last run older than interval → true", () => {
    expect(shouldRun({ ...base, lastRunMs: base.now - daysToMs(8) })).toBe(true);
  });
  it("interval 0 → always true (past debounce)", () => {
    expect(shouldRun({ ...base, intervalMs: 0, lastRunMs: base.now })).toBe(true);
  });
});

describe("marker IO", () => {
  it("write then read roundtrips", () => {
    const dir = mkdtempSync(join(tmpdir(), "se-"));
    try {
      const f = join(dir, "sub", ".marker");
      expect(readMarker(f)).toBeUndefined();
      writeMarker(f, 123456);
      expect(readMarker(f)).toBe(123456);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  it("read missing → undefined", () => {
    expect(readMarker(join(tmpdir(), "definitely-missing-se-marker"))).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && bunx vitest run self-evolve/schedule.test.ts`
预期：FAIL（`Cannot find module './schedule.js'`）。

- [ ] **步骤 3：编写实现**

```ts
// extensions/self-evolve/schedule.ts
// 自进化调度的纯逻辑 + 标记文件 IO（无 LLM、无网络，便于单测）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 进程内防抖：一次启动可能触发多个 session_start，避免重复 spawn。 */
export const MIN_SPAWN_GAP_MS = 10_000;

export function daysToMs(days: number): number {
  return Math.max(0, Number.isFinite(days) ? days : 0) * DAY_MS;
}

export interface ScheduleInput {
  enabled: boolean;
  intervalMs: number;
  /** 上次运行的 epoch ms（来自标记文件）；undefined = 从未运行。 */
  lastRunMs: number | undefined;
  /** 项目最早会话的 epoch ms（年龄门槛）；undefined = 无会话。 */
  earliestSessionMs: number | undefined;
  now: number;
  lastSpawnMs: number;
}

/** 是否应触发一次自进化（对齐 MiMo shouldAutoRun 语义）。 */
export function shouldRun(i: ScheduleInput): boolean {
  if (!i.enabled) return false;
  if (i.now - i.lastSpawnMs < MIN_SPAWN_GAP_MS) return false;
  if (i.lastRunMs === undefined) {
    // 首次：项目需足够老（有可固化内容）才跑。
    if (i.earliestSessionMs === undefined) return false;
    return i.now - i.earliestSessionMs >= i.intervalMs;
  }
  return i.now - i.lastRunMs >= i.intervalMs;
}

export function readMarker(path: string): number | undefined {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function writeMarker(path: string, now: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(now), "utf8");
  } catch {
    /* best-effort */
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && bunx vitest run self-evolve/schedule.test.ts`
预期：PASS（10 个用例）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/self-evolve/schedule.ts extensions/self-evolve/schedule.test.ts
git commit -m "feat(self-evolve): add schedule interval logic + marker IO"
```

---

## 任务 2：memory-file.ts（MEMORY.md 读取 + 注入格式化）

**文件：**
- 创建：`extensions/self-evolve/memory-file.ts`
- 测试：`extensions/self-evolve/memory-file.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/self-evolve/memory-file.test.ts
import { describe, expect, it } from "vitest";
import { formatInjection, readMemoryFile } from "./memory-file.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("formatInjection", () => {
  it("both empty → empty string", () => {
    expect(formatInjection("", "  ", 4096)).toBe("");
  });
  it("project only → labeled project block", () => {
    expect(formatInjection("rule A", "", 4096)).toBe("# Project memory\n\nrule A");
  });
  it("global only → labeled global block", () => {
    expect(formatInjection("", "habit B", 4096)).toBe("# Global memory\n\nhabit B");
  });
  it("both → project first then global", () => {
    expect(formatInjection("rule A", "habit B", 4096)).toBe(
      "# Project memory\n\nrule A\n\n# Global memory\n\nhabit B",
    );
  });
  it("over budget → keep project (truncated), drop global", () => {
    // 哨兵用不出现在表头 "# Project memory" / "# Global memory" 里的字符。
    const out = formatInjection("9".repeat(50), "Z".repeat(50), 30);
    expect(out.length).toBe(30);
    expect(out.startsWith("# Project memory")).toBe(true);
    expect(out.includes("Z")).toBe(false);
  });
});

describe("readMemoryFile", () => {
  it("missing file → empty string", () => {
    expect(readMemoryFile(join(tmpdir(), "no-such-MEMORY.md"))).toBe("");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && bunx vitest run self-evolve/memory-file.test.ts`
预期：FAIL（`Cannot find module './memory-file.js'`）。

- [ ] **步骤 3：编写实现**

```ts
// extensions/self-evolve/memory-file.ts
// 读取 MEMORY.md 并格式化为注入正文（项目优先、带预算上限）。纯函数，便于单测。
import { readFileSync } from "node:fs";

export function readMemoryFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** 把项目/全局 MEMORY.md 拼成注入正文；超 maxChars 时项目优先、必要时截断。 */
export function formatInjection(project: string, global: string, maxChars: number): string {
  const parts: Array<{ title: string; body: string }> = [];
  if (project.trim()) parts.push({ title: "Project memory", body: project.trim() });
  if (global.trim()) parts.push({ title: "Global memory", body: global.trim() });
  let out = "";
  for (const part of parts) {
    const block = `# ${part.title}\n\n${part.body}`;
    const next = out ? `${out}\n\n${block}` : block;
    if (next.length > maxChars) {
      if (!out) out = next.slice(0, maxChars);
      break;
    }
    out = next;
  }
  return out;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && bunx vitest run self-evolve/memory-file.test.ts`
预期：PASS（6 个用例）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/self-evolve/memory-file.ts extensions/self-evolve/memory-file.test.ts
git commit -m "feat(self-evolve): add MEMORY.md read + injection formatting"
```

---

## 任务 3：personas.ts（persona 文本 + task 常量）

**文件：**
- 创建：`extensions/self-evolve/personas.ts`

无独立测试（纯文本常量，由后续任务的构建/冒烟覆盖）。

- [ ] **步骤 1：编写文件**

```ts
// extensions/self-evolve/personas.ts
// dream/distill 子代理的默认 persona（系统提示）与触发 task。
// seed.ts 把 persona 播种到 ~/.pi/agent/agents/<name>.md（用户可改）；
// runner.ts 优先读用户文件，缺失则回退这里的常量。

export const DREAM_PERSONA = `# Dream: 记忆固化子代理

你是 Pi 的记忆固化子代理。回顾近期会话，把持久、已验证的知识固化进项目记忆，并维护人类可读的 MEMORY.md。本次为只读分析 + 仅写记忆产物。

## 数据源（只读）
- 历史会话：用 history_search 工具按关键词检索。会话是真相源。
- 已有记忆：用 memory_recall 工具检索 long-term-memory 记忆库。
- 记忆文件：项目 <cwd>/.pi/memory/MEMORY.md，全局 ~/.pi/agent/MEMORY.md。

## 规则
- 会话与记忆库视为只读；只写 MEMORY.md，并经 memory_save 写记忆库。
- 不碰源码（仅可用 glob/grep 验证路径/符号）。
- 高信息密度优先；合并重复，不堆砌。
- 打包重复工作流是 /distill 的职责；本代理仅一行提示候选。

## 步骤
1. 读项目 MEMORY.md，记录现有分节，避免重复。
2. history_search 检索近期会话（关键词如 rule/decision/always/never/记住/约定/报错），以近 7 天为主。
3. 提取候选持久事实：明确的用户规则、架构决策、跨会话重复知识、易错陷阱。
4. 仅当有明确用户陈述 / 清晰设计决策 / 跨会话重复证据时才固化。
5. 固化：
   - memory_save 写 long-term-memory（category：rule/decision/knowledge/pattern/gotcha）。
   - 合并进 MEMORY.md，分节：## Rules / ## Architecture decisions / ## Discovered knowledge / ## Patterns / ## Gotchas。每条 1-3 行，相对日期转 YYYY-MM-DD，末尾附来源会话 id。
6. Prune：去重；删被新决策推翻的过期项；删只对单次会话有意义的细节。MEMORY.md 控制在 200 行 / 10KB 内。用 glob/grep 验证路径/符号，存疑标 [unverified]。
7. 输出简短摘要：新增 / 更新 / 删除 / 跳过原因 / 一行 distill 候选 / MEMORY.md 行数与大小。`;

export const DISTILL_PERSONA = `# Distill: 行为提炼子代理

你是 Pi 的行为提炼子代理。回顾近期工作，识别重复的手工工作流，把高置信的打包成最小形态可复用资产：skill / 子 agent / command。本次为只读分析 + 仅写资产文件。

## 数据源（只读）
- 历史会话：history_search 检索。会话是真相源。
- 记忆：memory_recall + MEMORY.md（## Patterns / ## Rules）找跨会话模式。
- 已有资产：先盘点，避免重复造。

## 规则
- 会话/记忆只读；只写资产文件，不碰源码、不做任何不可逆外部动作。
- 默认产出紧凑短名单 + 建议；证据非常强、最小形态明显时才真正创建。
- 没有真正重复就什么都不造（合法且预期的结果）。

## 步骤
1. 盘点已有资产（glob 读 name+description）：
   - skills：~/.pi/agent/skills/**/SKILL.md 与项目 .pi/skills/**/SKILL.md
   - agents：~/.pi/agent/agents/*.md
   - commands：~/.pi/agent/commands/*.md
   已被覆盖的候选记为「扩展已有」或「跳过」。
2. history_search 检索近 30 天会话，找重复命令序列 / 调试-修复循环 / 多步流程；用户语中「又 / 每次 / 老样子 / 重复」等信号。
3. 候选成立：至少 2 次或明显高频高成本；有稳定输入、可复现步骤、清晰产出/停止条件；能实质提升速度/质量/一致性；未被已有资产覆盖。
4. 短名单：每条含 一行工作流 / 证据与会话 id / 频次置信 / 推荐形态（skill/agent/command/扩展已有/跳过）/ 是否值得。
5. 仅创建高置信缺失项，选最小形态：
   - skill：~/.pi/agent/skills/<name>/SKILL.md，YAML frontmatter（name, description——description 是给模型的触发条件，写成聚焦的祈使句）。
   - 子 agent：~/.pi/agent/agents/<name>.md，frontmatter（description，可选 model/tools）+ 系统提示正文。
   - command：~/.pi/agent/commands/<name>.md，frontmatter（description）+ 用 $ARGUMENTS / $1 的模板正文。
6. 写后用 glob 验证引用路径、grep 验证引用符号。
7. 输出简短摘要：短名单 / 创建或扩展（路径+一行用途，无则写「未创建——无值得打包的重复工作流」）/ 跳过及原因 / 需更多证据的候选。`;

export const DREAM_TASK =
  "对当前项目执行一次 dream 记忆固化。窗口：近 7 天会话（不足则全部）。会话与记忆库为只读真相源，只写 MEMORY.md 与经 memory_save 写记忆库。完成后给出简短摘要。";

export const DISTILL_TASK =
  "对当前项目执行一次 distill 行为提炼。窗口：近 30 天会话。先盘点已有资产再决定。只创建高置信缺失项；无则不创建。完成后给出简短摘要。";
```

- [ ] **步骤 2：Commit**

```bash
git add extensions/self-evolve/personas.ts
git commit -m "feat(self-evolve): add dream/distill persona prompts + tasks"
```

---

## 任务 4：seed.ts（播种 persona 到 ~/.pi/agent/agents/）

**文件：**
- 创建：`extensions/self-evolve/seed.ts`

- [ ] **步骤 1：编写文件**（仿 `extensions/fable-behavior/seed.ts` 模式）

```ts
// extensions/self-evolve/seed.ts
// 把默认 persona 播种到 ~/.pi/agent/agents/{dream,distill}.md（if-absent），用户可覆盖。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { DISTILL_PERSONA, DREAM_PERSONA } from "./personas.js";

export const SELF_EVOLVE_SEED_VERSION = "2026-06-26";

export function seedPersonas(): void {
  if ((getConfig("SELF_EVOLVE_SEED") ?? "1") === "0") return;
  try {
    const dir = join(getAgentDir(), "agents");
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of [
      ["dream", DREAM_PERSONA],
      ["distill", DISTILL_PERSONA],
    ] as const) {
      const file = join(dir, `${name}.md`);
      if (existsSync(file)) continue;
      writeFileSync(file, content, "utf8");
    }
    writeFileSync(join(dir, ".self-evolve-seed-version"), `${SELF_EVOLVE_SEED_VERSION}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add extensions/self-evolve/seed.ts
git commit -m "feat(self-evolve): seed dream/distill personas into agent dir"
```

---

## 任务 5：runner.ts（读 persona、spawn 子代理）

**文件：**
- 创建：`extensions/self-evolve/runner.ts`

参考 `extensions/multi-agent/runner.ts`（`process.execPath` + `--mode json -p`）。fire-and-forget，绝不抛进 session_start。

- [ ] **步骤 1：编写文件**

```ts
// extensions/self-evolve/runner.ts
// fire-and-forget spawn dream/distill 子代理：读用户可改的 persona、拼 task、
// 以受限工具集运行 `pi --mode json -p --no-session`。镜像 multi-agent/runner.ts 的命令解析。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { DISTILL_PERSONA, DISTILL_TASK, DREAM_PERSONA, DREAM_TASK } from "./personas.js";

// 自进化子代理无需联网/出图；其余被 safety 闸 deny（叠加到既有 SAFETY_DENY_TOOLS）。
const NETWORK_DENY = [
  "web_search",
  "web_search_multi",
  "fetch_url",
  "fetch_llms",
  "fetch_html",
  "fetch_markdown",
  "fetch_txt",
  "fetch_json",
  "fetch_github_readme",
  "fetch_web_content",
  "image_gen",
];

function piCommand(): { cmd: string; baseArgs: string[] } {
  const piBin = getConfig("PI_BIN");
  return piBin ? { cmd: piBin, baseArgs: [] } : { cmd: process.execPath, baseArgs: [] };
}

function loadPersona(agent: "dream" | "distill"): string {
  const fallback = agent === "dream" ? DREAM_PERSONA : DISTILL_PERSONA;
  try {
    return readFileSync(join(getAgentDir(), "agents", `${agent}.md`), "utf8").trim() || fallback;
  } catch {
    return fallback;
  }
}

export interface SpawnOpts {
  agent: "dream" | "distill";
  cwd: string;
  model?: string;
  timeoutMs: number;
}

export function spawnEvolveAgent(opts: SpawnOpts): void {
  try {
    const { cmd, baseArgs } = piCommand();
    const task = opts.agent === "dream" ? DREAM_TASK : DISTILL_TASK;
    const prompt = `${loadPersona(opts.agent)}\n\n---\n\n${task}`;
    const args = [...baseArgs, "--mode", "json", "-p", "--no-session", prompt];
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        SELF_EVOLVE_CHILD: "1",
        ...(opts.model ? { SUBAGENT_MODEL: opts.model } : {}),
        SAFETY_DENY_TOOLS: [process.env.SAFETY_DENY_TOOLS, ...NETWORK_DENY].filter(Boolean).join(","),
      },
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);
    child.on("exit", () => clearTimeout(timer));
    child.on("error", () => clearTimeout(timer));
    child.unref?.();
  } catch {
    /* best-effort: never throw into session_start */
  }
}
```

- [ ] **步骤 2：Commit**

```bash
git add extensions/self-evolve/runner.ts
git commit -m "feat(self-evolve): add fire-and-forget subagent spawner"
```

---

## 任务 6：index.ts + package.json + 注册

**文件：**
- 创建：`extensions/self-evolve/index.ts`
- 创建：`extensions/self-evolve/package.json`
- 修改：`extensions/index.ts`

- [ ] **步骤 1：编写 `extensions/self-evolve/index.ts`**

```ts
// extensions/self-evolve: 自进化（dream 知识固化 + distill 行为提炼）。
// session_start 间隔自动触发专用子代理；/dream /distill 手动触发；
// before_agent_start 注入 项目+全局 MEMORY.md。子进程置 SELF_EVOLVE_CHILD 防递归。
import { join } from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { formatInjection, readMemoryFile } from "./memory-file.js";
import { spawnEvolveAgent } from "./runner.js";
import { daysToMs, readMarker, shouldRun, writeMarker } from "./schedule.js";
import { seedPersonas } from "./seed.js";

const auto = () => (getConfig("SELF_EVOLVE_AUTO") ?? "1") !== "0";
const dreamDays = () => Number(getConfig("SELF_EVOLVE_DREAM_INTERVAL_DAYS") ?? "7");
const distillDays = () => Number(getConfig("SELF_EVOLVE_DISTILL_INTERVAL_DAYS") ?? "30");
const memInject = () => (getConfig("SELF_EVOLVE_MEMORY_INJECT") ?? "1") !== "0";
const memMaxChars = () => Number(getConfig("SELF_EVOLVE_MEMORY_MAX_CHARS") ?? "4096") || 4096;
const timeoutMs = () => Number(getConfig("SELF_EVOLVE_TIMEOUT_MS") ?? "300000") || 300000;
const model = () => getConfig("SELF_EVOLVE_MODEL")?.trim() || undefined;
const isChild = () => process.env.SELF_EVOLVE_CHILD === "1";

const projectMemory = (cwd: string) => join(cwd, ".pi", "memory", "MEMORY.md");
const globalMemory = () => join(getAgentDir(), "MEMORY.md");
const dreamMarker = (cwd: string) => join(cwd, ".pi", "memory", ".self-evolve-dream");
const distillMarker = (cwd: string) => join(cwd, ".pi", "memory", ".self-evolve-distill");

async function earliestSessionMs(cwd: string): Promise<number | undefined> {
  const infos = await SessionManager.list(cwd).catch(() => []);
  let min: number | undefined;
  for (const i of infos) {
    const t = +new Date((i as { modified?: string }).modified ?? "");
    if (Number.isFinite(t)) min = min === undefined ? t : Math.min(min, t);
  }
  return min;
}

export default function (pi: ExtensionAPI) {
  let lastDreamSpawn = 0;
  let lastDistillSpawn = 0;

  seedPersonas();

  pi.on("session_start", async (_event, ctx) => {
    if (isChild() || !auto()) return;
    try {
      const now = Date.now();
      const earliest = await earliestSessionMs(ctx.cwd);
      if (
        shouldRun({
          enabled: true,
          intervalMs: daysToMs(dreamDays()),
          lastRunMs: readMarker(dreamMarker(ctx.cwd)),
          earliestSessionMs: earliest,
          now,
          lastSpawnMs: lastDreamSpawn,
        })
      ) {
        lastDreamSpawn = now;
        writeMarker(dreamMarker(ctx.cwd), now);
        spawnEvolveAgent({ agent: "dream", cwd: ctx.cwd, model: model(), timeoutMs: timeoutMs() });
      }
      if (
        shouldRun({
          enabled: true,
          intervalMs: daysToMs(distillDays()),
          lastRunMs: readMarker(distillMarker(ctx.cwd)),
          earliestSessionMs: earliest,
          now,
          lastSpawnMs: lastDistillSpawn,
        })
      ) {
        lastDistillSpawn = now;
        writeMarker(distillMarker(ctx.cwd), now);
        spawnEvolveAgent({ agent: "distill", cwd: ctx.cwd, model: model(), timeoutMs: timeoutMs() });
      }
    } catch {
      /* never block session_start */
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!memInject()) return undefined;
    const body = formatInjection(
      readMemoryFile(projectMemory(ctx.cwd)),
      readMemoryFile(globalMemory()),
      memMaxChars(),
    );
    if (!body) return undefined;
    return { message: { customType: "self-evolve-memory", content: body, display: false } };
  });

  pi.registerCommand("dream", {
    description: "立即固化近期会话知识到记忆库与 MEMORY.md（/dream）",
    handler: async (_args, ctx) => {
      writeMarker(dreamMarker(ctx.cwd), Date.now());
      spawnEvolveAgent({ agent: "dream", cwd: ctx.cwd, model: model(), timeoutMs: timeoutMs() });
      ctx.ui.notify("dream 已在后台启动；完成后结果写入 long-term-memory 与 MEMORY.md。", "info");
    },
  });

  pi.registerCommand("distill", {
    description: "立即提炼近期重复工作流为 skill/agent/command（/distill）",
    handler: async (_args, ctx) => {
      writeMarker(distillMarker(ctx.cwd), Date.now());
      spawnEvolveAgent({ agent: "distill", cwd: ctx.cwd, model: model(), timeoutMs: timeoutMs() });
      ctx.ui.notify("distill 已在后台启动；完成后高置信资产写入 ~/.pi/agent/。", "info");
    },
  });
}
```

- [ ] **步骤 2：编写 `extensions/self-evolve/package.json`**（仿 `extensions/long-term-memory/package.json`）

```json
{
  "name": "@pi-ext/self-evolve",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **步骤 3：注册到 `extensions/index.ts`**

import 区（紧邻 longTermMemory 一行后）加：

```ts
import selfEvolve from "./self-evolve/index.js";
```

`export { ... }` 块内 `longTermMemory,` 后加 `selfEvolve,`。
`allExtensions` 数组内 `longTermMemory,` 后加 `selfEvolve,`。
`namedExtensions` 数组内 `{ name: "long-term-memory", factory: longTermMemory },` 后加：

```ts
  { name: "self-evolve", factory: selfEvolve },
```

- [ ] **步骤 4：typecheck**

运行：`cd cli && npm run typecheck`
预期：PASS（无 self-evolve 相关新错误；既有 39 条技术债不受影响）。若报 self-evolve 错误，按报错修（常见：未用的 import）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/self-evolve/index.ts extensions/self-evolve/package.json extensions/index.ts
git commit -m "feat(self-evolve): wire commands, session_start scheduler, MEMORY.md inject; register extension"
```

---

## 任务 7：构建 sidecar + 冒烟 + 回归

- [ ] **步骤 1：扩展单测全绿**

运行：`cd extensions && bunx vitest run self-evolve/`
预期：PASS（schedule 10 + memory-file 6）。

- [ ] **步骤 2：构建 sidecar**

运行：`cd tauri-agent && npm run build:sidecar`
预期：`GrenAgent sidecar ready: ...`，bun 打包成功。

- [ ] **步骤 3：冒烟——扩展计数 +1**

运行（PowerShell）：
```powershell
$exe = ".\src-tauri\binaries\pi-x86_64-pc-windows-msvc.exe"; $err = [System.IO.Path]::GetTempFileName(); $p = Start-Process -FilePath $exe -ArgumentList "--mode","rpc" -RedirectStandardError $err -RedirectStandardOutput ([System.IO.Path]::GetTempFileName()) -PassThru -WindowStyle Hidden; Start-Sleep -Seconds 5; if (!$p.HasExited) { $p | Stop-Process -Force }; Get-Content $err
```
预期：`[grenagent-sidecar] ready ext=39 safety=on`（38 → 39，self-evolve 已加载）。

- [ ] **步骤 4：冒烟——persona 已播种**

运行（PowerShell）：`Test-Path "$HOME\.pi\agent\agents\dream.md"; Test-Path "$HOME\.pi\agent\agents\distill.md"`
预期：两个 `True`（sidecar 启动时 seedPersonas 已写入）。

- [ ] **步骤 5：Commit（如有构建产物变更，如 sidecar 二进制不纳入版本库则跳过）**

```bash
git add -A
git commit -m "chore(self-evolve): rebuild sidecar with self-evolve extension"
```

---

## 自检

- **规格覆盖度：** dream（任务 3 persona + 任务 6 触发/命令/记忆库复用 + MEMORY.md）✓；distill（任务 3 persona + 任务 6 触发/命令）✓；调度间隔/年龄/防抖（任务 1）✓；MEMORY.md 注入（任务 2 + 任务 6 before_agent_start）✓；persona 播种可改（任务 4）✓；subagent spawn + 工具限制 + 防递归（任务 5）✓；配置项（任务 6）✓；真相源 SessionManager（任务 6 earliestSessionMs + persona 内 history_search）✓；注册（任务 6 步骤 3）✓。
- **占位符扫描：** 任务 6 步骤 1 的 `_runner` 占位行已显式标注删除指引；其余无 TODO/待定。
- **类型一致性：** `spawnEvolveAgent(SpawnOpts)`、`shouldRun(ScheduleInput)`、`readMarker/writeMarker`、`formatInjection/readMemoryFile`、`seedPersonas()` 在定义（任务 1/2/4/5）与调用（任务 6）处签名一致。

## 范围外（YAGNI）

- 不做常驻调度器；仅 session_start + 手动命令。
- 不流式回显子代理输出（手动命令仅 notify「已后台启动」）；如需可后续用 multi-agent runner 的 transcript 流式。
- 不移植 MiMo 远程 skill 市场（discovery.ts）。
- distill 不改源码、不做不可逆外部动作。
