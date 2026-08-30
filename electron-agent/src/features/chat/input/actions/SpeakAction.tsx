import { ActionIcon } from '@lobehub/ui';
import { Volume2 } from 'lucide-react';
import { useChatInput } from '../ChatInputContext';

export default function SpeakAction() {
  const { setValue } = useChatInput();
  return (
    <ActionIcon
      icon={Volume2}
      size="small"
      title="朗读文本"
      onClick={() => setValue('请朗读以下文本（使用 speak 工具）：\n')}
    />
  );
}
