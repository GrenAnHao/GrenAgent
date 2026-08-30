import { describe, it, expect } from 'vitest';
import { modelKey, parseModelKey, parseModels } from './modelUtils';

describe('modelUtils', () => {
  it('roundtrips provider/id even when id contains a colon', () => {
    const key = modelKey('openai', 'gpt-4o:2024');
    expect(parseModelKey(key)).toEqual({ provider: 'openai', id: 'gpt-4o:2024' });
  });

  it('parseModelKey returns empty provider for keyless input', () => {
    expect(parseModelKey('solo-id')).toEqual({ provider: '', id: 'solo-id' });
  });

  it('parseModels accepts a raw array', () => {
    const raw = [{ id: 'a', provider: 'p' }];
    expect(parseModels(raw)).toEqual(raw);
  });

  it('parseModels unwraps a { models } envelope', () => {
    const models = [{ id: 'a', provider: 'p' }];
    expect(parseModels({ models })).toEqual(models);
  });

  it('parseModels returns [] for unexpected shapes', () => {
    expect(parseModels(null)).toEqual([]);
    expect(parseModels('nope')).toEqual([]);
    expect(parseModels({ other: 1 })).toEqual([]);
  });
});
