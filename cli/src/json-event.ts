import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * 与 @earendil-works/pi-coding-agent 的 dist/modes/json-event.js 等价的降级实现。
 *
 * 上游未从包根导出 toJsonEvent（深路径 import 触发 ERR_PACKAGE_PATH_NOT_EXPORTED），
 * 故自持一份。作用：剥掉流式事件里的累积快照——否则 message_update 每 token 带一份完整
 * AgentMessage，单条消息 O(n^2) IPC 克隆；且渲染层 agentReducer 的「快照优先、delta 兜底」
 * 分支会翻到从未被真实数据验证过的那条路。
 *
 * 对应上游版本：pi-coding-agent@0.87.0。升级 pi-coding-agent 必查 dist/modes/json-event.js。
 */
type UnknownRecord = Record<string, unknown>;

function toJsonAssistantMessageEvent(event: UnknownRecord): UnknownRecord {
  if (event.type === "toolcall_start") {
    const partial = event.partial as UnknownRecord | undefined;
    const content = partial?.content as UnknownRecord[] | undefined;
    const toolCall = content?.[event.contentIndex as number];
    if (toolCall?.type !== "toolCall") {
      throw new Error(`toolcall_start content at index ${String(event.contentIndex)} is not a tool call`);
    }
    const { partial: _partial, ...deltaEvent } = event;
    return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
  }
  if (!("partial" in event)) return event;
  const { partial: _partial, ...deltaEvent } = event;
  return deltaEvent;
}

export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
  const raw = event as unknown as UnknownRecord;
  if (raw.type !== "message_update") return event as unknown as JsonAgentSessionEvent;
  const message = raw.message as UnknownRecord | undefined;
  if (message?.role !== "assistant") {
    throw new Error("message_update message is not an assistant message");
  }
  return {
    type: "message_update",
    usage: message.usage,
    assistantMessageEvent: toJsonAssistantMessageEvent(raw.assistantMessageEvent as UnknownRecord),
  } as unknown as JsonAgentSessionEvent;
}
