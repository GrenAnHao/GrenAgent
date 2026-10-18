import { describe, expect, it } from 'vitest';
import { coerceVisibleLevel, defaultLevel, levelDisplayLabel, levelOptions, mergeModelCatalog } from './thinkingLevels';

describe('levelDisplayLabel', () => {
  it('把 pi 内部档位显示成设置页同一套中文名', () => {
    expect(levelDisplayLabel('off')).toBe('关闭');
    expect(levelDisplayLabel('minimal')).toBe('最低');
    expect(levelDisplayLabel('medium')).toBe('中');
    expect(levelDisplayLabel('xhigh')).toBe('很高');
    expect(levelDisplayLabel('max')).toBe('极致');
    expect(levelDisplayLabel('custom')).toBe('custom');
  });
});

describe('levelOptions', () => {
  it('只展示 thinkingLevelMap 里显式配置的档位，null 和缺省键都隐藏', () => {
    const opts = levelOptions({
      provider: 'openai',
      reasoning: true,
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: null },
    });
    expect(opts.map((o) => o.value)).toEqual(['low', 'medium', 'high']);
  });

  it('关闭档只有映射里写成字符串时才出现', () => {
    const hidden = levelOptions({
      provider: 'proxy',
      api: 'anthropic-messages',
      reasoning: true,
      thinkingLevelMap: { minimal: 'low', low: 'medium', medium: 'high', high: 'xhigh', xhigh: 'max' },
    });
    expect(hidden.map((o) => o.value)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);

    const shown = levelOptions({
      provider: 'proxy',
      reasoning: true,
      thinkingLevelMap: { off: '', low: 'low' },
    });
    expect(shown.map((o) => o.value)).toEqual(['off', 'low']);
  });

  it('只露出一个思考档时，默认就落在这一档', () => {
    const model = {
      provider: 'google',
      reasoning: true,
      thinkingLevelMap: { high: 'high', minimal: null, low: null, medium: null },
    };
    expect(defaultLevel(model)).toBe('high');
    expect(coerceVisibleLevel(model, 'medium')).toBe('high');
    expect(coerceVisibleLevel(model, 'off')).toBe('high');
    expect(coerceVisibleLevel(model, 'high')).toBe('high');
    expect(coerceVisibleLevel(model, undefined)).toBeUndefined();
  });

  it('自定义供应商的协议默认映射不展示未配置的 off 和 max', () => {
    const opts = levelOptions({ provider: 'my-proxy', api: 'openai-completions', reasoning: true });
    expect(opts.map((o) => o.value)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('自定义 Anthropic 协议默认从低到极致五档，最低隐藏，标签和档位同名', () => {
    const opts = levelOptions({ provider: 'my-claude', api: 'anthropic-messages', reasoning: true });
    expect(opts).toEqual([
      { label: 'low', value: 'low' },
      { label: 'medium', value: 'medium' },
      { label: 'high', value: 'high' },
      { label: 'xhigh', value: 'xhigh' },
      { label: 'max', value: 'max' },
    ]);
  });

  it('标签用映射里的供应商原生值', () => {
    const opts = levelOptions({
      provider: 'deepseek',
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'L', medium: 'M', high: 'H' },
    });
    expect(opts).toEqual([
      { label: 'off', value: 'off' },
      { label: 'L', value: 'low' },
      { label: 'M', value: 'medium' },
      { label: 'H', value: 'high' },
    ]);
  });
});

describe('mergeModelCatalog', () => {
  it('会话模型没有映射时，用可用列表里的档位配置', () => {
    const session = { id: 'flash', provider: 'deepseek', api: 'openai-completions', reasoning: true };
    const catalog = [{
      id: 'flash',
      provider: 'deepseek',
      api: 'openai-completions',
      reasoning: true,
      thinkingLevelMap: { low: 'low', high: 'high' },
    }];
    const merged = mergeModelCatalog(session, catalog);
    expect(levelOptions(merged).map((o) => o.value)).toEqual(['low', 'high']);
  });

  it('会话上是保存前的旧映射时，用列表里新勾上的关闭档', () => {
    const session = {
      id: 'claude-opus-5.5',
      provider: 'custom-mujo43d2',
      api: 'anthropic-messages',
      reasoning: true,
      thinkingLevelMap: { minimal: 'low', low: 'medium', medium: 'high', high: 'xhigh', xhigh: 'max' },
    };
    const catalog = [{
      ...session,
      thinkingLevelMap: { ...session.thinkingLevelMap, max: null, off: '' },
    }];
    expect(levelOptions(mergeModelCatalog(session, catalog)).map((o) => o.value)).toEqual([
      'off', 'minimal', 'low', 'medium', 'high', 'xhigh',
    ]);
  });

  it('会话映射只有空对象时仍回退到列表配置', () => {
    const session = {
      id: 'flash',
      provider: 'deepseek',
      reasoning: true,
      thinkingLevelMap: {},
    };
    const catalog = [{
      id: 'flash',
      provider: 'deepseek',
      reasoning: true,
      thinkingLevelMap: { medium: 'medium' },
    }];
    expect(levelOptions(mergeModelCatalog(session, catalog)).map((o) => o.value)).toEqual(['medium']);
  });
});
