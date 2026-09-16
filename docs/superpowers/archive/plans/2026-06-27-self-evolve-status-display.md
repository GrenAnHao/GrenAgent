# self-evolve 状态显示对齐 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `self-evolve` 的 dream/distill 执行从 silent fire-and-forget 改为复用 `multi-agent` registry + 右坞可见进度，并在主聊天插入 MiMo 语义等价的 Notice（手动仅启动；自动启动+完成）。

**架构：** `runner.ts` 调用 `spawnPiAgent` + `SubAgentRegistry`；`index.ts` 负责 Notice 与 auto 完成回调；前端 `NoticePill` 扩展标题；`ChatView` 保留 slash 短超时。

**技术栈：** TypeScript Pi extensions、Vitest、`multi-agent/runner.ts`、`multi-agent/registry.ts`、GrenAgent React。

**规格：** [2026-06-27-self-evolve-status-display-design.md](../specs/2026-06-27-self-evolve-status-display-design.md)

---

## 文件清单

| 文件 | 职责 |
|---|---|
| `extensions/self-evolve/runner.ts` | 重写：`startEvolveJob` → registry + `spawnPiAgent` |
| `extensions/self-evolve/runner.test.ts` | mock spawn/registry 生命周期 |
| `extensions/self-evolve/index.ts` | 调用新 runner；Notice sendMessage；删除 `ackBackgroundJob` |
| `extensions/self-evolve/package.json` | 如需声明对 multi-agent 的路径（仅 dev 类型，无新 npm 包） |
| `tauri-agent/src/features/chat/NoticePill.tsx` | done/error customType 标题 |
| `tauri-agent/src/features/chat/NoticePill.test.tsx` | 新标题测试 |
| `tauri-agent/src/features/chat/ChatView.tsx` | 已有 slash 2s 超时，确认保留 |

---

## 任务 1：`runner.test.ts` — 定义 `startEvolveJob` 契约

**文件：**
- 创建：`extensions/self-evolve/runner.test.ts`

- [ ] **步骤 1：编写测试文件**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const spawnPiAgent = vi.fn(async () => ({ ok: true, output: "consolidated 3 facts", exitCode: 0, transcript: "" }));

vi.mock("../multi-agent/runner.js", () => ({ spawnPiAgent }));

import { SubAgentRegistry } from "../multi-agent/registry.js";
import { startEvolveJob, waitEvolveJob } from "./runner.js";

