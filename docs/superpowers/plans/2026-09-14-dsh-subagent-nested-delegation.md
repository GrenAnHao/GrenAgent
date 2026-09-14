# DSH 子代理第七期：嵌套委派与深度预算 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 子级可再委派（one-shot 与可续聊皆可），深度按 `subagent_meta.depth` 与 `SUBAGENT_DEPTH` 双源取 max、上限 `SUBAGENT_MAX_DEPTH`（默认 2）；Activation 图带 `ownedChildren`，结算等后代空，拆除子级优先；每个 continuable Activation 自注册为父 host 供孙级 notice；祖先可打断任意深度后代；目录白名单递归。

**架构：** 新 `depth.ts` 管深度；`index.ts` 删两道硬拦、改成深度校验 + env/meta 写入；`activation.ts` 加 `depth` / `parentActivationId`，install 时挂父 `ownedChildren` + 自注册 host，dispose 时先拆后代再摘出；`adjacent-tools.ts` interrupt 沿 `parentActivationId` 链找祖先；`registry.ts` 加 `parentId` / `depth` 列；Electron 白名单递归折叠、页头目录接收子路径变更事件。

**技术栈：** TypeScript、vitest、node:sqlite、React。

**规格：** `docs/superpowers/specs/2026-09-14-dsh-subagent-nested-delegation-design.md`

**前置：** 第五期与第六期计划已落地（`executeSubagent` 已含 `withDelegationScope`；`buildExcludeTools` 已含 `list_subagent_models`）。

**执行顺序：** 1 → **6**（registry 两列）→ 2 → 3 → 4 → 5 → 7 → 8 → 9���任务 2 的 `registry.create` 调用依赖任务 6 的列，先做 6 免得中途编译不过。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `extensions/multi-agent/depth.ts` | 创建 | `resolveDelegationDepth`、`readMaxDepth`、`childDepthOf`、`assertDepthAllowed`、`DEFAULT_MAX_DEPTH` |
| `extensions/multi-agent/depth.test.ts` | 创建 | 双源取 max、上限、非法回默认 |
| `extensions/multi-agent/index.ts` | 修改 | 删 `PI_IS_SUBAGENT` 守卫与 fork `inChild`；深度校验；`SUBAGENT_DEPTH` env；`depth` / `parentActivationId` 透传；registry `parentId` / `depth` |
| `extensions/multi-agent/index.test.ts` | 修改 | 深度用例 |
| `extensions/multi-agent/embedded-runner.ts` | 修改 | `buildExcludeTools` 按深度决定 `spawn_agent`；meta 写 `depth`；`startContinuableEmbedded` 透传 `parentActivationId` |
| `extensions/multi-agent/runner.ts` | 修改 | deny 列表按深度决定 `spawn_agent` |
| `extensions/multi-agent/runner.test.ts` | 修改 | deny 条件用例 |
| `extensions/multi-agent/activation.ts` | 修改 | 图 + host + 子级优先拆除 |
| `extensions/multi-agent/activation.test.ts` | 修改 | 图 / 拆除顺序 / 孙级 notice |
| `extensions/multi-agent/adjacent-tools.ts` | 修改 | 祖先 interrupt；send_message 冷恢复传 sender Activation |
| `extensions/multi-agent/adjacent-tools.test.ts` | 修改 | 祖先 / 旁支用例 |
| `extensions/multi-agent/registry.ts` | 修改 | 两列 + 迁移 |
| `extensions/multi-agent/registry.test.ts` | 修改 | 迁移用例 |
| `electron-agent/electron/app/subagentService.ts` | 修改 | `catalogWhitelist` 递归 |
| `electron-agent/electron/app/subagentService.test.ts` | 修改 | 曾孙可投递 |
| `electron-agent/src/features/subagents/SubagentHeaderCatalog.tsx` | 修改 | 子路径事件触发重载 |
| `electron-agent/src/features/subagents/SubagentHeaderCatalog.test.tsx` | 修改 | 子路径事件用例 |
| `electron-agent/src/features/settings/settingsSchema.ts` | 修改 | `SUBAGENT_MAX_DEPTH` 键 |

---

### 任务 1：深度记账（`depth.ts`）

**文件：**
- 创建：`extensions/multi-agent/depth.ts`
- 创建：`extensions/multi-agent/depth.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
// extensions/multi-agent/depth.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));
import { getConfig } from "../_shared/runtime-config.js";
import { assertDepthAllowed, childDepthOf, DEFAULT_MAX_DEPTH, readMaxDepth, resolveDelegationDepth } from "./depth.js";

const cfg = (map: Record<string, string | undefined>) => vi.mocked(getConfig).mockImplementation((k: string) => map[k]);
const metaCtx = (depth?: number) => ({
  sessionManager: {
    getEntries: () => [
      { type: "message" },
      { type: "custom", customType: "subagent_meta", data: { origin: "subagent", ...(depth === undefined ? {} : { depth }) } },
    ],
  },
});

beforeEach(() => vi.resetAllMocks());

describe("resolveDelegationDepth", () => {
  it("top-level session with no meta and no env is 0", () => {
    cfg({});
    expect(resolveDelegationDepth({ sessionManager: { getEntries: () => [] } })).toBe(0);
  });
  it("takes max(meta.depth, SUBAGENT_DEPTH)", () => {
    cfg({ SUBAGENT_DEPTH: "1" });
    expect(resolveDelegationDepth(metaCtx(2))).toBe(2);
    cfg({ SUBAGENT_DEPTH: "3" });
    expect(resolveDelegationDepth(metaCtx(2))).toBe(3);
  });
  it("cold resume: env gone, meta still wins", () => {
    cfg({});
    expect(resolveDelegationDepth(metaCtx(2))).toBe(2);
  });
  it("meta without depth counts as 0", () => {
    cfg({});
    expect(resolveDelegationDepth(metaCtx())).toBe(0);
  });
  it("tolerates a sessionManager that throws", () => {
    cfg({ SUBAGENT_DEPTH: "1" });
    expect(resolveDelegationDepth({ sessionManager: { getEntries: () => { throw new Error("x"); } } })).toBe(1);
  });
});

describe("readMaxDepth", () => {
  it("defaults to 2", () => {
    cfg({});
    expect(DEFAULT_MAX_DEPTH).toBe(2);
    expect(readMaxDepth()).toBe(2);
  });
  it("reads a valid integer", () => {
    cfg({ SUBAGENT_MAX_DEPTH: "1" });
    expect(readMaxDepth()).toBe(1);
  });
  it("invalid → default", () => {
    for (const v of ["", "abc", "-1", "1.5"]) {
      cfg({ SUBAGENT_MAX_DEPTH: v });
      expect(readMaxDepth()).toBe(2);
    }
  });
});

describe("childDepthOf / assertDepthAllowed", () => {
  it("child depth is parent + 1", () => {
    cfg({});
    expect(childDepthOf(metaCtx(1))).toBe(2);
  });
  it("assert throws with code DEPTH_EXCEEDED beyond max", () => {
    cfg({ SUBAGENT_MAX_DEPTH: "1" });
    expect(() => assertDepthAllowed(2)).toThrow("已达委派深度上限 1");
    expect(() => assertDepthAllowed(1)).not.toThrow();
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/depth --reporter=dot`
预期：FAIL，模块不存在

