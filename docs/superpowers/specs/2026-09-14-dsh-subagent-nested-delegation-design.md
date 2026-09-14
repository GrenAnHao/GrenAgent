# DSH 子代理第七期：嵌套委派与深度预算

- 日期：2026-09-14
- 状态：待审查
- 主题：对齐 DSH 嵌套委派——子级可再委派（one-shot 与可续聊皆可），深度按 `subagent_meta` 与环境双源记账且单调不降，Activation 图带 `ownedChildren`，拆除子级优先，祖先可打断任意深度后代，目录多层。
- 依赖：[规格 2](./2026-09-13-dsh-subagent-continuable-notice-design.md)（Activation / inbox / parent host / notice）、[规格 3](./2026-09-13-dsh-subagent-header-catalog-design.md)（目录 / 覆层 / IPC 白名单）、[规格 4](./2026-09-13-dsh-subagent-fork-seed-design.md)（fork 在子级里的拒绝条件）
- 关联：`extensions/multi-agent/activation.ts`、`index.ts`、`adjacent-tools.ts`、`parent-host.ts`、`embedded-runner.ts`、`registry.ts`、`electron-agent/electron/app/subagentService.ts`、`electron-agent/src/features/subagents/SubagentHeaderCatalog.tsx`
- DSH 参照：`packages/subagent/subagent/src/depth.ts`、`continuation-activation.ts`、`.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md`

---

## 1. 问题

现状（2026-09-14 核对）：

- 子级禁止再委派靠两道硬拦：子进程路径 `PI_IS_SUBAGENT === "1"`（`index.ts:395`）、embedded 路径 `buildExcludeTools` 固定去掉 `spawn_agent`（`embedded-runner.ts:147`）。
- 规格 2 的 `Activation.ownedChildren` 恒空；`watchSettlement` 已在 `ownedChildren.size > 0` 时不结算（`activation.ts:166`），但没有任何地方往里放东西。
- `interrupt_agent` 只认直接父（`adjacent-tools.ts:205`）。
- 目录 `hasChildren` 已实现，树深实际恒为 1。
- `send_message` 鉴权已按 `parentSessionId === senderId` 泛化（`adjacent-tools.ts:136-143`），不依赖「顶层」概念。
- `sendSettlementToParent` 按 `parentSessionPath` 查 host（`parent-host.ts:36`）；host 只由 `WorkspaceHandle` 为主会话注册，子级没有。

DSH：深度记在 session header 且单调不降（运行时 option 只能加深）；`maxDepth` 可配；Activation 图带 `ownedChildren`，结算要等后代空；拆除子级优先；祖先可打断任意深度后代。

## 2. 目标与成功标准

1. `SUBAGENT_MAX_DEPTH`（默认 2）之内，子级里的 `spawn_agent` 可用，`run` / `tasks` / `chain` / `action: "spawn"` / `fork: true` 都可；超过深度上限的子级看不到 `spawn_agent`，即使硬调也报错不启动。
2. 冷恢复的子级深度不归零：`subagent_meta.depth` 是权威，env 只能加深。
3. 子级以 `action: "spawn"` 启动的孙级结算后，notice 落进子级 JSONL（子级模型可见）；子级自己在孙级未结算前不结算。
4. `spawn_agent({ action: "cancel" })` 或父 `WorkspaceHandle` dispose 拆除子级时，先拆其后代再拆自身，全部写 `tornDown`。
5. 顶层可 `interrupt_agent` 孙级；同级 / 旁支不行。
6. 页头目录能展开到孙级；孙级覆层能投递与打断（IPC 白名单含孙级路径）。

**范围**：`extensions/multi-agent` + Electron 目录白名单 + 设置一个键 + registry 两列。

## 3. 方案取舍（已锁定）

