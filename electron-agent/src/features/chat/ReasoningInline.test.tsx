import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./LazyMarkdown', () => ({
  LazyMarkdown: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

import { formatThinkingDuration, latestThinkingLine, nextLinearOffset, ReasoningInline } from './ReasoningInline';

afterEach(() => {
  cleanup();
});

describe('formatThinkingDuration', () => {
  it('按整秒显示，不保留一位小数', () => {
    expect(formatThinkingDuration(1100)).toBe('1 秒');
    expect(formatThinkingDuration(7400)).toBe('7 秒');
    expect(formatThinkingDuration(3200)).toBe('3 秒');
  });
});

describe('nextLinearOffset', () => {
  it('相同时间走相同距离，不超过目标', () => {
    const first = nextLinearOffset(0, 2000, 16);
    const second = nextLinearOffset(first, 2000, 16);
    expect(second - first).toBeCloseTo(first - 0, 5);
    expect(second).toBeLessThan(2000);
    expect(nextLinearOffset(1990, 2000, 48)).toBe(2000);
    expect(nextLinearOffset(50, 10, 16)).toBe(10);
  });
});

describe('latestThinkingLine', () => {
  it('取最后一行非空文本', () => {
    expect(latestThinkingLine('第一行\n\n  第二行  \n')).toBe('第二行');
  });
});

describe('ReasoningInline', () => {
  it('空内容不渲染', () => {
    const { container } = render(<ReasoningInline content="   " streaming={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('结束后默认收起为摘要行，不展示思考正文，点开才展示完整推理', () => {
    render(<ReasoningInline content="深思熟虑的推理内容" streaming={false} />);
    const root = screen.getByTestId('reasoning-inline');
    expect(root.textContent).toContain('已深度思考');
    expect(screen.queryByTestId('md')).toBeNull();
    expect(screen.queryByTestId('reasoning-stream-text')).toBeNull();

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('md').textContent).toContain('深思熟虑的推理内容');
  });

  it('结束后展示思考耗时', () => {
    render(<ReasoningInline content="推理内容" streaming={false} durationMs={3200} />);
    expect(screen.getByTestId('reasoning-inline').textContent).toContain('已深度思考 · 3 秒');
  });

  it('结束后展开仍使用可滚动的限高正文容器', () => {
    render(<ReasoningInline content={'长推理\n'.repeat(80)} streaming={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('reasoning-body')).toContainElement(screen.getByTestId('md'));
  });

  it('流式时单行显示最后一行，并带正在深度思考与耗时', () => {
    render(
      <ReasoningInline
        content={'前面的推断\ndropping the sort field'}
        streaming
        startedAt={Date.now() - 3200}
      />,
    );
    const root = screen.getByTestId('reasoning-inline');
    expect(root.textContent).toMatch(/正在深度思考 · \d+ 秒/);
    const line = screen.getByTestId('reasoning-stream-text');
    expect(line.textContent).toBe('dropping the sort field');
    expect(line.textContent).not.toContain('前面的推断');
    expect(screen.queryByTestId('reasoning-stream-body')).toBeNull();
  });

  it('流式点开后展示全文，收起单行', () => {
    render(<ReasoningInline content={'第一行\n第二行'} streaming />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('reasoning-stream-text')).toBeNull();
    expect(screen.getByTestId('reasoning-stream-body').textContent).toContain('第一行');
    expect(screen.getByTestId('reasoning-stream-body').textContent).toContain('第二行');
  });

  it('思考结束后单行消失，文案变成已深度思考', () => {
    const view = render(<ReasoningInline content="还在想" streaming startedAt={Date.now() - 1000} />);
    expect(screen.getByTestId('reasoning-stream-text')).toBeTruthy();
    view.rerender(<ReasoningInline content="还在想" streaming={false} durationMs={1000} />);
    expect(screen.queryByTestId('reasoning-stream-text')).toBeNull();
    expect(screen.getByTestId('reasoning-inline').textContent).toContain('已深度思考');
    expect(screen.queryByTestId('md')).toBeNull();
  });
});
