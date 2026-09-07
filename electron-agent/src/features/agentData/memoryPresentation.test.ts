import { describe, expect, it } from 'vitest';
import { findSourceSession, memorySummary, sourceSessionId } from './memoryPresentation';
import { memoryRecord, sourceSession } from './memoryTestData';

describe('memory presentation', () => {
  it('summarizes parsed fields and arrays instead of showing truncated raw JSON', () => {
    expect(memorySummary('{"preference":"中文","tools":["TypeScript","测试"]}')).toBe('preference：中文 · tools：TypeScript、测试');
    expect(memorySummary('未结构化文本')).toBe('未结构化文本');
  });
  it('matches an existing session by source id and normalized source workspace', () => {
    expect(findSourceSession({ ...memoryRecord, sourceWorkspace: 'd:\\proj\\ALPHA\\' }, [sourceSession])).toEqual(sourceSession);
    expect(findSourceSession({ ...memoryRecord, sourceWorkspace: 'D:/other' }, [sourceSession])).toBeUndefined();
    expect(findSourceSession(memoryRecord, [{ ...sourceSession, cwd: null }])).toBeUndefined();
    expect(findSourceSession(memoryRecord, [])).toBeUndefined();
  });
  it('never mistakes the memory owner or a manual source label for a source session', () => {
    const legacy = { ...memoryRecord, sourceSessionId: undefined, sourceWorkspace: undefined, sourceProjectId: 'D:/other' };
    expect(findSourceSession(legacy, [sourceSession])).toEqual(sourceSession);
    expect(sourceSessionId({ ...legacy, origin: 'manual' })).toBeUndefined();
    expect(sourceSessionId({ ...legacy, source: 'https://example.com' })).toBeUndefined();
  });
});