- [ ] **步骤 3：实现**

```ts
// extensions/multi-agent/depth.ts
// 委派深度：顶层 0，子级 = 父 + 1。权威是自身 JSONL 的 subagent_meta.depth（冷恢复后 env 会丢），
// env SUBAGENT_DEPTH 只能加深，不能降低——否则冷恢复的子级会以为自己是顶层。
import { getConfig } from "../_shared/runtime-config.js";
import { SubagentError } from "./inbox.js";

export const DEFAULT_MAX_DEPTH = 2;

type EntriesCtx = { sessionManager?: { getEntries?: () => unknown[] } };

function metaDepth(ctx: EntriesCtx): number {
  try {
    const entries = ctx.sessionManager?.getEntries?.();
    if (!Array.isArray(entries)) return 0;
    let depth = 0;
    for (const e of entries) {
      const item = e as { type?: string; customType?: string; data?: { depth?: unknown } };
      if (item?.type === "custom" && item.customType === "subagent_meta" && typeof item.data?.depth === "number") {
        depth = item.data.depth;
      }
    }
    return Number.isSafeInteger(depth) && depth >= 0 ? depth : 0;
  } catch {
    return 0;
  }
}

function envDepth(): number {
  const n = Number(getConfig("SUBAGENT_DEPTH") ?? "");
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export function resolveDelegationDepth(ctx: EntriesCtx): number {
  return Math.max(metaDepth(ctx), envDepth());
}

export function readMaxDepth(): number {
  const raw = getConfig("SUBAGENT_MAX_DEPTH")?.trim();
  if (!raw) return DEFAULT_MAX_DEPTH;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_MAX_DEPTH;
}

export function childDepthOf(ctx: EntriesCtx): number {
  return resolveDelegationDepth(ctx) + 1;
}

export function assertDepthAllowed(childDepth: number): void {
  const max = readMaxDepth();
  if (childDepth > max) throw new SubagentError(`已达委派深度上限 ${max}`, "DEPTH_EXCEEDED");
}
```

`inbox.ts` 的 `SubagentError` code 联合若是封闭字面量，加 `"DEPTH_EXCEEDED"`（`grep -n "code:" extensions/multi-agent/inbox.ts`）。

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent/depth --reporter=dot`
预期：PASS（11 tests）

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/depth.ts extensions/multi-agent/depth.test.ts extensions/multi-agent/inbox.ts
git commit -m "feat(multi-agent): 委派深度双源记账与上限"
```

---

### 任务 2：spawn_agent 放开嵌套并按深度过滤工具

**文件：**
- 修改：`extensions/multi-agent/index.ts`（`execute` 开头守卫、fork 校验、`profileEnv`、`executeSubagent` / `startContinuableEmbedded` opts、registry `create`）
- 修改：`extensions/multi-agent/embedded-runner.ts`（`EmbeddedSubagentOpts.depth`、meta、`buildExcludeTools`）
- 修改：`extensions/multi-agent/runner.ts`（`buildSubagentRuntimeConfig` deny）
- 修改：`extensions/multi-agent/index.test.ts`、`runner.test.ts`、`embedded-runner.run.test.ts`

- [ ] **步骤 1：写失败的测试（index）**

`index.test.ts` 末尾追加：

```ts
describe("spawn_agent · nested delegation depth", () => {
  const depthCtx = (depth: number) => ({
    ...ctx,
    sessionManager: {
      getEntries: () => [{ type: "custom", customType: "subagent_meta", data: { origin: "subagent", depth } }],
      getSessionId: () => `sa-parent-${depth}`,
    },
  });
  const cfg = (map: Record<string, string>) =>
    vi.mocked(getConfig).mockImplementation((k: string) => (k === "SUBAGENT_MAX_PER_SESSION" ? "0" : map[k]));

  it("no longer blocks spawn on PI_IS_SUBAGENT=1", async () => {
    process.env.PI_IS_SUBAGENT = "1";
    cfg({});
    await loadSpawnAgent()("t", { task: "x" }, null, null, ctx);
    expect(spawnPiAgent).toHaveBeenCalled();
    delete process.env.PI_IS_SUBAGENT;
  });

  it("child depth = parent + 1 goes into env and executeSubagent opts", async () => {
    cfg({});
    await loadSpawnAgent()("t", { task: "x" }, null, null, depthCtx(1));
    const opts = vi.mocked(spawnPiAgent).mock.calls[0]?.[2];
    expect(opts?.env?.SUBAGENT_DEPTH).toBe("2");
    expect(opts?.depth).toBe(2);
  });

  it("rejects when child depth exceeds SUBAGENT_MAX_DEPTH, without reserving a per-session slot", async () => {
    cfg({ SUBAGENT_MAX_DEPTH: "1" });
    const r = await loadSpawnAgent()("t", { task: "x" }, null, null, depthCtx(1));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("已达委派深度上限 1");
    expect(spawnPiAgent).not.toHaveBeenCalled();
  });

  it("tasks[] all share the same child depth", async () => {
    cfg({});
    await loadSpawnAgent()("t", { tasks: ["a", "b"] }, null, null, depthCtx(0));
    for (const call of vi.mocked(spawnPiAgent).mock.calls) expect(call[2]?.depth).toBe(1);
  });

  it("fork inside a child is no longer rejected for being a child", async () => {
    cfg({});
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    const r = await runInWorkspace(
      { origin: "subagent", workspace: ctx.cwd, cwd: ctx.cwd, config: {} },
      () => loadSpawnAgent()("t", { task: "x", fork: true }, null, null, { ...depthCtx(1), sessionManager: { ...depthCtx(1).sessionManager, buildContextEntries: () => [] } }),
    );
    expect(r.isError).toBeFalsy();
    expect(runEmbeddedSubagent).toHaveBeenCalled();
  });

  it("continuable spawn passes parentActivationId when the caller is a resident activation", async () => {
    cfg({});
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    vi.spyOn(activation, "getActivation").mockImplementation((id: string) => (id === "sa-parent-1" ? ({ childId: id, ownedChildren: new Set() } as never) : undefined));
    await loadSpawnAgent()("t", { task: "x", action: "spawn" }, null, null, depthCtx(1));
    const opts = vi.mocked(startContinuableEmbedded).mock.calls[0]?.[0];
    expect(opts?.parentActivationId).toBe("sa-parent-1");
    expect(opts?.depth).toBe(2);
  });
});
```

