import { cleanup, render, screen } from '@testing-library/react';
import type { FC, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FullscreenLoading } from './FullscreenLoading';
import { PiBrandLogo } from './PiBrandLogo';

vi.mock('@lobehub/ui/brand', () => ({
  BrandLoading: ({ text: Text, size }: { text: FC<{ size?: number }>; size?: number }) => (
    <Text data-testid="brand-loading" size={size} />
  ),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
}));

afterEach(cleanup);

describe('PiBrandLogo', () => {
  it('renders an svg with a path and GrenAgent title', () => {
    const { container } = render(<PiBrandLogo />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('path')).toBeTruthy();
    expect(screen.getByText('GrenAgent')).toBeTruthy();
  });

  it('forwards className so BrandLoading animation can attach', () => {
    const { container } = render(<PiBrandLogo className="lobe-brand-loading" />);
    expect(container.querySelector('svg.lobe-brand-loading')).toBeTruthy();
  });
});

describe('FullscreenLoading', () => {
  it('renders brand loading and product name when visible', () => {
    render(<FullscreenLoading visible />);
    expect(screen.getByTestId('fullscreen-loading')).toBeTruthy();
    expect(screen.getByTestId('brand-loading')).toBeTruthy();
    expect(screen.getByText(/GREN/)).toBeTruthy();
  });

  it('stays mounted right after becoming invisible (awaits fade-out)', () => {
    const { rerender } = render(<FullscreenLoading visible />);
    rerender(<FullscreenLoading visible={false} />);
    expect(screen.getByTestId('fullscreen-loading')).toBeTruthy();
  });

  it('renders nothing if never visible', () => {
    render(<FullscreenLoading visible={false} />);
    expect(screen.queryByTestId('fullscreen-loading')).toBeNull();
  });
});
