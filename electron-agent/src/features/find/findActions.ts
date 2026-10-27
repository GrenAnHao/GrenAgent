import { useFindStore } from './findStore';

/** 查找栏占的高度（px）。会话里列表顶边按它下移，保证不压消息。 */
export const FIND_BAR_HEIGHT = 40;

const openers = new Map<string, Element | null>();
const support = new Map<string, () => boolean>();

/** 某个查找范围现在能不能查（文件标签里没有打开文本文件时不能）。 */
export function registerFindScope(scope: string, canFind: () => boolean): () => void {
  support.set(scope, canFind);
  return () => {
    if (support.get(scope) === canFind) support.delete(scope);
  };
}

export function canFindIn(scope: string): boolean {
  return support.get(scope)?.() ?? false;
}

function selectedTextWithin(root: Element | null): string {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  const text = selection.toString().trim();
  if (!text || text.includes('\n') || text.length > 120) return '';
  const anchor = selection.anchorNode;
  return anchor && root.contains(anchor) ? text : '';
}

/** 打开（或重新聚焦）查找栏。打开前焦点在哪儿记下来，关闭时还回去。 */
export function openFind(scope: string, root: Element | null): void {
  const state = useFindStore.getState().scopes[scope];
  if (!state?.open) openers.set(scope, document.activeElement);
  useFindStore.getState().open(scope, selectedTextWithin(root) || undefined);
}

/** 关闭查找栏并把焦点还给打开前的元素；它已经不在了就落到这个范围的输入位置，再不行就落到范围根上。 */
export function closeFind(scope: string, root?: Element | null): void {
  useFindStore.getState().close(scope);
  const opener = openers.get(scope);
  openers.delete(scope);
  const scopeRoot = root ?? document.querySelector(`[data-find-scope="${CSS.escape(scope)}"]`);
  requestAnimationFrame(() => {
    if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) {
      opener.focus({ preventScroll: true });
      return;
    }
    const fallback =
      scopeRoot?.querySelector<HTMLElement>('[contenteditable="true"], [data-find-fallback]') ??
      (scopeRoot instanceof HTMLElement ? scopeRoot : null);
    fallback?.focus({ preventScroll: true });
  });
}