`index.test.ts` 顶部已 `import * as activation from "./activation.js"` 与 `import { runInWorkspace } from "../_shared/workspace-context.js"`。若 `runInWorkspace` 被 mock 成透传，第五个用例照样成立。

- [ ] **步骤 2：写失败的测试（runner / embedded）**

`runner.test.ts` `describe("buildSubagentLaunch")` 里把现有 `it("deny 列表含 spawn_agent 与 explore_context")` 改成两个：

```ts
  it("deny 列表：深度未到顶时只含 explore_context，不含 spawn_agent", () => {
    const launch = buildSubagentLaunch("D:/a", "t", { env: { SUBAGENT_DEPTH: "1" } });
    const deny = (launch.env.SAFETY_DENY_TOOLS ?? "").split(",");
    expect(deny).toContain("explore_context");
    expect(deny).not.toContain("spawn_agent");
    launch.cleanup();
  });

  it("deny 列表：深度到顶时含 spawn_agent", () => {
    const launch = buildSubagentLaunch("D:/a", "t", { env: { SUBAGENT_DEPTH: "2" } });
    expect((launch.env.SAFETY_DENY_TOOLS ?? "").split(",")).toContain("spawn_agent");
    launch.cleanup();
  });
```

（`runner.test.ts` 未 mock `runtime-config`，`SUBAGENT_MAX_DEPTH` 未设即默认 2。）

`embedded-runner.run.test.ts` `describe("runEmbeddedSubagent")` 追加：

```ts
  it("excludes spawn_agent only when depth reaches the max; records depth in meta", async () => {
    createAgentSessionFromServices.mockResolvedValue({ session: fakeSession({ provider: "a", id: "b" }) });
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-d1", depth: 1, env: { SUBAGENT_DEPTH: "1" } });
    const a1 = createAgentSessionFromServices.mock.calls[0]?.[0] as { excludeTools: string[] };
    expect(a1.excludeTools).not.toContain("spawn_agent");
    expect(a1.excludeTools).toContain("explore_context");
    const meta = appendCustomEntry.mock.calls.find((c) => c[0] === "subagent_meta")?.[1] as { depth?: number };
    expect(meta.depth).toBe(1);

    createAgentSessionFromServices.mockClear();
    await runEmbeddedSubagent({ cwd: "/ws", task: "t", agentId: "sa-d2", depth: 2, env: { SUBAGENT_DEPTH: "2" } });
    const a2 = createAgentSessionFromServices.mock.calls[0]?.[0] as { excludeTools: string[] };
    expect(a2.excludeTools).toContain("spawn_agent");
  });
```

该文件 mock 的 `buildSubagentRuntimeConfig` 返回固定 `env: { SAFETY_DENY_TOOLS: "bash" }`，不带 `SUBAGENT_DEPTH`——所以 `buildExcludeTools` 要从 `opts.depth` 判断，不能只看 `childConfig`（见步骤 4）。

- [ ] **步骤 3：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/index -t "nested delegation" multi-agent/runner multi-agent/embedded-runner.run --reporter=dot`
预期：新增用例 FAIL

- [ ] **步骤 4：实现（runner.ts / embedded-runner.ts）**

`runner.ts`：import `readMaxDepth` from `./depth.js`。`buildSubagentRuntimeConfig` 里

```ts
  denyTools.add("spawn_agent");
```

改为

```ts
  // 子级深度到顶才藏掉 spawn_agent；未到顶允许再委派（第七期）。
  const depth = Number(extraEnv.SUBAGENT_DEPTH ?? "");
  if (Number.isSafeInteger(depth) && depth >= readMaxDepth()) denyTools.add("spawn_agent");
```

`SpawnPiAgentOpts` 加 `depth?: number;`（仅为让 `executeSubagent` opts 类型统一；子进程路径靠 env）。

`embedded-runner.ts`：`EmbeddedSubagentOpts` 加 `depth?: number;` 与 `parentActivationId?: string;`。import `readMaxDepth`。

`buildExcludeTools(env)` 改签名为 `buildExcludeTools(env, depth: number | undefined)`：

```ts
function buildExcludeTools(env: Record<string, string>, depth: number | undefined): string[] {
  const deny = new Set(["explore_context", "list_subagent_models"]);
  const effective = depth ?? Number(env.SUBAGENT_DEPTH ?? "");
  if (Number.isSafeInteger(effective) && effective >= readMaxDepth()) deny.add("spawn_agent");
  for (const t of (env.SAFETY_DENY_TOOLS ?? "").split(",")) {
    const s = t.trim();
    if (s) deny.add(s);
  }
  return [...deny];
}
```

调用处改为 `buildExcludeTools(prepared.childConfig, opts.depth)`。

`subagent_meta` 对象追加 `depth: opts.depth ?? 0,`。

`startContinuableEmbedded` 的 `installActivation({...})` 追加：

```ts
          depth: opts.depth ?? 0,
          ...(opts.parentActivationId ? { parentActivationId: opts.parentActivationId } : {}),
```

（`installActivation` 的这两个字段在任务 3 加；本任务先在类型上放宽，任务 3 再实现行为。为了让任务 2 单独可编译，先给 `installActivation` 的 input 类型加 `depth?: number; parentActivationId?: string;` 两个可选字段，行为留到任务 3。）

- [ ] **步骤 5：实现（index.ts）**

import：

```ts
import { assertDepthAllowed, childDepthOf } from "./depth.js";
import { getActivation } from "./activation.js";
```

删除 `execute` 开头这段：

```ts
      if ((action === "run" || action === "spawn") && process.env.PI_IS_SUBAGENT === "1") {
        throw new Error("子代理禁止再启动子代理（嵌套 spawn 已被拦截）");
      }
