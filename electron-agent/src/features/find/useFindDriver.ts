import { useEffect, useRef } from 'react';
import type { FindDriver } from './domFinder';
import { useFindScope } from './findStore';

/**
 * 把一个范围的查找状态（findStore）接到它的驱动上：
 * 打开 / 改查询 → setQuery（回到第一个命中）；上 / 下一个请求 → next / prev；关闭 → clear。
 * driver 换了（比如换了会话）旧的先 dispose，清掉它留在页面上的高亮。
 * resetKey 变了（文件标签里换了一个文件）用同一个查询重新查一遍，回到新文件的第一个命中。
 */
export function useFindDriver(scope: string, driver: FindDriver | null, resetKey?: string | number | null): void {
  const { open, query, nav } = useFindScope(scope);

  useEffect(() => {
    if (!driver) return;
    if (open) driver.setQuery(query);
    else driver.clear();
  }, [driver, open, query, resetKey]);

  // 范围换了（文件管理器里切到另一个文件标签，它从没有范围变成有）：新范围里已有的 nonce 是以前的跳转，不是新请求。
  const handled = useRef({ scope, nonce: nav.nonce });
  useEffect(() => {
    if (handled.current.scope !== scope) {
      handled.current = { scope, nonce: nav.nonce };
      return;
    }
    if (nav.nonce === handled.current.nonce) return;
    handled.current.nonce = nav.nonce;
    if (!driver || !open) return;
    if (nav.dir === 'next') driver.next();
    else driver.prev();
  }, [driver, open, nav, scope]);

  useEffect(() => () => driver?.dispose(), [driver]);
}
