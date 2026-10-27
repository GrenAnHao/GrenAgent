import { createContext, useCallback, useLayoutEffect, useState, type RefObject } from 'react';

/** Portal 仍属于本次 ChatView 的 React 树；不把几何状态放进跨会话 store。 */
export const ComposerOverlayRegistration = createContext<(element: HTMLElement | null) => void>(() => {});

const CONTENT_GAP = 8;

export function useComposerClearance(
  viewportRef: RefObject<HTMLElement | null>,
  seatRef: RefObject<HTMLElement | null>,
  scope: string,
) {
  const [overlay, setOverlay] = useState<{ scope: string; element: HTMLElement | null }>();
  const [measured, setMeasured] = useState({ scope, height: 0 });
  const registerOverlay = useCallback((element: HTMLElement | null) => {
    setOverlay((previous) => previous?.scope === scope && previous.element === element ? previous : { scope, element });
  }, [scope]);
  const element = overlay?.scope === scope ? overlay.element : null;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const seat = seatRef.current;
    if (!viewport || !seat) return;
    const measure = () => {
      const rect = element?.getBoundingClientRect();
      // 空间是覆盖范围的并集。seat 可能还包括 Goal/审批，不能简单再加一遍卡片高度。
      const covered = rect && rect.width > 0 && rect.height > 0
        ? Math.max(0, viewport.getBoundingClientRect().bottom - rect.top + CONTENT_GAP)
        : 0;
      const height = Math.ceil(Math.max(seat.offsetHeight, covered));
      setMeasured((previous) => previous.scope === scope && previous.height === height ? previous : { scope, height });
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(viewport);
    resize.observe(seat);
    if (element) resize.observe(element);
    // 锚点/窗口变化可能只移动浮层而不改变尺寸；sessionOverlay 会更新其 inline bottom。
    const position = element ? new MutationObserver(measure) : null;
    if (element) position?.observe(element, { attributes: true, attributeFilter: ['style'] });
    return () => {
      resize.disconnect();
      position?.disconnect();
    };
  }, [element, scope, seatRef, viewportRef]);

  return { paddingBottom: measured.scope === scope ? measured.height : 0, registerOverlay };
}
