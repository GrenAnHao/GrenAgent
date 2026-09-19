import { describe, expect, it } from 'vitest';
import { levelDisplayLabel, levelOptions, mergeModelCatalog } from './thinkingLevels';

describe('levelDisplayLabel', () => {
  it('把 pi 内部档位显示成设置页同一套中文名', () => {
    expect(levelDisplayLabel('off')).toBe('关闭');
    expect(levelDisplayLabel('minimal')).toBe('最低');
    expect(levelDisplayLabel('medium')).toBe('中');
    expect(levelDisplayLabel('xhigh')).toBe('很高');
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
    expect(opts.map((o) => o.value)).toEqual(['off', 'low', 'medium', 'high']);
  });

  it('自定义供应商的协议默认映射不展示未配置的 max', () => {
    const opts = levelOptions({ provider: 'my-proxy', api: 'openai-completions', reasoning: true });
    expect(opts.map((o) => o.value)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('标签用映射里的供应商原生值', () => {
    const opts = levelOptions({
      provider: 'deepseek',
      reasoning: true,
      thinkingLevelMap: { low: 'L', medium: 'M', high: 'H' },
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
    expect(levelOptions(merged).map((o) => o.value)).toEqual(['off', 'low', 'high']);
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
    expect(levelOptions(mergeModelCatalog(session, catalog)).map((o) => o.value)).toEqual(['off', 'medium']);
  });
});
