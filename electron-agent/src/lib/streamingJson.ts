import { parseStreamingJson } from '@earendil-works/pi-ai/utils/json-parse';

/** 解析流式中的半截参数 JSON；任何异常都返回 {}，不抛。与 Pi/TUI 使用同一解析器。 */
export function parsePartialArgs(json: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const value = parseStreamingJson<Record<string, unknown>>(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
