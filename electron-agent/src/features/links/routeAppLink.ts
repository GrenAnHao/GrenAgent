import { classifyHref } from '../../lib/hrefKinds';
import { openUrl } from '../../platform/runtime';
import { resolveSessionFile } from '../chat/sessionCwd';
import { openInAppBrowser } from '../dock/browser/openInAppBrowser';
import { openWorkspaceFile } from '../dock/openWorkspaceFile';

export interface RouteLinkOptions {
  /** Ctrl / ⌘ 点击：交给系统默认浏览器。 */
  system: boolean;
  /** 当前会话的工作目录，本地路径链接按它解析；没有就无法打开本地文件。 */
  workspace: string | null;
  notify: (text: string) => void;
}

/**
 * 对话正文（以及其它没有自己处理的 `<a>`）里的链接去哪儿：
 * 网页 → 右侧栏内置浏览器（Ctrl / ⌘ 点击改用系统浏览器）；项目里的文件路径 → 右侧栏「文件」标签；
 * `#锚点` → 对话里没有可跳的目标，静默吞掉；其余（mailto、javascript、file: …）→ 提示不支持。
 * 无论走哪条，调用方都已经 preventDefault，应用窗口不会被导航走。
 */
export async function routeAppLink(href: string, options: RouteLinkOptions): Promise<void> {
  const kind = classifyHref(href);
  switch (kind.kind) {
    case 'anchor':
      return;
    case 'unsupported':
      options.notify(kind.reason);
      return;
    case 'external': {
      if (options.system) {
        await openUrl(kind.url).catch((error: unknown) => {
          options.notify(`无法用系统浏览器打开：${error instanceof Error ? error.message : String(error)}`);
        });
        return;
      }
      if (!openInAppBrowser(kind.url)) options.notify('无法打开这个链接');
      return;
    }
    case 'path': {
      const target = options.workspace ? resolveSessionFile(options.workspace, undefined, kind.path) : null;
      if (!target) {
        options.notify('无法解析这个本地链接');
        return;
      }
      await openWorkspaceFile(target.absolute, target.root).catch((error: unknown) => {
        options.notify(`无法打开文件：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}

/** 点击事件里取出被点的 `<a href>`；下载链接、没有 href 的不管。 */
export function anchorHrefOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target : null;
  const anchor = element?.closest('a[href]');
  if (!anchor || anchor.hasAttribute('download')) return null;
  return anchor.getAttribute('href');
}
