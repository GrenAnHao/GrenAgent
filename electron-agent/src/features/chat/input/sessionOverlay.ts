import { useEffect, useState, type RefObject } from 'react';

export const CHAT_COLUMN_SELECTOR = '[data-chat-column]';

export interface SessionOverlayBox {
  left: number;
  bottom: number;
  width: number;
}

/** 相对对话列测量。列不在（或被 display:none 收成 0）时返回 null，浮层不留在别的页面上。 */
export function measureSessionOverlay(
  anchor: HTMLElement,
  gap: number,
): (SessionOverlayBox & { host: HTMLElement }) | null {
  const host = anchor.closest(CHAT_COLUMN_SELECTOR);
  if (!(host instanceof HTMLElement)) return null;
  const rect = anchor.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  if (rect.width === 0 || hostRect.width === 0 || hostRect.height === 0) return null;
  return {
    host,
    left: Math.round(rect.left - hostRect.left),
    bottom: Math.round(hostRect.bottom - rect.top + gap),
    width: Math.round(rect.width),
  };
}

export function useSessionOverlayBox(
  anchorRef: RefObject<HTMLElement | null>,
  active: boolean,
  gap: number,
): { host: HTMLElement | null; box: SessionOverlayBox | null } {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState<SessionOverlayBox | null>(null);

  useEffect(() => {
    if (!active) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const measure = () => {
      const next = measureSessionOverlay(anchor, gap);
      setHost(next?.host ?? null);
      setBox((prev) => {
        if (!next) return null;
        if (prev && prev.left === next.left && prev.bottom === next.bottom && prev.width === next.width) return prev;
        return { left: next.left, bottom: next.bottom, width: next.width };
      });
    };
    measure();
    const onChange = () => requestAnimationFrame(measure);
    const ro = new ResizeObserver(onChange);
    let node: HTMLElement | null = anchor;
    while (node) {
      ro.observe(node);
      node = node.parentElement;
    }
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [active, anchorRef, gap]);

  if (!active) return { host: null, box: null };
  return { host, box };
}
