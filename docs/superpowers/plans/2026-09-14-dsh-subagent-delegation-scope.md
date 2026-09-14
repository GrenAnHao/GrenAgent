# DSH 子代理第五期：委派范围声明 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 子级工具调用被判定为 `ask` 时主进程直接改判 `deny`（不排队），子模型收到「已自动拒绝，不要重试，报告限制」文案；每个子级系统提示固定附一句委派范围声明。

**架构：** 三处改动：(1) 主进程 `ToolDecisionService.evaluate` 对 `origin === 'subagent'` 的 `ask` 改判 `deny`；(2) sidecar `safety` 扩展按 `ruleId` 分流拒绝文案；(3) `multi-agent/index.ts` 的 `executeSubagent` 在分流 embedded / 子进程之前把声明拼进 `systemPrompt`。文案与拼接函数放 `extensions/_shared/delegation-scope.ts`。

**技术栈：** TypeScript、vitest（`extensions/` 与 `electron-agent/` 各自的 vitest 配置）。

**规格：** `docs/superpowers/specs/2026-09-14-dsh-subagent-delegation-scope-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `extensions/_shared/delegation-scope.ts` | 创建 | `DELEGATION_SCOPE_STATEMENT`、`DELEGATION_DENY_REASON`、`SUBAGENT_ASK_PINNED_RULE_ID`、`withDelegationScope()` |
| `extensions/_shared/delegation-scope.test.ts` | 创建 | 拼接函数单测 |
| `electron-agent/electron/app/toolPermission/toolDecisionService.ts` | 修改 | subagent + ask → deny |
| `electron-agent/electron/app/toolPermission/toolDecisionService.test.ts` | 修改 | 新增改判用例 |
| `extensions/safety/index.ts` | 修改 | deny 文案按 `ruleId` 分流 |
| `extensions/safety/index.test.ts` | 修改 | 新增文案用例 |
| `extensions/multi-agent/index.ts` | 修改 | `executeSubagent` 注入声明 |
| `extensions/multi-agent/index.test.ts` | 修改 | 两条路径 `systemPrompt` 断言 |

`ruleId` 字符串常量必须在主进程与 sidecar 两边一致；主进程直接从 `extensions/_shared/delegation-scope.js` 导入（`toolDecisionService.ts` 已经这样导入 `_shared/approval.js`，路径前缀 `../../../../extensions/_shared/`）。

---

### 任务 1：声明与文案常量

**文件：**
- 创建：`extensions/_shared/delegation-scope.ts`
- 创建：`extensions/_shared/delegation-scope.test.ts`

- [ ] **步骤 1：写失败的测试**

```ts
// extensions/_shared/delegation-scope.test.ts
import { describe, expect, it } from "vitest";
import {
  DELEGATION_DENY_REASON,
  DELEGATION_SCOPE_STATEMENT,
  SUBAGENT_ASK_PINNED_RULE_ID,
  withDelegationScope,
} from "./delegation-scope.js";

describe("withDelegationScope", () => {
  it("returns only the statement when there is no system prompt", () => {
    expect(withDelegationScope(undefined)).toBe(DELEGATION_SCOPE_STATEMENT);
    expect(withDelegationScope("")).toBe(DELEGATION_SCOPE_STATEMENT);
    expect(withDelegationScope("   ")).toBe(DELEGATION_SCOPE_STATEMENT);
  });

  it("puts the named-agent prompt first, then a blank line, then the statement", () => {
    expect(withDelegationScope("You are scout.\n")).toBe(`You are scout.\n\n${DELEGATION_SCOPE_STATEMENT}`);
  });

  it("does not double-append when the prompt already ends with the statement", () => {
    const once = withDelegationScope("You are scout.");
    expect(withDelegationScope(once)).toBe(once);
  });
});

