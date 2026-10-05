import { describe, expect, it, vi } from 'vitest';
import { attachGuestWindowOpenHandler, decideWindowOpen, shouldClearModifierOnKeyUp } from './webviewPopup';

describe('decideWindowOpen', () => {
  it('drops non-http(s) URLs', () => {
    expect(decideWindowOpen({ url: 'about:blank', disposition: 'new-window', modifierActive: false })).toEqual({
      kind: 'drop',
    });
  });

  it('opens background-tab and modifier clicks externally', () => {
    expect(
      decideWindowOpen({ url: 'https://a.test', disposition: 'background-tab', modifierActive: false }),
    ).toEqual({ kind: 'external', url: 'https://a.test' });
    expect(
      decideWindowOpen({ url: 'https://a.test', disposition: 'new-window', modifierActive: true }),
    ).toEqual({ kind: 'external', url: 'https://a.test' });
  });

  it('routes ordinary popups internally', () => {
    expect(
      decideWindowOpen({ url: 'https://a.test/x', disposition: 'foreground-tab', modifierActive: false }),
    ).toEqual({ kind: 'internal', url: 'https://a.test/x' });
  });
});

describe('shouldClearModifierOnKeyUp', () => {
  it('clears only when the released key is Control or Meta', () => {
    expect(shouldClearModifierOnKeyUp({ type: 'keyUp', key: 'Control', code: 'ControlLeft' })).toBe(true);
    expect(shouldClearModifierOnKeyUp({ type: 'keyUp', key: 'Meta', code: 'MetaLeft' })).toBe(true);
    expect(shouldClearModifierOnKeyUp({ type: 'keyUp', key: 'a', code: 'KeyA', control: true })).toBe(false);
    expect(shouldClearModifierOnKeyUp({ type: 'keyDown', key: 'Control', code: 'ControlLeft' })).toBe(false);
  });
});

interface SimGuest {
  listeners: Record<string, Array<(...args: never[]) => void>>;
  id: number;
  on: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
}

function makeGuest(): SimGuest {
  const listeners: SimGuest['listeners'] = {};
  return {
    id: 9,
    listeners,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      (listeners[event] ??= []).push(handler);
    }),
    setWindowOpenHandler: vi.fn(),
  };
}

function makeEmbedder() {
  const listeners: Record<string, Array<(...args: never[]) => void>> = {};
  return {
    listeners,
    send: vi.fn(),
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      (listeners[event] ??= []).push(handler);
    }),
  };
}

describe('attachGuestWindowOpenHandler', () => {
  it('always denies native windows and follows decideWindowOpen', () => {
    const guest = makeGuest();
    const openExternal = vi.fn(async () => {});
    const sendInternal = vi.fn();
    attachGuestWindowOpenHandler({
      guest: guest as never,
      embedder: { send: vi.fn(), on: vi.fn() } as never,
      tabIdFor: (id) => (id === 9 ? 'tab-9' : undefined),
      eventChannel: 'gren:event:browser-open-url',
      openExternal,
      sendInternal,
      warn: vi.fn(),
    });

    const handler = guest.setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string;
      disposition: string;
    }) => { action: string };
    expect(handler({ url: 'https://a.test', disposition: 'new-window' })).toEqual({ action: 'deny' });
    expect(sendInternal).toHaveBeenCalledWith('gren:event:browser-open-url', {
      url: 'https://a.test',
      disposition: 'new-window',
      sourceTabId: 'tab-9',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('still denies when sendInternal throws', () => {
    const guest = makeGuest();
    attachGuestWindowOpenHandler({
      guest: guest as never,
      embedder: { send: vi.fn(), on: vi.fn() } as never,
      tabIdFor: () => 'tab-9',
      eventChannel: 'gren:event:browser-open-url',
      openExternal: vi.fn(async () => {}),
      sendInternal: vi.fn(() => {
        throw new Error('destroyed');
      }),
      warn: vi.fn(),
    });
    const handler = guest.setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string;
      disposition: string;
    }) => { action: string };
    expect(handler({ url: 'https://a.test', disposition: 'new-window' })).toEqual({ action: 'deny' });
  });

  it('opens externally after Control keyDown and stops after Control keyUp', () => {
    const guest = makeGuest();
    const openExternal = vi.fn(async () => {});
    const sendInternal = vi.fn();
    attachGuestWindowOpenHandler({
      guest: guest as never,
      embedder: { send: vi.fn(), on: vi.fn() } as never,
      tabIdFor: () => 'tab-9',
      eventChannel: 'gren:event:browser-open-url',
      openExternal,
      sendInternal,
      warn: vi.fn(),
    });
    const onInput = guest.listeners['before-input-event']?.[0];
    const handler = guest.setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string;
      disposition: string;
    }) => { action: string };

    onInput?.({} as never, { type: 'keyDown', key: 'Control', code: 'ControlLeft', control: true } as never);
    handler({ url: 'https://a.test', disposition: 'new-window' });
    expect(openExternal).toHaveBeenCalledWith('https://a.test');
    expect(sendInternal).not.toHaveBeenCalled();

    sendInternal.mockClear();
    openExternal.mockClear();
    onInput?.({} as never, { type: 'keyUp', key: 'Control', code: 'ControlLeft', control: true } as never);
    handler({ url: 'https://a.test', disposition: 'new-window' });
    expect(openExternal).not.toHaveBeenCalled();
    expect(sendInternal).toHaveBeenCalled();
  });

  it('clears sticky modifier on guest blur', () => {
    const guest = makeGuest();
    const openExternal = vi.fn(async () => {});
    const sendInternal = vi.fn();
    attachGuestWindowOpenHandler({
      guest: guest as never,
      embedder: { send: vi.fn(), on: vi.fn() } as never,
      tabIdFor: () => 'tab-9',
      eventChannel: 'gren:event:browser-open-url',
      openExternal,
      sendInternal,
      warn: vi.fn(),
    });
    const onInput = guest.listeners['before-input-event']?.[0];
    const onBlur = guest.listeners.blur?.[0];
    const handler = guest.setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string;
      disposition: string;
    }) => { action: string };
    onInput?.({} as never, { type: 'keyDown', key: 'Meta', code: 'MetaLeft', meta: true } as never);
    onBlur?.();
    handler({ url: 'https://a.test', disposition: 'new-window' });
    expect(openExternal).not.toHaveBeenCalled();
    expect(sendInternal).toHaveBeenCalled();
  });

  it('clears sticky modifier when the host webContents blurs', () => {
    const guest = makeGuest();
    const embedder = makeEmbedder();
    const openExternal = vi.fn(async () => {});
    const sendInternal = vi.fn();
    attachGuestWindowOpenHandler({
      guest: guest as never,
      embedder: embedder as never,
      tabIdFor: () => 'tab-9',
      eventChannel: 'gren:event:browser-open-url',
      openExternal,
      sendInternal,
      warn: vi.fn(),
    });

    guest.listeners['before-input-event']?.[0]?.(
      {} as never,
      { type: 'keyDown', key: 'Control', code: 'ControlLeft', control: true } as never,
    );
    embedder.listeners.blur?.[0]?.();

    const handler = guest.setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string;
      disposition: string;
    }) => { action: string };
    handler({ url: 'https://a.test', disposition: 'new-window' });
    expect(openExternal).not.toHaveBeenCalled();
    expect(sendInternal).toHaveBeenCalled();
  });
});
