import { ChatInputArea } from '@lobehub/ui/chat';
import { useMessageStore } from '../../store';

interface ChatInputProps {
  onSend: (message: string) => Promise<void>;
  onAbort: () => Promise<void>;
}

export function ChatInput({ onSend, onAbort }: ChatInputProps) {
  const isStreaming = useMessageStore((state) => state.isStreaming);

  return (
    <ChatInputArea
      onSend={onSend}
      onStop={onAbort}
      loading={isStreaming}
      placeholder="Type a message..."
    />
  );
}
