import { coerceTodoStatus, normalizeTodos, type Todo } from '@extensions/_shared/todo-model';
import type { ChatMessage } from '../../../stores/agentReducer';
import { getDetails } from '../../tools/toolUtils';

function todosFromPayload(value: unknown): Todo[] | null {
  const details = getDetails(value);
  if (details?.error != null) return null;
  const normalized = normalizeTodos(details ?? value);
  return normalized ? normalized.todos : null;
}

/**
 * 还在执行的调用：中间结果优先；否则等参数里每一行都有 status 再顶上。
 * 参数还没写完就跳过，清单继续停在上一次成功的结果。
 * 只用于参数已经完整的调用；流式半截参数由 todosFromTool 挡在外面。
 */
function todosFromArgs(value: unknown): Todo[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const rows = (value as { todos?: unknown }).todos;
  if (!Array.isArray(rows)) return null;
  const complete = rows.every((row) => {
    if (typeof row !== 'object' || row === null) return false;
    return coerceTodoStatus((row as { status?: unknown }).status) != null;
  });
  if (!complete) return null;
  return normalizeTodos(value)?.todos ?? null;
}

function todosFromTool(message: Extract<ChatMessage, { kind: 'tool' }>): Todo[] | null {
  if (message.status === 'error') return null;
  if (message.status === 'done') return todosFromPayload(message.result);
  if (getDetails(message.result)?.error != null) return null;
  const partial = todosFromPayload(message.result);
  if (partial) return partial;
  // 参数还在生成时，前缀常常「每行都有 status」，下一个字又不满足：
  // 任务条会在旧清单、空清单和半截新清单之间来回切，文案也逐字长。等 toolcall_end 再用。
  if (message.argsComplete === false) return null;
  return todosFromArgs(message.args);
}

function latestTodoSnapshot(messages: readonly ChatMessage[]): { index: number; todos: Todo[] } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind !== 'tool' || message.toolName.toLowerCase() !== 'todo') continue;
    const todos = todosFromTool(message);
    if (todos == null) continue;
    return { index: i, todos };
  }
  return null;
}

export function latestTodosFromMessages(messages: readonly ChatMessage[]): Todo[] | null {
  return latestTodoSnapshot(messages)?.todos ?? null;
}

/** 清单已经做完，且后面有新的用户消息时，任务条不再显示。 */
export function dockTodos(messages: readonly ChatMessage[], listFinished: boolean): Todo[] | null {
  const snapshot = latestTodoSnapshot(messages);
  if (!snapshot || snapshot.todos.length === 0) return null;
  const nextRound = messages.slice(snapshot.index + 1).some((message) => message.kind === 'user' && !message.steering);
  const noPending = snapshot.todos.every((todo) => todo.status !== 'pending');
  const finished = noPending && (listFinished || snapshot.todos.every((todo) => todo.status === 'completed'));
  if (nextRound && finished) return null;
  return snapshot.todos;
}
