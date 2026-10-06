import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ServiceTaskRegistry } from './serviceTaskRegistry';

describe('ServiceTaskRegistry', () => {
  it('registers built-in task definitions with policy metadata', () => {
    const registry = new ServiceTaskRegistry();
    for (const kind of ['memory_extract', 'memory_deduplicate', 'memory_scene', 'memory_persona', 'memory_summarize', 'thread_title_generate', 'content_classify', 'context_summarize']) {
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

  it('memory_extract / memory_deduplicate 超时对齐上游 180s', () => {
    const registry = new ServiceTaskRegistry();
    expect(registry.get('memory_extract')!.timeoutMs).toBe(180_000);
    expect(registry.get('memory_deduplicate')!.timeoutMs).toBe(180_000);
  });

  it('memory_deduplicate 允许 store 决策省略 target_ids', () => {
    const registry = new ServiceTaskRegistry();
    expect(registry.validateOutput('memory_deduplicate', [{ record_id: 'r0', action: 'store' }])).toEqual([
      { record_id: 'r0', action: 'store', target_ids: [] },
    ]);
  });

  it('memory_scene / memory_persona 走 JSON 协议，超时对齐上游（L2 300s，L3 180s）', () => {
    const registry = new ServiceTaskRegistry();
    expect(registry.get('memory_scene')).toMatchObject({ timeoutMs: 300_000 });
    expect(registry.get('memory_persona')).toMatchObject({ timeoutMs: 180_000 });
    expect(registry.validateOutput('memory_scene', {
      scenes: [{ filename: '团队记忆-SOP与禁忌.md', action: 'write', content: '## 核心 SOP' }],
      persona_update_request: 'SOP 已跨场景稳定',
    })).toMatchObject({ scenes: [expect.any(Object)] });
    expect(registry.validateOutput('memory_persona', { content: '# Team Operating Doctrine' })).toEqual({
      content: '# Team Operating Doctrine',
    });
    expect(() => registry.validateOutput('memory_scene', [])).toThrow();
    expect(() => registry.validateOutput('memory_persona', { content: '' })).toThrow();
  });
});
