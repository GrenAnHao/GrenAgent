import { useCallback, useEffect, useRef, useState } from 'react';
import { pathsEquivalent } from '../../lib/pathUtils';

const MAX_HISTORY = 50;

export interface FileHistory {
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
}

/**
 * 像浏览器一样在打开过的文件之间前进 / 后退。
 *
 * 历史不另起一套状态机：监听「当前打开的是哪个文件」，变了就记一条（点文件树、点 md 内链、外部请求都一样）。
 * 前进 / 后退走和点文件树同一条 `open`，所以未保存修改的询问、同文件不重载都沿用。
 *
 * 前进 / 后退引起的路径变化不能被当成「新打开」（否则前进栈被截掉），而渲染和 `open` 返回谁先谁后不确定，
 * 所以两边都认：effect 看到路径等于 pending 目标就落定指针；`open` 返回 true 时也落定一次（幂等）。
 * 返回 false（用户在询问里取消、或被别的 open 顶掉）指针不动。
 * 在中间位置打开了新文件，前进栈截掉，和浏览器一致。历史只放内存，随文件标签一起消失。
 */
export function useFileHistory(openPath: string | null, open: (path: string) => Promise<boolean>): FileHistory {
  const history = useRef<{ list: string[]; index: number }>({ list: [], index: -1 });
  const pending = useRef<{ path: string; index: number } | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!openPath) return;
    const h = history.current;
    const nav = pending.current;
    if (nav && pathsEquivalent(nav.path, openPath)) {
      h.index = nav.index;
      bump((n) => n + 1);
      return;
    }
    if (h.index >= 0 && pathsEquivalent(h.list[h.index], openPath)) return;
    const list = [...h.list.slice(0, h.index + 1), openPath].slice(-MAX_HISTORY);
    history.current = { list, index: list.length - 1 };
    bump((n) => n + 1);
  }, [openPath]);

  const go = useCallback(
    async (delta: -1 | 1) => {
      const index = history.current.index + delta;
      const path = history.current.list[index];
      if (path === undefined) return;
      const nav = { path, index };
      pending.current = nav;
      let opened = false;
      try {
        opened = await open(path);
      } finally {
        if (pending.current === nav) pending.current = null;
      }
      if (opened && history.current.list[index] === path && history.current.index !== index) {
        history.current.index = index;
        bump((n) => n + 1);
      }
    },
    [open],
  );

  const h = history.current;
  return {
    canBack: h.index > 0,
    canForward: h.index >= 0 && h.index < h.list.length - 1,
    back: useCallback(() => void go(-1), [go]),
    forward: useCallback(() => void go(1), [go]),
  };
}
