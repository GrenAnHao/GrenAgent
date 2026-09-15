import { render, screen } from '@testing-library/react';
import type { CSSProperties, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@lobehub/ui', () => ({
  Markdown: ({
    children,
    className,
    style,
  }: {
    children?: ReactNode;
    className?: string;
    style?: CSSProperties;
  }) => (
    <div className={className} style={style} data-testid="lobe-md">
      {children}
    </div>
  ),
}));

import { LazyMarkdown } from './LazyMarkdown';

describe('LazyMarkdown prose classes', () => {
  it('adds pi-md by default', async () => {
    render(<LazyMarkdown>hello</LazyMarkdown>);
    const root = await screen.findByTestId('lobe-md');
    expect(root.className.split(/\s+/)).toContain('pi-md');
    expect(root.className.split(/\s+/)).not.toContain('pi-md-secondary');
  });

  it('adds pi-md-secondary for tone=secondary', async () => {
    render(
      <LazyMarkdown tone="secondary" enableMermaid={false}>
        hello
      </LazyMarkdown>,
    );
    const root = await screen.findByTestId('lobe-md');
    expect(root.className.split(/\s+/)).toEqual(expect.arrayContaining(['pi-md', 'pi-md-secondary']));
  });

  it('omits pi-md when prose is false', async () => {
    render(
      <LazyMarkdown prose={false} enableMermaid={false}>
        hello
      </LazyMarkdown>,
    );
    const root = await screen.findByTestId('lobe-md');
    expect(root.className.split(/\s+/)).not.toContain('pi-md');
    expect(root.className.split(/\s+/)).not.toContain('pi-md-secondary');
  });

  it('repoints lobe markdown vars at the axis', async () => {
    render(<LazyMarkdown enableMermaid={false}>hello</LazyMarkdown>);
    const root = await screen.findByTestId('lobe-md');
    expect(root.style.getPropertyValue('--lobe-markdown-font-size')).toBe('var(--pi-font-size, 14px)');
  });

  it('repoints at the secondary axis for tone=secondary', async () => {
    render(
      <LazyMarkdown tone="secondary" enableMermaid={false}>
        hello
      </LazyMarkdown>,
    );
    const root = await screen.findByTestId('lobe-md');
    expect(root.style.getPropertyValue('--lobe-markdown-font-size')).toBe(
      'var(--pi-font-size-secondary, 13px)',
    );
  });
});
