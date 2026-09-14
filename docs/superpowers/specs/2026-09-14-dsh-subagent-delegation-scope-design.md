# DSH 子代理第五期：委派范围声明与子级审批钉死

- 日期：2026-09-14
- 状态：待审查
- 主题：对齐 DSH 子代理的审批语义（子级审批钉死为自动拒绝）与 `subagent:delegation` 声明（每个子级系统提示固定注入一句范围说明）。
- 依赖：[规格 1](./2026-09-13-dsh-subagent-session-child-design.md)（embedded 子会话）、工具授权 S1（`electron-agent/electron/app/toolPermission/`）
- 关联：`electron-agent/electron/app/toolPermission/toolDecisionService.ts`、`extensions/safety/index.ts`、`extensions/multi-agent/index.ts`
- DSH 参照：`packages/subagent/subagent/src/child-agent.ts:206`（`subagent:delegation`）、`.agents/notes/implemented/feature/2026-08-10-subagent-approval-pinned-never.md`

---

## 1. 问题

现状（2026-09-14 核对）：

- 子级审批策略从父级折算：父 `full` / `workspace` → 子 `auto`；父 `ask` / `readonly` → 子同档（`extensions/multi-agent/index.ts:491`）。
- embedded 子级 `bindExtensions` 传 `noopUi`（`embedded-runner.ts:355`），`safety` 扩展遇到 `ask` 判定走 `!ctx.hasUI` 分支（`safety/index.ts:134`）：工具被 block，子模型看到 **「已攒起等待授权：<tool>」**，主进程审计行 `resolution: 'queued'` 并带 `queuePayload`（`toolDecisionService.ts:71`）。
- 子级上下文里没有任何机制把「攒起」的调用事后放行并重跑。对子模型这就是一次拒绝，但措辞暗示「等一下会有人批」，模型会重试或原地等；审计表里则堆着永远不会被处理的 queued 行。

DSH 的做法：子级审批钉死为 never（自动拒绝），并在每个子级的运行时上下文里固定注入一句声明，告诉模型「别重试，报告限制」。

## 2. 目标与成功标准

1. 子级（embedded 与子进程两条路径）发起的工具调用被判定为 `ask` 时，主进程直接改判 `deny`，审计 `resolution: 'auto'`，**不**写 `queuePayload`。
2. 子模型收到的拒绝文案明确说「已自动拒绝，不要重试，报告限制」。
3. 每个子级的系统提示末尾固定带一句委派范围声明，两条路径一致，named agent 的提示在前。
4. `origin === 'goal'` 的排队语义不变；`origin === 'main'` 完全不受影响。

**范围**：主进程判定 + `safety` 文案 + `multi-agent` 注入点。不动 `ApprovalPolicy` 五档、不动 UI。

## 3. 方案取舍（已锁定）

| 方案 | 做法 | 结论 |
|---|---|---|
| **1. 主进程钉死 + 共享注入点（采用）** | `evaluate` 里 subagent + ask → deny；`executeSubagent` 统一拼声明 | 审计仍有记录（deny 非 queued）；一处改判定、一处改注入，两条子级路径自动覆盖 |
| 2. 新增 `APPROVAL_POLICY=never` 档 | 子级环境直接设第六档 | 要改 `ApprovalPolicy` 类型、五档 UI、`resolvePreset` 一串；`readonly` 父的子级本来靠 `SAFETY_READONLY` 硬限，没必要再加档 |
| 3. 只在 `safety` 扩展侧改 | `!hasUI && origin === subagent` → refuse | 主进程已写完 `queued` 审计，事后仍是死队列；子进程 `hasUI` 语义还要另核 |

## 4. 设计

### 4.1 判定（`electron-agent/electron/app/toolPermission/toolDecisionService.ts`）

`evaluate` 现有流程算出 `decision` 后追加一步：

```ts
if (decision === 'ask' && call.origin === 'subagent') {
  decision = 'deny';
  ruleId = 'builtin.subagent-ask-pinned';
  resolution = 'auto';
}
```

- 位置在 `if (decision === 'ask') resolution = 'queued'` **之前**，这样 subagent 不会先被标成 queued。
- 不写 `queuePayload`（该分支只对 `decision === 'ask' && isHeadless` 生效，改判后自然跳过）。
- `origin === 'goal'` 不进这条分支，仍排队。
- 返回值带 `ruleId`，供扩展侧分流文案。

