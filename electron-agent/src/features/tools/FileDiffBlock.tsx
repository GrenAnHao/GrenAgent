import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DiffRow } from './fileDiffModel';
import { languageFromPath } from './codeLanguage';
import { LazyCodeDiff, LazyPatchDiff } from './LazyHighlighter';
import { CodeCard } from './CodeCard';

/**
 * lobe 的 getLobeDiffOptions 会用 diffOptions.unsafeCSS 整段换掉自己的主题覆盖，
 * 所以这里带上原来的透明底。横纵滚动都在 diff 的 [data-code] 上，滚动条悬停渐显。
 * 最大高度可配：会话卡用默认值，「查看改动」弹窗传自己的面板高度。
 */
const DEFAULT_MAX_HEIGHT = 'min(50vh, 360px)';

const diffUnsafeCSS = (maxHeight: string) => `
  :host {
    display: flex !important;
    flex-direction: column !important;
    width: 100% !important;
    min-width: 0 !important;
    min-height: 0 !important;
    max-height: ${maxHeight} !important;
    --diffs-dark-bg: transparent !important;
    --diffs-light-bg: transparent !important;
    --diffs-gap-fallback: 8px;
    --diffs-added-light: ${cssVar.colorSuccessHover};
    --diffs-added-dark: ${cssVar.colorSuccessBorderHover};
    --diffs-modified-light: ${cssVar.colorInfoHover};
    --diffs-modified-dark: ${cssVar.colorInfoBorderHover};
    --diffs-deleted-light: ${cssVar.colorErrorHover};
    --diffs-deleted-dark: ${cssVar.colorErrorBorderHover};
  }

  [data-gutter-buffer] {
    opacity: 0.2 !important;
  }

  [data-code] {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    max-height: ${maxHeight} !important;
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    overflow: auto !important;
    scrollbar-gutter: auto !important;
    scrollbar-width: thin !important;
    scrollbar-color: transparent transparent !important;
    transition: scrollbar-color 180ms ease !important;
  }

  :host(:hover) [data-code] {
    scrollbar-color: color-mix(in srgb, CanvasText 42%, transparent) transparent !important;
  }

  [data-gutter] {
    backdrop-filter: blur(16px) !important;
  }

  [data-code] {
    scrollbar-width: none !important;
  }

  [data-code]::-webkit-scrollbar,
  [data-code]::-webkit-scrollbar-thumb,
  [data-code]::-webkit-scrollbar-track,
  [data-code]::-webkit-scrollbar-track-piece,
  [data-code]::-webkit-scrollbar-corner {
    width: 0 !important;
    height: 0 !important;
    display: none !important;
    background: transparent !important;
  }
`;

/** 按高度缓存：diffOptions 是 lobe 里 useMemo 的依赖，每次渲染新对象会让主题选项跟着重算。 */
const diffOptionsCache = new Map<string, { unsafeCSS: string }>();
function diffOptionsFor(maxHeight: string): { unsafeCSS: string } {
  let options = diffOptionsCache.get(maxHeight);
  if (!options) {
    options = { unsafeCSS: diffUnsafeCSS(maxHeight) };
    diffOptionsCache.set(maxHeight, options);
  }
  return options;
}

const diffBodyStyles = {
  body: { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' } as CSSProperties,
};

const overlayStyles = createStaticStyles(({ css }) => ({
  frame: css`
    position: relative;
    width: 100%;
    min-width: 0;

    &:hover .diff-overlay-thumb {
      opacity: 1;
    }
  `,
  dragging: css`
    .diff-overlay-thumb {
      opacity: 1;
    }
  `,
  thumb: css`
    position: absolute;
    z-index: 2;
    display: none;
    opacity: 0;
    border-radius: 999px;
    background: color-mix(in srgb, CanvasText 42%, transparent);
    cursor: default;
    touch-action: none;
    transition: opacity 180ms ease;
  `,
  y: css`
    top: 32px;
    right: 3px;
    width: 6px;
  `,
  x: css`
    bottom: 3px;
    left: 8px;
    height: 6px;
  `,
}));

function withTrailingNewline(text: string): string {
  if (!text || text.endsWith('\n')) return text;
  return `${text}\n`;
}

function textsFromRows(rows: DiffRow[]): { oldContent: string; newContent: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const row of rows) {
    if (row.marker !== '+') oldLines.push(row.text);
    if (row.marker !== '-') newLines.push(row.text);
  }
  return {
    oldContent: withTrailingNewline(oldLines.join('\n')),
    newContent: withTrailingNewline(newLines.join('\n')),
  };
}

