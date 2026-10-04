// 与 Pi 内置摘要同一种序列化：先 convertToLlm，再 serializeConversation（工具结果每条截到 2000 字符）。
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

export function serializeForSummary(messages: readonly unknown[]): string {
  return serializeConversation(convertToLlm(messages as Parameters<typeof convertToLlm>[0]));
}