| 方案 | 做法 | 结论 |
|---|---|---|
| **1. 深度双源 + Activation 自注册父 host（采用）** | 深度 = max(自身 `subagent_meta.depth`, `SUBAGENT_DEPTH`)；每个 continuable Activation 安装时注册 `ParentSessionHost` | 复用全部现有结算 / notice / 鉴权路径；改动集中 |
| 2. 单独建委派树模块 | 新图结构，host / 鉴权 / 拆除都查它 | 与 Activation 表、registry 三份真值并存；DSH 也把图挂在 Activation 上 |
| 3. 深度只走 env | 最省 | 冷恢复的子级 env 归零 → 可当顶层再委派；DSH 明确指出此漏洞 |

## 4. 设计

### 4.1 深度与上限

**配置** `SUBAGENT_MAX_DEPTH`：数字，默认 `2`（顶层 0 → 子 1 → 孙 2）。设 `1` 即回到「子级不能再委派」的旧行为。设置页「子代理 → 并发与限制」分组加此键；非法值当默认。

**读取自身深度**（新文件 `extensions/multi-agent/depth.ts`）：

```ts
export function resolveDelegationDepth(ctx: { sessionManager?: { getEntries?: () => unknown[] } }): number;
// max(自身 JSONL 最后一条 subagent_meta.depth ?? 0, Number(getConfig("SUBAGENT_DEPTH")) || 0)
export function readMaxDepth(): number; // SUBAGENT_MAX_DEPTH，默认 2，非法回默认
export function childDepthOf(ctx): number; // resolveDelegationDepth(ctx) + 1
export function assertDepthAllowed(childDepth: number): void; // > max → SubagentError("已达委派深度上限 <max>", "DEPTH_EXCEEDED")
```

顶层会话无 meta 无 env → 0。两源取 max 保证单调。

**spawn 时**（`index.ts` `execute` 内 `run` / `spawn` 分支之前，替换 `PI_IS_SUBAGENT` 拦截）：
- `childDepth = childDepthOf(ctx)`；`assertDepthAllowed(childDepth)` 失败 → `isError`，不启动。
- `profileEnv.SUBAGENT_DEPTH = String(childDepth)`（embedded 经 ALS config、子进程经真 env）。
- 子 `subagent_meta` 加 `depth: childDepth`（embedded 与子进程路径的 meta 写点都加）。
- `tasks` / `chain` 各单元同一 `childDepth`。

**工具可见性**（`embedded-runner.ts` `buildExcludeTools(env)`）：
- 不再固定去掉 `spawn_agent`；`Number(env.SUBAGENT_DEPTH) >= readMaxDepth()` 时才去掉（子级不该看到一个必然报错的工具）。
- `explore_context` 照旧去掉。
- 子进程路径：`runner.ts` 现有 deny 列表同样按此条件决定是否含 `spawn_agent`。
- named agent 的 `tools` allowlist 仍优先（allowlist 不含 `spawn_agent` 则看不到）。

**删除**：`index.ts:395` 的 `PI_IS_SUBAGENT` 递归拦截；规格 4 的「在子级里禁 fork」（`index.ts:472` `inChild` 判定），fork 拒绝条件只剩「非 embedded」与「非单任务」。`PI_IS_SUBAGENT` 本身保留（`resolveToolOrigin` 与规格 5 的审批钉死仍靠它）。

`SUBAGENT_MAX_PER_SESSION` 按会话各自计数不变；与深度上限共同封顶总量。

### 4.2 Activation 图

`Activation` / `ActivationRecord` 新增：

```ts
depth: number;               // 来自 subagent_meta.depth
parentActivationId?: string; // 父是 Activation 时为其 childId；父是顶层会话时省略
```

**挂入**：`index.ts` `action: "spawn"` embedded 分支在 `startContinuableEmbedded` 成功、`writeParentCatalog` 之前：`const parentAct = getActivation(parentSid)`；存在则 `parentAct.ownedChildren.add(id)`，并把 `parentActivationId: parentSid` 传给 `installActivation`（`startContinuableEmbedded` 透传）。`coldResumeAndDeliver` 同样：sender 有 Activation 则挂入。

