import { describe, expect, it } from 'vitest';
import { bashRowSummary, terminalCommandLines, terminalOutputEmpty, terminalPromptLabel } from './bashCardModel';

describe('bashRowSummary', () => {
  it('prefers the UI description over the raw command', () => {
    expect(
      bashRowSummary({
        command: 'Get-Date -Format yyyy-MM-dd',
        description: 'Show current local date',
      }),
    ).toBe('Show current local date');
  });

  it('falls back to 执行命令 when description is missing, never the raw command', () => {
    expect(bashRowSummary({ command: 'echo hi' })).toBe('执行命令');
  });

  it('treats blank description as missing', () => {
    expect(bashRowSummary({ command: 'pwd', description: '   ' })).toBe('执行命令');
  });
});

describe('terminalPromptLabel', () => {
  it('uses the last path segment', () => {
    expect(terminalPromptLabel('/ws/demo')).toBe('demo');
    expect(terminalPromptLabel('D:\\repo\\测试')).toBe('测试');
  });

  it('uses $ when the last segment is a work-folder UUID', () => {
    expect(terminalPromptLabel('C:\\Users\\rxstudio\\.pi\\agent\\works\\544ff658-8429-4084-9a24-cd49ffbe7419')).toBe('$');
  });
});

describe('terminalCommandLines', () => {
  it('splits a multi-line command and drops a trailing newline', () => {
    expect(terminalCommandLines('a\nb\n')).toEqual(['a', 'b']);
  });
});

describe('terminalOutputEmpty', () => {
  it('treats missing and whitespace-only output as empty', () => {
    expect(terminalOutputEmpty(undefined)).toBe(true);
    expect(terminalOutputEmpty('  \n')).toBe(true);
    expect(terminalOutputEmpty('ok')).toBe(false);
  });
});
