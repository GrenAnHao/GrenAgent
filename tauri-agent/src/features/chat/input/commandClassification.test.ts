import { describe, expect, it } from 'vitest';

import { isExecutiveCommand, isExecutiveCommandMessage } from './commandClassification';

describe('isExecutiveCommand', () => {
  it('命中已知动作命令（忽略大小写 / skill: 前缀）', () => {
    expect(isExecutiveCommand('dream')).toBe(true);
    expect(isExecutiveCommand('newSession')).toBe(true);
    expect(isExecutiveCommand('COMPACT')).toBe(true);
  });
  it('提示词 / 技能 / 不确定命令保留气泡', () => {
    expect(isExecutiveCommand('skill:tdd')).toBe(false);
    expect(isExecutiveCommand('deep-research')).toBe(false);
    expect(isExecutiveCommand('review')).toBe(false);
  });
});

describe('isExecutiveCommandMessage', () => {
  it('仅当整条消息==单个执行性命令时为真', () => {
    expect(isExecutiveCommandMessage('/dream')).toBe(true);
    expect(isExecutiveCommandMessage('/dream foo')).toBe(true);
    expect(isExecutiveCommandMessage('/skill:tdd')).toBe(false);
    expect(isExecutiveCommandMessage('hello /dream')).toBe(false);
    expect(isExecutiveCommandMessage('please run dream')).toBe(false);
  });
});
