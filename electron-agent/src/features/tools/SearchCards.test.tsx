import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { GlobCard, GrepCard } from './SearchCards';

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

const textResult = (text: string) => ({ content: [{ type: 'text', text }] });

describe('GrepCard', { timeout: 30_000 }, () => {
  it('按文件分组展示命中行号与内容', () => {
    const result = textResult(
      ['Found 2 matches', '/proj/a.ts:', '  Line 3: const foo = 1', '', '/proj/b.ts:', '  Line 9: foo()'].join('\n'),
    );
    const { container } = wrap(<GrepCard result={result} />);
    expect(screen.getByTestId('card-grep')).toBeTruthy();
    expect(container.textContent).toContain('a.ts');
    expect(container.textContent).toContain('b.ts');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('const foo = 1');
    expect(container.textContent).toContain('foo()');
  });

  it('无命中显示占位', () => {
    const { container } = wrap(<GrepCard result={textResult('No files found')} />);
    expect(container.textContent).toContain('未找到匹配');
  });
});

describe('GlobCard', { timeout: 30_000 }, () => {
  it('列出匹配文件', () => {
    const { container } = wrap(<GlobCard result={textResult('/proj/a.ts\n/proj/sub/b.tsx')} />);
    expect(screen.getByTestId('card-glob')).toBeTruthy();
    expect(container.textContent).toContain('a.ts');
    expect(container.textContent).toContain('b.tsx');
  });
});
