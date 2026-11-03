import { describe, expect, it } from 'vitest';
import { normalizeAuthorConfig } from './authorConfig';
import { runPagePool, throwIfGlobalFailure, executeItem, stageFailureCode } from './fullGeneration';

describe('native author configuration', () => {
  it('keeps constraints-only auto configuration on the automatic path', () => {
    const config = normalizeAuthorConfig({ mode: 'auto', constraints: ['focus on tests'], notes: [] });
    expect(config.mode).toBe('auto'); expect(config.pages).toEqual([]);
  });
  it('does not treat legacy page dependencies as execution edges', () => {
    const config = normalizeAuthorConfig({ mode: 'pages', pages: [{ id: 'one', title: 'One', prompt: 'Explain', depends_on: ['one'] }] });
    expect(config.pages[0]).not.toHaveProperty('depends_on');
  });
});
describe('independent page pool', () => {
  it('retries only the failed subset after partial success', async () => {
    const calls: string[] = [];
    const result = await runPagePool(['a', 'b'], new Set(), 3, async id => { calls.push(id); return id === 'a' || calls.filter(x => x === 'b').length > 1; });
    expect(result.failed).toEqual([]); expect(calls.filter(x => x === 'a')).toHaveLength(1); expect(calls.filter(x => x === 'b')).toHaveLength(2);
  });
  it('throws without compensation when all pages fail and no success exists', async () => {
    const calls: string[] = [];
    await expect(runPagePool(['a', 'b'], new Set(), 3, async id => { calls.push(id); return false; })).rejects.toThrow('all 2 documents failed');
    expect(calls).toHaveLength(2);
  });
  it('keeps ordinary page errors local while abort, spending and fencing stop the run', () => {
    const signal = new AbortController().signal;
    expect(() => throwIfGlobalFailure(new Error('page_provider_rejected'), signal)).not.toThrow();
    for (const error of ['SPENDING_LIMIT', 'STALE_FENCE', 'SOURCE_SNAPSHOT_CHANGED']) expect(() => throwIfGlobalFailure(new Error(error), signal)).toThrow(error);
    const abort = new AbortController(); abort.abort(new Error('paused'));
    expect(() => throwIfGlobalFailure(new Error('page_provider_rejected'), abort.signal)).toThrow('paused');
  });
  it('resumes an interrupted final attempt without resetting its ordinal', async () => {
    const operation: any = { id: 'op', model: {} };
    const saved: any[] = [];
    const context: any = { signal: new AbortController().signal, checkpoints: () => [{ stage: 'page:attempt', itemId: 'op:a:1', disposition: 'done', parsed: { attempt: 2, status: 'inflight', sessionRestartCount: 0 } }, { stage: 'source', disposition: 'done', parsed: [] }], checkpoint: (value: unknown) => saved.push(value), usage: () => {}, event: () => {} };
    await expect(executeItem(operation, context, async () => ({ text: 'ok' }), { stage: 'page', itemId: 'a', purpose: 'wiki.full.page', variables: {}, evaluate: text => ({ ok: true, value: text }) })).resolves.toBe('ok');
    expect(saved).toContainEqual(expect.objectContaining({ stage: 'page:attempt', parsed: { attempt: 2, status: 'inflight', sessionRestartCount: 1 } }));
  });
});

describe('stage failure classification', () => {
  const context = (checkpoints: any[]) => ({ signal: new AbortController().signal, checkpoints: () => checkpoints }) as any;
  it('names the failure class instead of collapsing every cause into one code', () => {
    expect(stageFailureCode(context([]), 'catalogue-root', '', 'CATALOGUE_FAILED')).toBe('CATALOGUE_FAILED');
    expect(stageFailureCode(context([{ stage: 'catalogue-root', itemId: '', disposition: 'failed', error: 'MODEL_ERROR' }]), 'catalogue-root', '', 'CATALOGUE_FAILED')).toBe('CATALOGUE_MODEL_ERROR');
    expect(stageFailureCode(context([{ stage: 'catalogue-root', itemId: '', disposition: 'failed', error: 'model_output_length' }]), 'catalogue-root', '', 'CATALOGUE_FAILED')).toBe('CATALOGUE_OUTPUT_TRUNCATED');
    expect(stageFailureCode(context([{ stage: 'catalogue-root', itemId: '', disposition: 'failed', error: 'invalid section shape: expected string' }]), 'catalogue-root', '', 'CATALOGUE_FAILED')).toBe('CATALOGUE_OUTPUT_INVALID');
  });
  it('keeps the last failure for the stage and ignores other stages or items', () => {
    const checkpoints = [
      { stage: 'catalogue-root', itemId: '', disposition: 'failed', error: 'MODEL_ERROR' },
      { stage: 'catalogue-root', itemId: '', disposition: 'failed', error: 'invalid section shape: expected string' },
      { stage: 'catalogue-child', itemId: 'other', disposition: 'failed', error: 'MODEL_ERROR' },
    ];
    expect(stageFailureCode(context(checkpoints), 'catalogue-root', '', 'CATALOGUE_FAILED')).toBe('CATALOGUE_OUTPUT_INVALID');
    expect(stageFailureCode(context(checkpoints), 'catalogue-child', 'mine', 'CATALOGUE_CHILD_FAILED')).toBe('CATALOGUE_CHILD_FAILED');
  });
});
