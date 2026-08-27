type Listener = () => void;
const listeners = new Set<Listener>();
export function onResourceReloadRequested(listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function requestResourceReload(): boolean { const scheduled = listeners.size > 0; for (const listener of listeners) { try { listener(); } catch {} } return scheduled; }
