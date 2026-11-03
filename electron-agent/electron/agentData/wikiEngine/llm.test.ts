import { expect, it } from 'vitest';
import { createLlmClient } from './llm';

it('forwards ingest cancellation and max tokens while preserving the existing label argument', async () => {
  const controller = new AbortController();
  let received: unknown[] = [];
  const llm = createLlmClient(async (...input) => { received = input; return ' result '; });
  await expect(llm.chat({ system: 'system', prompt: 'prompt', label: 'analysis:source', maxOutputTokens: 123, abortSignal: controller.signal })).resolves.toBe('result');
  expect(received).toEqual(['system', 'prompt', 'analysis:source', { maxTokens: 123, signal: controller.signal }]);
});
