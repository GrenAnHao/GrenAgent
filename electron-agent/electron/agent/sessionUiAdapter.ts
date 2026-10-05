import { randomUUID } from 'node:crypto';
import type { ExtensionUIContext } from '../../../cli/src/pi-sdk.js';

export type UiSource = 'interactive' | 'goal';

export interface UiEnvelope {
  workspace: string;
  source: UiSource;
  sessionId?: string;
  /** 发起请求的那份会话文件。同项目多份会话同时跑时，渲染层据此把卡片放到对的会话上。 */
  sessionPath?: string;
  request: Record<string, unknown>;
}

export interface UiResponse {
  value?: unknown;
  confirmed?: boolean;
  cancelled?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  cancelValue: unknown;
  method: string;
  title?: string;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface DialogOpts { signal?: AbortSignal; timeout?: number }

export interface SessionUiAdapterOptions {
  workspace: string;
  sessionId: () => string | undefined;
  sessionPath?: () => string | undefined;
  /** 当前回合是否为 Goal：为真则对话立即默认值、通知丢弃，都不广播（对齐今日 rejectUiRequest）。 */
  isGoalTurn: () => boolean;
  emit: (envelope: UiEnvelope) => void;
}

/**
 * 把 pi 扩展的 UI 调用转成 pi://ui-request 信封。回包字段（value/confirmed/cancelled）
 * 与线协议 method 字段名对渲染层冻结，不得更改。成员均为自有可枚举属性（runner {...ui} 展开）。
 */
export class SessionUiAdapter {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: SessionUiAdapterOptions) {}

  readonly context: ExtensionUIContext = {
    select: (title: string, options: string[], opts?: DialogOpts) =>
      this.dialog('select', { title, options, timeout: opts?.timeout }, undefined, opts) as Promise<string | undefined>,
    confirm: (title: string, message: string, opts?: DialogOpts) =>
      this.dialog('confirm', { title, message, timeout: opts?.timeout }, false, opts) as Promise<boolean>,
    input: (title: string, placeholder?: string, opts?: DialogOpts) =>
      this.dialog('input', { title, placeholder, timeout: opts?.timeout }, undefined, opts) as Promise<string | undefined>,
    editor: (title: string, prefill?: string) =>
      this.dialog('editor', { title, prefill }, undefined, undefined) as Promise<string | undefined>,

    notify: (message: string, type?: 'info' | 'warning' | 'error') =>
      this.fireAndForget({ method: 'notify', message, notifyType: type }),
    setStatus: (key: string, text: string | undefined) =>
      this.fireAndForget({ method: 'setStatus', statusKey: key, statusText: text }),
    setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
      if (content === undefined || Array.isArray(content)) {
        this.fireAndForget({ method: 'setWidget', widgetKey: key, widgetLines: content, widgetPlacement: options?.placement });
      }
    },
    setTitle: (title: string) => this.fireAndForget({ method: 'setTitle', title }),
    setEditorText: (text: string) => this.fireAndForget({ method: 'set_editor_text', text }),
    pasteToEditor: (text: string) => this.fireAndForget({ method: 'set_editor_text', text }),

    // TUI 专用，rpc 模式空实现。必须存在且不抛，否则加载 TUI 分支的扩展会崩主进程。
    custom: async () => undefined,
    onTerminalInput: () => () => {},
    getEditorText: () => '',
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: new Proxy({}, { get() { throw new Error('theme is unavailable in the Electron host'); } }) as ExtensionUIContext['theme'],
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Theme switching not supported in the Electron host' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  } as ExtensionUIContext;

  respond(id: string, response: UiResponse): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.settle(id, entry, response.cancelled ? entry.cancelValue : (response.confirmed ?? response.value));
  }

  hasPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** 还有等用户回答的对话框。停在后台的 handle 有它就不能拆。 */
  hasAnyPending(): boolean {
    return this.pending.size > 0;
  }

  /** 回合仍阻塞在 ask_user 的 input 上时，返回那次请求的 id。界面重载后用来把答案交回去。 */
  pendingAskUserRequestId(): string | undefined {
    for (const [id, entry] of this.pending) {
      if (entry.method !== 'input' || typeof entry.title !== 'string') continue;
      try {
        const parsed = JSON.parse(entry.title) as { __askUser?: unknown };
        if (parsed?.__askUser === 1) return id;
      } catch {
        /* 普通文本输入 */
      }
    }
    return undefined;
  }

  cancelAll(): void {
    for (const [id, entry] of [...this.pending]) this.settle(id, entry, entry.cancelValue);
  }

  private dialog(method: string, fields: Record<string, unknown>, cancelValue: unknown, opts?: DialogOpts): Promise<unknown> {
    // Goal 回合：不广播，立即默认值（对齐 main.ts:184-188 对 goal 源一律 rejectUiRequest）。
    if (this.options.isGoalTurn()) return Promise.resolve(cancelValue);
    if (opts?.signal?.aborted) return Promise.resolve(cancelValue);
    const id = randomUUID();
    return new Promise((resolve) => {
      const entry: Pending = {
        resolve,
        cancelValue,
        method,
        ...(typeof fields.title === 'string' ? { title: fields.title } : {}),
      };
      if (opts?.signal) {
        entry.signal = opts.signal;
        entry.onAbort = () => this.settle(id, entry, cancelValue);
        opts.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      if (typeof opts?.timeout === 'number' && opts.timeout > 0) {
        entry.timer = setTimeout(() => this.settle(id, entry, cancelValue), opts.timeout);
      }
      this.pending.set(id, entry);
      this.options.emit({
        ...this.identity(),
        request: { type: 'extension_ui_request', id, method, ...fields },
      });
    });
  }

  private fireAndForget(fields: Record<string, unknown>): void {
    if (this.options.isGoalTurn()) return;
    this.options.emit({
      ...this.identity(),
      request: { type: 'extension_ui_request', id: randomUUID(), ...fields },
    });
  }

  private identity(): Omit<UiEnvelope, 'request'> {
    const sessionId = this.options.sessionId();
    let sessionPath: string | undefined;
    try {
      sessionPath = this.options.sessionPath?.();
    } catch {
      sessionPath = undefined;
    }
    return {
      workspace: this.options.workspace,
      source: 'interactive',
      ...(sessionId ? { sessionId } : {}),
      ...(sessionPath ? { sessionPath } : {}),
    };
  }

  private settle(id: string, entry: Pending, value: unknown): void {
    if (!this.pending.delete(id)) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.resolve(value);
  }
}
