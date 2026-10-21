import { describe, expect, it, vi } from 'vitest';
import { AttentionService, type AttentionNotification, type AttentionWindow } from './attentionService';
import { ATTENTION_OPEN_EVENT, WINDOW_FOCUS_EVENT, type AttentionKind, type AttentionNotifyInput } from './attentionContract';

function fakeWindow() {
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    isFocused: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    flashFrame: vi.fn(),
    setOverlayIcon: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
  };
  const emit = (event: string) => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  return { win: win as typeof win & AttentionWindow, emit };
}

function fakeNotification() {
  const listeners = new Map<string, Array<() => void>>();
  const n = {
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    show: vi.fn(),
    close: vi.fn(() => {
      for (const listener of listeners.get('close') ?? []) listener();
    }),
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
  return n as typeof n & AttentionNotification;
}

function setup(opts: { settings?: Record<string, string>; platform?: NodeJS.Platform; unsupported?: boolean } = {}) {
  const { win, emit } = fakeWindow();
  const notifications: ReturnType<typeof fakeNotification>[] = [];
  const createNotification = vi.fn(() => {
    if (opts.unsupported) return undefined;
    const n = fakeNotification();
    notifications.push(n);
    return n;
  });
  const send = vi.fn();
  const setBadgeCount = vi.fn();
  const createImage = vi.fn((url: string) => ({ image: url }));
  const svc = new AttentionService({
    window: () => win,
    readSettings: async () => opts.settings ?? {},
    createNotification,
    createImage,
    setBadgeCount,
    send,
    platform: opts.platform ?? 'win32',
  });
  return { svc, win, emit, notifications, createNotification, send, setBadgeCount, createImage };
}

const input = (kind: AttentionKind, sessionPath = 'D:/s/b.jsonl'): AttentionNotifyInput => ({
  kind,
  workspace: 'D:/repo',
  sessionPath,
  title: 'T',
  body: 'B',
});

describe('AttentionService.notify', () => {
  it('returns off when the kind is disabled', async () => {
    const { svc, createNotification } = setup({ settings: { 'notify.failed': '0' } });
    expect(await svc.notify(input('failed'))).toEqual({ route: 'off', sound: false });
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('keeps done off by default and the others on', async () => {
    const { svc } = setup();
    expect((await svc.notify(input('done'))).route).toBe('off');
    for (const kind of ['approval', 'choice', 'failed', 'blocked'] as const) {
      expect((await svc.notify(input(kind))).route).not.toBe('off');
    }
  });

  it('routes in-app while the window is focused', async () => {
    const { svc, win, createNotification } = setup();
    win.isFocused.mockReturnValue(true);
    expect(await svc.notify(input('choice'))).toEqual({ route: 'in-app', sound: true });
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('shows an OS notification and flashes the frame when unfocused', async () => {
    const { svc, win, createNotification, notifications } = setup();
    expect(await svc.notify(input('approval'))).toEqual({ route: 'os', sound: true });
    expect(createNotification).toHaveBeenCalledWith({ title: 'T', body: 'B', silent: false });
    expect(notifications[0].show).toHaveBeenCalled();
    expect(win.flashFrame).toHaveBeenCalledWith(true);
  });

  it('does not flash for done or when notify.taskbar is off', async () => {
    const done = setup({ settings: { 'notify.done': '1' } });
    expect((await done.svc.notify(input('done'))).route).toBe('os');
    expect(done.win.flashFrame).not.toHaveBeenCalled();

    const off = setup({ settings: { 'notify.taskbar': '0' } });
    expect((await off.svc.notify(input('approval'))).route).toBe('os');
    expect(off.win.flashFrame).not.toHaveBeenCalled();
  });

  it('is silent when notify.sound is off', async () => {
    const { svc, createNotification } = setup({ settings: { 'notify.sound': '0' } });
    expect(await svc.notify(input('failed'))).toEqual({ route: 'os', sound: false });
    expect(createNotification).toHaveBeenCalledWith({ title: 'T', body: 'B', silent: true });
  });

  it('replaces the previous notification of the same session', async () => {
    const { svc, notifications } = setup();
    await svc.notify(input('approval', 'D:\\S\\b.jsonl'));
    await svc.notify(input('failed', 'd:/s/b.jsonl'));
    expect(notifications).toHaveLength(2);
    expect(notifications[0].close).toHaveBeenCalled();
    expect(notifications[1].close).not.toHaveBeenCalled();
    await svc.notify(input('failed', 'D:/s/c.jsonl'));
    expect(notifications[1].close).not.toHaveBeenCalled();
  });

  it('restores a minimized window on click', async () => {
    const { svc, win, notifications, send } = setup();
    win.isMinimized.mockReturnValue(true);
    await svc.notify(input('choice'));
    notifications[0].emit('click');
    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(ATTENTION_OPEN_EVENT, { workspace: 'D:/repo', sessionPath: 'D:/s/b.jsonl' });
  });

  it('keeps the notification after a system-timeout close so the Action Center copy can still be replaced or clicked', async () => {
    const { svc, notifications, send } = setup();
    await svc.notify(input('approval'));
    // Windows 横幅超时进行动中心：close 事件先来，通知还在
    notifications[0].emit('close');
    notifications[0].emit('click');
    expect(send).toHaveBeenCalledWith(ATTENTION_OPEN_EVENT, { workspace: 'D:/repo', sessionPath: 'D:/s/b.jsonl' });
    const fresh = setup();
    await fresh.svc.notify(input('approval'));
    fresh.notifications[0].emit('close');
    await fresh.svc.notify(input('failed'));
    expect(fresh.notifications[0].close).toHaveBeenCalled();
  });

  it('clear() closes and forgets the notification of a session', async () => {
    const { svc, notifications } = setup();
    await svc.notify(input('approval', 'D:/S/B.jsonl'));
    svc.clear('d:\\s\\b.jsonl');
    expect(notifications[0].close).toHaveBeenCalledTimes(1);
    await svc.notify(input('failed'));
    expect(notifications[0].close).toHaveBeenCalledTimes(1);
    svc.clear('D:/s/unknown.jsonl');
  });

  it('normalizes the long-path prefix like the renderer', async () => {
    const { svc, notifications } = setup();
    await svc.notify(input('approval', '\\\\?\\D:\\s\\b.jsonl'));
    await svc.notify(input('failed', 'D:/s/b.jsonl'));
    expect(notifications[0].close).toHaveBeenCalled();
  });

  it('falls back to in-app when notifications are unsupported', async () => {
    const { svc } = setup({ unsupported: true });
    expect(await svc.notify(input('blocked'))).toEqual({ route: 'in-app', sound: true });
  });
});

describe('AttentionService window and badge', () => {
  it('forwards focus and blur and stops flashing on focus', () => {
    const { svc, win, emit, send } = setup();
    svc.attachWindow(win);
    emit('focus');
    expect(win.flashFrame).toHaveBeenCalledWith(false);
    expect(send).toHaveBeenLastCalledWith(WINDOW_FOCUS_EVENT, { focused: true });
    emit('blur');
    expect(send).toHaveBeenLastCalledWith(WINDOW_FOCUS_EVENT, { focused: false });
  });

  it('reports the window focus state', () => {
    const { svc, win } = setup();
    expect(svc.isFocused()).toBe(false);
    win.isFocused.mockReturnValue(true);
    expect(svc.isFocused()).toBe(true);
  });

  it('sets an overlay icon on win32 and clears it at zero', async () => {
    const { svc, win, createImage } = setup();
    await svc.badge({ count: 3, overlayDataUrl: 'data:image/png;base64,AA' });
    expect(createImage).toHaveBeenCalledWith('data:image/png;base64,AA');
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith({ image: 'data:image/png;base64,AA' }, '3 个会话需要处理');
    await svc.badge({ count: 0 });
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
  });

  it('uses setBadgeCount elsewhere', async () => {
    const { svc, win, setBadgeCount } = setup({ platform: 'darwin' });
    await svc.badge({ count: 3, overlayDataUrl: 'data:x' });
    expect(setBadgeCount).toHaveBeenCalledWith(3);
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
  });

  it('applies only the latest badge when settings reads finish out of order', async () => {
    const { win } = fakeWindow();
    const reads: Array<(v: Record<string, string>) => void> = [];
    const svc = new AttentionService({
      window: () => win,
      readSettings: () => new Promise((r) => reads.push(r)),
      createNotification: () => undefined,
      createImage: (url: string) => ({ image: url }),
      setBadgeCount: vi.fn(),
      send: vi.fn(),
      platform: 'win32',
    });
    const first = svc.badge({ count: 2, overlayDataUrl: 'data:2' });
    const second = svc.badge({ count: 0 });
    reads[1]({});
    await second;
    reads[0]({});
    await first;
    expect(win.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
  });

  it('clears the badge when notify.taskbar is off', async () => {
    const { svc, win } = setup({ settings: { 'notify.taskbar': '0' } });
    await svc.badge({ count: 3, overlayDataUrl: 'data:x' });
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
  });
});