```

在 `const list = normalizeTasks(params);` 之后、第六期的模型校验之前插入：

```ts
      const childDepth = childDepthOf(ctx as never);
      try {
        assertDepthAllowed(childDepth);
      } catch (e) {
        return { content: [{ type: "text", text: String((e as Error).message ?? e) }], isError: true };
      }
```

fork 校验删掉 `inChild`：

```ts
      if (params.fork) {
        if (hasChain || list.length !== 1) throw new Error("fork 仅支持单任务");
        if (!canUseEmbeddedSubagent(profile)) throw new Error("fork 需要 Electron 进程内子会话");
      }
```

`resolveToolOrigin` 若此后无其他引用，从 import 里删掉。

`profileEnv.APPROVAL_POLICY = …` 之后加：

```ts
      profileEnv.SUBAGENT_DEPTH = String(childDepth);
```

所有 `executeSubagent(...)` 与 `startContinuableEmbedded(...)` 的 opts 加 `depth: childDepth,`。`startContinuableEmbedded` 另加：

```ts
              parentActivationId: parentSid && getActivation(parentSid) ? parentSid : undefined,
```

所有 `registry.create({...})` 加 `parentId: parentSid ?? null, depth: childDepth,`（registry 列在任务 6 加；为让本任务编译，先在 `registry.create` 的 input 类型加这两个可选字段并在 INSERT 里忽略——或者把任务 6 提前做。**推荐先做任务 6 再回来做本任务的这一步。**）

`parentSid` 在 `run` 分支（`list.length === 1` / `tasks` / `chain`）里目前没算——在深度校验旁加一行 `const parentSid = parentSessionId(ctx);`，`spawn` 分支里已有的同名 `const` 删掉改用外层。

- [ ] **步骤 6：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent --reporter=dot`
预期：PASS。`index.test.ts` `beforeEach` 里的 `delete process.env.PI_IS_SUBAGENT` 与注释「would trip the recursion guard」可以留着（无害）。

- [ ] **步骤 7：Commit**

```bash
git add extensions/multi-agent/index.ts extensions/multi-agent/index.test.ts extensions/multi-agent/embedded-runner.ts extensions/multi-agent/embedded-runner.run.test.ts extensions/multi-agent/runner.ts extensions/multi-agent/runner.test.ts
git commit -m "feat(multi-agent): 放开嵌套委派，按深度上限过滤 spawn_agent"
```

---

### 任务 3：Activation 图、自注册父 host、子级优先拆除

**文件：**
- 修改：`extensions/multi-agent/activation.ts`
- 修改：`extensions/multi-agent/activation.test.ts`

- [ ] **步骤 1：写失败的测试**

`activation.test.ts` 的 `install()` helper 加两个可选项并透传：

```ts
    depth?: number;
    parentActivationId?: string;
```

```ts
    depth: over.depth ?? 1,
    ...(over.parentActivationId ? { parentActivationId: over.parentActivationId } : {}),
```

`mockSession()` 返回对象加：

```ts
    sendCustomMessage: vi.fn(),
```

`describe("activation")` 内追加：

```ts
  it("installing a grandchild links it into the parent's ownedChildren", () => {
    const parent = install(mockSession(), { childId: "sa-1", announced: false });
    install(mockSession(), { childId: "sa-1-1", sessionPath: "/ws/grand.jsonl", parentActivationId: "sa-1", depth: 2 });
    expect([...parent.ownedChildren]).toEqual(["sa-1-1"]);
  });

  it("parent does not settle while a grandchild is resident; settles after it settles", async () => {
    const parentSession = mockSession();
    const sendMessage = registerHost();
    install(parentSession, { childId: "sa-1", announced: true });
    const grand = mockSession();
    grand.isStreaming = true; // 孙级在忙，不会立刻自然结算
    install(grand, { childId: "sa-1-1", sessionPath: "/ws/grand.jsonl", parentActivationId: "sa-1", depth: 2, announced: true, parentSessionPath: "/ws/child.jsonl", parentSessionId: "sa-1" } as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getActivation("sa-1")).toBeDefined();
    grand.resolveIdle(); // 孙级自然结算 → 从父 ownedChildren 摘出 → 父结算
    await vi.waitFor(() => {
      expect(getActivation("sa-1")).toBeUndefined();
    });
    // 孙级的 notice 落在子级（sendCustomMessage），顶层 host 只收到子级自己的一条
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("a resident child is a parent host: grandchild settlement lands in the child's session", async () => {
    const child = mockSession();
    install(child, { childId: "sa-1", sessionPath: "/ws/child.jsonl", announced: false } as never);
    const grand = mockSession();
    install(grand, {
      childId: "sa-1-1",
      sessionPath: "/ws/grand.jsonl",
      parentActivationId: "sa-1",
      depth: 2,
      announced: true,
      parentSessionPath: "/ws/child.jsonl",
      parentSessionId: "sa-1",
    } as never);
    await vi.waitFor(() => {
      expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    });
    const [msg, opts] = child.sendCustomMessage.mock.calls[0];
    expect(msg.customType).toBe("subagent-settled");
    expect(msg.details.childId).toBe("sa-1-1");
    expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  it("busy child host gets the grandchild notice as steer", async () => {
    const child = mockSession();
    child.isStreaming = true;
    install(child, { childId: "sa-1", announced: false });
    const grand = mockSession();
    install(grand, { childId: "sa-1-1", sessionPath: "/ws/grand.jsonl", parentActivationId: "sa-1", depth: 2, announced: true, parentSessionPath: "/ws/child.jsonl", parentSessionId: "sa-1" } as never);
    await vi.waitFor(() => {
      expect(child.sendCustomMessage).toHaveBeenCalledTimes(1);
    });
    expect(child.sendCustomMessage.mock.calls[0][1]).toEqual({ triggerTurn: false, deliverAs: "steer" });
  });

  it("cancel disposes grandchildren first, then the child; both leave the table", async () => {
    const order: string[] = [];
    const child = mockSession();
    child.dispose = vi.fn(() => order.push("sa-1"));
    install(child, { childId: "sa-1", announced: true });
    const grand = mockSession();
    grand.dispose = vi.fn(() => order.push("sa-1-1"));
    install(grand, { childId: "sa-1-1", sessionPath: "/ws/grand.jsonl", parentActivationId: "sa-1", depth: 2, announced: true, parentSessionPath: "/ws/child.jsonl", parentSessionId: "sa-1" } as never);
    await disposeActivation("sa-1", "cancel");
    expect(order).toEqual(["sa-1-1", "sa-1"]);
    expect(getActivation("sa-1-1")).toBeUndefined();
    expect(getActivation("sa-1")).toBeUndefined();
  });

  it("host registration is removed on dispose", async () => {
    install(mockSession(), { childId: "sa-1", announced: false });
    expect(parentHostLookup("/ws/child.jsonl", "A")).toBeDefined();
    await disposeActivation("sa-1", "cancel");
    expect(parentHostLookup("/ws/child.jsonl", "A")).toBeUndefined();
  });
```

