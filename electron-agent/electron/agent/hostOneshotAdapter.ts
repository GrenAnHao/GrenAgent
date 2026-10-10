import type { ThinkingLevel } from '@earendil-works/pi-ai';
import type { ModelRuntimeHost } from './modelRuntimeHost.js';

const THINKING_LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export async function runHostOneshot(
  host: Pick<ModelRuntimeHost, 'completeSimple' | 'streamSimple'>,
  request: Record<string, unknown>,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const provider = typeof request.provider === 'string' ? request.provider : '';
  const modelId = typeof request.modelId === 'string' ? request.modelId : '';
  const user = typeof request.user === 'string' ? request.user : '';
  const systemPrompt = typeof request.system === 'string' ? request.system : undefined;
  // 只有流式透传思考档：host.completeSimple 有意丢掉 reasoning（见 modelRuntimeHost.ts）。
  // 不传 = 关闭思考，和对话里 off 档的发法一致（pi-agent-core agent.js）。
  const reasoning = typeof request.reasoning === 'string' && THINKING_LEVELS.has(request.reasoning)
    ? request.reasoning as ThinkingLevel
    : undefined;
  const emit = (obj: unknown) => onLine?.(JSON.stringify(obj));
  const input = { user, systemPrompt, provider, modelId, signal };
  try {
    if (request.stream === true) {
      for await (const ev of host.streamSimple(reasoning ? { ...input, reasoning } : input)) {
        if (ev.type === 'delta') emit({ type: 'delta', text: ev.text });
        else if (ev.type === 'thinking') emit({ type: 'thinking', text: ev.text });
        else if (ev.type === 'done') emit({ type: 'done', usage: ev.usage ?? {} });
        else if (ev.type === 'error') emit({ type: 'error', error: ev.error, usage: ev.usage });
      }
      return;
    }
    const content = await host.completeSimple(input);
    emit({ ok: true, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === '模型不可用') emit({ ok: false, error: `model not found: ${provider}/${modelId}` });
    else emit({ ok: false, error: message });
  }
}
