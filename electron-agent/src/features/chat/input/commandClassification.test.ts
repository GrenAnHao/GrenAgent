import { describe, expect, it } from 'vitest';

import { isExecutiveCommand, isExecutiveCommandMessage, sidebarTitleForPrompt } from './commandClassification';

describe('isExecutiveCommand', () => {
  it('命中已知动作命令（忽略大小写）', () => {
    expect(isExecutiveCommand('newSession')).toBe(true);
    expect(isExecutiveCommand('COMPACT')).toBe(true);
  });
  it('提示词 / 技能 / 不确定命令保留气泡', () => {
    expect(isExecutiveCommand('skill:tdd')).toBe(false);
    // 与白名单同名的技能（如 skill:new）也必须保留气泡——技能必产生轮次。
    expect(isExecutiveCommand('skill:new')).toBe(false);
    expect(isExecutiveCommand('deep-research')).toBe(false);
    expect(isExecutiveCommand('review')).toBe(false);
    expect(isExecutiveCommand('dream')).toBe(false);
    expect(isExecutiveCommand('distill')).toBe(false);
  });

  it('goal 是执行性命令（skill:goal 仍为假）', () => {
    expect(isExecutiveCommand('goal')).toBe(true);
    expect(isExecutiveCommand('GOAL')).toBe(true);
    expect(isExecutiveCommand('skill:goal')).toBe(false);
  });
});

describe('isExecutiveCommandMessage', () => {
  it('仅当整条消息==单个执行性命令时为真', () => {
    expect(isExecutiveCommandMessage('/dream')).toBe(false);
    expect(isExecutiveCommandMessage('/distill')).toBe(false);
    expect(isExecutiveCommandMessage('/skill:tdd')).toBe(false);
    expect(isExecutiveCommandMessage('hello /dream')).toBe(false);
    expect(isExecutiveCommandMessage('please run dream')).toBe(false);
    expect(isExecutiveCommandMessage('/goal 写完')).toBe(true);
    expect(isExecutiveCommandMessage('/skill:goal')).toBe(false);
  });
});

describe('sidebarTitleForPrompt', () => {
  it('uses the goal condition instead of the slash command', () => {
    expect(sidebarTitleForPrompt('/goal 测试子代理理')).toBe('测试子代理理');
    expect(sidebarTitleForPrompt('/GOAL 写完')).toBe('写完');
  });

  it('keeps ordinary prompts (trimmed, 80 chars)', () => {
    expect(sidebarTitleForPrompt('  hello world  ')).toBe('hello world');
    expect(sidebarTitleForPrompt('/goal')).toBe('/goal');
  });
});
