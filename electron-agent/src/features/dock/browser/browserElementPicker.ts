export type BrowserElementPick =
  | { status: 'cancelled' }
  | {
      status: 'selected';
      element: {
        tagName: string;
        selector: string;
        pageUrl: string;
        pageTitle: string;
        text: string;
        html: string;
        background: string;
        color: string;
        font: string;
        width: number;
        height: number;
        margin: string;
        padding: string;
        role: string;
        accessibleName: string;
        keyboardFocusable: boolean;
      };
    };

export type BrowserElementOrigin = {
  tabId: string;
  tabTitle: string;
};

export type BrowserElementOffer = {
  title: string;
  text: string;
};

const PICKER_KEY = '__grenBrowserElementPicker';

function runGuestPicker(): Promise<BrowserElementPick> {
  const key = '__grenBrowserElementPicker';
  const existing = (window as unknown as Record<string, { cancel?: () => void }>)[key];
  existing?.cancel?.();

  const truncate = (value: string, max: number) => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
  };

  const cssSelector = (node: Element) => {
    const tag = node.tagName.toLowerCase();
    if (node.id) return `${tag}#${CSS.escape(node.id)}`;
    const className = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean)[0] : '';
    return className ? `${tag}.${CSS.escape(className)}` : tag;
  };

  const boxShorthand = (style: CSSStyleDeclaration, kind: 'margin' | 'padding') => {
    const top = style.getPropertyValue(`${kind}-top`);
    const right = style.getPropertyValue(`${kind}-right`);
    const bottom = style.getPropertyValue(`${kind}-bottom`);
    const left = style.getPropertyValue(`${kind}-left`);
    if (top === right && right === bottom && bottom === left) return top;
    if (top === bottom && right === left) return `${top} ${right}`;
    if (right === left) return `${top} ${right} ${bottom}`;
    return `${top} ${right} ${bottom} ${left}`;
  };

  const toHex = (color: string) => {
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
    if (!match) return color;
    return `#${[match[1], match[2], match[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  };

  const implicitRole = (node: Element) => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'img') return 'img';
    if (tag === 'li') return 'listitem';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'input') {
      const type = (node.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return '';
  };

  const accessibleName = (node: Element) => {
    const labelled = node.getAttribute('aria-label')
      || node.getAttribute('alt')
      || node.getAttribute('title')
      || (node instanceof HTMLInputElement ? node.getAttribute('placeholder') : null);
    return truncate(labelled || '', 80);
  };

  const isFocusable = (node: Element) => {
    if (node.hasAttribute('disabled')) return false;
    const tab = node.getAttribute('tabindex');
    if (tab != null && Number(tab) >= 0) return true;
    const tag = node.tagName.toLowerCase();
    if (tag === 'a' && node.hasAttribute('href')) return true;
    if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
    return node instanceof HTMLElement && node.isContentEditable;
  };

  const collect = (node: Element) => {
    const style = window.getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return {
      tagName: node.tagName.toLowerCase(),
      selector: cssSelector(node),
      pageUrl: location.href,
      pageTitle: document.title,
      text: truncate(node.textContent ?? '', 4000),
      html: truncate(node.outerHTML ?? '', 6000),
      background: toHex(style.backgroundColor),
      color: toHex(style.color),
      font: `${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`,
      width: Math.round(box.width * 100) / 100,
      height: Math.round(box.height * 100) / 100,
      margin: boxShorthand(style, 'margin'),
      padding: boxShorthand(style, 'padding'),
      role: node.getAttribute('role') || implicitRole(node),
      accessibleName: accessibleName(node),
      keyboardFocusable: isFocusable(node),
    };
  };

  return new Promise((resolve) => {
    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';

    const highlight = document.createElement('div');
    highlight.setAttribute('data-gren-element-picker', 'highlight');
    highlight.style.cssText = [
      'position:fixed',
      'z-index:2147483646',
      'pointer-events:none',
      'border:2px solid #8ab4f8',
      'background:rgba(138,180,248,0.14)',
      'box-sizing:border-box',
    ].join(';');

    const tooltip = document.createElement('div');
    tooltip.setAttribute('data-gren-element-picker', 'tooltip');
    tooltip.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'pointer-events:none',
      'max-width:320px',
      'padding:8px 10px',
      'border-radius:6px',
      'background:#202124',
      'color:#e8eaed',
      'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
      'font:12px/1.45 ui-sans-serif,system-ui,sans-serif',
      'white-space:pre',
    ].join(';');

    document.documentElement.appendChild(highlight);
    document.documentElement.appendChild(tooltip);

    let settled = false;
    let pending: Element | null = null;
    const listeners: Array<[string, EventListener]> = [];

    const listen = (type: string, handler: EventListener) => {
      window.addEventListener(type, handler, true);
      listeners.push([type, handler]);
    };

    const finish = (result: BrowserElementPick) => {
      if (settled) return;
      settled = true;
      for (const [type, handler] of listeners) window.removeEventListener(type, handler, true);
      highlight.remove();
      tooltip.remove();
      document.documentElement.style.cursor = previousCursor;
      delete (window as unknown as Record<string, unknown>)[key];
      resolve(result);
    };

    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const targetFromPoint = (clientX: number, clientY: number) => {
      const node = document.elementFromPoint(clientX, clientY);
      if (!node || node === highlight || node === tooltip) return null;
      if (node instanceof Element && node.closest('[data-gren-element-picker]')) return null;
      return node;
    };

    const paintTooltip = (node: Element, box: DOMRect) => {
      const info = collect(node);
      tooltip.textContent = [
        `${info.selector}    ${info.width} × ${info.height}`,
        `Background  ${info.background}`,
        `Margin      ${info.margin}`,
        `Padding     ${info.padding}`,
        'ACCESSIBILITY',
        `Name        ${info.accessibleName}`,
        `Role        ${info.role}`,
        `Keyboard-focusable  ${info.keyboardFocusable ? 'yes' : 'no'}`,
      ].join('\n');
      const gap = 8;
      let top = box.bottom + gap;
      let left = box.left;
      const width = tooltip.offsetWidth;
      const height = tooltip.offsetHeight;
      if (top + height > window.innerHeight - gap) top = box.top - height - gap;
      if (left + width > window.innerWidth - gap) left = window.innerWidth - width - gap;
      if (left < gap) left = gap;
      if (top < gap) top = gap;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    const onMove = (event: Event) => {
      const pointer = event as MouseEvent;
      const node = targetFromPoint(pointer.clientX, pointer.clientY);
      if (!node) {
        tooltip.style.visibility = 'hidden';
        return;
      }
      const box = node.getBoundingClientRect();
      highlight.style.left = `${box.left}px`;
      highlight.style.top = `${box.top}px`;
      highlight.style.width = `${box.width}px`;
      highlight.style.height = `${box.height}px`;
      tooltip.style.visibility = 'visible';
      paintTooltip(node, box);
    };

    const onPointerDown = (event: Event) => {
      swallow(event);
      const pointer = event as MouseEvent;
      pending = targetFromPoint(pointer.clientX, pointer.clientY);
    };

    const onClick = (event: Event) => {
      swallow(event);
      const pointer = event as MouseEvent;
      const node = pending || targetFromPoint(pointer.clientX, pointer.clientY);
      pending = null;
      if (!node) {
        finish({ status: 'cancelled' });
        return;
      }
      finish({ status: 'selected', element: collect(node) });
    };

    const onKey = (event: Event) => {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key !== 'Escape') return;
      swallow(event);
      finish({ status: 'cancelled' });
    };

    (window as unknown as Record<string, { cancel: () => void }>)[key] = {
      cancel: () => finish({ status: 'cancelled' }),
    };
    listen('mousemove', onMove);
    listen('pointerdown', onPointerDown);
    listen('pointerup', swallow);
    listen('mousedown', swallow);
    listen('mouseup', swallow);
    listen('click', onClick);
    listen('auxclick', swallow);
    listen('dblclick', swallow);
    listen('submit', swallow);
    listen('keydown', onKey);
  });
}

export function buildBrowserElementPickerScript(): string {
  return `(${runGuestPicker.toString()})()`;
}

export function buildCancelBrowserElementPickerScript(): string {
  return `void (window.${PICKER_KEY} && window.${PICKER_KEY}.cancel && window.${PICKER_KEY}.cancel())`;
}

export function parseBrowserElementPick(value: unknown): BrowserElementPick | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as BrowserElementPick;
  if (result.status === 'cancelled') return result;
  if (result.status !== 'selected' || !result.element || typeof result.element !== 'object') return null;
  const element = result.element;
  if (typeof element.tagName !== 'string' || typeof element.selector !== 'string') return null;
  return result;
}

export function formatBrowserElementOffer(
  pick: Extract<BrowserElementPick, { status: 'selected' }>,
  origin: BrowserElementOrigin,
): BrowserElementOffer {
  const { element } = pick;
  const lines = [
    '浏览器元素',
    `标签页: ${origin.tabTitle}`,
    `标签页 id: ${origin.tabId}`,
    `页面: ${element.pageUrl}`,
    `页面标题: ${element.pageTitle || '(无标题)'}`,
    `选择器: ${element.selector}`,
    `标签: ${element.tagName}`,
    `尺寸: ${element.width} × ${element.height}`,
    `Background: ${element.background}`,
    `Margin: ${element.margin}`,
    `Padding: ${element.padding}`,
    `Role: ${element.role || '(无)'}`,
    `Name: ${element.accessibleName || '(无)'}`,
    `Keyboard-focusable: ${element.keyboardFocusable ? 'yes' : 'no'}`,
    `定位: tab=${origin.tabId} selector=${element.selector}`,
    `文本: ${element.text || '(无文本)'}`,
    'HTML:',
    element.html,
  ];
  return {
    title: element.selector,
    text: lines.join('\n'),
  };
}

type BrowserElementSink = (offer: BrowserElementOffer) => void;

let browserElementSink: BrowserElementSink | null = null;

export function bindBrowserElementChatSink(sink: BrowserElementSink | null): void {
  browserElementSink = sink;
}

export function offerBrowserElementToChat(offer: BrowserElementOffer): void {
  browserElementSink?.(offer);
}
