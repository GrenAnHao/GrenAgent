import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PiBrandLogo } from './PiBrandLogo';
import iconSource from '../../brand/source/grenagent-icon.svg?raw';

afterEach(cleanup);

describe('PiBrandLogo', () => {
  it('renders an svg with a path and an accessible brand name', () => {
    const { container } = render(<PiBrandLogo />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('path')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'GrenAgent' })).toBeTruthy();
  });

  it('forwards className to the svg', () => {
    const { container } = render(<PiBrandLogo className="brand-mark" />);
    expect(container.querySelector('svg.brand-mark')).toBeTruthy();
  });

  it('uses the full viewBox by default', () => {
    const { container } = render(<PiBrandLogo />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 352 352');
  });

  it('keeps the original square canvas for existing tight callers', () => {
    const { container } = render(<PiBrandLogo size={23} tight />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 352 352');
    expect(svg?.getAttribute('height')).toBe('23');
    expect(svg?.getAttribute('width')).toBe('23');
    expect(svg?.hasAttribute('tight')).toBe(false);
  });

  it('renders the approved G geometry and transform without depending on a font', () => {
    const { container } = render(<PiBrandLogo aria-label="GrenAgent" />);
    const original = new DOMParser().parseFromString(iconSource, 'image/svg+xml').querySelector('path')!;
    const path = container.querySelector('path')!;
    expect(path.getAttribute('d')).toBe(original.getAttribute('d'));
    expect(path.getAttribute('transform')).toBe('translate(16 19)');
    expect(container.querySelector('text, image')).toBeNull();
    expect(screen.getByRole('img', { name: 'GrenAgent' })).toBeTruthy();
  });
});
