import { useCallback, useRef } from 'react';
import { ActionIcon, Flexbox, Popover } from '@lobehub/ui';
import { MoreHorizontal } from 'lucide-react';
import { useElementMeasure } from '../../../hooks/useElementMeasure';
import {
  actionMap,
  ACTION_LABELS,
  ACTION_WIDTH,
  COLLAPSE_PRIORITY,
  MORE_BUTTON_WIDTH,
  type ActionKey,
} from './config';
import { ContextUsageTag } from './ContextUsageTag';
import { resolveToolbarOverflow } from './toolbarOverflow';

interface ActionBarProps {
  actions: ActionKey[];
}

export function ActionBar({ actions }: ActionBarProps) {
  const ref = useRef<HTMLDivElement>(null);

  // 量自身可用宽度（作为 flex:1 占满左侧剩余空间），在首帧前量好，避免折叠态闪烁。
  // 只记折进「更多」的是哪几个：拖分隔条时宽度每帧都变，折叠结果不变就不重渲。
  const collapsedKey = useElementMeasure(
    ref,
    useCallback(
      (width: number) =>
        resolveToolbarOverflow(width, actions, COLLAPSE_PRIORITY, ACTION_WIDTH, MORE_BUTTON_WIDTH).collapsed.join(','),
      [actions],
    ),
  );
  const collapsedSet = new Set(collapsedKey.split(','));
  const visible = actions.filter((key) => !collapsedSet.has(key));
  const collapsed = actions.filter((key) => collapsedSet.has(key));

  return (
    <Flexbox horizontal align="center" gap={10} flex={1} ref={ref} style={{ minWidth: 0, overflow: 'hidden' }}>
      {visible.map((key) => {
        const Render = actionMap[key];
        return <Render key={key} />;
      })}
      <ContextUsageTag />
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