顶部 import 加 `lookupParentHost as parentHostLookup` from `./parent-host.js`。`install()` helper 里 `sessionPath` / `parentSessionPath` / `parentSessionId` 目前写死；把它们也改成可覆盖：

```ts
    sessionPath: over.sessionPath ?? "/ws/child.jsonl",
    parentSessionId: over.parentSessionId ?? "p1",
    parentSessionPath: over.parentSessionPath ?? "/ws/parent.jsonl",
```

并把这三项加进 `over` 的类型（此时上面用例里的 `as never` 可去掉）。

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/activation --reporter=dot`
预期：新增 6 个 FAIL

- [ ] **步骤 3：实现**

`activation.ts`：

import 加 `registerParentSessionHost` from `./parent-host.js`；`AgentSessionLike` 加：

```ts
  sendCustomMessage?: (
    msg: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
    opts: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" },
  ) => void;
```

`Activation` 接口加：

```ts
  depth: number;
  parentActivationId?: string;
```

`ActivationRecord` 加 `unregisterHost?: () => void;` 与 `wakers: Array<() => void>;`（构造时 `wakers: []`）。

**为什么要 wakers：** 父在等后代时 session 是 idle 的，`watchSettlement` 的 `await session.waitForIdle()` 会立刻返回；若只是 `return false` 让循环继续，就会空转。所以「因后代未空而不结算」时要挂在一个 waker 上，后代摘出时再唤醒。

新增两个私有函数：

```ts
function wake(act: ActivationRecord): void {
  for (const w of act.wakers.splice(0)) w();
}

function unlinkFromParent(act: ActivationRecord): void {
  act.unregisterHost?.();
  act.unregisterHost = undefined;
  if (!act.parentActivationId) return;
  const parent = activations.get(act.parentActivationId);
  if (!parent || !parent.ownedChildren.delete(act.childId)) return;
  wake(parent);
}
```

`watchSettlement` 的 lock 内把

```ts
      if (act.inbox.hasPending || act.ownedChildren.size > 0) return false;
```

改为

```ts
      if (act.inbox.hasPending) return false;
      if (act.ownedChildren.size > 0) return "wait" as const;
```

lock 之后的 `if (stop) return;` 改为：

```ts
    if (stop === true) return;
    if (stop === "wait") {
      await new Promise<void>((resolve) => act.wakers.push(resolve));
    }
```

（`childLock.run` 的返回类型随之变成 `boolean | "wait"`。）`watchSettlement` 结算成功路径里 `activations.delete(act.childId);` 之后加 `unlinkFromParent(act);`。

`installActivation` input 加 `depth?: number; parentActivationId?: string;`；构造 `act` 时加 `depth: input.depth ?? 0, parentActivationId: input.parentActivationId, wakers: [],`。`activations.set(...)` 之后、`if (act.announced) startWatch(act)` 之前追加：

```ts
  if (act.parentActivationId) {
    const parent = activations.get(act.parentActivationId);
    if (parent) {
      if (parent.inbox.closing) {
        activations.delete(act.childId);
        throw new SubagentError(`parent activation ${act.parentActivationId} is draining`, "DRAINING");
      }
      parent.ownedChildren.add(act.childId);
    }
  }
  act.unregisterHost = registerParentSessionHost({
    sessionId: act.childId,
    sessionPath: act.sessionPath,
    workspace: act.workspace,
    isBusy: () => !isSessionIdle(act.session),
    isDraining: () => act.inbox.closing !== undefined,
    sendMessage: (msg, opts) => act.session.sendCustomMessage?.(msg, opts),
    prompt: (text, delivery) => deliverToChild(act.childId, text, delivery),
  });
```

新增私有函数已在上面给出（`wake` / `unlinkFromParent`）。

`disposeActivation` 改为先拆后代，并在自身摘表后唤醒可能挂着的 watch：

```ts
export async function disposeActivation(
  childId: string,
  reason: "settled" | "cancel" | "rollback",
): Promise<void> {
  const owned = activations.get(childId)?.ownedChildren;
  for (const id of owned ? [...owned] : []) {
    await disposeActivation(id, "cancel");
  }
  await childLock.run(childId, async () => {
    const act = activations.get(childId);
    if (!act) return;
    const announced = act.announced;
    await act.inbox.close(async () => {
      act.session.dispose();
    });
    activations.delete(childId);
    wake(act);
    unlinkFromParent(act);
    if (reason === "cancel" && announced) {
      /* 现有 aborted notice 逻辑不变 */
    }
  });
}
```

`SubagentError` code 联合加 `"DRAINING"`（若尚无）。

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent/activation multi-agent/embedded-runner.run --reporter=dot`
预期：PASS。旧用例 `"does not deliver settlement across workspaces …"` 之类依赖 `registerHost()` 的仍应通过——子 Activation 自注册的 host 键是 `/ws/child.jsonl`，与旧用例的父 host 键 `/ws/parent.jsonl` 不冲突。

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/activation.ts extensions/multi-agent/activation.test.ts extensions/multi-agent/inbox.ts
git commit -m "feat(multi-agent): Activation 图、子级自注册父 host、子级优先拆除"
```

---

### 任务 4：冷恢复孙级挂进 sender、tornDown 递归

**文件：**
- 修改：`extensions/multi-agent/activation.ts`（`coldResumeAndDeliver` 签名）
- 修改：`extensions/multi-agent/adjacent-tools.ts`（冷恢复调用传 sender）
- 修改：`extensions/multi-agent/cancel.ts`（连带拆除的后代也写 tornDown）
- 修改：`extensions/multi-agent/activation.test.ts`、`cancel.test.ts`

- [ ] **步骤 1：写失败的测试**

`activation.test.ts` `describe("coldResumeAndDeliver")` 追加（照该 describe 里 `"opens session, rebuilds services, binds extensions, then delivers"` 的 `sdk.open` / `createAgentSessionFromServices` 夹具写法）：

```ts
  it("links the resumed child into the sender's ownedChildren when given", async () => {
    const sender = install(mockSession(), { childId: "sa-1", announced: false });
    sdk.open.mockReturnValue({
      getEntries: () => [{ type: "custom", customType: "subagent_meta", data: { mode: "continuable", parentSessionId: "sa-1", parentSession: "/ws/child.jsonl", depth: 2 } }],
      appendCustomEntry: vi.fn(),
      getCwd: () => "/ws",
    });
    sdk.createAgentSessionFromServices.mockResolvedValue({ session: { ...mockSession(), bindExtensions: vi.fn(async () => {}) } });
    await coldResumeAndDeliver("sa-1-1", "/ws/grand.jsonl", "hi", "followUp", { senderActivationId: "sa-1" });
    expect([...sender.ownedChildren]).toEqual(["sa-1-1"]);
    expect(getActivation("sa-1-1")?.depth).toBe(2);
  });
