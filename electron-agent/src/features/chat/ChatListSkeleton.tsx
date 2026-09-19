import { Flexbox, Skeleton } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { CHAT_CONTENT_WIDTH } from './chatStyles';

const styles = createStaticStyles(({ css }) => ({
  scroll: css`
    position: absolute;
    inset: 0;
    overflow-y: auto;
  `,
  // 与 VirtualizedMessageList 的 itemStyle 同宽同边距：骨架切到真实消息时列宽不跳。
  list: css`
    display: flex;
    flex-direction: column;
    gap: 24px;

    width: ${CHAT_CONTENT_WIDTH};
    margin-inline: auto;
    padding: 16px 24px;
  `,
}));

function AssistantBubble() {
  return (
    <Flexbox gap={8} style={{ maxWidth: '82%' }}>
      <Skeleton.Block active style={{ height: 12, width: 96 }} />
      <Skeleton.Block active style={{ height: 12, width: '94%' }} />
      <Skeleton.Block active style={{ height: 12, width: '72%' }} />
    </Flexbox>
  );
}

function UserBubble() {
  return (
    <Flexbox style={{ alignSelf: 'flex-end', width: '46%' }}>
      <Skeleton.Block active style={{ borderRadius: 12, height: 32, width: '100%' }} />
    </Flexbox>
  );
}

/**
 * 切换 / 新建对话时的内容区占位骨架（替代全屏 loading）。
 * 仅做视觉占位，对齐 ChatListView 的滚动容器、内容列宽与内边距。
 */
export function ChatListSkeleton() {
  return (
    <div aria-hidden className={styles.scroll} data-testid="chat-skeleton">
      <div className={styles.list}>
        <UserBubble />
        <AssistantBubble />
        <UserBubble />
        <AssistantBubble />
      </div>
    </div>
  );
}
