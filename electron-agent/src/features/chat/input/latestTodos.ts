import { normalizeTodos, type Todo } from '@extensions/_shared/todo-model';
import type { ChatMessage } from '../../../stores/agentReducer';
import { getDetails } from '../../tools/toolUtils';

export function latestTodosFromMessages(messages: readonly ChatMessage[]): Todo[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind !== 'tool' || message.toolName.toLowerCase() !== 'todo') continue;
    if (message.status !== 'done') continue;
    const details = getDetails(message.result);
    if (details?.error != null) continue;
    const normalized = normalizeTodos(details);
    if (!normalized) continue;
    return normalized.todos;
  }
  return null;
}
