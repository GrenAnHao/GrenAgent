import { contextBridge, ipcRenderer } from 'electron';

type EventHandler = (event: { payload: unknown }) => void;

const subscribe = (event: string, handler: EventHandler) => {
  const channel = `gren:event:${event}`;
  const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => handler({ payload });
  ipcRenderer.on(channel, listener);
  return Promise.resolve(() => ipcRenderer.removeListener(channel, listener));
};

contextBridge.exposeInMainWorld('gren', {
  invoke: <T>(command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke('gren:invoke', { command, args }) as Promise<T>,
  subscribe,
  pickDirectory: () => ipcRenderer.invoke('gren:pick-directory'),
  openUrl: (url: string) => ipcRenderer.invoke('gren:open-url', url),
  openPath: (path: string) => ipcRenderer.invoke('gren:open-path', path),
  revealItemInDir: (path: string) => ipcRenderer.invoke('gren:reveal-item', path),
  window: {
    minimize: () => ipcRenderer.invoke('gren:window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('gren:window:toggle-maximize'),
    isMaximized: () => ipcRenderer.invoke('gren:window:is-maximized'),
    close: () => ipcRenderer.invoke('gren:window:close'),
    onResized: (handler: () => void) => subscribe('window-resized', () => handler()),
  },
  webview: {
    onDragDropEvent: (handler: EventHandler) => subscribe('webview-drag-drop', handler),
  },
});
