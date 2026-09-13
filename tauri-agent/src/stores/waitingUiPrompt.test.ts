import { describe, expect, it } from 'vitest';
import { parseWaitingUiPrompt, waitingUiPromptLabel } from './waitingUiPrompt';

describe('parseWaitingUiPrompt', () => {
  it('reads kind and title from setStatus JSON', () => {
    expect(parseWaitingUiPrompt(JSON.stringify({ kind: 'select', title: '请求批准' }))).toEqual({
      kind: 'select',
      title: '请求批准',
    });
  });

  it('clears when status text is empty', () => {
    expect(parseWaitingUiPrompt(undefined)).toBeUndefined();
    expect(parseWaitingUiPrompt('')).toBeUndefined();
  });

  it('ignores unknown kinds', () => {
    expect(parseWaitingUiPrompt(JSON.stringify({ kind: 'toast' }))).toBeUndefined();
  });
});

describe('waitingUiPromptLabel', () => {
  it('maps prompt kinds to list footer copy', () => {
    expect(waitingUiPromptLabel({ kind: 'select' })).toBe('等待批准…');
    expect(waitingUiPromptLabel({ kind: 'confirm' })).toBe('等待确认…');
    expect(waitingUiPromptLabel({ kind: 'input' })).toBe('等待输入…');
    expect(waitingUiPromptLabel({ kind: 'editor' })).toBe('等待输入…');
    expect(waitingUiPromptLabel({ kind: 'custom' })).toBe('等待输入…');
    expect(waitingUiPromptLabel(undefined)).toBeUndefined();
  });
});
