import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { DisplayMessage } from '../chat/groupMessages';
import type { MessageListViewport } from '../chat/VirtualizedMessageList';
import type { MinimapIndicator } from './types';
import { findIndicatorPosition, getReplyText, getTitleText } from './utils';

/**
 * 地图数据源：只为用户消息生成刻度（它们是对话的分节点，助手回复挂在其后），
 * 顺带把每一轮的问答摘要备好给悬停气泡，并把视口位置换算成当前该高亮哪条刻度。
 */
export function useMinimapData(messages: DisplayMessage[], viewport: MessageListViewport) {
  // 每个滚动帧都会收到通知，但快照是顶部条目下标：同一条目内滚动时值不变，不触发重渲染。
  const activeIndex = useSyncExternalStore(viewport.subscribe, viewport.getTopIndex);

  const indicators = useMemo<MinimapIndicator[]>(
    () =>
      messages.reduce<MinimapIndicator[]>((acc, message, listIndex) => {
        if (message.kind !== 'user') return acc;

        acc.push({
          id: message.id,
          listIndex,
          title: getTitleText(message.text),
          reply: getReplyText(messages, listIndex),
        });

        return acc;
      }, []),
    [messages],
  );

  const activePosition = useMemo(() => {
    const position = findIndicatorPosition(indicators, activeIndex);
    return position < 0 ? null : position;
  }, [activeIndex, indicators]);

  const handleJump = useCallback(
    (listIndex: number) => {
      viewport.scrollToIndex(listIndex);
    },
    [viewport],
  );

  return { activePosition, handleJump, indicators };
}
