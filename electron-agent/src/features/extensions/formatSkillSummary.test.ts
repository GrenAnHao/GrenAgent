import { describe, expect, it } from 'vitest';
import { formatSkillSummary } from './formatSkillSummary';

describe('formatSkillSummary', () => {
  it('replaces newlines with spaces and collapses leftover whitespace', () => {
    expect(formatSkillSummary('browser automation\ntasks using CDP')).toBe('browser automation tasks using CDP');
    expect(formatSkillSummary('Add sound effects,\r\n  music, streaming')).toBe('Add sound effects, music, streaming');
  });

  it('trims empty or whitespace-only descriptions to nothing', () => {
    expect(formatSkillSummary('')).toBe('');
    expect(formatSkillSummary('  \n\t  ')).toBe('');
    expect(formatSkillSummary(undefined)).toBe('');
  });
});
