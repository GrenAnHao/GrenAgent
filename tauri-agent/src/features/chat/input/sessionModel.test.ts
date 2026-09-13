import { describe, expect, it } from 'vitest';
import { modelKey } from './modelUtils';
import { pickFallbackModelKey, selectedModelLabel, sessionModelKey } from './sessionModel';

const models = [
  { id: 'm', name: 'My Model', provider: 'anthropic' },
  { id: 'g', name: 'GPT', provider: 'openai' },
];

describe('sessionModelKey', () => {
  it('builds a key only when provider and id are both present', () => {
    expect(sessionModelKey({ provider: 'anthropic', id: 'm' })).toBe(modelKey('anthropic', 'm'));
    expect(sessionModelKey({ provider: 'anthropic' })).toBe('');
    expect(sessionModelKey(null)).toBe('');
  });
});

describe('pickFallbackModelKey', () => {
  it('prefers the last selected model when it is still in the list', () => {
    expect(pickFallbackModelKey(models, modelKey('openai', 'g'))).toBe(modelKey('openai', 'g'));
  });

  it('falls back to the first available model for an empty session', () => {
    expect(pickFallbackModelKey(models, '')).toBe(modelKey('anthropic', 'm'));
    expect(pickFallbackModelKey([], 'missing')).toBe('');
  });
});

describe('selectedModelLabel', () => {
  it('uses the catalog name and otherwise the model id', () => {
    expect(selectedModelLabel(modelKey('openai', 'g'), models)).toBe('GPT');
    expect(selectedModelLabel(modelKey('other', 'x'), models)).toBe('x');
    expect(selectedModelLabel('', models)).toBe('');
  });
});
