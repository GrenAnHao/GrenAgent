import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./LazyMarkdown', () => ({
  LazyMarkdown: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

import { ReasoningInline } from './ReasoningInline';

afterEach(() => {
  cleanup();
});

describe('ReasoningInline', () => {
  it('空内容不渲染', () => {
    const { container } = render(<ReasoningInline content="   " streaming={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('结束后默认收起为摘要行，点开才展示完整推理', () => {
    render(<ReasoningInline content="深思熟虑的推理内容" streaming={false} />);
    const root = screen.getByTestId('reasoning-inline');
    expect(root.textContent).toContain('已深度思考');
    // 收起态不渲染正文
    expect(screen.queryByTestId('md')).toBeNull();

    // 点「展开全部」
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('md').textContent).toContain('深思熟虑的推理内容');
  });

  it('结束后展示思考耗时', () => {
    render(<ReasoningInline content="推理内容" streaming={false} durationMs={3200} />);
    expect(screen.getByTestId('reasoning-inline').textContent).toContain('已深度思考 · 3.2 秒');
  });

  it('流式时显示「正在深度思考...」头部并展示内容，无展开按钮', () => {
    render(<ReasoningInline content="部分推理" streaming />);
    const root = screen.getByTestId('reasoning-inline');
    expect(root.textContent).toContain('正在深度思考...');
    expect(screen.getByTestId('md').textContent).toContain('部分推理');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
