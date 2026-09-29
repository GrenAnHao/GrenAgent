import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PiBrandLogo } from './PiBrandLogo';

afterEach(cleanup);

describe('PiBrandLogo', () => {
  it('renders an svg with a path and GrenAgent title', () => {
    const { container } = render(<PiBrandLogo />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('path')).toBeTruthy();
    expect(screen.getByText('GrenAgent')).toBeTruthy();
  });

  it('forwards className to the svg', () => {
    const { container } = render(<PiBrandLogo className="brand-mark" />);
    expect(container.querySelector('svg.brand-mark')).toBeTruthy();
  });

  it('uses the full viewBox by default', () => {
    const { container } = render(<PiBrandLogo />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 240 220');
  });

  it('crops to the glyph when tight', () => {
    const { container } = render(<PiBrandLogo size={23} tight />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('40 56 160 134');
    expect(svg?.getAttribute('height')).toBe('23');
    expect(svg?.hasAttribute('tight')).toBe(false);
  });
});
