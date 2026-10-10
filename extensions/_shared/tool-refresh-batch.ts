// 合并 pi 的工具表刷新。
//
// pi 的 registerTool 每调一次都同步执行 refreshTools()，也就是 AgentSession._refreshToolRegistry()：
// 重新包装全部工具、重算 loadout、让 codemode 把所有可调用工具重新渲染成描述。一次注册 N 个工具
// 就是 N 次全量刷新，开销随工具数平方增长（300 个 MCP 工具一次投影要几秒）。
//
// 会话创建后、绑定扩展前调 installToolRefreshBatching(session)：之后在 batchToolRefresh(fn) 同步执行
// 期间，这个会话无参数的刷新只记下，fn 结束时每个会话刷新一次。带参数的刷新（建运行时、reload）照常
// 立即执行。pi 的 refreshTools 动作每次都现取 this._refreshToolRegistry，所以换掉实例上的方法就够了，
// 不用改 pi。pi 改名或改实现时 tool-refresh-batch.test.ts 的契约用例会失败。

type RefreshTarget = { _refreshToolRegistry?: (options?: unknown) => unknown };

interface BatchState {
  depth: number;
  pending: Set<() => void>;
}

const STATE_KEY = Symbol.for("gren.toolRefreshBatch");
const INSTALLED = Symbol.for("gren.toolRefreshBatch.installed");

function state(): BatchState {
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: BatchState };
  holder[STATE_KEY] ??= { depth: 0, pending: new Set() };
  return holder[STATE_KEY];
}

/** fn 同步执行期间合并已安装会话的工具表刷新，结束时每个会话刷新一次。返回 fn 的返回值。 */
export function batchToolRefresh<T>(fn: () => T): T {
  const batch = state();
  batch.depth += 1;
  try {
    return fn();
  } finally {
    batch.depth -= 1;
    if (batch.depth === 0) flush(batch);
  }
}

function flush(batch: BatchState): void {
  const pending = [...batch.pending];
  batch.pending.clear();
  let failure: unknown;
  for (const refresh of pending) {
    try {
      refresh();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

/** 让这个会话的工具表刷新可以被 batchToolRefresh 合并。已安装或对象不支持时返回 false。 */
export function installToolRefreshBatching(session: unknown): boolean {
  if (!session || typeof session !== "object") return false;
  const target = session as RefreshTarget & { [INSTALLED]?: true };
  const original = target._refreshToolRegistry;
  if (typeof original !== "function" || target[INSTALLED]) return false;
  const refreshNow = (options?: unknown) => original.call(session, options);
  const deferred = () => { refreshNow(); };
  target._refreshToolRegistry = (options?: unknown) => {
    const batch = state();
    if (batch.depth > 0 && options === undefined) {
      batch.pending.add(deferred);
      return undefined;
    }
    return refreshNow(options);
  };
  target[INSTALLED] = true;
  return true;
}
