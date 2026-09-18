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

  it('registers wiki_page_generate with a 60s timeout and accepts markdown string output', () => {
    const registry = new ServiceTaskRegistry();
    expect(registry.get('wiki_page_generate')).toMatchObject({ kind: 'wiki_page_generate', timeoutMs: 60_000 });
    expect(() => registry.validateOutput('wiki_page_generate', '# md')).not.toThrow();
  });

  it('memory_extract 的输出 schema 拒绝非记录数组', () => {
    const registry = new ServiceTaskRegistry();
    expect(() => registry.validateOutput('memory_extract', { l1: [{ content: '', type: 'work_fact' }] })).toThrow();
    expect(registry.validateOutput('memory_extract', { l1: [{ content: 'x', type: 'work_fact' }] })).toMatchObject({ l1: [expect.any(Object)] });
  });

  it('memory_extract 超时放宽到 60s', () => {
    expect(new ServiceTaskRegistry().get('memory_extract')!.timeoutMs).toBe(60_000);
  });
});
