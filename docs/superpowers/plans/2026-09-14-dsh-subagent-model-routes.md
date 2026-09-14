# DSH 子代理第六期：子级模型路由 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 模型侧为子级显式选路由默认关闭；用户在设置里开开关并勾白名单后新建的会话，`spawn_agent` 才暴露 `model` / `thinking_level`，并注册 `list_subagent_models`；显式路由必须落在白名单 ∩ 实时可用目录内。

**架构：** 新模块 `model-selection.ts` 负责读策略 + 两个断言；`index.ts` factory 时读一次策略决定 schema 与是否注册发现工具（`list-models-tool.ts`）；`thinking_level` 经 `executeSubagent` 透传到 embedded（`createAgentSessionFromServices({ thinkingLevel })`）与子进程（`--thinking`）。设置页加 `SUBAGENT_MODEL_SELECTION`（boolean）与 `SUBAGENT_MODEL_ALLOWLIST`（新字段类型 `model-list`）。

**技术栈：** TypeScript、typebox、vitest、React + antd（设置页）。

**规格：** `docs/superpowers/specs/2026-09-14-dsh-subagent-model-routes-design.md`

**前置：** 第五期计划（`2026-09-14-dsh-subagent-delegation-scope.md`）已落地——本计划改到的 `executeSubagent` 已含 `withDelegationScope`。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `extensions/multi-agent/model-selection.ts` | 创建 | `readModelSelectionPolicy`、`assertRouteAllowed`、`assertThinkingLevel`、`THINKING_LEVELS` |
| `extensions/multi-agent/model-selection.test.ts` | 创建 | 纯函数单测 |
| `extensions/multi-agent/list-models-tool.ts` | 创建 | `registerListSubagentModels(pi, policy)` |
| `extensions/multi-agent/list-models-tool.test.ts` | 创建 | 交集 / 过滤 / 空态 |
| `extensions/multi-agent/index.ts` | 修改 | schema 按策略构造；execute 校验；`thinkingLevel` 透传；注册发现工具 |
| `extensions/multi-agent/index.test.ts` | 修改 | 关 / 开两态 |
| `extensions/multi-agent/embedded-runner.ts` | 修改 | `thinkingLevel` → SDK；`excludeTools` 加 `list_subagent_models`；meta 记 `thinkingLevel` |
| `extensions/multi-agent/embedded-runner.run.test.ts` | 修改 | 透传断言 |
| `extensions/multi-agent/runner.ts` | 修改 | `--thinking` 参数 |
| `extensions/multi-agent/runner.test.ts` | 修改 | 参数位置断言 |
| `electron-agent/src/features/settings/settingsSchema.ts` | 修改 | `FieldType` 加 `'model-list'`；两个键 |
| `electron-agent/src/features/settings/ModelListField.tsx` | 创建 | 多选路由控件 |
| `electron-agent/src/features/settings/ModelListField.test.tsx` | 创建 | 存取 / 不可用条目 |
| `electron-agent/src/features/settings/SettingField.tsx` | 修改 | `case 'model-list'` |
| `electron-agent/src/features/settings/settingsSchema.test.ts` | 修改 | 两键存在 |

已核实的接口：`ExtensionContext.modelRegistry.getAvailable(): Model[]`；`Model` 有 `provider`、`id`、`name`、`reasoning: boolean`、`thinkingLevelMap?: Record<ThinkingLevel, string | null>`（null 标不支持）；`createAgentSessionFromServices` 接受 `thinkingLevel?: ThinkingLevel`；CLI 接受 `--thinking <level>`；设置页 boolean 默认存 `'1'` / `'0'`。

---

### 任务 1：策略读取与断言（`model-selection.ts`）

