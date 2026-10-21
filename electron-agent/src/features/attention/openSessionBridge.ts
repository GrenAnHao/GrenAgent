type OpenHandler = (workspace: string, path: string) => void | Promise<void>;

let handler: OpenHandler | undefined;

/**
 * 应用内提示的「前往」和系统通知的点击都要打开某个会话，打开逻辑在 App 里（handleOpenSourceSession）。
 * App 挂载时注册进来，返回注销函数。
 */
export function registerAttentionOpenHandler(fn: OpenHandler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = undefined;
  };
}

/** 没有注册时什么都不做。 */
export function openSessionFromAttention(workspace: string, path: string): void {
  if (!handler) return;
  void Promise.resolve(handler(workspace, path)).catch(() => {});
}
