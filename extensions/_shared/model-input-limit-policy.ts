import type { ProviderModelOptions } from './provider-model-options.js';

/** These payload shapes are exercised at the public serializer boundary. */
export const HTTP_INPUT_LIMIT_APIS = new Set(['openai-completions', 'openai-responses', 'azure-openai-responses', 'anthropic-messages']);
export const GOOGLE_INPUT_LIMIT_APIS = new Set(['google-generative-ai', 'google-vertex']);
export function inputLimitSupport(api: string | undefined): { counts: boolean; bytes: boolean; explanation?: string } {
  if (HTTP_INPUT_LIMIT_APIS.has(api ?? '')) return { counts: true, bytes: true };
  if (GOOGLE_INPUT_LIMIT_APIS.has(api ?? '')) return { counts: true, bytes: false, explanation: 'Google SDK 不提供最终 HTTP JSON 边界，暂不支持请求字节限制；如有显式字节覆盖，请清除，否则会拒绝请求。' };
  return { counts: false, bytes: false, explanation: api === 'openai-codex-responses' ? 'Codex 自动 / WebSocket 续传暂不支持此预检；携带显式数量 / 字节覆盖会拒绝请求。调用方显式 SSE 可使用预检。' : '此协议暂不支持数量 / 字节预检；携带显式数量 / 字节覆盖会拒绝请求，请清除覆盖或选择受支持协议。' };
}
type JsonObject = Record<string, unknown>;
const record = (value: unknown): JsonObject | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;

function imageCount(value: unknown, api: string): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + imageCount(item, api), 0);
  const node = record(value);
  if (!node) return 0;
  if (api === 'anthropic-messages' && node.type === 'image') return 1;
  if (api === 'openai-completions' && node.type === 'image_url') return 1;
  if (api.includes('responses') && node.type === 'input_image') return 1;
  if (api.startsWith('google-')) {
    const data = record(node.inlineData ?? node.inline_data ?? node.fileData ?? node.file_data);
    if (data && typeof (data.mimeType ?? data.mime_type) === 'string' && String(data.mimeType ?? data.mime_type).startsWith('image/')) return 1;
  }
  return Object.values(node).reduce<number>((sum, child) => sum + imageCount(child, api), 0);
}

/** Only the final provider payload counts; server-side continuation history is deliberately absent. */
export function assertModelInputLimits(payload: unknown, model: { api: string; inputLimits?: ProviderModelOptions['inputLimits'] }, serializedBytes?: number): void {
  if (!model.inputLimits) return;
  const limits = model.inputLimits;
  const body = record(payload);
  const messages = model.api.startsWith('google-') ? body?.contents : model.api.includes('responses') ? body?.input : body?.messages;
  const counts = Array.isArray(messages) ? messages.map((message) => imageCount(message, model.api)) : [];
  if (limits.images?.maxPerMessage !== undefined && counts.some((count) => count > limits.images!.maxPerMessage!)) throw new Error(`图片输入限制：单条消息图片数超过 ${limits.images.maxPerMessage} 张，未发送请求；附件保持不变。`);
  if (limits.images?.maxPerRequest !== undefined && counts.reduce((sum, count) => sum + count, 0) > limits.images.maxPerRequest) throw new Error(`图片输入限制：本次请求图片数超过 ${limits.images.maxPerRequest} 张，未发送请求；附件保持不变。`);
  if (limits.maxRequestBytes !== undefined) {
    const json = JSON.stringify(payload);
    if (json === undefined) throw new Error('请求输入限制：最终 payload 不能序列化为 JSON。');
    const bytes = serializedBytes ?? new TextEncoder().encode(json).byteLength;
    if (bytes > limits.maxRequestBytes) throw new Error(`请求输入限制：UTF-8 未压缩 JSON 为 ${bytes} bytes，超过 ${limits.maxRequestBytes} bytes（不含 HTTP 头），未发送请求。`);
  }
}
