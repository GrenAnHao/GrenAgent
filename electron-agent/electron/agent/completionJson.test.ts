import { describe, expect, it } from 'vitest';
import { parseLooseJson, stripModelWrappers } from './completionJson';

describe('system completion JSON', () => {
  it('preserves Goal JSON parsing through thinking and code fences', () => {
    const raw = '<think>draft</think>\n```json\n{"verdict":"pass","reason":"done","missing":[]}\n```';
    expect(parseLooseJson(stripModelWrappers(raw))).toEqual({ verdict: 'pass', reason: 'done', missing: [] });
  });

  it('retains control-character and trailing-comma tolerance', () => {
    expect(parseLooseJson('{"reason":"line one\nline two",}')).toEqual({ reason: 'line one\nline two' });
    expect(() => parseLooseJson('not json')).toThrow();
  });
});
