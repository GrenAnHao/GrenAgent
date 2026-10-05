import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  clampBrowserViewport,
  parseViewportDimension,
  type BrowserViewportSize,
} from './browserViewport';

type ResizeAxis = { width: 0 | 1; height: 0 | 1 };

export function ResponsiveBrowserViewport({
  active,
  children,
  size,
  onSizeChange,
}: {
  active: boolean;
  children: ReactNode;
  size: BrowserViewportSize;
  onSizeChange: (size: BrowserViewportSize) => void;
}) {
  const [widthDraft, setWidthDraft] = useState(String(size.width));
  const [heightDraft, setHeightDraft] = useState(String(size.height));
  const [drag, setDrag] = useState<{
    pointerId: number;
    startX: number;
    startY: number;
    start: BrowserViewportSize;
    axis: ResizeAxis;
  } | null>(null);

  useEffect(() => {
    if (drag) return;
    setWidthDraft(String(size.width));
    setHeightDraft(String(size.height));
  }, [drag, size.height, size.width]);

  const commitAxis = (axis: 'width' | 'height', raw: string) => {
    const parsed = parseViewportDimension(raw, axis);
    if (parsed == null) {
      if (axis === 'width') setWidthDraft(String(size.width));
      else setHeightDraft(String(size.height));
      return;
    }
    onSizeChange(clampBrowserViewport({
      width: axis === 'width' ? parsed : size.width,
      height: axis === 'height' ? parsed : size.height,
    }));
  };

  const beginResize = (axis: ResizeAxis, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // jsdom and some synthetic pointers have no capture.
    }
    setDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start: size,
      axis,
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    onSizeChange(clampBrowserViewport({
      width: drag.start.width + (event.clientX - drag.startX) * drag.axis.width,
      height: drag.start.height + (event.clientY - drag.startY) * drag.axis.height,
    }));
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setDrag(null);
  };

  return (
    <div className="gren-browser-viewport">
      {active ? (
        <div className="gren-browser-viewport-bar">
          <input
            aria-label="视口宽度"
            inputMode="numeric"
            value={widthDraft}
            onChange={(event) => setWidthDraft(event.target.value)}
            onBlur={() => commitAxis('width', widthDraft)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            }}
          />
          <span aria-hidden="true">×</span>
          <input
            aria-label="视口高度"
            inputMode="numeric"
            value={heightDraft}
            onChange={(event) => setHeightDraft(event.target.value)}
            onBlur={() => commitAxis('height', heightDraft)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
            }}
          />
        </div>
      ) : null}
      <div
        className={`gren-browser-viewport-canvas${active ? ' gren-browser-viewport-canvas-active' : ''}`}
        data-testid="gren-browser-viewport-canvas"
      >
        <div
          className="gren-browser-viewport-frame"
          data-testid="gren-browser-viewport-frame"
          style={active ? { width: size.width, height: size.height } : undefined}
        >
          {children}
          {active ? (
            <>
              <div
                className="gren-browser-viewport-handle gren-browser-viewport-handle-e"
                aria-label="调整浏览器视口宽度"
                onPointerDown={(event) => beginResize({ width: 1, height: 0 }, event)}
                onPointerMove={onPointerMove}
                onPointerUp={endResize}
                onPointerCancel={endResize}
              />
              <div
                className="gren-browser-viewport-handle gren-browser-viewport-handle-s"
                aria-label="调整浏览器视口高度"
                onPointerDown={(event) => beginResize({ width: 0, height: 1 }, event)}
                onPointerMove={onPointerMove}
                onPointerUp={endResize}
                onPointerCancel={endResize}
              />
              <div
                className="gren-browser-viewport-handle gren-browser-viewport-handle-se"
                aria-label="调整浏览器视口尺寸"
                onPointerDown={(event) => beginResize({ width: 1, height: 1 }, event)}
                onPointerMove={onPointerMove}
                onPointerUp={endResize}
                onPointerCancel={endResize}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
