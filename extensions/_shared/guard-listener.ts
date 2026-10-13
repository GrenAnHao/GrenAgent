// Pi 挂在 SDK 会话上的监听方（session.subscribe）不能把错误抛回 SDK。
// AgentSession 同步逐个调用监听方，Agent 等它们处理完才算这条事件发完；任何一个抛错，这条事件的 promise 就被拒：
// - tool_execution_update（工具调 onUpdate 发的）：SDK 在 execute 结束后统一等这些 promise，被拒的话 execute 成功了
//   这次工具调用也会失败（pi-agent-core 1.1.0 agent-loop.js:587）。工具那一侧接不到这个拒绝，只能在监听方这里拦。
// - 别的事件（message_update 等）：整轮中断。
// 扩展的事件处理器 SDK 自己逐个 try/catch 了，Pi 自己的监听方没有，所以都经这里包一层：出错记日志、吞掉。
// 同一个监听方第一次出错记完整堆栈，之后只计数，收尾时（report）写一行总数，免得流式输出时一秒几十行。

export interface GuardedListener<A extends unknown[]> {
  (...args: A): void;
  /** 收尾时调：第一次之后又吞了几次，有就写一行。 */
  report(): void;
}

export function guardListener<A extends unknown[]>(name: string, fn: (...args: A) => unknown): GuardedListener<A> {
  let failures = 0;
  const swallow = (error: unknown): void => {
    failures += 1;
    if (failures === 1) console.error(`[session-listener] ${name} failed; swallowed so the session keeps going`, error);
  };
  const guarded = ((...args: A): void => {
    try {
      const result = fn(...args);
      // 万一监听方是 async 的：它的拒绝同样不能变成漏网错误。
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, swallow);
      }
    } catch (error) {
      swallow(error);
    }
  }) as GuardedListener<A>;
  guarded.report = () => {
    if (failures > 1) console.error(`[session-listener] ${name}: ${failures - 1} more error(s) swallowed`);
    failures = 0;
  };
  return guarded;
}
