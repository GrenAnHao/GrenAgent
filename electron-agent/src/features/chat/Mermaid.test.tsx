// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
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

vi.mock('@lobehub/ui', () => ({
  ActionIcon: ({ title }: { title?: string }) => <button title={title} />,
  Icon: () => null,
  Mermaid: ({ children, bodyRender, copyable, fullFeatured, theme, styles }: {
    children: string;
    bodyRender?: (props: { content: string; originalNode: React.ReactNode }) => React.ReactNode;
    copyable?: boolean;
    fullFeatured?: boolean;
    theme?: string;
    styles?: { content?: { background?: string } };
  }) => (
    <div
      data-testid="lobehub-mermaid"
      data-custom-body={Boolean(bodyRender)}
      data-copyable={String(copyable)}
      data-full-featured={String(fullFeatured)}
      data-theme={theme}
      data-content-background={styles?.content?.background}
    >
      {bodyRender ? bodyRender({ content: children, originalNode: null }) : children}
    </div>
  ),
}));

import { Mermaid } from './Mermaid';

const wrap = (ui: React.ReactElement) => render(ui);

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

  it('keeps the full-featured LobeHub body for flowcharts with subgraphs', async () => {
    wrap(<Mermaid code={'flowchart TB\n  subgraph Service\n    A[API]\n  end'} />);

    const component = await screen.findByTestId('lobehub-mermaid');
    expect(component).toHaveAttribute('data-full-featured', 'true');
    expect(component).toHaveAttribute('data-custom-body', 'false');
  });

  it('isolates SVG text from the global font-size adjustment', async () => {
    wrap(<Mermaid code={'flowchart TD\n  A[Long label]'} />);

    await waitFor(() => expect(screen.getAllByTestId('lobehub-mermaid').length).toBeGreaterThan(0));
    const component = screen.getAllByTestId('lobehub-mermaid').at(-1)!;
    const diagramFrame = component.parentElement?.parentElement;
    expect(diagramFrame).toBeTruthy();
    const cssRules = [...document.styleSheets].flatMap((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText);
      } catch {
        return [];
      }
    });
    expect(cssRules.some((rule) => /font-size-adjust:\s*none/i.test(rule))).toBe(true);
  });

  it('keeps the project error card when Mermaid parsing fails', async () => {
    mermaidMock.parse.mockRejectedValueOnce(new Error('parse failed'));
    wrap(<Mermaid code="invalid diagram" />);

    expect(await screen.findByText('Mermaid 图表渲染失败')).toBeInTheDocument();
    expect(screen.getByText('parse failed')).toBeInTheDocument();
  });

  // 虚拟列表把离屏条目卸载后再挂回来：首帧必须就是终态，不能退回 Loading 占位（高度会先缩再涨）。
  it('renders a previously prepared diagram on the first frame after remount', async () => {
    const code = 'flowchart LR\n  Remount1 --> Remount2';
    const first = wrap(<Mermaid code={code} />);
    await screen.findByTestId('lobehub-mermaid');
    first.unmount();
    mermaidMock.parse.mockClear();

    wrap(<Mermaid code={code} />);

    expect(screen.getByTestId('lobehub-mermaid')).toBeInTheDocument();
    expect(screen.queryByText('Loading diagram…')).not.toBeInTheDocument();
    expect(mermaidMock.parse).not.toHaveBeenCalled();
  });

  it('renders a previously failed diagram as the error card on the first frame after remount', async () => {
    mermaidMock.parse.mockRejectedValue(new Error('parse failed'));
    const code = 'remount invalid diagram';
    const first = wrap(<Mermaid code={code} />);
    expect(await screen.findByText('Mermaid 图表渲染失败')).toBeInTheDocument();
    first.unmount();

    wrap(<Mermaid code={code} />);

    expect(screen.getByText('Mermaid 图表渲染失败')).toBeInTheDocument();
    expect(screen.queryByText('Loading diagram…')).not.toBeInTheDocument();
  });
});
