import { ThemeProvider } from '@lobehub/ui';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mermaidMock } = vi.hoisted(() => ({
  mermaidMock: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 10 10"><path /></svg>' })),
  },
}));

vi.mock('mermaid', () => ({ default: mermaidMock }));

vi.mock('@lobehub/ui', async () => {
  const actual = await vi.importActual<typeof import('@lobehub/ui')>('@lobehub/ui');
  return {
    ...actual,
    Mermaid: ({ children, copyable, theme, styles }: {
      children: string;
      copyable?: boolean;
      theme?: string;
      styles?: { content?: { background?: string } };
    }) => (
      <div
        data-testid="lobehub-mermaid"
        data-copyable={String(copyable)}
        data-theme={theme}
        data-content-background={styles?.content?.background}
      >
        {children}
      </div>
    ),
  };
});

import { Mermaid } from './Mermaid';

const wrap = (ui: React.ReactElement) => render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

describe('Mermaid adapter', () => {
  beforeEach(() => {
    mermaidMock.parse.mockReset();
    mermaidMock.parse.mockResolvedValue(true);
    mermaidMock.initialize.mockClear();
  });

  it('passes sanitized source to LobeHub Mermaid', async () => {
    wrap(<Mermaid code={'flowchart TD\n  A -->|x{1}| B'} />);

    await waitFor(() => expect(screen.getByTestId('lobehub-mermaid')).toBeInTheDocument());
    expect(screen.getByTestId('lobehub-mermaid')).toHaveTextContent('"x{1}"');
    expect(screen.getByTestId('lobehub-mermaid')).toHaveAttribute('data-copyable', 'false');
    expect(screen.getByTestId('lobehub-mermaid')).toHaveAttribute('data-theme', 'lobe-theme');
    expect(screen.getByTestId('lobehub-mermaid')).toHaveAttribute('data-content-background', 'var(--ant-color-bg-container)');
  });

  it('keeps the project error card when Mermaid parsing fails', async () => {
    mermaidMock.parse.mockRejectedValueOnce(new Error('parse failed'));
    wrap(<Mermaid code="invalid diagram" />);

    expect(await screen.findByText('Mermaid 图表渲染失败')).toBeInTheDocument();
    expect(screen.getByText('parse failed')).toBeInTheDocument();
  });
});
