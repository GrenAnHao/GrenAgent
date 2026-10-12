// 进程内共享的 ModelRuntime。
//
// 宿主（Electron 的 agent-host 子进程）建好交互会话用的 ModelRuntime 后登记在这里；嵌入式子代理和冷恢复
// 建子会话时复用它，不再各自 ModelRuntime.create（读 auth / models、建内置供应商目录、两次全量重建）。
// 十个子代理并行启动时，这一步在同一个事件循环里排队，是冷启动的大头之一。
// 交互会话本来就共用这一份；没有宿主的进程（pi-worker）不登记，子会话照旧自己建。

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const KEY = Symbol.for("gren.sharedModelRuntime");

type Holder = typeof globalThis & { [KEY]?: ModelRuntime };

export function setSharedModelRuntime(runtime: ModelRuntime | undefined): void {
  (globalThis as Holder)[KEY] = runtime;
}

export function sharedModelRuntime(): ModelRuntime | undefined {
  return (globalThis as Holder)[KEY];
}
