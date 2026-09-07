import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
export { parseJsonLoose, resolveModel, type AskFn } from '../_shared/llm.js';

/** Use the active registry so provider credentials, headers and request transforms are preserved. */
export async function askLlm(
  ctx: Pick<ExtensionContext, 'model' | 'modelRegistry' | 'signal'>,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  if (!ctx.model) throw new Error('Wiki generation requires a model');
  const message = await ctx.modelRegistry.complete(ctx.model, {
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
  }, { signal: ctx.signal });
  if (message.stopReason !== 'stop' || ctx.signal?.aborted) {
    throw new Error(`Wiki generation did not complete: ${message.stopReason}`);
  }
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
