import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { ToolExecution } from './ToolExecution';

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

describe('ToolExecution web_search inspector', { timeout: 30_000 }, () => {
  it('显示「搜索：查询词」与结果数（N）', () => {
    wrap(
      <ToolExecution
        toolName="web_search"
        args={{ query: 'lobehub ChatItem' }}
        result={{ details: { query: 'lobehub ChatItem', count: 12, results: [] }, content: [] }}
        status="done"
      />,
    );
    // 查询词单独成高亮节点（而非 "query: ..." 的参数摘要）。
    expect(screen.getByText('lobehub ChatItem')).toBeTruthy();
    expect(document.body.textContent).toContain('搜索：');
    expect(document.body.textContent).toContain('（12）');
  });
});

describe('ToolExecution skill invocation inspector', { timeout: 30_000 }, () => {
  it('read 某个 SKILL.md 时显示「使用技能 <name>」', () => {
    wrap(
      <ToolExecution
        toolName="read"
        args={{ path: '/home/u/.agents/skills/brave-search/SKILL.md' }}
        result={{ content: [{ type: 'text', text: '---\nname: brave-search\n---\n# Brave' }] }}
        status="done"
      />,
    );
    expect(document.body.textContent).toContain('使用技能');
    expect(screen.getByText('brave-search')).toBeTruthy();
  });
});

describe('ToolExecution bash row', { timeout: 30_000 }, () => {
  it('shows command in the row and output in the body (no redundant $ prompt)', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'echo hi' }}
        result={{ content: [{ type: 'text', text: 'hi there' }] }}
        status="running"
      />,
    );
    // 命令进行内 args、输出进展开 body；工具名 bash 可见。去冗余后不再重复 $ 提示符。
    expect(screen.getByText('echo hi')).toBeTruthy();
    expect(document.body.textContent).toContain('hi there');
    expect(document.body.textContent).toContain('bash');
  });
});

describe('ToolExecution edit inspector', { timeout: 30_000 }, () => {
  it('supports the edits array schema and shows only the filename', () => {
    wrap(
      <ToolExecution
        toolName="edit"
        args={{ path: 'D:/workspace/GeminiProvider.ts', edits: [{ oldText: 'old', newText: 'new' }] }}
        result={{ details: { diff: ' 1 old\n-2 old\n+2 new\n 3 next' }, content: [] }}
        status="done"
      />,
    );
    fireEvent.click(screen.getByText('edit'));
    expect(screen.getAllByText('GeminiProvider.ts')).toHaveLength(2);
    expect(screen.queryByText(/D:\/workspace/)).toBeNull();
    expect(screen.getByTestId('edit-preview-language').textContent).toContain('new');
  });

  it('shows a no-change edit error even when the result is not marked as an error', () => {
    wrap(
      <ToolExecution
        toolName="edit"
        args={{
          path: 'D:/workspace/GeminiProvider.ts',
          edits: [{ oldText: 'same', newText: 'same' }],
        }}
        result={{
          content: [
            {
              type: 'text',
              text: 'No changes made to D:/workspace/GeminiProvider.ts. The replacement produced identical content.',
            },
          ],
        }}
        status="done"
      />,
    );
    fireEvent.click(screen.getByText('edit'));
    expect(document.body.textContent).toContain('No changes made');
    expect(document.body.textContent).toContain('replacement produced identical content');
    expect(screen.queryByText('+ same')).toBeNull();
  });
});