**文件：**
- 创建：`extensions/multi-agent/model-selection.ts`
- 创建：`extensions/multi-agent/model-selection.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
// extensions/multi-agent/model-selection.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));
import { getConfig } from "../_shared/runtime-config.js";
import { assertRouteAllowed, assertThinkingLevel, readModelSelectionPolicy, THINKING_LEVELS } from "./model-selection.js";

function cfg(map: Record<string, string | undefined>): void {
  vi.mocked(getConfig).mockImplementation((k: string) => map[k]);
}

const model = (provider: string, id: string, reasoning = false) => ({ provider, id, name: id, reasoning }) as never;

beforeEach(() => vi.resetAllMocks());

describe("readModelSelectionPolicy", () => {
  it("disabled when switch off even with allowlist", () => {
    cfg({ SUBAGENT_MODEL_SELECTION: "0", SUBAGENT_MODEL_ALLOWLIST: '["a/b"]' });
    expect(readModelSelectionPolicy().enabled).toBe(false);
  });
  it("disabled when switch on but allowlist empty", () => {
    cfg({ SUBAGENT_MODEL_SELECTION: "1", SUBAGENT_MODEL_ALLOWLIST: "[]" });
    expect(readModelSelectionPolicy().enabled).toBe(false);
  });
  it("enabled with '1' or 'true' and a non-empty list", () => {
    cfg({ SUBAGENT_MODEL_SELECTION: "true", SUBAGENT_MODEL_ALLOWLIST: '["a/b"," c/d "]' });
    const p = readModelSelectionPolicy();
    expect(p.enabled).toBe(true);
    expect([...p.allowlist]).toEqual(["a/b", "c/d"]);
  });
  it("bad JSON → empty list → disabled", () => {
    cfg({ SUBAGENT_MODEL_SELECTION: "1", SUBAGENT_MODEL_ALLOWLIST: "not json" });
    expect(readModelSelectionPolicy().enabled).toBe(false);
  });
});

describe("assertRouteAllowed", () => {
  const policy = { enabled: true, allowlist: new Set(["a/b"]) };
  it("rejects a route outside the allowlist", () => {
    expect(() => assertRouteAllowed("x/y", policy, [model("x", "y")])).toThrow("路由 x/y 不在授权白名单");
  });
  it("rejects an allowlisted route that is not available", () => {
    expect(() => assertRouteAllowed("a/b", policy, [])).toThrow("路由 a/b 当前不可用");
  });
  it("passes an allowlisted, available route", () => {
    expect(() => assertRouteAllowed("a/b", policy, [model("a", "b")])).not.toThrow();
  });
});

describe("assertThinkingLevel", () => {
  it("rejects a non-enum level", () => {
    expect(() => assertThinkingLevel("turbo", model("a", "b", true))).toThrow("thinking_level 无效");
  });
  it("rejects a non-off level on a model without reasoning", () => {
    expect(() => assertThinkingLevel("medium", model("a", "b", false))).toThrow("模型 a/b 不支持思考档");
  });
  it("accepts off on a model without reasoning", () => {
    expect(() => assertThinkingLevel("off", model("a", "b", false))).not.toThrow();
  });
  it("accepts high on a reasoning model", () => {
    expect(() => assertThinkingLevel("high", model("a", "b", true))).not.toThrow();
  });
  it("rejects a level the model maps to null", () => {
    const m = { ...(model("a", "b", true) as object), thinkingLevelMap: { xhigh: null } } as never;
    expect(() => assertThinkingLevel("xhigh", m)).toThrow("模型 a/b 不支持思考档 xhigh");
  });
  it("exports the SDK enum", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/model-selection --reporter=dot`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现**

```ts
// extensions/multi-agent/model-selection.ts
// 子级模型路由授权：用户白名单 + 实时目录交集；thinking_level 校验。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getConfig } from "../_shared/runtime-config.js";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ModelSelectionPolicy {
  enabled: boolean;
  allowlist: Set<string>;
}

export interface RouteModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function readModelSelectionPolicy(): ModelSelectionPolicy {
  const sw = getConfig("SUBAGENT_MODEL_SELECTION")?.trim().toLowerCase();
  const allowlist = parseAllowlist(getConfig("SUBAGENT_MODEL_ALLOWLIST"));
  const enabled = (sw === "1" || sw === "true") && allowlist.size > 0;
  return { enabled, allowlist };
}

export function routeOf(m: RouteModel): string {
  return `${m.provider}/${m.id}`;
}

export function assertRouteAllowed(route: string, policy: ModelSelectionPolicy, available: readonly RouteModel[]): void {
  if (!policy.allowlist.has(route)) throw new Error(`路由 ${route} 不在授权白名单`);
  if (!available.some((m) => routeOf(m) === route)) throw new Error(`路由 ${route} 当前不可用`);
}

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

export function assertThinkingLevel(level: string, model: RouteModel): void {
  if (!isThinkingLevel(level)) throw new Error(`thinking_level 无效：${level}（可选 ${THINKING_LEVELS.join("/")}）`);
  if (level === "off") return;
  if (!model.reasoning) throw new Error(`模型 ${routeOf(model)} 不支持思考档`);
  if (model.thinkingLevelMap && model.thinkingLevelMap[level] === null) {
    throw new Error(`模型 ${routeOf(model)} 不支持思考档 ${level}`);
  }
}

/** 一个模型可用的思考档：无 reasoning 只有 off；有则去掉 map 里标 null 的。 */
export function supportedThinkingLevels(model: RouteModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((l) => model.thinkingLevelMap?.[l] !== null);
}
```

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent/model-selection --reporter=dot`
预期：PASS（13 tests）

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/model-selection.ts extensions/multi-agent/model-selection.test.ts
git commit -m "feat(multi-agent): 子级模型路由策略读取与校验"
```

---

### 任务 2：发现工具 `list_subagent_models`

