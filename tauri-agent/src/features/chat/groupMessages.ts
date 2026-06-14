import type { ChatMessage } from '../../stores/agentReducer';

interface ToolDisplay {
  id: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

export type DisplayMessage =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistantGroup';
      id: string;
      text: string;
      thinking: string;
      streaming: boolean;
      thinkingDuration?: number;
      tools: ToolDisplay[];
    }
  | { kind: 'tool'; id: string; toolCallId: string; toolName: string; args: unknown; result: unknown; status: 'running' | 'done' | 'error' }
  | { kind: 'notice'; id: string; customType: string; content: string };

/**
 * Flatten ChatMessage[] → DisplayMessage[].
 * Consecutive assistant + tool runs are merged into a single assistantGroup
 * so the UI can render tools inline beneath the assistant bubble.
 */
export function groupMessages(messages: ChatMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  let pending: (DisplayMessage & { kind: 'assistantGroup' }) | null = null;

  const flush = () => {
    if (pending) {
      out.push(pending);
      pending = null;
    }
  };

  for (const msg of messages) {
    switch (msg.kind) {
      case 'assistant':
        flush();
        pending = {
          kind: 'assistantGroup',
          id: msg.id,
          text: msg.text,
          thinking: msg.thinking,
          streaming: msg.streaming,
          thinkingDuration: msg.thinkingDuration,
          tools: [],
        };
        break;
      case 'tool':
        // 子代理（spawn_agent）作为流内一等公民单独成项（前面的助手叙述照常成组），
        // 由 ChatMessageItems 渲染为可折叠的 SubAgentInline，而非埋进工具列表。
        if (msg.toolName === 'spawn_agent') {
          flush();
          out.push(msg);
        } else if (pending) {
          pending.tools.push({
            id: msg.id,
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            args: msg.args,
            result: msg.result,
            status: msg.status,
          });
        } else {
          out.push(msg);
        }
        break;
      default:
        flush();
        out.push(msg);
    }
  }
  flush();
  return out;
}
