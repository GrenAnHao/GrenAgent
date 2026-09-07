export type RuntimeArgs = Record<string, unknown> | undefined;

export type UnlistenFn = () => void;

export interface RuntimeEvent<T> {
  payload: T;
}

export interface GrenWindowApi {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  close(): Promise<void>;
  onResized(handler: () => void): Promise<UnlistenFn>;
}

export interface GrenWebviewApi {
  /** 返回 true 表示已接管拖放，preload 会阻止浏览器/编辑器的默认处理。 */
  onDragDropEvent(handler: (event: RuntimeEvent<DragDropPayload>) => boolean | void): Promise<UnlistenFn>;
}

export interface DragDropPayload {
  type: 'over' | 'leave' | 'drop';
  position?: { x: number; y: number };
  paths: string[];
  types?: string[];
  text?: string;
}

export interface GrenRuntimeBridge {
  invoke<T>(command: string, args?: RuntimeArgs): Promise<T>;
  subscribe<T>(event: string, handler: (event: RuntimeEvent<T>) => void): Promise<UnlistenFn>;
  pickDirectory(): Promise<string | null>;
  openUrl(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  revealItemInDir(path: string): Promise<void>;
  window: GrenWindowApi;
  webview: GrenWebviewApi;
}

declare global {
  interface Window {
    gren?: GrenRuntimeBridge;
  }
}

function bridge(): GrenRuntimeBridge {
  if (typeof window !== 'undefined' && window.gren) return window.gren;
  return browserPreviewBridge;
}

const browserPreviewBridge: GrenRuntimeBridge = {
  invoke: async () => {
    throw new Error('Electron runtime bridge is unavailable');
  },
  subscribe: async () => () => {},
  pickDirectory: async () => null,
  openUrl: async () => {},
  openPath: async () => {},
  revealItemInDir: async () => {},
  window: {
    minimize: async () => {},
    toggleMaximize: async () => {},
    isMaximized: async () => false,
    close: async () => {},
    onResized: async () => () => {},
  },
  webview: {
    onDragDropEvent: async () => () => {},
  },
};

export function invoke<T>(command: string, args?: RuntimeArgs): Promise<T> {
  return bridge().invoke<T>(command, serializeRuntimeArg(args) as RuntimeArgs);
}

export function listen<T>(event: string, handler: (event: RuntimeEvent<T>) => void): Promise<UnlistenFn> {
  return bridge().subscribe(event, handler);
}

export class Channel<T> {
  readonly id = `channel-${channelSequence++}`;
  onmessage: ((message: T) => void) | null = null;

  postMessage(message: T): void {
    this.onmessage?.(message);
  }
}

let channelSequence = 0;
const subscribedChannels = new WeakSet<Channel<unknown>>();

function serializeRuntimeArg(value: unknown): unknown {
  if (value instanceof Channel) {
    if (!subscribedChannels.has(value as Channel<unknown>)) {
      subscribedChannels.add(value as Channel<unknown>);
      void bridge()
        .subscribe(`channel:${value.id}`, (event) => value.postMessage(event.payload))
        .catch(() => {});
    }
    return { __grenChannelId: value.id };
  }
  if (Array.isArray(value)) return value.map(serializeRuntimeArg);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeRuntimeArg(item)]));
  }
  return value;
}

export function openDirectory(): Promise<string | null> {
  return bridge().pickDirectory();
}

export function openUrl(url: string): Promise<void> {
  return bridge().openUrl(url);
}

export function openPath(path: string): Promise<void> {
  return bridge().openPath(path);
}

export function revealItemInDir(path: string): Promise<void> {
  return bridge().revealItemInDir(path);
}

export function getCurrentWindow(): GrenWindowApi {
  if (typeof window !== 'undefined' && window.gren) return window.gren.window;
  return {
    minimize: async () => {},
    toggleMaximize: async () => {},
    isMaximized: async () => false,
    close: async () => {},
    onResized: async () => () => {},
  };
}

export function getCurrentWebview(): GrenWebviewApi {
  return bridge().webview;
}
