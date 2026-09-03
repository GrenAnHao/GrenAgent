export const isNavigable = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  return /^(https?:|about:)/i.test(url);
};

export function findAnchor(target: EventTarget | null, composedPath: readonly EventTarget[] = []): HTMLAnchorElement | null {
  const direct = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null;
  if (direct) return direct;
  return composedPath.find((entry): entry is HTMLAnchorElement => (
    entry instanceof HTMLAnchorElement && entry.hasAttribute('href')
  )) ?? null;
}

export function resolveNavigableUrl(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || value === 'about:blank') return null;
  try {
    const resolved = new URL(value, base).href;
    return isNavigable(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

const navigateInGuest = (value: string): void => {
  // Navigating in the guest avoids relying on the embedder's ipc-message timing.
  window.location.href = value;
};

const originalOpen = window.open;
window.open = (url, target, features) => {
  const resolved = resolveNavigableUrl(url, window.location.href);
  if (resolved) {
    navigateInGuest(resolved);
    return null;
  }
  return originalOpen.call(window, url, target, features);
};

document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = findAnchor(event.target, typeof event.composedPath === 'function' ? event.composedPath() : []);
  if (!link || !isNavigable(link.href)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  navigateInGuest(link.href);
}, true);
