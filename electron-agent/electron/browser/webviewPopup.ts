import { isAllowedPopupUrl } from './webviewPolicy';

export type WindowOpenDecision =
  | { kind: 'drop' }
  | { kind: 'external'; url: string }
  | { kind: 'internal'; url: string };

export function decideWindowOpen(params: {
  url: string;
  disposition: string;
  modifierActive: boolean;
}): WindowOpenDecision {
  const { url, disposition, modifierActive } = params;
  if (!isAllowedPopupUrl(url)) {
    return { kind: 'drop' };
  }
  if (disposition === 'background-tab' || modifierActive) {
    return { kind: 'external', url };
  }
  return { kind: 'internal', url };
}

export function shouldClearModifierOnKeyUp(input: {
  type: string;
  key?: string;
  code?: string;
}): boolean {
  if (input.type !== 'keyUp') {
    return false;
  }
  const key = input.key ?? '';
  const code = input.code ?? '';
  if (key === 'Control' || key === 'Meta') {
    return true;
  }
  if (code.startsWith('Control') || code.startsWith('Meta')) {
    return true;
  }
  return false;
}

const MODIFIER_NAMES = new Set(['control', 'ctrl', 'meta', 'command', 'cmd']);

export function isModifierDown(input: {
  control?: boolean;
  meta?: boolean;
  modifiers?: string[];
}): boolean {
  if (input.control === true || input.meta === true) {
    return true;
  }
  const modifiers = input.modifiers;
  if (!modifiers?.length) {
    return false;
  }
  for (const m of modifiers) {
    if (MODIFIER_NAMES.has(m.toLowerCase())) {
      return true;
    }
  }
  return false;
}

interface InputEventLike {
  type: string;
  key?: string;
  code?: string;
  control?: boolean;
  meta?: boolean;
  modifiers?: string[];
}

interface GuestLike {
  id: number;
  on(event: string, handler: (...args: unknown[]) => void): void;
  setWindowOpenHandler(
    handler: (details: { url: string; disposition: string }) => { action: 'deny' },
  ): void;
}

interface EmbedderLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export function attachGuestWindowOpenHandler(options: {
  guest: GuestLike;
  embedder: EmbedderLike;
  tabIdFor: (guestId: number) => string | undefined;
  eventChannel: string;
  openExternal: (url: string) => Promise<unknown>;
  sendInternal: (channel: string, payload: Record<string, unknown>) => void;
  warn: (...args: unknown[]) => void;
}): void {
  const { guest, embedder, tabIdFor, eventChannel, openExternal, sendInternal, warn } = options;
  let modifierActive = false;

  const clearModifier = () => {
    modifierActive = false;
  };

  guest.on('before-input-event', (_event: unknown, input: InputEventLike) => {
    if (shouldClearModifierOnKeyUp(input)) {
      modifierActive = false;
    } else {
      modifierActive = isModifierDown(input);
    }
  });

  guest.on('blur', clearModifier);
  embedder.on('blur', clearModifier);

  guest.setWindowOpenHandler((details) => {
    try {
      const decision = decideWindowOpen({
        url: details.url,
        disposition: details.disposition,
        modifierActive,
      });

      switch (decision.kind) {
        case 'drop':
          warn('webview popup dropped:', details.url);
          break;
        case 'external':
          try {
            void Promise.resolve(openExternal(decision.url)).catch(warn);
          } catch (err) {
            warn(err);
          }
          break;
        case 'internal': {
          const payload: Record<string, unknown> = {
            url: decision.url,
            disposition: details.disposition,
          };
          const sourceTabId = tabIdFor(guest.id);
          if (sourceTabId !== undefined) {
            payload.sourceTabId = sourceTabId;
          }
          sendInternal(eventChannel, payload);
          break;
        }
      }
    } finally {
      return { action: 'deny' };
    }
  });
}
