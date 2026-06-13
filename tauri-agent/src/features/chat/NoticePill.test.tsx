import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NoticePill } from './NoticePill';

afterEach(() => {
  cleanup();
});

describe('NoticePill', () => {
  it('shows the knowledge-rag title', () => {
    render(<NoticePill customType="knowledge-rag" content="# KB" />);
    expect(screen.getByTestId('notice-pill').textContent).toContain('已注入知识库上下文');
  });

  it('shows the long-term-memory title', () => {
    render(<NoticePill customType="long-term-memory" content="# Mem" />);
    expect(screen.getByTestId('notice-pill').textContent).toContain('已注入长期记忆');
  });

  it('falls back to a generic title for unknown customType', () => {
    render(<NoticePill customType="other" content="x" />);
    expect(screen.getByTestId('notice-pill').textContent).toContain('已注入上下文');
  });
});
