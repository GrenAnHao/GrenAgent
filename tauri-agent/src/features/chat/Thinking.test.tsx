import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { m } from 'motion/react';
import { Thinking } from './Thinking';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
});

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(
    <ConfigProvider motion={m}>
      <ThemeProvider themeMode="dark">{ui}</ThemeProvider>
    </ConfigProvider>,
  );

describe('Thinking', { timeout: 30_000 }, () => {
  it('does not render an expandable header for blank thinking content', () => {
    wrap(<Thinking content={' \n\t '} thinking={false} duration={400} />);

    expect(screen.queryByText(/已深度思考/)).toBeNull();
  });

  it('reopens non-empty thinking content after collapsing', async () => {
    wrap(<Thinking content="工具链推理内容" thinking duration={400} />);

    const title = screen.getByText(/深度思考中/);
    expect(screen.getByText('工具链推理内容')).toBeTruthy();

    fireEvent.click(title);
    fireEvent.click(title);

    await waitFor(() => {
      expect(screen.getByText('工具链推理内容')).toBeTruthy();
    });
  });
});
