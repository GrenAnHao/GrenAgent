import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NoticePill } from './NoticePill';

afterEach(() => {
  cleanup();
});

describe('NoticePill', () => {
  it('does not retain a dedicated title for retired self-evolve notices', () => {
    render(<NoticePill customType="self-evolve-dream-start" content="- running" />);
    expect(screen.getByTestId('notice-pill').textContent).toContain('已注入上下文');
  });

  it('falls back to a generic title for unknown customType', () => {
    render(<NoticePill customType="other" content="x" />);
    expect(screen.getByTestId('notice-pill').textContent).toContain('已注入上下文');
  });

  it('折叠头显示条目数（剥离重复大标题后数列表项）', () => {
    const content = '# Injected context\n\n- a\n- b\n- c';
    render(<NoticePill customType="other" content={content} />);
    const el = screen.getByTestId('notice-pill');
    expect(el.textContent).toContain('已注入上下文');
    expect(el.textContent).toContain('3 条');
  });
});
