import { describe, expect, it } from 'vitest';
import { parseAnswer } from './AnswerCard';

describe('parseAnswer', () => {
  it('parses title and answer', () => {
    expect(parseAnswer(JSON.stringify({ title: '选哪个？', answer: '选项A' }))).toEqual({
      title: '选哪个？',
      answer: '选项A',
    });
  });

  it('coerces a missing answer to empty string', () => {
    expect(parseAnswer(JSON.stringify({ title: '只有问题' }))).toEqual({ title: '只有问题', answer: '' });
  });

  it('returns null for non-json or when title is missing', () => {
    expect(parseAnswer('not json')).toBeNull();
    expect(parseAnswer(JSON.stringify({ answer: 'x' }))).toBeNull();
  });
});
