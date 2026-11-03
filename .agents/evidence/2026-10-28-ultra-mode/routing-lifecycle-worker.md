# 子代理路由域生命周期隔离（worker 交付）

日期：2026-10-28

## 接口（`extensions/_shared/ultra-context.ts`，新增）

```ts
export const ROUTING_MODE_KEY = "PI_SUBAGENT_ROUTING_MODE";
export type RoutingMode = "ultra" | "ordinary";

export function isUltraRouting(ctx?: {
  cwd?: string;
  sessionManager?: { getSessionId?: () => string; getEntries?: () => unknown[] };
}): boolean;

export function routingContextEnv(ultra: boolean): Record<string, string>;
// → { PI_SUBAGENT_ROUTING_MODE: "ultra" | "ordinary" }（内部键，不新增用户设置）

export function routingModeFromConfig(config?): RoutingMode | undefined;
export function routingModeFromEnv(): RoutingMode | undefined;
export function routingModeFromMeta(meta?): RoutingMode;      // 旧会话无标记 → ordinary
export function pinnedRoutingMode(): RoutingMode | undefined;  // 只在子代理上下文生效
export function routingWorkspaceContext(mode, base): WorkspaceContext;
export function withRoutingMode(ctx, mode): WorkspaceContext;
export function bindRoutingDomain<T>(session, ctx): T;         // prompt/sendCustomMessage/bindExtensions 包域
export function lastRoutingMeta(entries): Record<string, unknown> | undefined;
```

判定顺序（唯一入口）：

1. 有 `subagent_meta` 的会话（`ctx` 或 ALS 所在会话）→ `meta.routingMode`；无标记的旧子会话直接 ordinary，
   不继承父会话当前 ALS 的 Ultra 标记。
2. 无条目的子代理上下文（进程内孙代理、worker 进程：ALS `origin=subagent` 或 `PI_IS_SUBAGENT=1`）
   → 该上下文已固定的域。
3. 其余都是根会话 → 只看真实 `AgentMode`（`getAgentMode(cwd, sessionId) === "ultra"`）。
   ALS / env 里带 `PI_SUBAGENT_ROUTING_MODE` 不会把根会话变成 Ultra。

## 生命周期落点

- `embedded-runner.ts`：`prepareEmbeddedConfig` 固定 `routingMode`（`env` 显式值 → 发起方域 → ordinary），
  写入派生配置与 `subagent_meta.routingMode`。model / thinkingLevel / excludeTools / 权限一项都没改。
- `activation.ts`：`Activation.routingMode`、驻留池条目、`openResumedChildSession` 都带域；
  `createAgentSessionServices` / `createAgentSessionFromServices` / `bindExtensions` / `prompt` 全在子会话域内执行。
  返回的会话由 `bindRoutingDomain` 包住投递面（prompt / sendCustomMessage / bindExtensions），
  宿主看到的对象身份不变。`SubagentInbox` 的投递、`send_message`（唤醒与 wake:false）也在子会话域内。
- Ultra 冷恢复不自动换模：读最后一条 `model_change`（分支），退 `subagent_meta.model`，
  要求 `modelRuntime.getModel` 命中且 `hasConfiguredAuth`，然后显式传给 `createAgentSessionFromServices`；
  不可用 / 缺凭据 / 无记录都明确报错，不启动。普通恢复不传 model，行为不变。
- worker：`PreparedEmbedded.routingMode` → `SerializedPrepared.routingMode?`（可选，旧宿主兼容，
  worker 侧按 childConfig 回退）→ `WorkerResumed.routingMode` → `resumeWorkerChildSession` 返回 →
  `worker-host` resume 后把 ctx 钉成子会话域。

## 测试

新增（先红后绿）：

- `extensions/_shared/ultra-context.test.ts`（11）：env 键只含域键、旧 meta=ordinary、根会话只按模式、
  ALS/env 域键不改变根会话、旧子会话不继承父 ALS 的 Ultra。
- `extensions/multi-agent/ultra-routing-spawn.test.ts`（13）：spawn 写入 ultra/ordinary、父切模式后子域不变、
  冷恢复扩展初始化/bind/prompt 三段都在子域内、Ultra 恢复显式模型（model_change 与 meta 两条来源）、
  历史模型缺失 / 缺凭据 / 无记录三种拒绝、普通旧恢复不传 model、驻留续聊双向域不串。
- `extensions/multi-agent/worker-session.test.ts`（+4）：open 载荷带域、旧载荷可缺字段、
  resume 返回域、无域旧 worker 会话 = ordinary。

证据：`ultra-routing-lifecycle-red.log`（缺 meta 域 / 冷恢复串域时的 6 红）、
`ultra-routing-lifecycle-green.log`（6 文件 123 用例全绿，含主线程的 `ultra-sdk.integration.test.ts`
真实 SDK 双 provider + 恢复第三请求 + 取消 fixture-one 后拒绝恢复）。
