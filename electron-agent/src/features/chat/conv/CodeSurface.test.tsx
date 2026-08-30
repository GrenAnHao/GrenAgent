import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeSurface } from './CodeSurface';

describe('CodeSurface', () => {
  it('renders children text in a code block', () => {
    render(<CodeSurface>hello-output</CodeSurface>);
    expect(screen.getByText('hello-output')).toBeTruthy();
  });
});
