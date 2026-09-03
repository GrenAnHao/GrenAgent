import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ServiceTaskRegistry } from './serviceTaskRegistry';

describe('ServiceTaskRegistry', () => {
  it('registers built-in task definitions with policy metadata', () => {
    const registry = new ServiceTaskRegistry();
    for (const kind of ['memory_extract', 'memory_deduplicate', 'memory_summarize', 'thread_title_generate', 'content_classify', 'context_summarize']) {
      expect(registry.get(kind)).toMatchObject({ kind, timeoutMs: expect.any(Number), maxAttempts: expect.any(Number), capabilities: expect.any(Array) });
    }
  });

  it('rejects unknown kinds, invalid input and undeclared capabilities', () => {
    const registry = new ServiceTaskRegistry();
    registry.register({ kind: 'test', inputSchema: z.object({ text: z.string() }), outputSchema: z.object({ ok: z.boolean() }), timeoutMs: 1000, maxAttempts: 2, capabilities: ['llm_completion'] });
    expect(() => registry.validate('missing', {})).toThrow('service task kind is not registered');
    expect(() => registry.validate('test', { text: 1 })).toThrow('service task input does not match schema');
    expect(() => registry.assertCapabilities('test', ['network'])).toThrow('service task capability is not declared');
    expect(() => registry.validateOutput('test', { ok: 'yes' })).toThrow('service task output does not match schema');
  });
});