**摘出**：`activation.ts` 三种 dispose（`settled` / `cancel` / `rollback`）在 `activations.delete(childId)` 后：`parentActivationId` 对应的 Activation 若还在，`ownedChildren.delete(childId)` 并 `poke(parentAct)`，让父的 `watchSettlement` 重新评估。

one-shot 嵌套（`run` / `tasks` / `chain`）不进 `ownedChildren`：父在工具调用里阻塞，session 非 idle，结算不会误触发。

### 4.3 子 Activation 充当父 host

`installActivation` 末尾：

```ts
act.unregisterHost = registerParentSessionHost({
  sessionId: act.childId,
  sessionPath: act.sessionPath,
  workspace: act.workspace,
  isBusy: () => !isSessionIdle(act.session),
  isDraining: () => act.inbox.closing !== undefined,
  sendMessage: (msg, opts) => act.session.sendCustomMessage(msg, opts),
  prompt: (text, delivery) => deliverToChild(act.childId, text, delivery),
});
```

`AgentSessionLike` 加 `sendCustomMessage`（SDK `AgentSession` 已有）。dispose 时 `act.unregisterHost()`。

孙级结算 notice 于是走现有 `sendSettlementToParent(parentSessionPath, workspace, notice)` 落进子级 JSONL（`custom_message`，子级模型可见；覆层复用 `SubagentSettledPill`）。

子进程路径的父没有 host（现状不变）：其后代结算 notice 静默丢弃，只留 registry 终态。

### 4.4 拆除顺序（子级优先）

`disposeActivation(childId, reason)` 改为：

1. `childLock` 外先快照 `[...act.ownedChildren]`，逐个 `await disposeActivation(id, "cancel")`（递归到叶；每个后代各写 `tornDown`）。
2. 进 `childLock`：关自身 inbox、`session.dispose()`、`unregisterHost()`、`activations.delete`、从父 `ownedChildren` 摘出并 poke（§4.2）。
3. `reason === "cancel" && announced` → 向父发 `aborted` notice（现有）。

被拆的中间层 `isDraining()` 为真，它收到的后代 notice 只写入不唤醒（`sendSettlementToParent` 现有分支）。

`drainByParent(mainSessionPath)` 因递归自动覆盖整棵子树；不需要改。

`cancel.ts` 的 `writeTornDown` 对被连带拆除的后代同样各写一条（放在递归 dispose 内，按各自 `sessionPath`）。

### 4.5 `interrupt_agent` 祖先权限

`adjacent-tools.ts` `executeInterrupt`：

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

- 非祖先 → `UNAUTHORIZED`；目标不驻留仍是接受的空操作（现有）。
- 只 `session.abort()` 目标当前轮，目标的后代不动。
- 工具描述改为「目标可以是你的直接子级，或你之下更深的后代」。

### 4.6 `send_message`

现有逻辑按 id 相邻判定，孙级 ↔ 子级直接成立。不放开隔代；冷恢复仍只对直接子级，sender 必须在线（现状）。孙级首条任务的返回指引里 `parentSessionId` 取 `ctx.sessionManager.getSessionId()`（子级 id），天然正确。

### 4.7 目录与 UI

- 子级成功创建后代时，`writeParentCatalog(pi, ctx, …)` 在子级扩展实例里自然写子 JSONL，`emitCatalogChanged({ sessionPath: 子路径 })`。
- `SubagentHeaderCatalog`：`subagent_catalog_changed` 的 `sessionPath` 若等于某已展开行的 `sessionPath`，只重采那一行的子目录；等于主会话路径则重折根目录（现有）。
- `subagentService.catalogWhitelist(parentSessionPath)`：改为递归折叠——从主会话起逐层打开子 JSONL 折叠其目录，最多 `readMaxDepth()` 层；结果 Map 含全部后代。`subagent_prompt` / `subagent_interrupt` / `catalogRowSample` 都用它。
- 覆层从孙级返回仍回主会话（规格 3 结论不变）。

