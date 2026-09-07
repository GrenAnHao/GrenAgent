import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: { isPackaged: false },
}));
vi.mock('electron', () => electron);

import { attachDevToolsShortcut, isDevToolsShortcut, isDevToolsShortcutEnabled, type KeyInput } from './devtoolsShortcut';

interface SimTarget {
  listeners: Record<string, Array<(...args: never[]) => void>>;
  on: ReturnType<typeof vi.fn>;
  openDevTools: ReturnType<typeof vi.fn>;
  closeDevTools: ReturnType<typeof vi.fn>;
  isDevToolsOpened: ReturnType<typeof vi.fn>;
}

function makeTarget(): SimTarget {
  const listeners: SimTarget['listeners'] = {};
  return {
    listeners,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      (listeners[event] ??= []).push(handler);
    }),
    openDevTools: vi.fn(),
    closeDevTools: vi.fn(),
    isDevToolsOpened: vi.fn(() => false),
  };
}

/** 按一次键。 */
function fireKey(target: SimTarget, partial: Partial<KeyInput>): ReturnType<typeof vi.fn> {
  const handler = target.listeners['before-input-event']?.[0];
  expect(handler).toBeDefined();
  const preventDefault = vi.fn();
  const input: KeyInput = {
    type: 'keyDown',
    key: 'F12',
    isAutoRepeat: false,
    control: false,
    shift: false,
    alt: false,
    meta: false,
    ...partial,
  };
  handler?.({ preventDefault } as never, input as never);
  return preventDefault;
}

const input = (partial: Partial<KeyInput> = {}): KeyInput => ({
  type: 'keyDown',
  key: 'F12',
  isAutoRepeat: false,
  control: false,
  shift: false,
  alt: false,
  meta: false,
  ...partial,
});

afterEach(() => {
  delete process.env.GREN_DEVTOOLS;
  electron.app.isPackaged = false;
});

describe('isDevToolsShortcut', () => {
  it('accepts F12 regardless of modifiers', () => {
    expect(isDevToolsShortcut(input())).toBe(true);
    expect(isDevToolsShortcut(input({ control: true }))).toBe(true);
  });

  it('accepts the platform inspect combos', () => {
    expect(isDevToolsShortcut(input({ key: 'I', control: true, shift: true }))).toBe(true);
    expect(isDevToolsShortcut(input({ key: 'i', control: true, shift: true }))).toBe(true);
    expect(isDevToolsShortcut(input({ key: 'i', meta: true, alt: true }))).toBe(true);
  });

  it('rejects near-miss combos', () => {
    expect(isDevToolsShortcut(input({ key: 'I', control: true }))).toBe(false);
    expect(isDevToolsShortcut(input({ key: 'I', meta: true, shift: true }))).toBe(false);
    expect(isDevToolsShortcut(input({ key: 'F11' }))).toBe(false);
  });

  it('ignores keyUp and auto-repeat (holding the key must not retrigger)', () => {
    expect(isDevToolsShortcut(input({ type: 'keyUp' }))).toBe(false);
    expect(isDevToolsShortcut(input({ isAutoRepeat: true }))).toBe(false);
  });
});

describe('attachDevToolsShortcut', () => {
  it('opens detached DevTools on F12 in dev builds', () => {
    const host = makeTarget();
    attachDevToolsShortcut({ webContents: host } as never);

    expect(host.on).toHaveBeenCalledWith('before-input-event', expect.any(Function));
    expect(host.on).toHaveBeenCalledWith('did-attach-webview', expect.any(Function));

    fireKey(host, {});
    expect(host.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true });
    expect(host.closeDevTools).not.toHaveBeenCalled();
  });

  it('toggles closed when DevTools is already open', () => {
    const host = makeTarget();
    attachDevToolsShortcut({ webContents: host } as never);

    host.isDevToolsOpened.mockReturnValue(true);
    fireKey(host, { key: 'i', control: true, shift: true });
    expect(host.closeDevTools).toHaveBeenCalledTimes(1);
    expect(host.openDevTools).not.toHaveBeenCalled();
  });

  it('prevents the key from reaching the page', () => {
    const host = makeTarget();
    attachDevToolsShortcut({ webContents: host } as never);
    const preventDefault = fireKey(host, {});
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('also binds guests attached as webviews', () => {
    const host = makeTarget();
    attachDevToolsShortcut({ webContents: host } as never);

    const guest = makeTarget();
    const attachHandler = host.listeners['did-attach-webview']?.[0];
    expect(attachHandler).toBeDefined();
    attachHandler?.({} as never, guest as never);

    fireKey(guest, {});
    expect(guest.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true });
    // 宿主不受 guest 按键影响
    expect(host.openDevTools).not.toHaveBeenCalled();
  });

  it('does nothing in packaged builds unless GREN_DEVTOOLS is set', () => {
    electron.app.isPackaged = true;
    const host = makeTarget();
    attachDevToolsShortcut({ webContents: host } as never);
    expect(host.on).not.toHaveBeenCalled();
    expect(isDevToolsShortcutEnabled()).toBe(false);
  });

  it('honors the GREN_DEVTOOLS override in packaged builds', () => {
    electron.app.isPackaged = true;
    process.env.GREN_DEVTOOLS = '1';
    expect(isDevToolsShortcutEnabled()).toBe(true);

    const host = makeTarget();
    attachDevToolsShortcut({ webContents: host } as never);
    expect(host.on).toHaveBeenCalledWith('before-input-event', expect.any(Function));
  });
});
