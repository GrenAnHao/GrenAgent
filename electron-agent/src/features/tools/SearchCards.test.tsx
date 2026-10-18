import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { codeCardContentClass } from './CodeCard';
import { CodeSearchCard, GlobCard, GrepCard } from './SearchCards';

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

const textResult = (text: string) => ({ content: [{ type: 'text', text }] });

describe('GrepCard', { timeout: 30_000 }, () => {
  it('按文件分组展示命中行号与内容', async () => {
    const result = textResult(
      ['Found 2 matches', '/proj/a.ts:', '  Line 3: const foo = 1', '', '/proj/b.ts:', '  Line 9: foo()'].join('\n'),
    );
    const { container } = wrap(<GrepCard result={result} />);
    expect(screen.getByTestId('card-grep')).toBeTruthy();
    expect(await screen.findByText('a.ts')).toBeTruthy();
    expect(screen.getByText('b.ts')).toBeTruthy();
    await waitFor(() => {
      expect(container.textContent).toContain('3');
      expect(container.textContent).toContain('const foo = 1');
      expect(container.textContent).toContain('foo()');
    });
    expect(screen.getAllByTestId('code-card-header').every((header) => header.querySelector('button') == null)).toBe(true);
    expect(container.querySelectorAll(`.${codeCardContentClass}`)).toHaveLength(2);
  });

  it('无命中显示占位', () => {
    const { container } = wrap(<GrepCard result={textResult('No files found')} />);
    expect(container.textContent).toContain('未找到匹配');
  });
});

describe('CodeSearchCard', { timeout: 30_000 }, () => {
  it('按文件展示代码命中', async () => {
    const { container } = wrap(
      <CodeSearchCard
        result={{
          content: [{ type: 'text', text: 'src/a.ts\n  12: export function PddWorkbench' }],
          details: {
            matches: [{ file: 'src/a.ts', line: 12, text: 'export function PddWorkbench' }],
            total: 1,
            files: 1,
            capped: false,
          },
        }}
      />,
    );
    expect(screen.getByTestId('card-code-search')).toBeTruthy();
    expect(await screen.findByText('a.ts')).toBeTruthy();
    await waitFor(() => {
      expect(container.textContent).toContain('export function PddWorkbench');
    });
    expect(screen.getByTestId('code-card-header').querySelector('button')).toBeNull();
    expect(container.querySelector(`.${codeCardContentClass}`)).toBeTruthy();
  });

  it('无命中显示未找到匹配', () => {
    const { container } = wrap(
      <CodeSearchCard
        result={{
          content: [{ type: 'text', text: 'No matches.' }],
          details: { matches: [], total: 0, files: 0, capped: false },
        }}
      />,
    );
    expect(container.textContent).toContain('未找到匹配');
    expect(container.textContent).not.toContain('未找到结果');
  });

  it('工具失败时展示返回的原因', () => {
    const { container } = wrap(
      <CodeSearchCard
        result={{
          content: [{ type: 'text', text: 'search: no valid patterns.' }],
          details: { matches: [], total: 0, files: 0, capped: false },
        }}
      />,
    );
    expect(container.textContent).toContain('search: no valid patterns.');
    expect(container.textContent).not.toContain('未找到结果');
  });

  it('参数校验失败时展示 pi 的报错，不显示未找到匹配', () => {
    const msg =
      'Validation failed for tool "search":\n  - patterns: must have required properties patterns\n\nReceived arguments:\n{}';
    const { container } = wrap(
      <CodeSearchCard result={{ content: [{ type: 'text', text: msg }] }} isError />,
    );
    expect(container.textContent).toContain('Validation failed');
    expect(container.textContent).toContain('patterns');
    expect(container.textContent).not.toContain('未找到匹配');
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
