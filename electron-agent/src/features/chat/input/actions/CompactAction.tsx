import { ActionIcon } from '@lobehub/ui';
import { FoldVertical } from 'lucide-react';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { pi } from '../../../../lib/pi';

export default function CompactAction() {
  const { workspace } = useAgentStoreContext();
  return (
    <ActionIcon
      icon={FoldVertical}
      size="small"
      title="压缩上下文"
      onClick={() => void pi.compact(workspace)}
    />
  );
}
