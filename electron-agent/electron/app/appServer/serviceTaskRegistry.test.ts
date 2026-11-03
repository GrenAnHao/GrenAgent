import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KIND_TIMEOUT_MS } from '../../agent/shortCall';
import { BUILTIN_SERVICE_TASKS, ServiceTaskRegistry } from './serviceTaskRegistry';

describe('ServiceTaskRegistry', () => {
  it('rejects all retired Memory task kinds', () => {
    const registry = new ServiceTaskRegistry();
    for (const kind of ['memory_extract', 'memory_deduplicate', 'memory_scene', 'memory_persona', 'memory_summarize']) {
      expect(registry.get(kind)).toBeUndefined();
      expect(() => registry.validate(kind, {})).toThrow('service task kind is not registered');
    }
  });
  it('BUILTIN_SERVICE_TASKS 的超时以 KIND_TIMEOUT_MS 为唯一来源', () => {
    for (const definition of BUILTIN_SERVICE_TASKS) {
      const expected = KIND_TIMEOUT_MS[definition.kind];
      if (expected === undefined) continue;
      expect(definition.timeoutMs, definition.kind).toBe(expected);
    }
  });

  it('registers built-in task definitions with policy metadata', () => {
    const registry = new ServiceTaskRegistry();
    for (const kind of ['thread_title_generate', 'content_classify', 'context_summarize']) {
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

  it('registers wiki_page_generate with a 60s timeout and accepts markdown string output', () => {
    const registry = new ServiceTaskRegistry();
    expect(registry.get('wiki_page_generate')).toMatchObject({ kind: 'wiki_page_generate', timeoutMs: 60_000 });
    expect(() => registry.validateOutput('wiki_page_generate', '# md')).not.toThrow();
  });

});
