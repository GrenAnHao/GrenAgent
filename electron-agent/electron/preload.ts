import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from './ipc/contracts';

type EventHandler = (event: { payload: unknown }) => void;

const subscribe = (event: string, handler: EventHandler) => {
  const channel = `${IPC_CHANNELS.eventPrefix}${event}`;
  const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => handler({ payload });
  ipcRenderer.on(channel, listener);
  return Promise.resolve(() => ipcRenderer.removeListener(channel, listener));
};

contextBridge.exposeInMainWorld('gren', {
  invoke: <T>(command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.invoke, { command, args }) as Promise<T>,
  subscribe,
  pickDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.pickDirectory),
  openUrl: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.openUrl, url),
  openPath: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  revealItemInDir: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.revealItem, path),
  window: {
    minimize: () => ipcRenderer.invoke(IPC_CHANNELS.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC_CHANNELS.windowToggleMaximize),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.windowIsMaximized),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.windowClose),
    onResized: (handler: () => void) => subscribe('window-resized', () => handler()),
  },
  webview: {
    onDragDropEvent: (handler: EventHandler) => subscribe('webview-drag-drop', handler),
  },
});
