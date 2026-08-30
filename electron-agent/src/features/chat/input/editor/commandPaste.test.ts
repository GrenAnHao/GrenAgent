import { describe, it, expect } from 'vitest';
import { parseCommandToken, resolveCommandTag } from './commandPaste';
import type { PiCommand } from '../commandTypes';

describe('parseCommandToken', () => {
  it('纯命令解析出命令名、rest 为空', () => {
    expect(parseCommandToken('/goal')).toEqual({ name: 'goal', rest: '' });
  });

  it('命令带参数时拆出 rest', () => {
    expect(parseCommandToken('/goal 帮我获取今日 github 热点')).toEqual({
      name: 'goal',
      rest: '帮我获取今日 github 热点',
    });
  });

  it('命令名与参数间的多余空白被归一化掉', () => {
    expect(parseCommandToken('/review    clear')).toEqual({ name: 'review', rest: 'clear' });
  });

  it('容忍前导空白', () => {
    expect(parseCommandToken('  /goal')).toEqual({ name: 'goal', rest: '' });
  });

  it('支持连字符与 skill: 前缀命令名', () => {
    expect(parseCommandToken('/deep-research')).toEqual({ name: 'deep-research', rest: '' });
    expect(parseCommandToken('/skill:foo')).toEqual({ name: 'skill:foo', rest: '' });
  });

  it('换行后的参数也算 rest', () => {
    expect(parseCommandToken('/goal\n第二行')).toEqual({ name: 'goal', rest: '第二行' });
  });

  it('绝对路径不被误判成命令', () => {
    expect(parseCommandToken('/usr/local/bin')).toBeNull();
    expect(parseCommandToken('/foo/bar')).toBeNull();
  });

  it('双斜杠 / 单独斜杠不是命令', () => {
    expect(parseCommandToken('//comment')).toBeNull();
    expect(parseCommandToken('/')).toBeNull();
  });

  it('不以斜杠开头的文本返回 null', () => {
    expect(parseCommandToken('goal')).toBeNull();
    expect(parseCommandToken('帮我 /goal')).toBeNull();
  });
});

const commands: PiCommand[] = [
  { name: 'goal', source: 'api', apiSource: 'extension' },
  { name: 'review', source: 'api', apiSource: 'builtin' },
  { name: 'skill:foo', source: 'api', apiSource: 'skill' },
  { name: 'compact', source: 'frontend' },
];

describe('resolveCommandTag', () => {
  it('已知 api 命令转成命令标签数据', () => {
    expect(resolveCommandTag(commands, '/goal')).toEqual({
      category: 'command',
      label: 'goal',
      value: 'goal',
      commandGroup: 'extension',
      trailingText: undefined,
    });
  });

  it('命令参数作为 trailingText 带上', () => {
    expect(resolveCommandTag(commands, '/goal 帮我获取热点')).toEqual({
      category: 'command',
      label: 'goal',
      value: 'goal',
      commandGroup: 'extension',
      trailingText: '帮我获取热点',
    });
  });

  it('skill 命令展示去前缀名、value 保留前缀', () => {
    expect(resolveCommandTag(commands, '/skill:foo')).toMatchObject({
      label: 'foo',
      value: 'skill:foo',
      commandGroup: 'skill',
    });
  });

  it('未知命令返回 null（放行纯文本）', () => {
    expect(resolveCommandTag(commands, '/unknown')).toBeNull();
  });

  it('前端即时命令不转标签', () => {
    expect(resolveCommandTag(commands, '/compact')).toBeNull();
  });

  it('非命令文本返回 null', () => {
    expect(resolveCommandTag(commands, '/usr/local/bin')).toBeNull();
    expect(resolveCommandTag(commands, '帮我写代码')).toBeNull();
  });
});
