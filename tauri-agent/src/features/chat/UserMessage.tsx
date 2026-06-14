import { memo } from 'react';
import { ChatItemShell } from './ChatItemShell';

interface UserMessageProps {
  text: string;
}

function UserMessageInner({ text }: UserMessageProps) {
  return (
    <ChatItemShell placement="right" bubble>
      {text}
    </ChatItemShell>
  );
}

export const UserMessage = memo(UserMessageInner);
