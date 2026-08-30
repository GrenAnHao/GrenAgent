export interface StreamingSource {
  getState: () => { isStreaming: boolean };
  subscribe: (listener: (s: { isStreaming: boolean }) => void) => () => void;
}

/**
 * 等待一次 streaming 周期结束——用于发 prompt 后占住并发槽直到本会话流式真正结束。
 *
 * pi 的 prompt RPC 是“接受即返回”（preflight 成功即响应，流式走事件），因此 prompt
 * resolve 时 isStreaming 往往尚未翻 true。这里据此处理三种情形：
 * - 已在 streaming：等它转 false；
 * - 尚未 streaming：先等它开始，再等结束；
 * - startTimeoutMs 内始终未开始（prompt 被去重/忽略/被拒）：放行，避免永久占槽。
 *
 * 注意：startTimeoutMs 必须覆盖「首个 agent_start 事件」的到达延迟，而不只是 RPC 接受耗时。
 * 推理模型 / 慢供应商 / 冷启动时首响应可能数秒甚至十几秒才到；若超时过短，本函数会在流式
 * 真正开始前提前放行，调用方（ChatView.runOnce）据此误判为「空轮失败」，闪出「发送失败，正在
 * 重试」红条并重发 prompt。默认 15s 给首响应留足窗口（仍由 awaitingResponse 兜底防误判）。
 */
export function awaitStreamingEnd(
  source: StreamingSource,
  opts: { startTimeoutMs?: number } = {},
): Promise<void> {
  const startTimeoutMs = opts.startTimeoutMs ?? 15000;
  return new Promise<void>((resolve) => {
    if (source.getState().isStreaming) {
      const unsub = source.subscribe((s) => {
        if (!s.isStreaming) {
          unsub();
          resolve();
        }
      });
      return;
    }

    let started = false;
    let unsub = () => {};
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      unsub();
      if (startTimer) clearTimeout(startTimer);
      resolve();
    };
    unsub = source.subscribe((s) => {
      if (s.isStreaming) started = true;
      else if (started) finish();
    });
    startTimer = setTimeout(() => {
      if (!started) finish();
    }, startTimeoutMs);
  });
}
