import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeSurface } from './CodeSurface';

describe('CodeSurface', () => {
  it('renders children text in a code block', () => {
    render(<CodeSurface>hello-output</CodeSurface>);
    expect(screen.getByText('hello-output')).toBeTruthy();
  });

  it('terminal variant keeps raw lines for horizontal scrolling', () => {
    render(<CodeSurface terminal>col1    col2    col3</CodeSurface>);
    const el = screen.getByTestId('code-surface');
    expect(el.getAttribute('data-variant')).toBe('terminal');
    expect(el.textContent).toBe('col1    col2    col3');
  });
});
