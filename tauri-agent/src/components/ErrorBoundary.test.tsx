import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

afterEach(() => {
  cleanup();
});

function Boom(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>OK_CONTENT</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('OK_CONTENT')).toBeTruthy();
  });

  it('renders fallback when a child throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={<div>FALLBACK</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('FALLBACK')).toBeTruthy();
    spy.mockRestore();
  });
});