describe("constants", () => {
  it("rule id is stable", () => {
    expect(SUBAGENT_ASK_PINNED_RULE_ID).toBe("builtin.subagent-ask-pinned");
  });
  it("deny reason tells the model not to retry", () => {
    expect(DELEGATION_DENY_REASON).toContain("不要重试");
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run _shared/delegation-scope --reporter=dot`
预期：FAIL，`Cannot find module './delegation-scope.js'`

- [ ] **步骤 3：最少实现**

```ts
// extensions/_shared/delegation-scope.ts
// 子级委派范围声明与拒绝文案。主进程（toolDecisionService）与 sidecar（safety / multi-agent）共用，
// 确保 ruleId 与措辞不在两处各维护一份。

export const SUBAGENT_ASK_PINNED_RULE_ID = "builtin.subagent-ask-pinned";

export const DELEGATION_SCOPE_STATEMENT =
  "你是被委派的子代理：权限范围在启动时已固定，无法在本会话内扩大——需要审批的操作会被自动拒绝。" +
  "任务需要超出范围的访问时，不要重试被拒绝的操作；在回复中说明限制，让委派方处理。";

export const DELEGATION_DENY_REASON =
  "子代理的权限范围在启动时已固定，此操作需要审批，已被自动拒绝。不要重试；在回复中说明这一限制，交由委派方处理。";

/** named agent 提示在前、���明在后；空提示只留声明；已含声明不重复。 */
export function withDelegationScope(systemPrompt: string | undefined): string {
  const head = systemPrompt?.trim() ?? "";
  if (!head) return DELEGATION_SCOPE_STATEMENT;
  if (head.endsWith(DELEGATION_SCOPE_STATEMENT)) return head;
  return `${head}\n\n${DELEGATION_SCOPE_STATEMENT}`;
}
```

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run _shared/delegation-scope --reporter=dot`
预期：PASS（5 tests）

- [ ] **步骤 5：Commit**

```bash
git add extensions/_shared/delegation-scope.ts extensions/_shared/delegation-scope.test.ts
git commit -m "feat(shared): 子级委派范围声明与拒绝文案常量"
```

---

### 任务 2：主进程钉死 subagent 的 ask

**文件：**
- 修改：`electron-agent/electron/app/toolPermission/toolDecisionService.ts:41-57`
- 修改：`electron-agent/electron/app/toolPermission/toolDecisionService.test.ts`

- [ ] **步骤 1：写失败的测试**

在 `toolDecisionService.test.ts` 的 `describe('ToolDecisionService.evaluate', …)` 末尾（`it('writes the digested args …')` 之后）追加：

```ts
  it('pins a subagent ask to deny, audited as auto with no queue payload', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({ origin: 'subagent', flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(decision).toMatchObject({ decision: 'deny', ruleId: 'builtin.subagent-ask-pinned' });
    const row = audit.get(decision.auditId);
    expect(row).toMatchObject({ decision: 'deny', resolution: 'auto', ruleId: 'builtin.subagent-ask-pinned' });
    expect(row?.queuePayload).toBeUndefined();
  });

  it('keeps goal ask queued (only subagent is pinned)', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({ origin: 'goal', flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(decision.decision).toBe('ask');
    expect(audit.get(decision.auditId)).toMatchObject({ resolution: 'queued' });
  });

  it('does not override a subagent allow or an explicit builtin deny', async () => {
    const { service } = await fixture();
    const allow = service.evaluate(facts({ origin: 'subagent' }));
    expect(allow.decision).toBe('allow');
    const deny = service.evaluate(facts({ origin: 'subagent', tool: 'write', path: 'D:/repo/.git/config', flags: { ...NO_FLAGS, write: true, protectedPath: true } }));
    expect(deny).toMatchObject({ decision: 'deny', ruleId: 'builtin.protected-path' });
  });

  it('pins the rule-lookup-failed ask for subagents too', async () => {
    const { audit } = await fixture();
    const broken = new ToolDecisionService(
      { applicable: () => { throw new Error('database is locked'); }, add: () => { throw new Error('unused'); } } as never,
      audit,
    );
    const decision = broken.evaluate(facts({ origin: 'subagent' }));
    expect(decision).toMatchObject({ decision: 'deny', ruleId: 'builtin.subagent-ask-pinned' });
  });
```

注意：`builtin.protected-path` 的匹配条件是 `flags.write && flags.protectedPath`（`builtinRules.ts:17`），两个 flag 都要给。

- [ ] **步骤 2：运行确认失败**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/toolDecisionService --reporter=dot`
预期：新增 4 个用例中至少前两个 FAIL（subagent ask 目前返回 `ask` / `queued`）

- [ ] **步骤 3：实现**

`toolDecisionService.ts` 顶部 import 追加：

```ts
import { SUBAGENT_ASK_PINNED_RULE_ID } from '../../../../extensions/_shared/delegation-scope.js';
```

把 `evaluate` 中这一段：

```ts
    if (decision === 'ask') resolution = 'queued';
```

改为：

```ts
    // 子级没有交互 UI，也没有事后放行重跑的机制：ask 钉死为 deny，审计仍留 auto 行。
    if (decision === 'ask' && call.origin === 'subagent') {
      decision = 'deny';
      ruleId = SUBAGENT_ASK_PINNED_RULE_ID;
      resolution = 'auto';
    }
    if (decision === 'ask') resolution = 'queued';
```

`queuePayload` 分支（`decision === 'ask' && isHeadless(call)`）不用改：subagent 已不再是 `ask`。

- [ ] **步骤 4：运行确认通过**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/toolDecisionService --reporter=dot`
预期：PASS（全部）

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/toolPermission/toolDecisionService.ts electron-agent/electron/app/toolPermission/toolDecisionService.test.ts
git commit -m "feat(permission): 子代理的 ask 判定钉死为 deny"
```

---

### 任务 3：safety 扩展按 ruleId 分流拒绝文案

**文件：**
- 修改：`extensions/safety/index.ts:129-131`
- 修改：`extensions/safety/index.test.ts`

- [ ] **步骤 1：写失败的测试**

在 `extensions/safety/index.test.ts` 的 `describe("safety approval gating", …)` 内追加：

```ts
  it("uses the delegation deny reason when the pinned subagent rule fires", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "deny", auditId: "a1", ruleId: "builtin.subagent-ask-pinned" } as never);
    const r = await setup()({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, { hasUI: false, cwd, ui: {} });
    expect(r).toMatchObject({ block: true, terminate: true });
    expect(r?.reason).toContain("已被自动拒绝");
    expect(r?.reason).toContain("不要重试");
  });

  it("keeps the generic deny reason for other rule ids", async () => {
    vi.mocked(getApprovalPolicy).mockReturnValue("auto");
    mocks.evaluateToolCall.mockResolvedValue({ decision: "deny", auditId: "a1", ruleId: "builtin.protected-path" } as never);
    const r = await setup()({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, { hasUI: false, cwd, ui: {} });
    expect(r?.reason).toBe("已被授权规则拒绝：bash");
  });
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run safety/index --reporter=dot`
预期：第一个新用例 FAIL（reason 为「已被授权规则拒绝：bash」）

- [ ] **步骤 3：实现**

`extensions/safety/index.ts` import 追加：

```ts
import { DELEGATION_DENY_REASON, SUBAGENT_ASK_PINNED_RULE_ID } from "../_shared/delegation-scope.js";
```

把

```ts
    if (verdict.decision === "deny") {
      return refuse(`已被授权规则拒绝：${event.toolName}`);
    }
```

改为

```ts
    if (verdict.decision === "deny") {
      if (verdict.ruleId === SUBAGENT_ASK_PINNED_RULE_ID) return refuse(DELEGATION_DENY_REASON);
      return refuse(`已被授权规则拒绝：${event.toolName}`);
    }
```

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run safety --reporter=dot`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add extensions/safety/index.ts extensions/safety/index.test.ts
git commit -m "feat(safety): 子代理审批钉死命中时返回委派范围拒绝文案"
```

---

### 任务 4：executeSubagent 注入声明

**文件：**
- 修改：`extensions/multi-agent/index.ts:130-157`（`executeSubagent`）
- 修改：`extensions/multi-agent/index.test.ts`

- [ ] **步骤 1：写失败的测试**

在 `extensions/multi-agent/index.test.ts` 末尾追加：

```ts
describe("spawn_agent · delegation scope statement", () => {
  const STATEMENT = "你是被委派的子代理：权限范围在启动时已固定";

  it("subprocess path: systemPrompt ends with the statement", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(false);
    await loadSpawnAgent()("t-ds1", { task: "do x" }, null, null, ctx);
    const sp = vi.mocked(spawnPiAgent).mock.calls[0]?.[2]?.systemPrompt as string;
    expect(sp).toContain(STATEMENT);
    expect(sp.startsWith("你是被委派的子代理")).toBe(true);
  });

  it("embedded path: systemPrompt ends with the statement", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    await loadSpawnAgent()("t-ds2", { task: "do x" }, null, null, ctx);
    const sp = vi.mocked(runEmbeddedSubagent).mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).toContain(STATEMENT);
  });

  it("continuable spawn also carries the statement", async () => {
    vi.mocked(canUseEmbeddedSubagent).mockReturnValue(true);
    await loadSpawnAgent()("t-ds4", { task: "do x", action: "spawn" }, null, null, ctx);
    const sp = vi.mocked(startContinuableEmbedded).mock.calls[0]?.[0]?.systemPrompt as string;
    expect(sp).toContain(STATEMENT);
  });
});
```

named agent 提示在前、声明在后的顺序已由任务 1 的 `withDelegationScope` 单测锁定；`index.test.ts` 的 `agents.js` mock 让 `resolveAgent` 恒返回 undefined，这里不再重复测 named agent。

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run multi-agent/index -t "delegation scope" --reporter=dot`
预期：3 个 FAIL（`systemPrompt` 为 undefined 或不含声明）

