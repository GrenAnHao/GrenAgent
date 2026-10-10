import { memo, type CSSProperties, type ReactNode } from 'react';
import { cx } from 'antd-style';
import { chatStyles } from './chatStyles';

interface ChatItemShellProps {
  /** 'left' = 助手（全宽 ContentBlock 栈），'right' = 用户（右对齐气泡）。 */
  placement: 'left' | 'right';
  /** 用气泡包裹内容（用户消息）。助手消息不包气泡。 */
  bubble?: boolean;
  /** hover/focus 才浮现的操作栏（焦点气泡）。预留固定高度，避免显隐跳动。 */
  actions?: ReactNode;
  /** 用户消息占满会话列宽。任务提示词限高时用，避免气泡缩成内容宽度。 */
  fullWidth?: boolean;
  /** 按行虚拟化时仅整轮首尾保留消息留白，内部行距由列表负责。 */
  paddingBlock?: CSSProperties['paddingBlock'];
  children: ReactNode;
}

/** 自研无头像消息外壳：对齐 lobehub 间距（gap 8 / paddingBlock 8 / 用户 paddingInlineStart 36）。 */
function ChatItemShellInner({ placement, bubble, actions, children, fullWidth, paddingBlock }: ChatItemShellProps) {
  const isUser = placement === 'right';
  return (
    <div className={cx(chatStyles.item, isUser && chatStyles.itemUser)} style={paddingBlock === undefined ? undefined : { paddingBlock }}>
      <div className={cx(chatStyles.body, (!isUser || fullWidth) && chatStyles.bodyAssistant)}>
        {bubble ? <div className={chatStyles.bubble}>{children}</div> : children}
        {actions ? (
          <div
            className={cx(
              'chat-actions',
              chatStyles.actions,
              isUser ? chatStyles.actionsRight : chatStyles.actionsLeft,
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const ChatItemShell = memo(ChatItemShellInner);