**文件：**
- 创建：`extensions/multi-agent/list-models-tool.ts`
- 创建：`extensions/multi-agent/list-models-tool.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
// extensions/multi-agent/list-models-tool.test.ts
import { describe, expect, it, vi } from "vitest";
import { registerListSubagentModels } from "./list-models-tool.js";

type Execute = (id: string, params: Record<string, unknown>, s: null, u: null, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function harness(policy: { enabled: boolean; allowlist: Set<string> }) {
  let exec: Execute | undefined;
  const pi = { registerTool: (t: { name: string; execute: Execute }) => { if (t.name === "list_subagent_models") exec = t.execute; } };
  registerListSubagentModels(pi as never, policy);
  return exec;
}

const m = (provider: string, id: string, reasoning = false, name?: string) => ({ provider, id, name: name ?? id, reasoning });
const ctxWith = (models: unknown[]) => ({ cwd: "/p", modelRegistry: { getAvailable: () => models } });

describe("list_subagent_models", () => {
  it("is not registered when policy is disabled", () => {
    expect(harness({ enabled: false, allowlist: new Set(["a/b"]) })).toBeUndefined();
  });

  it("lists allowlist ∩ available with thinking levels", async () => {
    const exec = harness({ enabled: true, allowlist: new Set(["a/b", "a/c", "z/z"]) })!;
    const r = await exec("t", {}, null, null, ctxWith([m("a", "b", true, "B model"), m("a", "c", false), m("q", "q")]));
    const text = r.content[0].text;
    expect(text).toContain("a/b — B model；思考档：off/minimal/low/medium/high/xhigh/max");
    expect(text).toContain("a/c — c；思考档：off");
    expect(text).not.toContain("z/z");
    expect(text).not.toContain("q/q");
  });

  it("filters by provider", async () => {
    const exec = harness({ enabled: true, allowlist: new Set(["a/b", "c/d"]) })!;
    const r = await exec("t", { provider: "c" }, null, null, ctxWith([m("a", "b"), m("c", "d")]));
    expect(r.content[0].text).toContain("c/d");
    expect(r.content[0].text).not.toContain("a/b");
  });

  it("empty intersection is a plain message, not an error", async () => {
    const exec = harness({ enabled: true, allowlist: new Set(["a/b"]) })!;
    const r = await exec("t", {}, null, null, ctxWith([]));
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toBe("白名单内暂无可用模型");
  });

  it("registry failure is treated as empty", async () => {
    const exec = harness({ enabled: true, allowlist: new Set(["a/b"]) })!;
    const r = await exec("t", {}, null, null, { cwd: "/p", modelRegistry: { getAvailable: () => { throw new Error("boom"); } } });
    expect(r.content[0].text).toBe("白名单内暂无可用模型");
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/list-models-tool --reporter=dot`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现**

```ts
// extensions/multi-agent/list-models-tool.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { routeOf, supportedThinkingLevels, type ModelSelectionPolicy, type RouteModel } from "./model-selection.js";

export function availableModels(ctx: { modelRegistry?: { getAvailable?: () => unknown } }): RouteModel[] {
  try {
    const list = ctx.modelRegistry?.getAvailable?.();
    return Array.isArray(list) ? (list as RouteModel[]) : [];
  } catch {
    return [];
  }
}

export function registerListSubagentModels(pi: ExtensionAPI, policy: ModelSelectionPolicy): void {
  if (!policy.enabled) return;
  pi.registerTool({
    name: "list_subagent_models",
    label: "List Sub-agent Models",
    description:
      "List the model routes you may pick for a sub-agent (`spawn_agent` `model`), with each route's supported thinking levels. " +
      "Omit `provider` to list every authorized route.",
    parameters: Type.Object({
      provider: Type.Optional(Type.String({ description: "Only list routes of this provider id." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const filter = typeof params.provider === "string" ? params.provider.trim() : "";
      const rows = availableModels(ctx as never)
        .filter((m) => policy.allowlist.has(routeOf(m)))
        .filter((m) => !filter || m.provider === filter)
        .map((m) => `${routeOf(m)} — ${m.name ?? m.id}；思考档：${supportedThinkingLevels(m).join("/")}`);
      return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "白名单内暂无可用模型" }] };
    },
  });
}
```

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent/list-models-tool --reporter=dot`
预期：PASS（5 tests）

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/list-models-tool.ts extensions/multi-agent/list-models-tool.test.ts
git commit -m "feat(multi-agent): list_subagent_models 发现工具"
```

---

### 任务 3：`thinkingLevel` 透传（embedded + 子进程）

**文件：**
- 修改：`extensions/multi-agent/embedded-runner.ts`（`EmbeddedSubagentOpts`、`buildExcludeTools`、`openEmbeddedChildSession` 的 meta 与 `createAgentSessionFromServices`）
- 修改：`extensions/multi-agent/embedded-runner.run.test.ts`
- 修改：`extensions/multi-agent/runner.ts`（`SpawnPiAgentOpts`、`buildSubagentLaunch`）
- 修改：`extensions/multi-agent/runner.test.ts`

- [ ] **步骤 1：写失败的测试（runner）**

`runner.test.ts` 的 `describe("buildSubagentLaunch")` 内追加：