describe("startEvolveJob", () => {
  let dir: string;
  let reg: SubAgentRegistry;

  afterEach(() => {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
    spawnPiAgent.mockClear();
  });

  it("registers running row and calls spawnPiAgent with SELF_EVOLVE_CHILD", async () => {
    dir = mkdtempSync(join(tmpdir(), "se-run-"));
    reg = new SubAgentRegistry(join(dir, ".pi", "subagents", "registry.db"));
    const done = vi.fn();
    const { id } = startEvolveJob(
      { agent: "dream", cwd: dir, source: "manual", timeoutMs: 5000 },
      { onComplete: done },
    );
    expect(id).toMatch(/^sa-/);
    expect(spawnPiAgent).toHaveBeenCalledTimes(1);
    const env = spawnPiAgent.mock.calls[0][2].env as Record<string, string>;
    expect(env.SELF_EVOLVE_CHILD).toBe("1");
    await waitEvolveJob(id, dir);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ ok: true, id }));
    const row = reg.get(id);
    expect(row?.status).toBe("done");
    expect(row?.task).toBe("Dream（手动）");
  });

  it("labels auto distill as Auto Distill", async () => {
    dir = mkdtempSync(join(tmpdir(), "se-run-"));
    reg = new SubAgentRegistry(join(dir, ".pi", "subagents", "registry.db"));
    const { id } = startEvolveJob({ agent: "distill", cwd: dir, source: "auto", timeoutMs: 5000 });
    await waitEvolveJob(id, dir);
    expect(reg.get(id)?.task).toBe("Auto Distill");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions && bunx vitest run self-evolve/runner.test.ts`
预期：FAIL（`startEvolveJob` / `waitEvolveJob` 未导出）

---

## 任务 2：重写 `runner.ts`

**文件：**
- 修改：`extensions/self-evolve/runner.ts`

- [ ] **步骤 1：实现 `startEvolveJob`**

核心逻辑（完整替换文件）：

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { spawnPiAgent } from "../multi-agent/runner.js";
import { SubAgentRegistry } from "../multi-agent/registry.js";
import { DISTILL_PERSONA, DISTILL_TASK, DREAM_PERSONA, DREAM_TASK } from "./personas.js";

const NETWORK_DENY = [ /* 保持现有列表 */ ];

const TASK_LABEL: Record<"dream" | "distill", Record<"manual" | "auto", string>> = {
  dream: { manual: "Dream（手动）", auto: "Auto Dream" },
  distill: { manual: "Distill（手动）", auto: "Auto Distill" },
};

function registryFor(cwd: string): SubAgentRegistry {
  return new SubAgentRegistry(join(cwd, ".pi", "subagents", "registry.db"));
}

function loadPersona(agent: "dream" | "distill"): string { /* 保持现有 */ }

function buildPrompt(agent: "dream" | "distill"): string {
  const task = agent === "dream" ? DREAM_TASK : DISTILL_TASK;
  return `${loadPersona(agent)}\n\n---\n\n${task}`;
}

function evolveEnv(model?: string): Record<string, string> {
  return {
    ...process.env,
    SELF_EVOLVE_CHILD: "1",
    ...(model ? { SUBAGENT_MODEL: model } : {}),
    SAFETY_DENY_TOOLS: [process.env.SAFETY_DENY_TOOLS, ...NETWORK_DENY].filter(Boolean).join(","),
  };
}

export interface EvolveJobOpts {
  agent: "dream" | "distill";
  cwd: string;
  source: "manual" | "auto";
  model?: string;
  timeoutMs: number;
}

export interface EvolveJobResult {
  id: string;
  ok: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

const inflight = new Map<string, Promise<EvolveJobResult>>();

export function startEvolveJob(
  opts: EvolveJobOpts,
  hooks?: { onComplete?: (r: EvolveJobResult) => void },
): { id: string } {
  const registry = registryFor(opts.cwd);
  const id = SubAgentRegistry.genId();
  const task = TASK_LABEL[opts.agent][opts.source];
  const profile = JSON.stringify({ preset: opts.agent, source: opts.source });
  registry.create({ id, task, profile, model: opts.model ?? null });

  const prompt = buildPrompt(opts.agent);
  const p = spawnPiAgent(opts.cwd, prompt, {
    model: opts.model ?? getConfig("SELF_EVOLVE_MODEL")?.trim() || getConfig("SUBAGENT_MODEL")?.trim(),
    systemPrompt: undefined,
    timeoutMs: opts.timeoutMs,
    env: evolveEnv(opts.model),
    onUpdate: () => registry.touch(id),
  })
    .then((r) => {
      registry.finish(id, {
        status: r.ok ? "done" : "error",
        output: r.output,
        error: r.error ?? null,
        exitCode: r.exitCode,
      });
      const result: EvolveJobResult = {
        id,
        ok: r.ok,
        output: r.output,
        error: r.error,
        exitCode: r.exitCode,
      };
      hooks?.onComplete?.(result);
      return result;
    })
    .catch((e) => {
      const msg = String((e as Error)?.message ?? e);
      registry.finish(id, { status: "error", error: msg, exitCode: -1 });
      const result: EvolveJobResult = { id, ok: false, output: "", error: msg, exitCode: -1 };
      hooks?.onComplete?.(result);
      return result;
    })
    .finally(() => {
      registry.close();
      inflight.delete(id);
    });

  inflight.set(id, p);
  return { id };
}

/** 测试与 session_start 同步等待用（生产 fire-and-forget 可不 await） */
export function waitEvolveJob(id: string, cwd: string): Promise<EvolveJobResult> {
  const pending = inflight.get(id);
  if (pending) return pending;
  const row = registryFor(cwd).get(id);
  registryFor(cwd).close();
  return Promise.resolve({
    id,
    ok: row?.status === "done",
    output: row?.output ?? "",
    error: row?.error ?? undefined,
    exitCode: row?.exitCode ?? -1,
  });
}

/** @deprecated 使用 startEvolveJob */
export function spawnEvolveAgent(opts: { agent: "dream" | "distill"; cwd: string; model?: string; timeoutMs: number }): void {
  startEvolveJob({ ...opts, source: "manual" });
}
```

- [ ] **步骤 2：运行 runner 测试**

运行：`cd extensions && bunx vitest run self-evolve/runner.test.ts`
预期：PASS

---

## 任务 3：`index.ts` — Notice 与 auto 完成回调

**文件：**
- 修改：`extensions/self-evolve/index.ts`

- [ ] **步骤 1：替换 spawn 调用与 Notice 逻辑**

```ts
function taskLabel(agent: "dream" | "distill", source: "manual" | "auto"): string {
  return source === "auto" ? (agent === "dream" ? "Auto Dream" : "Auto Distill") : agent === "dream" ? "Dream" : "Distill";
}

function postNotice(
  pi: ExtensionAPI,
  customType: string,
  lines: string[],
) {
  pi.sendMessage(
    { customType, content: lines.join("\n"), display: true },
    { triggerTurn: false },
  );
}

function runEvolve(
  pi: ExtensionAPI,
  agent: "dream" | "distill",
  source: "manual" | "auto",
  ctx: ExtensionContext,
) {
  const label = taskLabel(agent, source);
  postNotice(pi, `self-evolve-${agent}-start`, [
    `- **${label}** 已在后台运行`,
    "- 点右上角 Bot 图标查看进度与完整 transcript",
  ]);
  startEvolveJob(
    { agent, cwd: ctx.cwd, source, model: model(), timeoutMs: timeoutMs() },
    source === "auto"
      ? {
          onComplete: (r) => {
            if (r.ok) {
              const summary = r.output.trim().slice(0, 400) || "（无文本摘要）";
              postNotice(pi, `self-evolve-${agent}-done`, [`- **${label}** 已完成`, `- ${summary}`]);
              return;
            }
            postNotice(pi, `self-evolve-${agent}-error`, [
              `- **${label}** 失败`,
              `- ${r.error ?? "unknown error"}`,
            ]);
          },
        }
      : undefined,
  );
}
```

- session_start 与 registerCommand handler 均改调 `runEvolve(pi, agent, source, ctx)`。
- 删除 `ackBackgroundJob`。
- `import { startEvolveJob } from "./runner.js"`。

- [ ] **步骤 2：运行 self-evolve 全量单测**

运行：`cd extensions && bunx vitest run self-evolve/`
预期：PASS（16 + runner 新增）

---

## 任务 4：前端 NoticePill 标题

**文件：**
- 修改：`tauri-agent/src/features/chat/NoticePill.tsx`
- 修改：`tauri-agent/src/features/chat/NoticePill.test.tsx`

- [ ] **步骤 1：扩展 TITLES**

```ts
const TITLES: Record<string, string> = {
  'knowledge-rag': '已注入知识库上下文',
  'long-term-memory': '已注入长期记忆',
  'self-evolve-dream-start': 'Dream 已启动',
  'self-evolve-distill-start': 'Distill 已启动',
  'self-evolve-dream-done': 'Auto Dream 已完成',
  'self-evolve-distill-done': 'Auto Distill 已完成',
  'self-evolve-dream-error': 'Auto Dream 失败',
  'self-evolve-distill-error': 'Auto Distill 失败',
};
```

- [ ] **步骤 2：测试 + 运行**

运行：`cd tauri-agent && bunx vitest run src/features/chat/NoticePill.test.tsx`
预期：PASS

---

## 任务 5：构建与冒烟

- [ ] **步骤 1：typecheck**

运行：`cd cli && npm run typecheck 2>&1 | findstr /i self-evolve`
预期：无 self-evolve 相关新错误

- [ ] **步骤 2：构建 sidecar**

运行：`cd tauri-agent && npm run build:sidecar`
预期：`ready ext=39`

- [ ] **步骤 3：冒烟（手动）**

1. GrenAgent 发 `/dream` → 主聊天出现「Dream 已启动」Notice；右上角 Bot 角标；右坞可看 running transcript。
2. 触发 auto（或临时 `SELF_EVOLVE_DREAM_INTERVAL_DAYS=0`）→ 启动 + 完成两条 Notice。

- [ ] **步骤 4：Commit（用户要求时）**

```bash
git add extensions/self-evolve/ tauri-agent/src/features/chat/NoticePill.* docs/superpowers/specs/2026-06-27-self-evolve-status-display-design.md docs/superpowers/plans/2026-06-27-self-evolve-status-display.md
git commit -m "feat(self-evolve): registry-backed dream/distill with chat notices and dock visibility"
```

---

## 自检

- **规格覆盖度：** registry 路径、Notice 类型、auto 完成 Notice、手动仅 start、MiMo 工具限制、schedule 不变、ChatView 短超时 — 均已映射到任务 2–5。
- **占位符：** 无 TODO/待定。
- **类型一致性：** `EvolveJobOpts.source`、`TASK_LABEL`、`customType` 后缀在各任务一致。

## 执行方式

计划已保存。可选：

1. **子代理驱动（推荐）** — 每任务独立子代理 + 审查  
2. **内联执行** — 当前会话按任务顺序实现

请指定执行方式后开始编码。
