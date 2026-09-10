// 模块级 listeners 是有意的进程级广播：requestResourceReload() 触发所有 handle reload。
// 规格 C 节接受（reload 在 waitForIdle 后执行、幂等）。不要改成按 workspace 分键。
type Listener = () => void;
const listeners = new Set<Listener>();
export function onResourceReloadRequested(listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function requestResourceReload(): boolean { const scheduled = listeners.size > 0; for (const listener of listeners) { try { listener(); } catch {} } return scheduled; }
