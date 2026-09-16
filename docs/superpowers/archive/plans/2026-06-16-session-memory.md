# 子项目 B：结构化会话状态 + 上下文重建（session-memory）实现计划

> **面向 AI 代理的工作者：** 必需子技能：superpowers:executing-plans（或 subagent-driven-development）。步骤用复选框跟踪。

**目标：** 新增纯扩展 `extensions/session-memory/`：周期性用小模型把对话抽取成结构化 markdown 状态，落 `<cwd>/.pi/session-state/<sessionId>.md`；压缩后下一轮把最新状态注入重新锚定 agent。零核心改动。

**架构：** `turn_end` 计轮；`agent_end` 每 N 轮抽取并写状态；`session_before_compact` 压缩前补写一份（用 branchEntries 的 message）；`session_compact` 置 needReanchor；`before_agent_start` 若 needReanchor 则注入最新状态并清标志。LLM 抽取注入 `AskFn`（可单测）。

**技术栈：** TypeScript（Pi 扩展，ESM `.js`）、node:fs、Vitest。

**规格依据：** `docs/superpowers/specs/2026-06-16-session-memory-design.md`

---

## 关键约束

1. 零核心改动；纯扩展。注入用 `before_agent_start` 返回 `{ message }`（`BeforeAgentStartEventResult`，`types.d.ts:760-764`，现网 `long-term-memory/index.ts:172-178`）。
2. 压缩事件：`session_compact`（后，`types.d.ts:433-437,815`）置标志；`session_before_compact`（前，`:425-431,814`）有 `branchEntries: SessionEntry[]`；`SessionMessageEntry { type:"message"; message: AgentMessage }`（`session-manager.d.ts:23-26`）。
3. 会话标识：`ctx.sessionManager.getSessionId()`（`session-manager.d.ts:136,188`）；`ctx.cwd`（`types.d.ts:216`）。token：`ctx.getContextUsage()`（`:236`）。
4. LLM：`ctx.model`/`ctx.modelRegistry` + pi-ai `completeSimple`（mirror `long-term-memory/llm.ts`）。
5. 自包含不跨扩展 import；可 import `../_shared/*`。测试 `cd extensions && bunx vitest run session-memory/<file>`。
6. 禁 emoji。提交 `git commit -- extensions/session-memory extensions/index.ts`。

## 文件结构

| 文件 | 职责 |
|---|---|
| `extensions/session-memory/package.json` | Pi 包清单 |
| `extensions/session-memory/llm.ts` | AskFn + resolveModel + askLlm（mirror long-term-memory） |
| `extensions/session-memory/transcript.ts` | messageToText + flattenMessages（纯函数） |
| `extensions/session-memory/writer.ts` | extractState(ask, transcript, prev?)（纯函数，失败保留 prev） |
| `extensions/session-memory/store.ts` | statePath/writeState/readState（node:fs） |
| `extensions/session-memory/injector.ts` | buildInjection（预算截断 + header） |
| `extensions/session-memory/index.ts` | 工厂：钩子编排 + /session-state |
| `*.test.ts` | 单测 |
| 修改 `extensions/index.ts` | 接入 `sessionMemory` |

---

## 任务 1：脚手架 + llm + transcript

**文件：** `package.json`、`llm.ts`、`transcript.ts`、`transcript.test.ts`

- [ ] **步骤 1：package.json**（同 goal，name `pi-session-memory`，devDeps 含 pi-coding-agent/pi-ai/pi-agent-core/vitest，scripts.test `vitest run`，pi.extensions `["./index.ts"]`）

- [ ] **步骤 2：llm.ts** —— 复制 `extensions/goal/llm.ts` 全文（AskFn / parseJsonLoose / resolveModel / askLlm 完全一致；session-memory 不需 parseJsonLoose 但保留无害，或删之）。最小版仅需 AskFn + resolveModel + askLlm：

```ts
import type { Context, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type AskFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export function resolveModel(
  current: Model<never> | undefined,
  registry: Pick<ModelRegistry, "find">,
  override: string | undefined,
): Model<never> | undefined {
  const spec = override?.trim();
  if (spec && spec.includes("/")) {
    const slash = spec.indexOf("/");
    const found = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (found) return found as Model<never>;
  }
  return current;
}

export async function askLlm(
  model: Model<never>,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const { completeSimple } = await import("@earendil-works/pi-ai");
  const context: Context = { systemPrompt, messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }] };
  const msg = await completeSimple(model, context, { reasoning: "off", signal } as never);
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}
```

- [ ] **步骤 3：transcript.ts**

```ts
function messageToText(m: unknown): string {
  const obj = (m ?? {}) as { role?: string; content?: unknown };
  const role = obj.role ?? "";
  const content = obj.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((p): p is { type: string; text: string } => !!p && typeof p === "object" && (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return text ? `${role}: ${text}` : "";
}

export function flattenMessages(messages: unknown[], maxChars = 12000): string {
  return messages.map(messageToText).filter(Boolean).join("\n").slice(-maxChars);
}
```

- [ ] **步骤 4：transcript.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { flattenMessages } from "./transcript.js";

