import { describe, expect, it } from 'vitest';
import type { PiCommand } from '../commandTypes';
import { filterPromptCommands, paramHint } from './slashPromptOptions';

const templates = [
  { name: 'refactor', description: '', body: '', params: [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }], path: '' },
  { name: 'review', description: '', body: '', params: [], path: '' },
];
const commands: PiCommand[] = [
  { name: 'refactor', source: 'api', apiSource: 'prompt' },
  { name: 'review', source: 'api', apiSource: 'prompt' },
  { name: 'goal', source: 'api', apiSource: 'extension' },
];

describe('filterPromptCommands', () => {
  it('在文首时全部保留', () => {
    expect(filterPromptCommands(commands, templates, true)).toEqual(commands);
  });

  it('不在文首时去掉带参数的模板', () => {
    expect(filterPromptCommands(commands, templates, false).map((c) => c.name)).toEqual(['review', 'goal']);
  });
});

describe('paramHint', () => {
  it('带参数的模板生成 {a} {b}，其他返回 undefined', () => {
    expect(paramHint(commands[0], templates)).toBe('{file} {style}');
    expect(paramHint(commands[1], templates)).toBeUndefined();
  });

  it('同名但不是提示词模板的命令不出提示', () => {
    const extension: PiCommand = { name: 'refactor', source: 'api', apiSource: 'extension' };
    expect(paramHint(extension, templates)).toBeUndefined();
  });
});
