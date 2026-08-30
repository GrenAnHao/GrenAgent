import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { ContextToolGroup } from './ContextToolGroup';
import type { ToolSegment } from '../chat/groupMessages';

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

const tool = (
  id: string,
  toolName: string,
  status: 'running' | 'done' | 'error' = 'done',
): ToolSegment => ({
  kind: 'tool',
  id,
  toolCallId: `c-${id}`,
  toolName,
  args: {},
  result: {},
  status,
});

describe('ContextToolGroup', { timeout: 30_000 }, () => {
  it('完成态：显示「已收集上下文」+ 分类计数', () => {
    const { container } = wrap(
      <ContextToolGroup tools={[tool('a', 'read'), tool('b', 'read_file'), tool('c', 'ls')]} />,
    );
    expect(container.textContent).toContain('已收集上下文');
    expect(container.textContent).toContain('2 个文件');
    expect(container.textContent).toContain('1 个目录');
  });

  it('运行中：显示 shimmer 进度（done/total）', () => {
    const { container } = wrap(
      <ContextToolGroup tools={[tool('a', 'read', 'done'), tool('b', 'list_dir', 'running')]} />,
    );
    expect(container.textContent).toContain('正在收集上下文');
    expect(container.textContent).toContain('1/2');
  });

  it('部分失败：显示计数 + 失败数（不整组标红）', () => {
    const { container } = wrap(
      <ContextToolGroup tools={[tool('a', 'read', 'done'), tool('b', 'ls', 'error')]} />,
    );
    expect(container.textContent).toContain('已收集上下文');
    expect(container.textContent).toContain('1 个失败');
  });

  it('全部失败：显示「收集上下文失败」', () => {
    const { container } = wrap(
      <ContextToolGroup tools={[tool('a', 'read', 'error'), tool('b', 'ls', 'error')]} />,
    );
    expect(container.textContent).toContain('收集上下文失败');
  });
});
