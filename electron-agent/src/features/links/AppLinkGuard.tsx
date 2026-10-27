import { App } from 'antd';
import { useEffect } from 'react';
import { useSessionStore } from '../../store/session';
import { anchorHrefOf, routeAppLink } from './routeAppLink';

/**
 * 全应用的链接兜底：渲染进程里任何 `<a href>` 被点，默认行为是把整个应用窗口导航走（或弹出新的 Electron 窗口）。
 * 这里在 document 冒泡阶段接手：别的组件已经 preventDefault 的（文件预览自己处理的内链、自带 onClick 的链接）不碰，
 * 其余一律 preventDefault 再按 routeAppLink 分流。冒泡阶段而不是捕获阶段，正是为了让「谁先处理谁说了算」。
 * 主进程还有 will-navigate / setWindowOpenHandler 兜底，见 electron/mainWindowNavigation.ts。
 */
export function AppLinkGuard(): null {
  const { message } = App.useApp();

  useEffect(() => {
    const handle = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      // click 是左键；auxclick 只接中键（等同新标签打开），右键留给系统菜单。
      if (event.type === 'auxclick' && event.button !== 1) return;
      const href = anchorHrefOf(event.target);
      if (href === null) return;
      event.preventDefault();
      void routeAppLink(href, {
        system: event.ctrlKey || event.metaKey,
        workspace: useSessionStore.getState().activeWorkspace ?? null,
        notify: (text) => void message.warning(text),
      });
    };
    document.addEventListener('click', handle);
    document.addEventListener('auxclick', handle);
    return () => {
      document.removeEventListener('click', handle);
      document.removeEventListener('auxclick', handle);
    };
  }, [message]);

  return null;
}