```

`cancel.test.ts` 追加（照该文件已有 `cancelSubAgent` 用例的 registry / inflight 夹具）：

```ts
  it("writes tornDown for every descendant torn down with the child", () => {
    const written: string[] = [];
    vi.spyOn(activationMod, "writeTornDown").mockImplementation((id: string) => { written.push(id); });
    vi.spyOn(activationMod, "getActivation").mockImplementation((id: string) =>
      id === "sa-1" ? ({ childId: "sa-1", ownedChildren: new Set(["sa-1-1"]), sessionPath: "/c.jsonl" } as never)
      : id === "sa-1-1" ? ({ childId: "sa-1-1", ownedChildren: new Set(), sessionPath: "/g.jsonl" } as never)
      : undefined,
    );
    const reg = fakeRegistryWithRunning("sa-1");
    cancelSubAgent("sa-1", reg, new Map());
    expect(written).toEqual(["sa-1-1", "sa-1"]);
  });
```

（`fakeRegistryWithRunning` 指该文件已有的 registry 夹具；按实际名字替换。顶部加 `import * as activationMod from "./activation.js"`。）

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/activation multi-agent/cancel --reporter=dot`
预期：2 个 FAIL

- [ ] **步骤 3：实现**

`coldResumeAndDeliver` 签名加第五参：

```ts
export async function coldResumeAndDeliver(
  childId: string,
  sessionPath: string,
  text: string,
  delivery: Delivery,
  link: { senderActivationId?: string } = {},
): Promise<void> {
```

`installActivation({...})` 调用里加：

```ts
    depth: typeof meta.depth === "number" ? meta.depth : 0,
    ...(link.senderActivationId && activations.has(link.senderActivationId) ? { parentActivationId: link.senderActivationId } : {}),
```

`adjacent-tools.ts` `executeSendMessage` 里冷恢复那一处（`await coldResumeAndDeliver(agentId, path, text, delivery)`）改为：

```ts
      await coldResumeAndDeliver(agentId, path, text, delivery, { senderActivationId: senderAct ? senderId : undefined });
```

（`senderAct` 与 `senderId` 在该函数里已存在。）

`cancel.ts` `cancelSubAgent`：`writeTornDown(agentId, row.sessionPath)` 之前加递归：

```ts
  const tornDownDescendants = (id: string): void => {
    const act = getActivation(id);
    for (const kid of act ? [...act.ownedChildren] : []) {
      tornDownDescendants(kid);
      writeTornDown(kid, getActivation(kid)?.sessionPath);
    }
  };
  tornDownDescendants(agentId);
```

import `getActivation` from `./activation.js`。

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent --reporter=dot`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/activation.ts extensions/multi-agent/activation.test.ts extensions/multi-agent/adjacent-tools.ts extensions/multi-agent/cancel.ts extensions/multi-agent/cancel.test.ts
git commit -m "feat(multi-agent): 冷恢复孙级挂进发送方，cancel 递归写 tornDown"
```

---

### 任务 5：`interrupt_agent` 祖先权限

**文件：**
- 修改：`extensions/multi-agent/adjacent-tools.ts`（`executeInterrupt`、描述）
- 修改：`extensions/multi-agent/adjacent-tools.test.ts`

- [ ] **步骤 1：写失败的测试**

`adjacent-tools.test.ts` 追加（照该文件已有 interrupt 用例的 `getActivation` mock 与 `execute` 取法）：

```ts
describe("interrupt_agent · ancestor authority", () => {
  const acts: Record<string, { childId: string; parentSessionId: string; parentActivationId?: string; workspace: string }> = {
    "sa-1": { childId: "sa-1", parentSessionId: "top", workspace: "A" },
    "sa-1-1": { childId: "sa-1-1", parentSessionId: "sa-1", parentActivationId: "sa-1", workspace: "A" },
    "sa-2": { childId: "sa-2", parentSessionId: "top", workspace: "A" },
  };
  beforeEach(() => {
    vi.mocked(getActivation).mockImplementation((id: string) => acts[id] as never);
  });
  const call = (sender: string, target: string) => interrupt({ agent_id: target }, { cwd: "A", sessionManager: { getSessionId: () => sender } });

  it("grandparent may interrupt a grandchild", async () => {
    const r = await call("top", "sa-1-1");
    expect(r.isError).toBeFalsy();
    expect(interruptChild).toHaveBeenCalledWith("sa-1-1");
  });
  it("child may interrupt its own grandchild-of-top (its child)", async () => {
    const r = await call("sa-1", "sa-1-1");
    expect(r.isError).toBeFalsy();
  });
  it("sibling / branch cannot", async () => {
    expect((await call("sa-2", "sa-1-1")).isError).toBe(true);
    expect((await call("sa-1-1", "sa-2")).isError).toBe(true);
  });
  it("grandchild cannot interrupt its grandparent", async () => {
    acts.top = { childId: "top", parentSessionId: "", workspace: "A" } as never;
    expect((await call("sa-1-1", "top")).isError).toBe(true);
    delete acts.top;
  });
});
```

