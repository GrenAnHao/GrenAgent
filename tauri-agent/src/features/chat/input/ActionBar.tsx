import { useLayoutEffect, useRef, useState } from 'react';
import { ActionIcon, Flexbox, Popover } from '@lobehub/ui';
import { MoreHorizontal } from 'lucide-react';
import {
  actionMap,
  ACTION_LABELS,
  ACTION_WIDTH,
  COLLAPSE_PRIORITY,
  MORE_BUTTON_WIDTH,
  type ActionKey,
} from './config';
import { resolveToolbarOverflow } from './toolbarOverflow';

interface ActionBarProps {
  actions: ActionKey[];
}

export function ActionBar({ actions }: ActionBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // 量自身可用宽度（作为 flex:1 占满左侧剩余空间），ResizeObserver 实时跟随窗口/面板变化。
  // 参考 App.tsx 的面板宽度测量：用 useLayoutEffect 在首帧前量好，避免折叠态闪烁。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { visible, collapsed } = resolveToolbarOverflow(
    width,
    actions,
    COLLAPSE_PRIORITY,
    ACTION_WIDTH,
    MORE_BUTTON_WIDTH,
  );

  return (
    <Flexbox horizontal align="center" gap={2} flex={1} ref={ref} style={{ minWidth: 0, overflow: 'hidden' }}>
      {visible.map((key) => {
        const Render = actionMap[key];
        return <Render key={key} />;
      })}
      {collapsed.length > 0 && (
        <Popover
          arrow={false}
          placement="topLeft"
          trigger="click"
          content={
            <Flexbox gap={2} style={{ minWidth: 128, padding: 2 }}>
              {collapsed.map((key) => {
                const Render = actionMap[key];
                // 图标 + 文字：折进菜单后竖排图标不易辨认，旁边补一行说明。
                return (
                  <Flexbox horizontal align="center" gap={6} key={key} style={{ paddingInlineEnd: 6 }}>
                    <Render />
                    <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{ACTION_LABELS[key]}</span>
                  </Flexbox>
                );
              })}
            </Flexbox>
          }
        >
          <ActionIcon icon={MoreHorizontal} size="small" title="更多" />
        </Popover>
      )}
    </Flexbox>
  );
}
