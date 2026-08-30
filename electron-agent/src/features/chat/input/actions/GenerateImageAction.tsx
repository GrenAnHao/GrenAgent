import { ActionIcon } from '@lobehub/ui';
import { Image } from 'lucide-react';
import { useChatInput } from '../ChatInputContext';

export default function GenerateImageAction() {
  const { setValue } = useChatInput();
  return (
    <ActionIcon
      icon={Image}
      size="small"
      title="生成图片"
      onClick={() => setValue('请生成一张图片：')}
    />
  );
}