`interrupt` 指该文件里已取出的 `interrupt_agent` execute；`getActivation` / `interruptChild` 已在该文件 mock（`vi.mock("./activation.js", …)`）——若没有 mock `interruptChild`，补上 `interruptChild: vi.fn()`。

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/adjacent-tools -t "ancestor" --reporter=dot`
预期：第一个用例 FAIL（现在只认直接父）

- [ ] **步骤 3：实现**

`adjacent-tools.ts` 新增：

```ts
function isAncestor(senderId: string, target: Activation): boolean {
  let cur: Activation | undefined = target;
  while (cur) {
    if (cur.parentSessionId === senderId) return true;
    cur = cur.parentActivationId ? getActivation(cur.parentActivationId) : undefined;
  }
  return false;
}
```

（import `type Activation` from `./activation.js`。）`executeInterrupt` 里

```ts
    if (targetAct.parentSessionId !== senderId) {
      throw new SubagentError("only the direct parent may interrupt a resident child", "UNAUTHORIZED");
    }
```

改为

```ts
    if (!isAncestor(senderId, targetAct)) {
      throw new SubagentError("only an ancestor may interrupt a resident agent", "UNAUTHORIZED");
    }
```

工具描述改为：

```ts
    description:
      "Interrupt a resident agent's current turn. The target may be your direct child or any deeper agent created under you. " +
      "Only the current turn stops; queued messages stay parked and agents it started keep running. " +
      "If the target is not resident, the request is recorded without error.",
    promptGuidelines: [
      "Use interrupt_agent to stop a resident descendant you (directly or indirectly) spawned.",
      "Interrupting yourself, a sibling, or a non-descendant is rejected.",
    ],
