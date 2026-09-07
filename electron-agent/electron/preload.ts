import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS } from './ipc/contracts';

type EventHandler = (event: { payload: unknown }) => boolean | void;

const subscribe = (event: string, handler: EventHandler) => {
  const channel = `${IPC_CHANNELS.eventPrefix}${event}`;
  const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => handler({ payload });
  ipcRenderer.on(channel, listener);
  return Promise.resolve(() => ipcRenderer.removeListener(channel, listener));
};

const onDragDropEvent = (handler: EventHandler) => {
  const onDrag = (event: DragEvent) => {
    const drop = event.type === 'drop';
    const transfer = event.dataTransfer;
    const types = Array.from(transfer?.types ?? []);
    const dpr = window.devicePixelRatio || 1;
    const handled = handler({
      payload: {
        type: drop ? 'drop' : 'over',
        // 保持现有拖放接口的物理像素坐标，输入框会按 DPR 换算回 CSS 像素。
        position: { x: event.clientX * dpr, y: event.clientY * dpr },
        paths: drop
          ? Array.from(transfer?.files ?? [], (file) => webUtils.getPathForFile(file)).filter(Boolean)
          : [],
        types,
        text: drop ? transfer?.getData('text/plain') ?? '' : undefined,
      },
    });
    if (handled) {
      event.preventDefault();
      // 输入框已自行处理，阻止编辑器再次插入文本或图片。
      event.stopPropagation();
      if (transfer) transfer.dropEffect = 'copy';
    } else if (drop && types.includes('Files')) {
      // 文件落在输入区外时也不能让 Chromium 导航到该文件。
      event.preventDefault();
    }
  };
  const onLeave = (event: DragEvent) => {
    if (event.type === 'dragleave' && event.relatedTarget) return;
    handler({ payload: { type: 'leave', paths: [] } });
  };
  document.addEventListener('dragenter', onDrag, true);
  document.addEventListener('dragover', onDrag, true);
  document.addEventListener('drop', onDrag, true);
  document.addEventListener('dragleave', onLeave, true);
  document.addEventListener('dragend', onLeave, true);
  return Promise.resolve(() => {
    document.removeEventListener('dragenter', onDrag, true);
    document.removeEventListener('dragover', onDrag, true);
    document.removeEventListener('drop', onDrag, true);
    document.removeEventListener('dragleave', onLeave, true);
    document.removeEventListener('dragend', onLeave, true);
  });
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
    onDragDropEvent,
  },
});