```ts
  it("thinkingLevel → --thinking，位置在 --mode 之前", () => {
    const launch = buildSubagentLaunch("D:/a", "t", { thinkingLevel: "high" });
    const i = launch.args.indexOf("--thinking");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(launch.args[i + 1]).toBe("high");
    expect(i).toBeLessThan(launch.args.indexOf("--mode"));
    launch.cleanup();
  });

  it("未给 thinkingLevel 则不传 --thinking", () => {
    const launch = buildSubagentLaunch("D:/a", "t", {});
    expect(launch.args).not.toContain("--thinking");
    launch.cleanup();
  });
```

- [ ] **步骤 2：写失败的测试（embedded）**

`embedded-runner.run.test.ts` 的 `describe("runEmbeddedSubagent")` 内追加（照该文件已有用例的写法：`createAgentSessionFromServices.mockResolvedValue({ session: fakeSession(...) })` 后调用 `runEmbeddedSubagent`）：

```ts
  it("passes thinkingLevel into createAgentSessionFromServices and records it in subagent_meta", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-x", thinkingLevel: "medium" });
    const arg = createAgentSessionFromServices.mock.calls[0]?.[0] as { thinkingLevel?: string; excludeTools?: string[] };
    expect(arg.thinkingLevel).toBe("medium");
    expect(arg.excludeTools).toContain("list_subagent_models");
    const meta = appendCustomEntry.mock.calls.find((c) => c[0] === "subagent_meta")?.[1] as { thinkingLevel?: string };
    expect(meta.thinkingLevel).toBe("medium");
  });

  it("omits thinkingLevel when not given", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-y" });
    const arg = createAgentSessionFromServices.mock.calls[0]?.[0] as { thinkingLevel?: string };
    expect(arg).not.toHaveProperty("thinkingLevel");
  });
```

- [ ] **步骤 3：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/runner multi-agent/embedded-runner.run --reporter=dot`
预期：新增 4 个 FAIL

- [ ] **步骤 4：实现（runner.ts）**

`SpawnPiAgentOpts` 加：

```ts
  /** Sub-agent thinking level → passed via --thinking. */
  thinkingLevel?: string;
```

`buildSubagentLaunch` 里 `const args = [ ...baseArgs, ...buildSubagentSkillArgs(...), "--mode", "json", … ]` 改为先放 `--thinking`：

```ts
  const args = [
    ...baseArgs,
    ...buildSubagentSkillArgs(getConfig("SUBAGENT_SKILLS_ROOT")),
    ...(opts.thinkingLevel ? ["--thinking", opts.thinkingLevel] : []),
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-approve",
  ];
```

- [ ] **步骤 5：实现（embedded-runner.ts）**

`EmbeddedSubagentOpts` 加 `thinkingLevel?: ThinkingLevel;`（import `type ThinkingLevel` from `"@earendil-works/pi-agent-core"`）。

`buildExcludeTools` 的 deny 初值改为：

```ts
  const deny = new Set(["spawn_agent", "explore_context", "list_subagent_models"]);
```

`openEmbeddedChildSession` 的 `subagent_meta` 对象追加一项（在 `inheritedEventCount,` 之后）：

```ts
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
```

`createAgentSessionFromServices({ … })` 调用追加：

```ts
    ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
```

- [ ] **步骤 6：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent/runner multi-agent/embedded-runner --reporter=dot`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add extensions/multi-agent/runner.ts extensions/multi-agent/runner.test.ts extensions/multi-agent/embedded-runner.ts extensions/multi-agent/embedded-runner.run.test.ts
git commit -m "feat(multi-agent): thinkingLevel 透传到 embedded 与子进程"
```

---

### 任务 4：`spawn_agent` 工具面按策略构造与校验

**文件：**
- 修改：`extensions/multi-agent/index.ts`（import、`executeSubagent` opts、factory 顶部、`parameters`、`execute` 开头、四处 `executeSubagent` / `startContinuableEmbedded` 调用）
- 修改：`extensions/multi-agent/index.test.ts`

- [ ] **步骤 1：写失败的测试**

`index.test.ts` 顶部 `loadSpawnHarness` 需要能拿到 schema 与是否注册了发现工具。把它改成：

```ts
function loadSpawnHarness(): {
  execute: Execute;
  appendEntry: ReturnType<typeof vi.fn>;
  handlers: Record<string, SessionHandler>;
  schema: Record<string, unknown>;
  toolNames: string[];
} {
  let exec: Execute | undefined;
  let schema: Record<string, unknown> = {};
  const toolNames: string[] = [];
  const appendEntry = vi.fn();
  const handlers: Record<string, SessionHandler> = {};
  const pi = {
    registerTool: (t: { name: string; execute: Execute; parameters?: { properties?: Record<string, unknown> } }) => {
      toolNames.push(t.name);
      if (t.name === "spawn_agent") {
        exec = t.execute;
        schema = t.parameters?.properties ?? {};
      }
    },
    registerCommand: () => {},
    sendUserMessage: () => {},
    on: (event: string, h: SessionHandler) => {
      handlers[event] = h;
    },
    appendEntry,
  };
  multiAgent(pi as unknown as Parameters<typeof multiAgent>[0]);
  return { execute: exec!, appendEntry, handlers, schema, toolNames };
}
```

文件末尾追加（`enable` / `AVAIL` / `ctxM` 放在 describe **外面**的文件顶层，步骤 4 修旧用例时也要用）：

```ts
const AVAIL = [{ provider: "a", id: "b", name: "b", reasoning: true }, { provider: "a", id: "c", name: "c", reasoning: false }];
const ctxM = { ...ctx, modelRegistry: { getAvailable: () => AVAIL } };
const enable = (list = '["a/b","a/c"]') =>
  vi.mocked(getConfig).mockImplementation((k: string) =>
    k === "SUBAGENT_MAX_PER_SESSION" ? "0" : k === "SUBAGENT_MODEL_SELECTION" ? "1" : k === "SUBAGENT_MODEL_ALLOWLIST" ? list : undefined,
  );