```

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent/adjacent-tools --reporter=dot`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/adjacent-tools.ts extensions/multi-agent/adjacent-tools.test.ts
git commit -m "feat(multi-agent): interrupt_agent 放开到任意深度后代"
```

---

### 任务 6：registry 加 `parentId` / `depth`

**文件：**
- 修改：`extensions/multi-agent/registry.ts`
- 修改：`extensions/multi-agent/registry.test.ts`
- 修改：`extensions/multi-agent/index.ts`（`list` 输出）

- [ ] **步骤 1：写失败的测试**

`registry.test.ts` 追加（照该文件的 tmp db 夹具）：

```ts
  it("migrates an old db without parentId/depth and persists them on create", () => {
    const file = join(dir, "registry.db");
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE subagents (id TEXT PRIMARY KEY, task TEXT NOT NULL, profile TEXT, model TEXT, status TEXT NOT NULL, output TEXT, error TEXT, exitCode INTEGER, transcript TEXT, sessionPath TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
    raw.close();
    const reg = new SubAgentRegistry(file);
    reg.load();
    const row = reg.create({ id: "sa-n", task: "t", parentId: "sa-p", depth: 2 });
    expect(row.parentId).toBe("sa-p");
    expect(row.depth).toBe(2);
    expect(reg.get("sa-n")).toMatchObject({ parentId: "sa-p", depth: 2 });
    reg.close();
  });

  it("defaults parentId null / depth 0", () => {
    const reg = new SubAgentRegistry(join(dir, "r2.db"));
    reg.load();
    expect(reg.create({ id: "sa-0", task: "t" })).toMatchObject({ parentId: null, depth: 0 });
    reg.close();
  });
```

（`dir` 指该文件里的临时目录变量；`DatabaseSync` 从 `node:sqlite` import。）

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/registry --reporter=dot`
预期：FAIL

- [ ] **步骤 3：实现**

`SubAgentRow` 加：

```ts
  /** 直接父级 id（顶层会话 spawn 的为 null）。 */
  parentId: string | null;
  /** 委派深度：顶层 0。 */
  depth: number;
```

`CREATE TABLE` 加两列 `parentId TEXT, depth INTEGER NOT NULL DEFAULT 0,`（放在 `sessionPath TEXT,` 之后）。迁移块追加：

```ts
    if (!cols.some((c) => c.name === "parentId")) db.exec("ALTER TABLE subagents ADD COLUMN parentId TEXT");
    if (!cols.some((c) => c.name === "depth")) db.exec("ALTER TABLE subagents ADD COLUMN depth INTEGER NOT NULL DEFAULT 0");
```

`create` input 加 `parentId?: string | null; depth?: number;`，row 加 `parentId: input.parentId ?? null, depth: input.depth ?? 0,`，INSERT 列与值各加两项。所有从 db 行映射到 `SubAgentRow` 的地方（`get` / `list` / `findStuck` 用的 `rowFrom` 之类）加 `parentId: (r.parentId as string | null) ?? null, depth: Number(r.depth ?? 0)`。

`index.ts` `action === "list"` 的输出行（`statusText` 或列表拼接处）追加 `parent=<parentId ?? "-"> depth=<depth>`。

回到任务 2 步骤 5：所有 `registry.create({...})` 现在可以带 `parentId: parentSid ?? null, depth: childDepth`。

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent --reporter=dot`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/registry.ts extensions/multi-agent/registry.test.ts extensions/multi-agent/index.ts
git commit -m "feat(multi-agent): registry 记录 parentId 与 depth"
```

---

### 任务 7：Electron 白名单递归与页头目录子路径事件

**文件：**
- 修改：`electron-agent/electron/app/subagentService.ts:178-188`
- 修改：`electron-agent/electron/app/subagentService.test.ts:207-211`
- 修改：`electron-agent/src/features/subagents/SubagentHeaderCatalog.tsx:321-339`
- 修改：`electron-agent/src/features/subagents/SubagentHeaderCatalog.test.tsx`

- [ ] **步骤 1：写失败的测试（service）**

把 `subagentService.test.ts:207` 的 `it('rejects prompt of a great-grandchild', …)` 改为：

```ts
  it('allows prompt of a great-grandchild (whitelist is recursive)', async () => {
    stubActivation(sa3Path, 'sa-3');
    await service.promptChild(workspace, parentPath, sa3Path, 'deep', 'steer');
    expect(deliverToChild).toHaveBeenCalledWith('sa-3', 'deep', 'steer');
  });

  it('whitelist tolerates a catalog cycle', async () => {
    stubCatalog({
      [parentPath]: [entry({ id: 'sa-1', sessionPath: sa1Path })],
      [sa1Path]: [entry({ id: 'sa-p', sessionPath: parentPath })],
    });
    await expect(service.promptChild(workspace, parentPath, '/stranger.jsonl', 'x', 'followUp'))
      .rejects.toThrow('sessionPath is not in the parent catalog');
  });
```

（`sa3Path` 与 `stubCatalog` 的三层夹具在该 describe 的 `beforeEach` 里已定义；确认 `stubCatalog` 已把 `sa2Path → [sa-3]` 挂上。）

- [ ] **步骤 2：写失败的测试（header）**

`SubagentHeaderCatalog.test.tsx` 追加（照该文件已有 `subagent_catalog_changed` 用例的 `emitPiEvent` / `foldCatalog` mock 写法）：

```tsx
  it('reloads when a catalog change arrives for an expanded child path', async () => {
    mockFold({ [parentPath]: [row('sa-1', childPath, { hasChildren: true })], [childPath]: [row('sa-1-1', grandPath)] });
    render(<SubagentHeaderCatalog />);
    fireEvent.click(await screen.findByTestId('subagent-header-catalog'));
    fireEvent.click(await screen.findByLabelText('展开'));
    await screen.findByText('sa-1-1');
    mockFold({ [parentPath]: [row('sa-1', childPath, { hasChildren: true })], [childPath]: [row('sa-1-1', grandPath), row('sa-1-2', grand2Path)] });
    emitPiEvent({ type: 'subagent_catalog_changed', sessionPath: childPath });
    await screen.findByText('sa-1-2');
  });
```

（`mockFold` / `row` / `emitPiEvent` / 各 path 常量取该测试文件已有的名字；若没有 `grand2Path` 就新建一个字符串常量。）

- [ ] **步骤 3：运行确认失败**

运行：`cd electron-agent && npx vitest run electron/app/subagentService src/features/subagents/SubagentHeaderCatalog --reporter=dot`
预期：新用例 FAIL

- [ ] **步骤 4：实现（service）**

```ts
const MAX_WHITELIST_DEPTH = 8;

function catalogWhitelist(parentSessionPath: string): Map<string, SubagentCatalogEntry> {
  const map = new Map<string, SubagentCatalogEntry>();
  const visited = new Set<string>([parentSessionPath]);
  const walk = (path: string, depth: number): void => {
    if (depth > MAX_WHITELIST_DEPTH) return;
    let entries: SubagentCatalogEntry[] = [];
    try {
      entries = foldCatalog(path).entries;
    } catch {
      return;
    }
    for (const child of entries) {
      if (visited.has(child.sessionPath)) continue;
      visited.add(child.sessionPath);
      map.set(child.sessionPath, child);
      walk(child.sessionPath, depth + 1);
    }
  };
  walk(parentSessionPath, 1);
  return map;
}
```

（规格 §4.7 写「最多 `readMaxDepth()` 层」；主进程不读 sidecar 配置，这里用固定 8 层 + 访问集做环保护。超过 `SUBAGENT_MAX_DEPTH` 的孩子不会存在，白名单多放几层不影响安全边界。）

- [ ] **步骤 5：实现（header）**

`SubagentHeaderCatalog.tsx:326-330` 改为：

```tsx
      if (event?.type !== 'subagent_catalog_changed') return;
      const path = event.sessionPath ?? env.sessionPath;
      const parent = parentPathRef.current;
      if (!parent || !path) return;
      const known = new Set<string>([parent, ...rootRowsRef.current.map((r) => r.sessionPath), ...Object.values(childRowsRef.current).flat().map((r) => r.sessionPath)]);
      if (!known.has(path)) return;
      void loadRoot(parent, openRef.current);
```

若文件里没有 `rootRowsRef`，照 `childRowsRef` 的写法加一个（`const rootRowsRef = useRef(rootRows); rootRowsRef.current = rootRows;`）。`loadRoot(parent, true)` 已会沿已展开行递归重采，不用再改。

- [ ] **步骤 6：运行确认通过**

运行：`cd electron-agent && npx vitest run electron/app/subagentService src/features/subagents --reporter=dot`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/electron/app/subagentService.ts electron-agent/electron/app/subagentService.test.ts electron-agent/src/features/subagents/SubagentHeaderCatalog.tsx electron-agent/src/features/subagents/SubagentHeaderCatalog.test.tsx
git commit -m "feat(electron): 目录白名单递归到任意深度，子路径变更触发重载"
```

---

### 任务 8：设置键 `SUBAGENT_MAX_DEPTH`

**文件：**
- 修改：`electron-agent/src/features/settings/settingsSchema.ts`
- 修改：`electron-agent/src/features/settings/settingsSchema.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
describe('subagent max depth', () => {
  it('exposes SUBAGENT_MAX_DEPTH as a number with default 2', () => {
    const all = SETTINGS_SCHEMA.flatMap((c) => [...(c.fields ?? []), ...(c.sections ?? []).flatMap((s) => s.fields)]);
    expect(all.find((f) => f.key === 'SUBAGENT_MAX_DEPTH')).toMatchObject({ type: 'number', default: '2' });
  });
});
```

- [ ] **步骤 2：实现**

在「子代理」分类里 `SUBAGENT_MAX_PER_SESSION` 字段之后加：

```ts
          {
            key: 'SUBAGENT_MAX_DEPTH',
            label: '委派深度上限',
            type: 'number',
            default: '2',
            placeholder: '2',
            description: '顶层为 0，子代理为 1，孙代理为 2。设为 1 即禁止子代理再委派',
          },
```

（用 `grep -n "SUBAGENT_MAX_PER_SESSION" electron-agent/src/features/settings/settingsSchema.ts` 找位置。）

- [ ] **步骤 3：运行确认通过 + Commit**

运行：`cd electron-agent && npx vitest run src/features/settings/settingsSchema --reporter=dot`

```bash
git add electron-agent/src/features/settings/settingsSchema.ts electron-agent/src/features/settings/settingsSchema.test.ts
git commit -m "feat(settings): 子代理委派深度上限"
```

---

### 任务 9：回归、类型检查、规格状态

- [ ] **步骤 1：类型检查**

运行：`cd cli && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5` 与 `cd electron-agent && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
预期：无错误

- [ ] **步骤 2：回归**

运行：`cd extensions && npx vitest run --reporter=dot 2>&1 | tail -5` 与 `cd electron-agent && npx vitest run src/features/subagents src/features/settings electron/app/subagentService --reporter=dot 2>&1 | tail -5`
预期：全部 PASS

- [ ] **步骤 3：规格状态**

把 `docs/superpowers/specs/2026-09-14-dsh-subagent-nested-delegation-design.md` 的 `- 状态：待审查` 改为 `- 状态：已落地`；§4.7 里「最多 `readMaxDepth()` 层」改为「固定 8 层 + 访问集环保护（主进程不读 sidecar 配置）」。

```bash
git add docs/superpowers/specs/2026-09-14-dsh-subagent-nested-delegation-design.md
git commit -m "docs(specs): 第七期嵌套委派标记已落地"
```