- [ ] **步骤 3：实现**

`extensions/multi-agent/index.ts` import 追加：

```ts
import { withDelegationScope } from "../_shared/delegation-scope.js";
```

`executeSubagent` 开头（`if (canUseEmbeddedSubagent(profile))` 之前）插入一行，并把两条路径的 `systemPrompt` 都换成它：

```ts
async function executeSubagent(
  cwd: string,
  task: string,
  agentId: string,
  profile: ReturnType<typeof resolveProfile>,
  opts: Parameters<typeof spawnPiAgent>[2] & { parentSessionPath?: string; seedMessages?: unknown[] },
): Promise<SubagentRunResult> {
  const systemPrompt = withDelegationScope(opts.systemPrompt);
  if (canUseEmbeddedSubagent(profile)) {
    return runEmbeddedSubagent({
      cwd,
      task,
      agentId,
      parentSessionPath: opts.parentSessionPath,
      model: opts.model,
      systemPrompt,
      tools: opts.tools,
      env: opts.env,
      mcp: opts.mcp,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onUpdate: opts.onUpdate,
      seedMessages: opts.seedMessages,
    });
  }
  const r = await spawnPiAgent(cwd, task, { ...opts, systemPrompt });
  const stopReason: SubagentStopReason = opts.signal?.aborted ? "aborted" : r.ok ? "completed" : "error";
  return { ...r, stopReason };
}
```