describe("spawn_agent · model selection policy", () => {
  it("disabled: schema has no model fields and no list tool", () => {
    const h = loadSpawnHarness();
    expect(h.schema).not.toHaveProperty("model");
    expect(h.schema).not.toHaveProperty("thinking_level");
    expect(h.toolNames).not.toContain("list_subagent_models");
  });

  it("disabled: explicit model is rejected before spawning", async () => {
    const h = loadSpawnHarness();
    const r = await h.execute("t", { task: "x", model: "a/b" }, null, null, ctxM);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("子代理路由选择未开启");
    expect(spawnPiAgent).not.toHaveBeenCalled();
  });

  it("disabled: tasks[].model / chain[].model / profile.model are rejected too", async () => {
    const h = loadSpawnHarness();
    for (const params of [
      { tasks: [{ task: "x", model: "a/b" }] },
      { chain: [{ task: "x", model: "a/b" }] },
      { task: "x", profile: { model: "a/b" } },
      { task: "x", thinking_level: "high" },
    ]) {
      const r = await h.execute("t", params, null, null, ctxM);
      expect(r.isError).toBe(true);
    }
    expect(spawnPiAgent).not.toHaveBeenCalled();
  });

  it("disabled: SUBAGENT_MODEL default still applies (user config, not model choice)", async () => {
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "0" : k === "SUBAGENT_MODEL" ? "x/y" : undefined));
    await loadSpawnAgent()("t", { task: "x" }, null, null, ctxM);
    expect(vi.mocked(spawnPiAgent).mock.calls[0]?.[2]?.model).toBe("x/y");
  });

  it("enabled: schema exposes model + thinking_level and registers the list tool", () => {
    enable();
    const h = loadSpawnHarness();
    expect(h.schema).toHaveProperty("model");
    expect(h.schema).toHaveProperty("thinking_level");
    expect(h.toolNames).toContain("list_subagent_models");
  });

  it("enabled: allowlisted available route spawns; thinking_level is forwarded", async () => {
    enable();
    await loadSpawnAgent()("t", { task: "x", model: "a/b", thinking_level: "high" }, null, null, ctxM);
    const opts = vi.mocked(spawnPiAgent).mock.calls[0]?.[2];
    expect(opts?.model).toBe("a/b");
    expect(opts?.thinkingLevel).toBe("high");
  });

  it("enabled: route outside allowlist is rejected", async () => {
    enable('["a/b"]');
    const r = await loadSpawnAgent()("t", { task: "x", model: "a/c" }, null, null, ctxM);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("不在授权白名单");
    expect(spawnPiAgent).not.toHaveBeenCalled();
  });

  it("enabled: thinking_level on a non-reasoning model is rejected", async () => {
    enable();
    const r = await loadSpawnAgent()("t", { task: "x", model: "a/c", thinking_level: "medium" }, null, null, ctxM);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("不支持思考档");
  });

  it("enabled: one bad task in tasks[] aborts the whole batch", async () => {
    enable('["a/b"]');
    const r = await loadSpawnAgent()("t", { tasks: [{ task: "ok", model: "a/b" }, { task: "bad", model: "a/c" }] }, null, null, ctxM);
    expect(r.isError).toBe(true);
    expect(spawnPiAgent).not.toHaveBeenCalled();
  });
});
```

`Execute` 类型的返回值要加 `isError?: boolean`：

```ts
) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown>; isError?: boolean }>;
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/index -t "model selection policy" --reporter=dot`
预期：9 个 FAIL

- [ ] **步骤 3：实现**

`index.ts` import 追加：

```ts
import { assertRouteAllowed, assertThinkingLevel, readModelSelectionPolicy, routeOf, THINKING_LEVELS } from "./model-selection.js";
import { availableModels, registerListSubagentModels } from "./list-models-tool.js";
```

`executeSubagent` 的 `opts` 类型已含 `Parameters<typeof spawnPiAgent>[2]`，任务 3 给 `SpawnPiAgentOpts` 加了 `thinkingLevel`，只需在 embedded 分支多传一项：

```ts
      thinkingLevel: opts.thinkingLevel as ThinkingLevel | undefined,
