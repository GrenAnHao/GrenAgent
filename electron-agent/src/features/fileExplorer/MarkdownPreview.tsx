import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { classifyHref } from '../../lib/hrefKinds';
import { DomFinder } from '../find/domFinder';
import { useFindStore } from '../find/findStore';
import { useFindDriver } from '../find/useFindDriver';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { fileExplorerStyles as styles } from './fileExplorerStyles';

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (delayMs <= 0) {
      setShown(value);
      return undefined;
    }
    const timer = setTimeout(() => setShown(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return delayMs <= 0 ? value : shown;
}

/** GitHub 风格的标题 id：小写、去标点（保留中日韩文字、连字符、下划线）、空白变连字符。 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/** 在预览容器里找锚点目标：先按 id / name 精确找，再按标题文字的 slug 找。 */
export function findAnchorTarget(container: HTMLElement, id: string): HTMLElement | null {
  for (const el of container.querySelectorAll<HTMLElement>('[id],a[name]')) {
    if (el.id === id || el.getAttribute('name') === id) return el;
  }
  const wanted = slugifyHeading(id);
  if (!wanted) return null;
  for (const heading of container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    if (slugifyHeading(heading.textContent ?? '') === wanted) return heading;
  }
  return null;
}

export interface MarkdownPreviewProps {
  content: string;
  /** 边写边看时防抖，避免每个按键都重新解析整篇。 */
  debounceMs: number;
  /**
   * 点了非锚点链接。href 是 `<a>` 上的原文；system 表示按住了 Ctrl / ⌘。
   * 不传也不会让应用跳转：链接点击一律在这里拦下，只是什么都不发生。
   */
  onOpenLink?: (href: string, options: { system: boolean }) => void;
  /** 预览自己处理不了时的可见提示（比如锚点找不到）。 */
  onNotice?: (text: string) => void;
  /** 给了就接入这个范围的查找栏：在预览的已渲染内容里高亮命中并跳转。 */
  findScope?: string;
  /** 变了就用同一查询重新查（换了文件）。 */
  findResetKey?: string | number;
}

/** Markdown 预览：和对话正文同一套渲染（含 mermaid）。 */
export function MarkdownPreview({ content, debounceMs, onOpenLink, onNotice, findScope, findResetKey }: MarkdownPreviewProps) {
  const shown = useDebouncedValue(content, debounceMs);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 查找：预览整篇都在 DOM 里（没有虚拟化），直接扫容器；渲染是懒加载的，内容补上来时 MutationObserver 会重算。
  const finder = useMemo(
    () =>
      findScope
        ? new DomFinder({
            getRoot: () => containerRef.current,
            getScroller: () => containerRef.current,
            onStatus: (status) => useFindStore.getState().setStatus(findScope, status),
          })
        : null,
    [findScope],
  );
  useFindDriver(findScope ?? '', finder, findResetKey);

  // 链接不能走浏览器默认行为：href 会按应用自己的地址补全，点一下整个应用窗口就被导航走了。
  // 捕获阶段拦：先于 lobe Markdown 自己给 `<a>` 挂的 target=_blank 等行为，并让全局 AppLinkGuard 看到 defaultPrevented 而跳过。
  const intercept = (event: MouseEvent<HTMLDivElement>) => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    const container = containerRef.current;
    if (!anchor || !container || !container.contains(anchor)) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    const kind = classifyHref(href);
    if (kind.kind === 'anchor') {
      const target = kind.id ? findAnchorTarget(container, kind.id) : container;
      if (!target) {
        onNotice?.(`文档里没有找到锚点 #${kind.id}`);
        return;
      }
      if (target === container) {
        container.scrollTo({ top: 0 });
        return;
      }
      const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top: Math.max(0, top - 8) });
      return;
    }
    onOpenLink?.(href, { system: event.ctrlKey || event.metaKey });
  };

  return (
    <div
      ref={containerRef}
      className={styles.markdown}
      tabIndex={0}
      data-testid="file-markdown-preview"
      onClickCapture={intercept}
      onAuxClickCapture={intercept}
    >
      <LazyMarkdown variant="chat">{shown}</LazyMarkdown>
    </div>
  );
}
