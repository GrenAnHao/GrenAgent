import { ActionIcon } from '@lobehub/ui';
import { Search } from 'lucide-react';
import { useChatInput } from '../ChatInputContext';

export default function WebSearchAction() {
  const { setValue } = useChatInput();
  return (
    <ActionIcon
      icon={Search}
      size="small"
      title="联网搜索"
      onClick={() => setValue('联网搜索：')}
    />
  );
}