```

（import `type ThinkingLevel` from `"@earendil-works/pi-agent-core"`。）

factory（`export default function (pi: ExtensionAPI) {`）开头加：

```ts
  const modelPolicy = readModelSelectionPolicy();
  registerListSubagentModels(pi, modelPolicy);
  const modelField = (desc: string) =>
    modelPolicy.enabled ? { model: Type.Optional(Type.String({ description: desc })) } : {};
```

`parameters: Type.Object({ … })` 里四处 `model` 改为条件展开：

```ts
    parameters: Type.Object({
      task: Type.Optional(Type.String({ description: "A single task for one sub-agent" })),
      ...modelField("Model route (provider/id) for `task`. Must come from `list_subagent_models`; omit to use the configured default."),
      tasks: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Object({
              task: Type.String(),
              ...modelField("Model route for this task; must come from `list_subagent_models`."),
              agent: Type.Optional(Type.String()),
            }),
          ]),
          { description: "Multiple tasks in parallel; each item may be a string or { task, model, agent }." },
        ),
      ),
      // … agent / agentScope 不变 …
      chain: Type.Optional(
        Type.Array(
          Type.Object({
            task: Type.String(),
            agent: Type.Optional(Type.String()),
            ...modelField("Model route for this step; must come from `list_subagent_models`."),
          }),
          { description: "Sequential steps; each step's task may contain {previous} (replaced by the prior step's output)." },
        ),
      ),
      profile: Type.Optional(
        Type.Union(
          [
            Type.String({ description: "Preset profile: explore | planner | executor | reviewer | default" }),
            Type.Object(
              {
                extends: Type.Optional(Type.String()),
                fs: /* 不变 */,
                net: Type.Optional(Type.Boolean()),
                mcp: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
                spawn: Type.Optional(Type.Boolean()),
                isolation: /* 不变 */,
                ...modelField("Model route or alias (cheap/strong) for this profile."),
              },
              { additionalProperties: false },
            ),
          ],
          { description: "Capability profile: preset name or inline object. Composable, additive/subtractive." },
        ),
      ),
      // … action / agentId / fork 不变 …
      ...(modelPolicy.enabled
        ? {
            thinking_level: Type.Optional(
              Type.Union(
                THINKING_LEVELS.map((l) => Type.Literal(l)),
                { description: "Thinking level for the child model; only levels listed by `list_subagent_models` for that route." },
              ),
            ),
          }
        : {}),
    }),
```

`promptGuidelines` 追加两句（仅 `modelPolicy.enabled` 时；用 `[...base, ...(modelPolicy.enabled ? [...] : [])]` 写法）：

```ts
      "开启自选路由时先调用 list_subagent_models，只用它列出的路由。",
      "fork: true 时换模型会失去父前缀缓存，非必要不换。",
```

`execute` 里，在 `const list = normalizeTasks(params);` 之后、单会话上限检查之前插入模型校验（校验失败要在预占名额之前，避免白白占额）：

```ts
      // 模型侧路由选择：关时任何显式 model / thinking_level 都拒；开时校验白名单 ∩ 可用目录。
      const explicitRoutes: string[] = [];
      if (typeof params.model === "string" && params.model.trim()) explicitRoutes.push(params.model.trim());
      for (const t of params.tasks ?? []) {
        if (typeof t === "object" && typeof t.model === "string" && t.model.trim()) explicitRoutes.push(t.model.trim());
      }
      for (const s of params.chain ?? []) {
        if (typeof s.model === "string" && s.model.trim()) explicitRoutes.push(s.model.trim());
      }
      const inlineProfileModel =
        params.profile && typeof params.profile === "object" && typeof params.profile.model === "string" ? params.profile.model.trim() : "";
      const thinkingLevel = typeof params.thinking_level === "string" ? params.thinking_level.trim() : "";
      if (!modelPolicy.enabled) {
        if (explicitRoutes.length > 0 || inlineProfileModel || thinkingLevel) {
          return {
            content: [{ type: "text", text: "子代理路由选择未开启（设置 → 子代理 → 允许模型自选路由）" }],
            isError: true,
          };
        }
      } else {
        const avail = availableModels(ctx as never);
        try {
          for (const route of explicitRoutes) assertRouteAllowed(route, modelPolicy, avail);
          if (inlineProfileModel && inlineProfileModel !== "cheap" && inlineProfileModel !== "strong") {
            assertRouteAllowed(inlineProfileModel, modelPolicy, avail);
          }
          if (thinkingLevel) {
            const target = explicitRoutes[0] ?? inlineProfileModel;
            const model = avail.find((m) => routeOf(m) === target) ?? avail.find((m) => routeOf(m) === (parentModelSpec(ctx.model) ?? ""));
            if (!model) throw new Error("thinking_level 需要一个可解析的目标模型");
            assertThinkingLevel(thinkingLevel, model);
          }
        } catch (e) {
          return { content: [{ type: "text", text: String((e as Error).message ?? e) }], isError: true };
        }
      }
