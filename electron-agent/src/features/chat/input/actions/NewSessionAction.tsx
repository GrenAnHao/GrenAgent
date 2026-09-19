import { ActionIcon } from '@lobehub/ui';
import { SquarePen } from 'lucide-react';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useChatInput } from '../ChatInputContext';
import { enterPendingNewSession } from '../../../../lib/pendingSession';

export default function NewSessionAction() {
  const { workspace, store } = useAgentStoreContext();
  const { setValue } = useChatInput();
  return (
    <ActionIcon
      icon={SquarePen}
      size="small"
      title="新会话"
      onClick={() => {
        enterPendingNewSession(workspace, () => store.reset());
        setValue('');
      }}
    />
  );
}
