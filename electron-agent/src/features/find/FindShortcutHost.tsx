import { useEffect } from 'react';
import { canFindIn, openFind } from './findActions';

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

/** 查找范围根元素：会话 / 文件标签的根上带 `data-find-scope="<范围 id>"`。 */
export function scopeRootOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[data-find-scope]') : null;
}

const isShown = (el: Element) => el.isConnected && el.getClientRects().length > 0;

/**
 * Ctrl+F（macOS ⌘+F）的唯一入口，整个应用挂一份。
 *
 * 归属：键盘焦点在哪个查找范围里就归哪个——含对话底部的输入框和编辑器（它们没有自己的查找，所以照样拦截）。
 * 焦点落在 body 上（刚点了消息文字、没有可聚焦的东西）时，按「最后一次点击落在哪个范围」认领。
 * 焦点在侧栏、设置、弹窗、终端等范围之外：不拦，侧栏搜索框原有的 Ctrl+F 照旧。
 *
 * 优先级：在 window 的捕获阶段处理并 stopImmediatePropagation，先于侧栏搜索框（react-hotkeys 挂在 document 上）和编辑器自己的
 * Mod-f 绑定，也先于任何默认行为——应用没有浏览器自带的页内查找（无菜单栏、没有 findInPage），所以不存在要让路的宿主查找。
 */
export function FindShortcutHost(): null {
  useEffect(() => {
    let lastPointerScope: HTMLElement | null = null;
    const onPointerDown = (event: PointerEvent) => {
      lastPointerScope = scopeRootOf(event.target);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'f' || event.altKey || event.shiftKey || event.isComposing) return;
      const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod) return;
      const target = event.target;
      // 弹窗里（确认框、设置抽屉）不拦。
      if (target instanceof Element && target.closest('.ant-modal, .ant-drawer, [role="dialog"]')) return;
      let root = scopeRootOf(target);
      const bare = !(target instanceof Element) || target === document.body || target === document.documentElement;
      if (!root && bare && lastPointerScope && isShown(lastPointerScope)) root = lastPointerScope;
      const scope = root?.dataset.findScope;
      if (!root || !scope || !canFindIn(scope)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openFind(scope, root);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  return null;
}
