import { describe, expect, it } from 'vitest';
import {
  clampDockHeight,
  diagnosticLevelOptions,
  DOCK_MIN_HEIGHT,
  pickDiagnosticLevel,
  reasoningForLevel,
  SETTINGS_RESERVE,
} from './providerDiagnosticsUtils';

const claude = {
  provider: 'anthropic',
  id: 'claude-opus',
  api: 'anthropic-messages',
  reasoning: true,
  thinkingLevelMap: { off: 'off', low: 'low', high: 'high', xhigh: 'max', max: null },
};

describe('diagnosticLevelOptions', () => {
  it('按模型映射列档位，中文档名在前，原生名不同才附上', () => {
    expect(diagnosticLevelOptions(claude)).toEqual([
      { value: 'off', label: '关闭' },
      { value: 'low', label: '低' },
      { value: 'high', label: '高' },
      { value: 'xhigh', label: '很高 · max' },
    ]);
  });

  it('非推理模型、没选模型都只有关闭', () => {
    expect(diagnosticLevelOptions({ provider: 'p', id: 'm', reasoning: false })).toEqual([{ value: 'off', label: '关闭' }]);
    expect(diagnosticLevelOptions(undefined)).toEqual([{ value: 'off', label: '关闭' }]);
  });
});

describe('pickDiagnosticLevel', () => {
  it('当前档仍可选就保留', () => {
    expect(pickDiagnosticLevel(claude, 'high')).toBe('high');
  });

  it('当前档不可选时默认关闭', () => {
    expect(pickDiagnosticLevel(claude, 'max')).toBe('off');
  });

  it('模型没有关闭档时取模型默认档', () => {
    const noOff = { ...claude, thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' } };
    expect(pickDiagnosticLevel(noOff, 'off')).toBe('medium');
  });
});

describe('reasoningForLevel', () => {
  it('关闭不带 reasoning，其余原样', () => {
    expect(reasoningForLevel('off')).toBeUndefined();
    expect(reasoningForLevel('xhigh')).toBe('xhigh');
  });
});

describe('clampDockHeight', () => {
  it('不低于下限，不高过给设置留的高度', () => {
    expect(clampDockHeight(20, 800)).toBe(DOCK_MIN_HEIGHT);
    expect(clampDockHeight(9999, 800)).toBe(800 - SETTINGS_RESERVE);
    expect(clampDockHeight(321.6, 800)).toBe(322);
  });

  it('容器太矮时以下限为准；量不到容器只管下限', () => {
    expect(clampDockHeight(300, 200)).toBe(DOCK_MIN_HEIGHT);
    expect(clampDockHeight(5000, 0)).toBe(5000);
  });
});