### 4.8 registry

`registry.ts` 加两列：`parentId TEXT NULL`、`depth INTEGER NOT NULL DEFAULT 0`。`load()` 时 `PRAGMA table_info` 缺列则 `ALTER TABLE ADD COLUMN`。`create` 写入；`spawn_agent({ action: "list" })` 输出行加 `parentId` / `depth`，不改过滤范围（仍列整个工作区）。

### 4.9 重启 reap

`reap-continuable.ts` 逻辑不变：JSONL 在且 `mode === "continuable"` 的行标 `done` 不通知。嵌套行同样处理；父子之间不做联动（进程已没了，没有 Activation 可拆）。

## 5. 错误

| 情况 | 结果 |
|---|---|
| `childDepth > SUBAGENT_MAX_DEPTH` | `isError`：`已达委派深度上限 <max>`，不启动、不占 `SUBAGENT_MAX_PER_SESSION` 名额 |
| 深度到顶的子级硬调 `spawn_agent` | 同上（工具本已被 exclude，双保险） |
| 孙级 install 时父 Activation 已在 closing | `installActivation` 抛 `DRAINING`，孙级 rollback |
| 中间层拆除中收到后代 notice | 只写入不唤醒 |
| 祖先链上遇到无 Activation 的父 | 链到此为止；未命中 sender → `UNAUTHORIZED` |
| registry 迁移失败 | 抛错，与现有 `load()` 失败同处理 |

## 6. 明确不做

- `list_agents` 新工具（`list` 已带 `parentId` / `depth`）
- 隔代 `send_message`
- 总后代数上限（深度 × 每会话上限已封顶）
- 子进程父的后代 notice
- 覆层堆栈式返回
- DSH `subagent/start` / `subagent/end` 生命周期事件
- 冷恢复非直接子级

## 7. 测试

**`depth.test.ts`**
- meta 与 env 取 max；env 归零仍按 meta（冷恢复场景）；顶层 0；`SUBAGENT_MAX_DEPTH` 非法回 2

**`index.test.ts`**
- `childDepth > max` → `isError` 且 `executeSubagent` 未调用、`sessionSpawnCount` 未增
- `max = 1`：子级 `excludeTools` 含 `spawn_agent`；`max = 2`：不含；孙级（depth 2）含
- 子进程路径 env 含 `SUBAGENT_DEPTH`
- 子级 `fork: true` 不再被拒绝
- `tasks` 三单元同一 `depth`

**`activation.test.ts`**
- 孙级 install → 父 `ownedChildren` 含其 id；父 idle 且 inbox 空但 `ownedChildren` 非空 → 不结算；孙结算后父 `ownedChildren` 空 → 父结算
- 父 `cancel`：断言 dispose 顺序为孙 → 子；两者都写 `tornDown`
- 孙级 notice 调子级 `sendCustomMessage`；子级 busy → `steer`；子级 draining → `triggerTurn: false` 无 `deliverAs`
- 子 Activation dispose 后 `lookupParentHost(childPath)` 为 undefined
- 冷恢复孙级挂进 sender `ownedChildren`

**`adjacent-tools.test.ts`**
- 顶层 interrupt 孙级成功；子级 interrupt 自己的孙级成功；同级 / 旁支 / 孙对祖父 → `UNAUTHORIZED`
- 孙级 `send_message` 给顶层（隔代）→ `UNAUTHORIZED`

**`catalog` / Electron**
- 三层目录折叠；`catalogWhitelist` 含孙级路径、不含超过 max 层的路径
- `subagent_catalog_changed` 命中已展开行时只重采该行

**`registry.test.ts`**
- 旧库无新列 → `load()` 后两列存在；`create` 写入 `parentId` / `depth`
