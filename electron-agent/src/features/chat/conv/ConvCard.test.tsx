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
});
