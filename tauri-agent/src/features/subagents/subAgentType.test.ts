import { describe, expect, it } from 'vitest';
import { accessLabel, parseSubAgentType, presetLabel } from './subAgentType.js';

describe('parseSubAgentType', () => {
  it('null/空档案视为默认可写', () => {
    expect(parseSubAgentType(null)).toEqual({ preset: 'default', access: 'write', restricted: false });
    expect(parseSubAgentType(undefined)).toEqual({ preset: 'default', access: 'write', restricted: false });
    expect(parseSubAgentType('')).toEqual({ preset: 'default', access: 'write', restricted: false });
  });

  it('非法 JSON 回退为默认', () => {
    expect(parseSubAgentType('{not json')).toEqual({ preset: 'default', access: 'write', restricted: false });
  });

  it('fs=readonly 解析为只读（explore/reviewer）', () => {
    expect(parseSubAgentType('{"name":"explore","fs":"readonly"}')).toEqual({
      preset: 'explore',
      access: 'readonly',
      restricted: false,
    });
    expect(parseSubAgentType('{"name":"reviewer","fs":"readonly"}').access).toBe('readonly');
  });

  it('fs=workspace 解析为可写工作', () => {
    expect(parseSubAgentType('{"name":"executor","fs":"workspace"}')).toEqual({
      preset: 'executor',
      access: 'write',
      restricted: false,
    });
  });

  it('fs.writeAllow 解析为受限写（planner）', () => {
    expect(parseSubAgentType('{"name":"planner","fs":{"writeAllow":["plans/","docs/"]}}')).toEqual({
      preset: 'planner',
      access: 'write',
      restricted: true,
    });
  });

  it('缺 name 的内联档案标记为 custom', () => {
    expect(parseSubAgentType('{"fs":"readonly"}').preset).toBe('custom');
  });

  it('缺 fs 的档案默认按可写', () => {
    expect(parseSubAgentType('{"name":"default"}')).toEqual({
      preset: 'default',
      access: 'write',
      restricted: false,
    });
  });
});

describe('presetLabel / accessLabel', () => {
  it('预设名映射中文，未知保留原名', () => {
    expect(presetLabel('explore')).toBe('探索');
    expect(presetLabel('reviewer')).toBe('审查');
    expect(presetLabel('weird')).toBe('weird');
  });

  it('访问级别短标签', () => {
    expect(accessLabel({ preset: 'explore', access: 'readonly', restricted: false })).toBe('只读');
    expect(accessLabel({ preset: 'executor', access: 'write', restricted: false })).toBe('工作');
    expect(accessLabel({ preset: 'planner', access: 'write', restricted: true })).toBe('受限写');
  });
});