describe("flattenMessages", () => {
  it("joins string and block content; keeps tail", () => {
    expect(
      flattenMessages([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "yo" }] },
      ]),
    ).toBe("user: hi\nassistant: yo");
  });
  it("slices to the most recent maxChars", () => {
    expect(flattenMessages([{ role: "user", content: "abcdef" }], 3)).toBe("def");
  });
});
```

- [ ] **步骤 5：运行** `cd extensions && bunx vitest run session-memory/transcript.test.ts` → 2 PASS。

---

## 任务 2：writer（结构化抽取）

**文件：** `writer.ts`、`writer.test.ts`

- [ ] **步骤 1：writer.ts**

```ts
import type { AskFn } from "./llm.js";

const SYSTEM =
  "You maintain a concise working-state summary of a coding session. Given the conversation, output " +
  "GitHub-flavored markdown with EXACTLY these sections (short bullet points): " +
  "'## Intent', '## Next step', '## Task progress', '## Key files', '## Key decisions'. " +
  "If a section has nothing, write '- (none)'. Output only the markdown, no prose around it.";

/** Extract structured state markdown. On empty/failed output, keep `prev` (graceful). */
export async function extractState(ask: AskFn, transcript: string, prev?: string): Promise<string | undefined> {
  try {
    const user = prev
      ? `Previous state:\n${prev}\n\nConversation (most recent last):\n${transcript}`
      : `Conversation (most recent last):\n${transcript}`;
    const out = (await ask(SYSTEM, user)).trim();
    return out.length > 0 ? out : prev;
  } catch {
    return prev;
  }
}
```

- [ ] **步骤 2：writer.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { type AskFn } from "./llm.js";
import { extractState } from "./writer.js";

describe("extractState", () => {
  it("returns extracted markdown on success", async () => {
    const ask: AskFn = async () => "## Intent\n- build X";
    expect(await extractState(ask, "convo")).toBe("## Intent\n- build X");
  });
  it("keeps prev on empty output", async () => {
    const ask: AskFn = async () => "   ";
    expect(await extractState(ask, "convo", "## Intent\n- old")).toBe("## Intent\n- old");
  });
  it("keeps prev on throw", async () => {
    const ask: AskFn = async () => {
      throw new Error("no model");
    };
    expect(await extractState(ask, "convo", "## Intent\n- old")).toBe("## Intent\n- old");
  });
});
```

- [ ] **步骤 3：运行** `cd extensions && bunx vitest run session-memory/writer.test.ts` → 3 PASS。

---

## 任务 3：store + injector

**文件：** `store.ts`、`store.test.ts`、`injector.ts`、`injector.test.ts`

- [ ] **步骤 1：store.ts**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function statePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "session-state", `${sessionId}.md`);
}

export function writeState(path: string, md: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, md, "utf8");
}

export function readState(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
```

- [ ] **步骤 2：store.test.ts**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readState, statePath, writeState } from "./store.js";

describe("store", () => {
  it("write then read round-trips; path uses sessionId", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-"));
    const p = statePath(dir, "sess123");
    expect(p.endsWith(join(".pi", "session-state", "sess123.md"))).toBe(true);
    writeState(p, "## Intent\n- x");
    expect(readState(p)).toBe("## Intent\n- x");
  });
  it("read missing → undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-"));
    expect(readState(statePath(dir, "none"))).toBeUndefined();
  });
});
```

- [ ] **步骤 3：injector.ts**

```ts
export interface InjectionMessage {
  customType: string;
  content: string;
  display: boolean;
}

export function buildInjection(md: string, maxChars: number): InjectionMessage {
  const body = md.length > maxChars ? md.slice(0, maxChars) : md;
  return {
    customType: "session-state",
    content: `# Session working state (restored after compaction)\n\n${body}`,
    display: false,
  };
}
```

- [ ] **步骤 4：injector.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { buildInjection } from "./injector.js";

describe("buildInjection", () => {
  it("wraps with header and is non-display", () => {
    const m = buildInjection("## Intent\n- x", 4000);
    expect(m.customType).toBe("session-state");
    expect(m.display).toBe(false);
    expect(m.content).toContain("# Session working state");
    expect(m.content).toContain("## Intent");
  });
  it("truncates to budget", () => {
    const m = buildInjection("y".repeat(100), 10);
    expect(m.content.endsWith("y".repeat(10))).toBe(true);
  });
});
```

- [ ] **步骤 5：运行** `cd extensions && bunx vitest run session-memory/store.test.ts session-memory/injector.test.ts` → 4 PASS。

---

## 任务 4：工厂（index.ts）

**文件：** `index.ts`、`index.test.ts`

- [ ] **步骤 1：index.ts**