```

注意 `params.tasks` 的元素类型是 `string | { task; model?; agent? }`，`typeof t === "object"` 分支才有 `model`。

四处 `executeSubagent(...)` 调用（chain 步骤、tasks ��行、单任务、后台子进程）与 `startContinuableEmbedded(...)` 调用的 opts 各加一行：

```ts
            thinkingLevel: thinkingLevel || undefined,
```

`chain` 分支里 `thinkingLevel` 变量在 execute 顶部已定义，直接可用。

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent --reporter=dot`
预期：全部 PASS。已知会被本任务改变行为的旧用例：`describe("spawn_agent · inherit parent model")` 里 `it("explicit model wins over parent")`（`index.test.ts:203`）直接传 `model: "openai/gpt-4o"`——��在默认关会被拒。把它改成先 `enable('["openai/gpt-4o"]')` 并给 ctx 加 `modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-4o", name: "gpt-4o", reasoning: false }] }`，断言不变。其余不传 `model` 的用例应原样通过。

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/index.ts extensions/multi-agent/index.test.ts
git commit -m "feat(multi-agent): spawn_agent 模型路由按用户白名单授权"
```

---

### 任务 5：设置页两个键与 `model-list` 字段

**文件：**
- 修改：`electron-agent/src/features/settings/settingsSchema.ts`（`FieldType` 与「模型策略」分组）
- 创建：`electron-agent/src/features/settings/ModelListField.tsx`
- 创建：`electron-agent/src/features/settings/ModelListField.test.tsx`
- 修改：`electron-agent/src/features/settings/SettingField.tsx`
- 修改：`electron-agent/src/features/settings/settingsSchema.test.ts`

- [ ] **步骤 1：写失败的测试（schema）**

`settingsSchema.test.ts` 末尾追加（照该文件已有用例取 schema 的方式；若文件里用 `SETTINGS_SCHEMA` / `settingsSchema` 之类的导出名，替换下面的 `schemaFields()`）：

```ts
describe('subagent model selection keys', () => {
  const all = () => SETTINGS_SCHEMA.flatMap((c) => [...(c.fields ?? []), ...(c.sections ?? []).flatMap((s) => s.fields)]);
  it('has the switch and the allowlist, the latter shown only when the switch is 1', () => {
    const sw = all().find((f) => f.key === 'SUBAGENT_MODEL_SELECTION');
    const list = all().find((f) => f.key === 'SUBAGENT_MODEL_ALLOWLIST');
    expect(sw?.type).toBe('boolean');
    expect(list?.type).toBe('model-list');
    expect(list?.showWhen).toEqual({ key: 'SUBAGENT_MODEL_SELECTION', equals: ['1'] });
  });
});
```

`SETTINGS_SCHEMA: SettingCategory[]` 已在该测试文件里 import；`SettingCategory` 同时可能有顶层 `fields` 与 `sections[].fields`（`settingsSchema.ts:38-51`），上面的 `all()` 两处都收。

- [ ] **步骤 2：写失败的测试（ModelListField）**

```tsx
// electron-agent/src/features/settings/ModelListField.test.tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./providerModelData', () => ({
  useProviderModelData: () => ({
    ready: true,
    providerOptions: [{ label: 'A', value: 'a' }],
    nameOf: (id: string) => id.toUpperCase(),
    modelsFor: (p: string) => (p === 'a' ? [{ label: 'b', value: 'b' }, { label: 'c', value: 'c' }] : []),
  }),
}));

import { ModelListField, parseModelList } from './ModelListField';

afterEach(cleanup);

describe('parseModelList', () => {
  it('parses a JSON array and drops junk', () => {
    expect(parseModelList('["a/b", 1, " c/d "]')).toEqual(['a/b', 'c/d']);
    expect(parseModelList('nope')).toEqual([]);
    expect(parseModelList('')).toEqual([]);
  });
});

