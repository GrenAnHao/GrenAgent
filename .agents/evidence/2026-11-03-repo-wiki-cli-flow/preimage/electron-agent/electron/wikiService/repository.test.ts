import { describe, expect, it } from 'vitest';
import { pinPriorPublication, formatCommitMessages, formatFileChanges } from './repository';
describe('native publication identity', () => {
  it('keeps the original read baseline after the partition changes during resume', () => {
    const saved: any[] = []; let current: any = { id: 'old', operationId: 'prior' };
    const context: any = { checkpoints: () => saved, checkpoint: (cp: any) => saved.push(cp), published: () => current, publication: (id: string) => id === 'old' ? { id: 'old' } : undefined };
    const op: any = { id: 'run', action: 'update' };
    expect(pinPriorPublication(op, context)).toEqual({ source: { id: 'old' }, expectedId: 'old' });
    current = { id: 'new', operationId: 'other' };
    expect(pinPriorPublication(op, context)).toEqual({ source: { id: 'old' }, expectedId: 'old' });
  });
  it('refuses repair if a newer unrelated publication replaced the parent baseline', () => {
    const context: any = { checkpoints: () => [{ stage: 'prior-publication', itemId: 'parent', disposition: 'done', parsed: { sourceId: 'old', expectedId: 'old' } }], published: () => ({ id: 'new', operationId: 'other' }) };
    expect(() => pinPriorPublication({ id: 'repair', action: 'repair', parentOperationId: 'parent' } as never, context)).toThrow('BASELINE_CHANGED');
  });
});

describe('reference Git material', () => {
  it('distinguishes apply and drop with full author/date metadata', () => {
    const text = formatCommitMessages([{ hash: '1234567890', author: 'A', date: '2026-01-01', message: 'first\nbody', direction: 'apply' }], [{ hash: 'abcdef0123', author: 'B', date: '2026-01-02', message: 'reverted', direction: 'drop' }], { apply: 1, drop: 1 });
    expect(text).toContain('1. [APPLY] 12345678\n   Message: first\nbody\n   Author: A\n   Date: 2026-01-01');
    expect(text).toContain('1. [DROP] abcdef01\n   Message: reverted');
  });
  it('formats explicit changed-file status without treating files as page dependencies', () => {
    expect(formatFileChanges([{ status: 'R100', oldPath: 'old.ts', path: 'new.ts' }], '123456789', 'abcdef012')).toContain('Renamed: old.ts -> new.ts');
  });
});
