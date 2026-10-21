import {
  ATTENTION_OPEN_EVENT,
  WINDOW_FOCUS_EVENT,
  attentionSessionKey,
  notifyEnabled,
  notifySettingOf,
  type AttentionNotifyInput,
  type AttentionNotifyResult,
} from './attentionContract';

/** BrowserWindow 里用到的那几个方法，单测用假的。 */
export interface AttentionWindow {
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  flashFrame(flag: boolean): void;
  setOverlayIcon(icon: unknown, description: string): void;
  on(event: 'focus' | 'blur', listener: () => void): unknown;
}

export interface AttentionNotification {
  on(event: 'click' | 'close', listener: () => void): unknown;
  show(): void;
  close(): void;
}

export interface AttentionServiceDeps {
  window: () => AttentionWindow | undefined;
  readSettings: () => Promise<Record<string, string>>;
  /** 返回 undefined 表示系统不支持通知。 */
  createNotification: (options: { title: string; body: string; silent: boolean }) => AttentionNotification | undefined;
  createImage: (dataUrl: string) => unknown;
  setBadgeCount: (count: number) => void;
  send: (event: string, payload: unknown) => void;
  platform: NodeJS.Platform;
}

/**
 * 会话需要注意时的系统层动作：按设置和窗口焦点决定不提示、交给渲染层弹应用内提示、还是发系统通知；
 * 任务栏闪烁、覆盖图标 / 角标数字；通知点击后拉起窗口并让渲染层打开那个会话。
 */
export class AttentionService {
  /**
   * 按会话记着当前那条系统通知，一直持有引用，否则被 GC 后点击回调不再触发。
   * 不在 close 事件上丢：Windows 横幅超时进行动中心时就会发 close，通知还在、还能被点。
   * 只在同会话新通知替换、被点击、渲染层说这个会话的状态已清（clear）时丢。
   */
  private readonly shown = new Map<string, AttentionNotification>();
  /** badge 要先读设置，两次调用可能乱序完成：只应用最新一次。 */
  private badgeSeq = 0;

  constructor(private readonly deps: AttentionServiceDeps) {}

  attachWindow(win: AttentionWindow): void {
    win.on('focus', () => {
      win.flashFrame(false);
      this.deps.send(WINDOW_FOCUS_EVENT, { focused: true });
    });
    win.on('blur', () => this.deps.send(WINDOW_FOCUS_EVENT, { focused: false }));
  }

  isFocused(): boolean {
    return this.deps.window()?.isFocused() ?? false;
  }

  async notify(input: AttentionNotifyInput): Promise<AttentionNotifyResult> {
    const settings = await this.deps.readSettings();
    if (!notifyEnabled(settings, notifySettingOf(input.kind))) return { route: 'off', sound: false };
    const sound = notifyEnabled(settings, 'notify.sound');
    const win = this.deps.window();
    if (win?.isFocused()) return { route: 'in-app', sound };

    const key = attentionSessionKey(input.sessionPath);
    this.clear(input.sessionPath);
    const notification = this.deps.createNotification({ title: input.title, body: input.body, silent: !sound });
    if (!notification) return { route: 'in-app', sound };
    this.shown.set(key, notification);
    const forget = () => {
      if (this.shown.get(key) === notification) this.shown.delete(key);
    };
    notification.on('click', () => {
      forget();
      this.bringToFront();
      this.deps.send(ATTENTION_OPEN_EVENT, { workspace: input.workspace, sessionPath: input.sessionPath });
    });
    notification.show();
    if (input.kind !== 'done' && notifyEnabled(settings, 'notify.taskbar')) win?.flashFrame(true);
    return { route: 'os', sound };
  }

  /** 这个会话不再需要提醒（已答复、已打开）：把它留在行动中心里的通知一起收掉。 */
  clear(sessionPath: string): void {
    const key = attentionSessionKey(sessionPath);
    const previous = this.shown.get(key);
    if (!previous) return;
    this.shown.delete(key);
    previous.close();
  }

  async badge(input: { count: number; overlayDataUrl?: string }): Promise<void> {
    const seq = ++this.badgeSeq;
    const settings = await this.deps.readSettings();
    if (seq !== this.badgeSeq) return;
    const count = notifyEnabled(settings, 'notify.taskbar') ? input.count : 0;
    if (this.deps.platform !== 'win32') {
      this.deps.setBadgeCount(count);
      return;
    }
    const win = this.deps.window();
    if (!win) return;
    if (count > 0 && input.overlayDataUrl) {
      win.setOverlayIcon(this.deps.createImage(input.overlayDataUrl), `${count} 个会话需要处理`);
    } else {
      win.setOverlayIcon(null, '');
    }
  }

  private bringToFront(): void {
    const win = this.deps.window();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}