`action: "spawn"` 的 embedded 分支（`startContinuableEmbedded({ … systemPrompt: layer.systemPrompt … })`，约 `index.ts:641`）不经过 `executeSubagent`，把那一行改为：

```ts
              systemPrompt: withDelegationScope(layer.systemPrompt),
```

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run multi-agent --reporter=dot`
预期：全部 PASS（含旧用例）

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/index.ts extensions/multi-agent/index.test.ts
git commit -m "feat(multi-agent): 子级系统提示固定附委派范围声明"
```

---

### 任务 5：全量回归与类型检查

- [ ] **步骤 1：类型检查**

运行：`cd cli && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`（`cli/tsconfig.json` 的 `include` 覆盖 `../extensions`）与 `cd electron-agent && npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
预期：无错误

- [ ] **步骤 2：回归**

运行：`cd extensions && npx vitest run --reporter=dot 2>&1 | tail -5` 与 `cd electron-agent && npx vitest run electron/app/toolPermission --reporter=dot 2>&1 | tail -5`
预期：全部 PASS

- [ ] **步骤 3：更新规格状态**

把 `docs/superpowers/specs/2026-09-14-dsh-subagent-delegation-scope-design.md` 第 4 行 `- 状态：待审查` 改为 `- 状态：已落地`。

```bash
git add docs/superpowers/specs/2026-09-14-dsh-subagent-delegation-scope-design.md
git commit -m "docs(specs): 第五期委派范围声明标记已落地"
```
