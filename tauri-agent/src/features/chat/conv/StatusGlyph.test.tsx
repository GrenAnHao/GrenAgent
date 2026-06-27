import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusGlyph } from './StatusGlyph';

describe('StatusGlyph', () => {
  it('renders a spinner for running', () => {
    const { container } = render(<StatusGlyph status="running" />);
    expect(container.querySelector('[data-status="running"]')).toBeTruthy();
  });

  it('renders check for done and x for error', () => {
    const { container: a } = render(<StatusGlyph status="done" />);
    const { container: b } = render(<StatusGlyph status="error" />);
    expect(a.querySelector('[data-status="done"]')).toBeTruthy();
    expect(b.querySelector('[data-status="error"]')).toBeTruthy();
  });
});
