import { describe, expect, it } from 'vitest';
import { agentDataModelOverride, applyAgentDataModel } from './agentDataSettings';

describe('agentDataModel', () => {
  it('空值和没有斜杠时不覆盖，继续用应用默认模型', () => {
    expect(agentDataModelOverride(undefined)).toBeUndefined();
    expect(agentDataModelOverride('')).toBeUndefined();
    expect(agentDataModelOverride('  ')).toBeUndefined();
    expect(agentDataModelOverride('only-provider')).toBeUndefined();
    expect(applyAgentDataModel({ user: 'q' }, '')).toEqual({ user: 'q' });
  });

  it('按第一个斜杠拆成 provider 与 modelId', () => {
    expect(agentDataModelOverride(' deepseek/deepseek-chat ')).toEqual({
      provider: 'deepseek',
      modelId: 'deepseek-chat',
    });
    expect(applyAgentDataModel({ user: 'q', systemPrompt: 's' }, 'openai/gpt-4o')).toEqual({
      user: 'q',
      systemPrompt: 's',
      provider: 'openai',
      modelId: 'gpt-4o',
    });
  });
});
