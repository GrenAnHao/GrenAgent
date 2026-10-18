// direct 服务器的连接等待。超时只放弃等待，不取消底层连接。
// signal 中止（用户停止这一轮）时同样只是不再等，返回 "aborted"。
export function waitForDirect(
  pendings: readonly Promise<unknown>[],
  budgetMs: number,
  signal?: AbortSignal,
): Promise<"ready" | "timeout" | "aborted"> {
  if (pendings.length === 0) return Promise.resolve("ready");
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: "ready" | "timeout" | "aborted") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish("aborted");
    const timer = setTimeout(() => finish("timeout"), budgetMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    void Promise.allSettled(pendings).then(() => finish("ready"));
  });
}