describe('ModelListField', () => {
  it('renders stored routes as tags, marking ones missing from the catalog', () => {
    render(<ModelListField value='["a/b","z/z"]' testId="f" onChange={() => {}} />);
    expect(screen.getByText('A / b')).toBeTruthy();
    expect(screen.getByText('z/z（不可用）')).toBeTruthy();
  });

  it('removing a tag writes the remaining list as JSON', () => {
    const onChange = vi.fn();
    render(<ModelListField value='["a/b","z/z"]' testId="f" onChange={onChange} />);
    const removes = screen.getAllByLabelText('close');
    fireEvent.click(removes[1]);
    expect(onChange).toHaveBeenCalledWith('["a/b"]');
  });
});
```

antd `Select mode="multiple"` 的 tag 关闭按钮带 `aria-label="close"`；若本仓库 antd 版本渲染的是 `aria-label="Close"` 或别的，运行后按实际 DOM 改 `getAllByLabelText` 的参数（用 `screen.debug()` 看一次）。

- [ ] **步骤 3：运行确认失败**

运行：`cd electron-agent && npx vitest run src/features/settings/ModelListField src/features/settings/settingsSchema --reporter=dot`
预期：FAIL

- [ ] **步骤 4：实现（settingsSchema.ts）**

`FieldType` 联合加 `'model-list'`：

```ts
export type FieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'model' | 'capability' | 'model-list';
```

「模型策略」分组 `fields` 末尾（`SUBAGENT_MODEL_STRONG` 之后）追加：

```ts
          {
            key: 'SUBAGENT_MODEL_SELECTION',
            label: '允许模型为子代理自选路由',
            type: 'boolean',
            description: '开启后 spawn_agent 可显式指定模型，且只能选下方白名单；改动对之后新建的会话生效',
          },
          {
            key: 'SUBAGENT_MODEL_ALLOWLIST',
            label: '可自选的路由白名单',
            type: 'model-list',
            description: '至少勾一条才算开启；不在当前目录里的条目会标「不可用」，可手动移除',
            showWhen: { key: 'SUBAGENT_MODEL_SELECTION', equals: ['1'] },
          },
```

- [ ] **步骤 5：实现（ModelListField.tsx）**

```tsx
// electron-agent/src/features/settings/ModelListField.tsx
import { Select } from 'antd';
import { useProviderModelData } from './providerModelData';

interface ModelListFieldProps {
  value: string;
  testId?: string;
  onChange: (v: string) => void;
}

/** 存储值是 JSON 数组字符串；坏 JSON 当空。 */
export function parseModelList(raw: string): string[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 子代理路由白名单：多选 "provider/id"。目录里没有的已存条目照常显示并标不可用，
 * 不自动删（对齐 DSH：用户授权只由用户改）。
 */
export function ModelListField({ value, testId, onChange }: ModelListFieldProps) {
  const { ready, providerOptions, nameOf, modelsFor } = useProviderModelData();
  const selected = parseModelList(value);

  const catalog = ready
    ? providerOptions.flatMap((p) => modelsFor(p.value).map((m) => ({ value: `${p.value}/${m.value}`, label: `${nameOf(p.value)} / ${m.label}` })))
    : [];
  const known = new Set(catalog.map((o) => o.value));
  const options = [
    ...catalog,
    ...selected.filter((v) => !known.has(v)).map((v) => ({ value: v, label: `${v}（不可用）` })),
  ];

  return (
    <Select
      data-testid={testId}
      mode="multiple"
      value={selected}
      options={options}
      placeholder="选择允许的路由"
      style={{ minWidth: 320 }}
      showSearch
      optionFilterProp="label"
      onChange={(next: string[]) => onChange(JSON.stringify(next))}
    />
  );
}
```

- [ ] **步骤 6：实现（SettingField.tsx）**

import 加 `import { ModelListField } from './ModelListField';`。`switch (field.type)` 里 `case 'model':` 之后加：

```tsx
      case 'model-list':
        return <ModelListField value={value} testId={testId} onChange={onChange} />;
```

`inline` 判定保持不变（`model-list` 走整行宽度分支）。

- [ ] **步骤 7：运行确认通过**

运行：`cd electron-agent && npx vitest run src/features/settings --reporter=dot`
预期：PASS

- [ ] **步骤 8：Commit**

```bash
git add electron-agent/src/features/settings/settingsSchema.ts electron-agent/src/features/settings/settingsSchema.test.ts electron-agent/src/features/settings/ModelListField.tsx electron-agent/src/features/settings/ModelListField.test.tsx electron-agent/src/features/settings/SettingField.tsx
git commit -m "feat(settings): 子代理路由自选开关与白名单字段"
```

---

### 任务 6：回归、类型检查、规格状态

- [ ] **步骤 1：类型检查**

运行：`cd cli && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5` 与 `cd electron-agent && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
预期：无错误

- [ ] **步骤 2：回归**

运行：`cd extensions && npx vitest run --reporter=dot 2>&1 | tail -5` 与 `cd electron-agent && npx vitest run src/features/settings --reporter=dot 2>&1 | tail -5`
预期：全部 PASS

- [ ] **步骤 3：规格状态**

把 `docs/superpowers/specs/2026-09-14-dsh-subagent-model-routes-design.md` 的 `- 状态：待审查` 改为 `- 状态：已落地`；同时把规格 §5.1 表里 `showWhen … equals: ['true']` 改为 `['1']`（设置页 boolean 默认存 `'1'`/`'0'`，本计划按此实现）。

```bash
git add docs/superpowers/specs/2026-09-14-dsh-subagent-model-routes-design.md
git commit -m "docs(specs): 第六期子级模型路由标记已落地"
```
