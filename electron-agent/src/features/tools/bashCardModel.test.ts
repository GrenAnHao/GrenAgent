import { describe, expect, it } from 'vitest';
import {
  bashRowSummary,
  formatRunDuration,
  terminalCommandHead,
  terminalCommandLines,
  terminalCopyText,
  terminalOutputEmpty,
  terminalPromptLabel,
} from './bashCardModel';

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

describe('terminalCommandHead', () => {
  it('keeps a one-line command as is', () => {
    expect(terminalCommandHead('Get-Date')).toBe('Get-Date');
  });

  it('shows only the first line of a multi-line command and marks the rest', () => {
    expect(terminalCommandHead('cd extensions\nnpx vitest run\n')).toBe('cd extensions …');
  });

  it('does not mark a lone trailing newline', () => {
    expect(terminalCommandHead('git status\n')).toBe('git status');
  });
});

describe('terminalCopyText', () => {
  const command = 'cd extensions\nnpx vitest run\n';
  const output = ' RUN  v4\n Tests  3 passed\n';

  it('copies the raw command without the trailing newline', () => {
    expect(terminalCopyText('command', command, output)).toBe('cd extensions\nnpx vitest run');
  });

  it('copies the output as shown', () => {
    expect(terminalCopyText('output', command, output)).toBe(output);
    expect(terminalCopyText('output', command, undefined)).toBe('');
  });

  it('copies prompt lines followed by the output', () => {
    expect(terminalCopyText('all', command, output)).toBe(
      '$ cd extensions\n$ npx vitest run\n RUN  v4\n Tests  3 passed\n',
    );
  });

  it('copies only the prompt lines when there is no output yet', () => {
    expect(terminalCopyText('all', 'Get-Date', '')).toBe('$ Get-Date');
  });
});

describe('terminalOutputEmpty', () => {
  it('treats missing and whitespace-only output as empty', () => {
    expect(terminalOutputEmpty(undefined)).toBe(true);
    expect(terminalOutputEmpty('  \n')).toBe(true);
    expect(terminalOutputEmpty('ok')).toBe(false);
  });
});

describe('formatRunDuration', () => {
  it('keeps sub-minute runs in seconds', () => {
    expect(formatRunDuration(0)).toBe('0s');
    expect(formatRunDuration(9_600)).toBe('10s');
    expect(formatRunDuration(59_400)).toBe('59s');
  });

  it('spells minutes with the remaining seconds', () => {
    expect(formatRunDuration(80_000)).toBe('1m20s');
    expect(formatRunDuration(120_000)).toBe('2m');
    expect(formatRunDuration(3_540_000)).toBe('59m');
  });

  it('drops to hours + minutes past an hour', () => {
    expect(formatRunDuration(3_600_000)).toBe('1h');
    expect(formatRunDuration(3_900_000)).toBe('1h5m');
  });
});