const NO_TEXTS = { oldContent: '', newContent: '' };

export const FileDiffBlock = memo(function FileDiffBlock({
  path,
  rows,
  patch,
  added,
  deleted,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: {
  path: string;
  /** 行级 diff（会话工具卡、本轮改动）。和 patch 至少给一个。 */
  rows?: DiffRow[];
  /** 单文件 unified patch（git diff）。给了就优先用它：行号是真实的，hunk 之间有分隔。 */
  patch?: string;
  added: number;
  deleted: number;
  /** 代码区最大高度（CSS 长度），默认和会话卡一致。 */
  maxHeight?: string;
}) {
  const { oldContent, newContent } = useMemo(() => (rows && !patch ? textsFromRows(rows) : NO_TEXTS), [rows, patch]);
  const diffStyle = useMemo<CSSProperties>(
    () => ({ display: 'flex', flexDirection: 'column', maxHeight, minHeight: 0, minWidth: 0, width: '100%' }),
    [maxHeight],
  );
  const fileName = path.split(/[/\\]/).pop() || path;
  const rootRef = useRef<HTMLDivElement>(null);
  const yThumbRef = useRef<HTMLDivElement>(null);
  const xThumbRef = useRef<HTMLDivElement>(null);
  const language = languageFromPath(path);
  const [highlightEpoch, setHighlightEpoch] = useState(0);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const placeThumbs = (checkHighlight: boolean) => {
      const code = root.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-code]') as HTMLElement | null;
      const yThumb = yThumbRef.current;
      const xThumb = xThumbRef.current;
      if (!code || !yThumb || !xThumb) return;
      const yNeeded = code.scrollHeight > code.clientHeight + 1;
      const xNeeded = code.scrollWidth > code.clientWidth + 1;
      yThumb.style.display = yNeeded ? 'block' : 'none';
      xThumb.style.display = xNeeded ? 'block' : 'none';
      if (yNeeded) {
        const thumb = Math.max(24, (code.clientHeight / code.scrollHeight) * (code.clientHeight - 32));
        const travel = code.clientHeight - 32 - thumb;
        const top = code.scrollHeight === code.clientHeight ? 0 : (code.scrollTop / (code.scrollHeight - code.clientHeight)) * travel;
        yThumb.style.height = `${thumb}px`;
        yThumb.style.transform = `translateY(${top}px)`;
      }
      if (xNeeded) {
        const thumb = Math.max(24, (code.clientWidth / code.scrollWidth) * (code.clientWidth - 16));
        const travel = code.clientWidth - 16 - thumb;
        const left = code.scrollWidth === code.clientWidth ? 0 : (code.scrollLeft / (code.scrollWidth - code.clientWidth)) * travel;
        xThumb.style.width = `${thumb}px`;
        xThumb.style.transform = `translateX(${left}px)`;
      }
      if (!checkHighlight || highlightEpoch >= 1 || (code.textContent?.length ?? 0) <= 30) return;
      const colors = new Set([...code.querySelectorAll('[data-line] span')].slice(0, 40).map((span) => getComputedStyle(span).color));
      if (colors.size <= 1) setHighlightEpoch(1);
    };
    const codeOf = () => root.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-code]') as HTMLElement | null;
    const onScroll = () => placeThumbs(false);
    const bindDrag = (thumb: HTMLElement, axis: 'x' | 'y') => {
      const start = (event: PointerEvent) => {
        const code = codeOf();
        if (!code) return;
        event.preventDefault();
        thumb.setPointerCapture(event.pointerId);
        root.classList.add(overlayStyles.dragging);
        const origin = axis === 'y' ? event.clientY : event.clientX;
        const originScroll = axis === 'y' ? code.scrollTop : code.scrollLeft;
        const view = axis === 'y' ? code.clientHeight : code.clientWidth;
        const extent = axis === 'y' ? code.scrollHeight : code.scrollWidth;
        const thumbSize = axis === 'y' ? thumb.offsetHeight : thumb.offsetWidth;
        const travel = Math.max(1, view - (axis === 'y' ? 32 : 16) - thumbSize);
        const range = extent - view;
        const move = (ev: PointerEvent) => {
          const delta = (axis === 'y' ? ev.clientY : ev.clientX) - origin;
          const next = originScroll + (delta / travel) * range;
          if (axis === 'y') code.scrollTop = next;
          else code.scrollLeft = next;
        };
        const end = () => {
          thumb.removeEventListener('pointermove', move);
          thumb.removeEventListener('pointerup', end);
          root.classList.remove(overlayStyles.dragging);
        };
        thumb.addEventListener('pointermove', move);
        thumb.addEventListener('pointerup', end);
      };
      thumb.addEventListener('pointerdown', start);
      return () => thumb.removeEventListener('pointerdown', start);
    };
    const unbindY = yThumbRef.current ? bindDrag(yThumbRef.current, 'y') : undefined;
    const unbindX = xThumbRef.current ? bindDrag(xThumbRef.current, 'x') : undefined;
    const hostNow = root.querySelector('diffs-container');
    hostNow?.shadowRoot?.querySelector('[data-code]')?.addEventListener('scroll', onScroll);
    const frame = requestAnimationFrame(() => placeThumbs(false));
    const later = window.setTimeout(() => placeThumbs(true), 900);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(later);
      hostNow?.shadowRoot?.querySelector('[data-code]')?.removeEventListener('scroll', onScroll);
      unbindY?.();
      unbindX?.();
    };
    // rows 每次渲染都是新数组，放进依赖会让这个 effect 每帧重绑一次指针/滚动监听并重排 900ms 定时器；
    // 内容变化已由 newContent / oldContent 表达。
  }, [highlightEpoch, newContent, oldContent, patch, path]);

  const shared = {
    diffOptions: diffOptionsFor(maxHeight),
    fileName: path,
    fullFeatured: false,
    language: language === 'text' ? undefined : language,
    showHeader: false,
    style: diffStyle,
    styles: diffBodyStyles,
    variant: 'borderless' as const,
    viewMode: 'unified' as const,
  };

  return (
    <div
      ref={rootRef}
      className={overlayStyles.frame}
      data-diff-source={patch ? 'patch' : 'rows'}
      data-new-content={patch ? undefined : newContent}
      data-old-content={patch ? undefined : oldContent}
      data-testid="file-diff-block"
      style={{
        width: '100%',
        minWidth: 0,
        ['--diffs-font-family' as string]: 'var(--pi-font-mono)',
        ['--diffs-header-font-family' as string]: 'var(--pi-font-sans)',
      }}
    >
      <CodeCard added={added} deleted={deleted} contained fileName={fileName} maxHeight={maxHeight}>
        {patch ? (
          <LazyPatchDiff key={highlightEpoch} {...shared} patch={patch} />
        ) : (
          <LazyCodeDiff key={highlightEpoch} {...shared} newContent={newContent} oldContent={oldContent} />
        )}
      </CodeCard>
      <div ref={yThumbRef} className={`${overlayStyles.thumb} ${overlayStyles.y} diff-overlay-thumb`} />
      <div ref={xThumbRef} className={`${overlayStyles.thumb} ${overlayStyles.x} diff-overlay-thumb`} />
    </div>
  );
});
