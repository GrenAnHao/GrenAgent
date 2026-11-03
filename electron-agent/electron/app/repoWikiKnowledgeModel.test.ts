import { describe, expect, it, vi } from 'vitest';
import { createRepoWikiKnowledgeModelResolver } from './repoWikiKnowledgeModel';

describe('Repo Wiki knowledge scheduler binding', () => {
  it('submits the original request to the host knowledge scheduler with model and workspace identity', async () => {
    const completeKnowledge = vi.fn(async () => 'raw page JSON');
    const scheduler = { describeKnowledgeModel: vi.fn(async () => 'knowledge/configured'), completeKnowledge };
    const resolver = createRepoWikiKnowledgeModelResolver(scheduler, async () => 'a'.repeat(64));
    const binding = await resolver('D:/project');
    const abort = new AbortController();
    const input = { systemPrompt: 'source rules', user: '{"files":[]}', maxTokens: 8192 };
    expect(await binding.complete(input, abort.signal)).toBe('raw page JSON');
    expect(completeKnowledge).toHaveBeenCalledWith({ ...input, expectedModel: 'knowledge/configured', expectedConfiguration: 'a'.repeat(64), sourceProjectId: 'D:/project' }, { signal: abort.signal });
    expect(binding.available).toBe(true);
    expect(binding.cacheKey).not.toContain('config-v1');
    const next = await createRepoWikiKnowledgeModelResolver(scheduler, async () => 'b'.repeat(64))('D:/project');
    expect(next.cacheKey).not.toBe(binding.cacheKey);
  });

  it('keeps existing pages readable without falling back to another model when the scheduler is unavailable', async () => {
    const completeKnowledge = vi.fn();
    const resolver = createRepoWikiKnowledgeModelResolver({ describeKnowledgeModel: async () => { throw new Error('unavailable'); }, completeKnowledge }, async () => 'identity');
    const binding = await resolver();
    expect(binding.available).toBe(false);
    await expect(binding.complete({ systemPrompt: '', user: '' }, new AbortController().signal)).rejects.toThrow('MODEL_UNAVAILABLE');
    expect(completeKnowledge).not.toHaveBeenCalled();
  });
});
