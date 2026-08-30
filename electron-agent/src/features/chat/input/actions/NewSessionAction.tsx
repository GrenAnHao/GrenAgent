import { ActionIcon } from '@lobehub/ui';
import { SquarePen } from 'lucide-react';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useChatInput } from '../ChatInputContext';
import { pi } from '../../../../lib/pi';

export default function NewSessionAction() {
  const { workspace, store } = useAgentStoreContext();
  const { setValue } = useChatInput();
  return (
    <ActionIcon
      icon={SquarePen}
      size="small"
      title="新会话"
      onClick={async () => {
        await pi.newSession(workspace);
        store.reset();
        setValue('');
      }}
    />
  );
}
