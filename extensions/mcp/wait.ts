// direct 服务器的连接等待。超时只放弃等待，不取消底层连接。
export function waitForDirect(pendings: readonly Promise<unknown>[], budgetMs: number): Promise<"ready" | "timeout"> {
  if (pendings.length === 0) return Promise.resolve("ready");
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve("timeout");
    }, budgetMs);
    void Promise.allSettled(pendings).then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve("ready");
    });
  });
}
