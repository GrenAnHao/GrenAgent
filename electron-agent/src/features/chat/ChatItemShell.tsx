import { memo, type ReactNode } from 'react';
import { cx } from 'antd-style';
import { chatStyles } from './chatStyles';

interface ChatItemShellProps {
  /** 'left' = 助手（全宽 ContentBlock 栈），'right' = 用户（右对齐气泡）。 */
  placement: 'left' | 'right';
  /** 用气泡包裹内容（用户消息）。助手消息不包气泡。 */
  bubble?: boolean;
  /** hover/focus 才浮现的操作栏（焦点气泡）。预留固定高度，避免显隐跳动。 */
  actions?: ReactNode;
  children: ReactNode;
}

/** 自研无头像消息外壳：对齐 lobehub 间距（gap 8 / paddingBlock 8 / 用户 paddingInlineStart 36）。 */
function ChatItemShellInner({ placement, bubble, actions, children }: ChatItemShellProps) {
  const isUser = placement === 'right';
  return (
    <div className={cx(chatStyles.item, isUser && chatStyles.itemUser)}>
      <div className={cx(chatStyles.body, !isUser && chatStyles.bodyAssistant)}>
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
