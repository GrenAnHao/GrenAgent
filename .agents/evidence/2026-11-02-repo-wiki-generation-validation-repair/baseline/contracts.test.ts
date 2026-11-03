import { describe, expect, it } from 'vitest';
import { parseStartKnowledgeTask, parseKnowledgeTaskMetadata, parseStageExecutionResult, DEFAULT_KNOWLEDGE_BUDGETS } from '../../../shared/knowledgeKernelContracts';
import { parseJobMetadata } from '../jobStore';

export const key = { workspaceInstanceId: 'instance', projectId: 'p', portableProjectId: 'portable', branch: 'main', language: 'zh-CN', domain: 'wiki' as const };
export const metadata = () => ({ version: 1 as const, key, intent: 'generate' as const, revision: 0, phase: 'prepare' as const, pipelineConfigHash: 'pipeline', budgets: structuredClone(DEFAULT_KNOWLEDGE_BUDGETS), resumePolicy: 'auto' as const, counts: { planned: 0, prepared: 0, failed: 0, blocked: 0, published: 0 } });
describe('knowledge contracts', () => {
  const start = { version: 1, requestId: 'request', projectId: 'p', domain: 'wiki', language: 'zh-CN', intent: 'generate', confirmExternal: true, expectedModelIdentity: 'model', expectedPlanToken: 'plan' };
  it('round trips v1 and preserves old job metadata beside repoWiki', () => {
    expect(parseStartKnowledgeTask(JSON.parse(JSON.stringify(start)))).toEqual(start);
    expect(parseKnowledgeTaskMetadata(metadata())).toEqual(metadata());
    expect(parseJobMetadata({ retryOf: 'old', payload: { kbId: 'kb', sourceIds: ['s'] }, repoWiki: metadata() })).toMatchObject({ retryOf: 'old', payload: { kbId: 'kb', sourceIds: ['s'] }, repoWiki: metadata() });
  });
  it('preserves the existing detached HEAD identity', () => expect(parseKnowledgeTaskMetadata({ ...metadata(), key: { ...key, branch: 'detached:abcdef123456' } }).key.branch).toBe('detached:abcdef123456'));
  it.each([{ version: 2 }, { confirmExternal: false }, { language: '../en' }, { intent: 'shell' }])('rejects invalid start %j', patch => expect(() => parseStartKnowledgeTask({ ...start, ...patch })).toThrow());
  it.each([{ phase: 'shell' }, { key: { ...key, branch: '../bad' } }, { fence: { ledgerId: 'x', ownerId: '', controllerEpoch: 'e', generation: 0 } }])('rejects invalid metadata %j', patch => expect(() => parseKnowledgeTaskMetadata({ ...metadata(), ...patch })).toThrow());
  it('rejects oversized stage payload before acknowledging', () => expect(() => parseStageExecutionResult({ version: 1, payload: 'x'.repeat(512 * 1024 + 1) })).toThrow());
});

describe('knowledge token budget accounting', () => {
  it('charges cache reads at a tenth so a resent tool-loop transcript is not billed in full every turn', async () => {
    const { knowledgeBudgetTokens } = await import('../../../shared/knowledgeKernelContracts');
    // Real turn from a DeepSeek overview stage: 7864 uncached input, 155 output, ~19.3k cache hits.
    expect(knowledgeBudgetTokens({ input: 7864, output: 155, cacheRead: 19328, cacheWrite: 0 })).toBe(7864 + 155 + 1933);
    expect(knowledgeBudgetTokens({ input: 10, output: 5 })).toBe(15);
  });
  it('lets a twelve-turn page with a growing context fit the unit budget', () => {
    // Twelve turns, each resending a context that grows by 8k tokens, mostly served from cache.
    let used = 0;
    for (let turn = 1; turn <= 12; turn++) used += 8000 + 300 + Math.ceil((turn - 1) * 8000 / 10);
    expect(used).toBeLessThan(DEFAULT_KNOWLEDGE_BUDGETS.unit.maxTotalTokens);
  });
});

describe('model citation normalisation', () => {
  it('fills hashes, accepts alternate line fields, falls back to the read range and drops unread citations', async () => {
    const { normalizeStageSources, validateStageResult } = await import('./validation');
    const files = { 'README.md': { hash: 'h1', lines: 100 }, 'src/a.ts': { hash: 'h2', lines: 50 }, 'unread.ts': { hash: 'h3', lines: 9 } };
    const read = [{ path: 'README.md', start: 1, end: 100 }, { path: 'src/a.ts', start: 1, end: 30 }];
    // The real DeepSeek overview answer: sources as {path, note} without hashes or lines.
    const payload = normalizeStageSources('overview', { summary: 's', sources: [{ path: 'README.md', note: 'entry' }, { path: 'src/a.ts', start_line: 3, end_line: 9 }, { path: 'unread.ts', start: 1, end: 2 }, { path: 'src/a.ts', start: 40, end: 45 }] }, files, read) as any;
    expect(payload.sources).toEqual([{ path: 'README.md', hash: 'h1', start: 1, end: 100 }, { path: 'src/a.ts', hash: 'h2', start: 3, end: 9 }]);
    expect(() => validateStageResult({ phase: 'overview', files, observedRanges: read }, payload)).not.toThrow();
  });
  it('keeps verified Markdown citations and turns unverifiable ones into plain text', async () => {
    const { normalizeStageSources, validateStageResult } = await import('./validation');
    const files = { 'src/a.ts': { hash: 'h2', lines: 50 } }, read = [{ path: 'src/a.ts', start: 1, end: 30 }];
    const payload = normalizeStageSources('generate', { markdown: 'See [a](source:src/a.ts#L2-L4) and [b](source:src/a.ts#L40-L41).', sources: [] }, files, read) as any;
    expect(payload.markdown).toBe('See [a](source:src/a.ts#L2-L4) and b.');
    expect(payload.sources).toEqual([{ path: 'src/a.ts', hash: 'h2', start: 2, end: 4 }]);
    expect(() => validateStageResult({ phase: 'generate', files, observedRanges: read }, payload)).not.toThrow();
  });
});

describe('citation fallback', () => {
  it('cites read ranges of files the page names when the model sent no usable sources', async () => {
    const { normalizeStageSources } = await import('./validation');
    const files = { 'src/a.ts': { hash: 'h2', lines: 50 }, 'src/b.ts': { hash: 'h3', lines: 9 } };
    const payload = normalizeStageSources('generate', { markdown: '`src/a.ts` wires everything.', sources: [{ note: 'x' }] }, files, [{ path: 'src/a.ts', start: 1, end: 30 }, { path: 'src/b.ts', start: 1, end: 9 }]) as any;
    expect(payload.sources).toEqual([{ path: 'src/a.ts', hash: 'h2', start: 1, end: 30 }]);
  });
});

it('accepts the local readme phase in frozen task metadata', () => {
  expect(parseKnowledgeTaskMetadata({ ...metadata(), phase: 'readme' }).phase).toBe('readme');
});
