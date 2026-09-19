import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConvCard } from './ConvCard';

describe('ConvCard', () => {
  it('renders label, body and footer', () => {
    render(
      <ConvCard label="PLAN" footer={<button>开始执行</button>}>
        <div>BODY</div>
      </ConvCard>,
    );
    expect(screen.getByText('PLAN')).toBeTruthy();
    expect(screen.getByText('BODY')).toBeTruthy();
    expect(screen.getByText('开始执行')).toBeTruthy();
  });

  it('elevated keeps the same label and body', () => {
    render(
      <ConvCard elevated label="请选择">
        <div>BODY</div>
      </ConvCard>,
    );
    expect(screen.getByText('请选择')).toBeTruthy();
    expect(screen.getByText('BODY')).toBeTruthy();
  });

  it('elevated uses the opaque raised surface instead of the stream fill', () => {
    const { container, rerender } = render(
      <ConvCard label="请选择">
        <div>BODY</div>
      </ConvCard>,
    );
    expect((container.firstElementChild as HTMLElement).getAttribute('data-surface')).toBe('plain');
    rerender(
      <ConvCard elevated label="请选择">
        <div>BODY</div>
      </ConvCard>,
    );
    expect((container.firstElementChild as HTMLElement).getAttribute('data-surface')).toBe('elevated');
  });
});