```ts
// session-memory: maintain a structured working-state markdown for the session
// and re-anchor the agent after compaction by injecting the latest state.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../_shared/runtime-config.js";
import { buildInjection } from "./injector.js";
import { type AskFn, askLlm, resolveModel } from "./llm.js";
import { readState, statePath, writeState } from "./store.js";
import { flattenMessages } from "./transcript.js";
import { extractState } from "./writer.js";

const enabled = () => (getConfig("SESSION_STATE_ENABLED") ?? "1") !== "0";
const everyTurns = () => Number(getConfig("SESSION_STATE_EVERY_TURNS") ?? "8") || 8;
const maxChars = () => Number(getConfig("SESSION_STATE_MAX_CHARS") ?? "4000") || 4000;
const stateModel = () => getConfig("SESSION_STATE_MODEL");

export default function (pi: ExtensionAPI) {
  let turnsSinceWrite = 0;
  let needReanchor = false;

  const makeAsk = (ctx: ExtensionContext): AskFn | undefined => {
    const model = resolveModel(
      ctx.model as never,
      (ctx.modelRegistry ?? { find: () => undefined }) as never,
      stateModel(),
    );
    if (!model) return undefined;
    return (system, user) => askLlm(model, system, user, ctx.signal);
  };

  const pathFor = (ctx: ExtensionContext) => statePath(ctx.cwd, ctx.sessionManager.getSessionId());

  const writeFrom = async (ctx: ExtensionContext, messages: unknown[]) => {
    const ask = makeAsk(ctx);
    if (!ask) return;
    const path = pathFor(ctx);
    const md = await extractState(ask, flattenMessages(messages), readState(path));
    if (md) writeState(path, md);
    turnsSinceWrite = 0;
  };

  pi.on("turn_end", async () => {
    turnsSinceWrite += 1;
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled()) return;
    if (turnsSinceWrite >= everyTurns()) await writeFrom(ctx, event.messages as unknown[]);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!enabled()) return;
    const entries = ((event as { branchEntries?: Array<{ type: string; message?: unknown }> }).branchEntries) ?? [];
    const messages = entries.filter((e) => e.type === "message" && e.message).map((e) => e.message);
    if (messages.length) await writeFrom(ctx, messages);
  });

  pi.on("session_compact", async () => {
    needReanchor = true;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!enabled() || !needReanchor) return undefined;
    needReanchor = false;
    const md = readState(pathFor(ctx));
    if (!md) return undefined;
    return { message: buildInjection(md, maxChars()) };
  });

  pi.registerCommand("session-state", {
    description: "查看当前会话的结构化工作状态：/session-state show",
    handler: async (_args, ctx) => {
      ctx.ui.notify(readState(pathFor(ctx)) ?? "暂无会话状态。", "info");
    },
  });
}
```

- [ ] **步骤 2：index.test.ts**

```ts
import { describe, expect, it } from "vitest";
import factory from "./index.js";

describe("session-memory factory", () => {
  it("registers state hooks and /session-state command", () => {
    const commands: string[] = [];
    const events: string[] = [];
    factory({
      registerCommand: (n: string) => commands.push(n),
      on: (e: string) => events.push(e),
    } as never);
    expect(commands).toContain("session-state");
    expect(events).toEqual(
      expect.arrayContaining(["turn_end", "agent_end", "session_before_compact", "session_compact", "before_agent_start"]),
    );
  });
});
```

- [ ] **步骤 3：运行全量** `cd extensions && bunx vitest run session-memory` → 6 文件全 PASS。

---

## 任务 5：接入 + 验证 + 提交

- [ ] **步骤 1：extensions/index.ts** 加 `import sessionMemory from "./session-memory/index.js";`；在 export 块与 allExtensions 的 `longTermMemory,` 之后加 `sessionMemory,`（两处）。

- [ ] **步骤 2：导入冒烟** `cd extensions && bun -e "const m = await import('./index.ts'); console.log(m.allExtensions.length, m.allExtensions.includes(m.sessionMemory));"` → 预期 `20 true`。

- [ ] **步骤 3：lint** ReadLints `extensions/session-memory` + `extensions/index.ts` → 无错。

- [ ] **步骤 4：提交**

```bash
git add extensions/session-memory extensions/index.ts
git commit -m "feat(session-memory): structured session state + post-compaction re-anchor" -- extensions/session-memory extensions/index.ts
```

---

## 自检

**规格覆盖度（对照 `2026-06-16-session-memory-design.md`）：**
- §3 组件 writer/store/injector/index/transcript/llm → 任务 1-4。
- §4 数据流（agent_end 周期写、session_before_compact 补写、session_compact→needReanchor、before_agent_start 注入、/session-state）→ index.ts。
- §6 错误处理（LLM 失败保留 prev、无状态不注入、无模型不写、预算截断）→ writer（prev 回退）+ index（守卫）+ injector（截断）。
- §7 配置（ENABLED/EVERY_TURNS/MAX_CHARS/MODEL）→ index.ts getConfig。
- §8 测试（抽取解析、注入触发去重、持久化/恢复）→ 各 test + index smoke。

**占位符扫描：** 无 TODO；全部步骤含完整代码与命令。

**类型一致性：** `AskFn`（llm.ts，writer/index 复用）；`flattenMessages`（transcript，index 复用）；`statePath/readState/writeState`（store，index 复用）；`buildInjection`（injector，index 复用）；`extractState`（writer，index 复用）。

**MVP 边界：** session_before_compact 用 branchEntries 的 message 抽取；appendEntry 指针留作可选（状态文件以 sessionId 命名，重开同会话即可 readState 恢复）。