### 4.2 拒绝文案（`extensions/safety/index.ts`）

`verdict.decision === "deny"` 分支按 `verdict.ruleId` 分流：

| ruleId | 返回 |
|---|---|
| `builtin.subagent-ask-pinned` | `refuse("子代理的权限范围在启动时已固定，此操作需要审批，已被自动拒绝。不要重试；在回复中说明这一限制，交由委派方处理。")` |
| 其他 | 现有 `已被授权规则拒绝：<tool>` |

文案常量放 `extensions/_shared/delegation-scope.ts`，与 4.3 的声明同文件，避免两处措辞漂移。

### 4.3 声明注入（`extensions/multi-agent/index.ts` `executeSubagent`）

`extensions/_shared/delegation-scope.ts` 导出：

```ts
export const DELEGATION_SCOPE_STATEMENT =
  "你是被委派的子代理：权限范围在启动时已固定，无法在本会话内扩大——需要审批的操作会被自动拒绝。" +
  "任务需要超出范围的访问时，不要重试被拒绝的操作；在回复中说明限制，让委派方处理。";
export const DELEGATION_DENY_REASON =
  "子代理的权限范围在启动时已固定，此操作需要审批，已被自动拒绝。不要重试；在回复中说明这一限制，交由委派方处理。";
export function withDelegationScope(systemPrompt: string | undefined): string;
```

`withDelegationScope`：`[systemPrompt?.trim(), DELEGATION_SCOPE_STATEMENT].filter(Boolean).join("\n\n")`。

`executeSubagent` 在分流 embedded / 子进程**之前**把 `opts.systemPrompt` 替换为 `withDelegationScope(opts.systemPrompt)`，两条路径（`runEmbeddedSubagent` 的 `appendSystemPrompt`、`spawnPiAgent` 的 `--append-system-prompt`）自动带上。不在 `embedded-runner.ts` / `runner.ts` 各写一份。

**无条件注入**：父是 `full` 时子级是 `auto`，仍然注入。DSH 同样固定注入；子级前缀稳定，模型行为不随父策略变。

### 4.4 与现有折算的关系

`index.ts:491` 的 `APPROVAL_POLICY` 折算保留：它决定的是 `auto` 档下哪些工具根本不问（内置规则按 preset 匹配）。本期只改「问到了怎么办」这一步。

## 5. 错误与边界

- 主进程通道不可用：`evaluateToolCall` 已返回 `deny`（`desktop-control.ts:105`），子级同样是拒绝，文案走通用「已被授权规则拒绝」。不为此加特殊处理。
- 子进程路径 `resolveToolOrigin()` 由 `PI_IS_SUBAGENT=1` 得出 `subagent`（`desktop-control.ts:78`），facts 里的 `origin` 因此正确；不用另传。
- named agent 的 `systemPrompt` 为空串 / 全空白：`filter(Boolean)` 后只剩声明。

## 6. 明确不做

- 不加 `ApprovalPolicy` 新档
- 不改 goal 的 headless 排队语义
- 不做「子代理被拒记录」UI（审计表已有，走现有审计入口）
- 不让父模型收到子级被拒的独立 notice（子级按声明在回复里说明即可）
- 不把声明做成可配置文案

## 7. 测试

**`toolDecisionService.test.ts`**
- subagent + 内置 ask 规则 → `deny`、`ruleId === 'builtin.subagent-ask-pinned'`、审计 `resolution: 'auto'`、无 `queuePayload`
- goal + 同规则 → 仍 `ask` / `queued` / 有 `queuePayload`
- subagent + allow → allow；subagent + 内置 deny → 原 ruleId 不被覆盖
- 规则查询失败 + subagent → 仍改判 deny（`builtin.rule-lookup-failed` 的 ask 也被钉死）

**`safety` 测试**
- `ruleId === 'builtin.subagent-ask-pinned'` → 文案为 `DELEGATION_DENY_REASON`
- 其他 deny → 原文案

**`multi-agent/index.test.ts`**
- embedded 路径：`createAgentSessionServices` 收到的 `appendSystemPrompt[0]` 以 `DELEGATION_SCOPE_STATEMENT` 结尾
- 子进程路径：`--append-system-prompt` 文件内容以声明结尾
- 有 named agent：agent 提示在前、声明在后、中间一个空行
- 无 named agent：只有声明

**`_shared/delegation-scope.test.ts`**
- `withDelegationScope(undefined)` / `("")` / `("  ")` → 只有声明
