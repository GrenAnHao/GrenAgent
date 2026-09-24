import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { labelOverflows } from './labelOverflows';
import { OptionRow } from './OptionRow';

describe('OptionRow', () => {
  it('fires onClick and shows recommended badge', () => {
    const onClick = vi.fn();
    render(<OptionRow index={1} label="选项 A" selected recommended onClick={onClick} />);
    fireEvent.click(screen.getByText('选项 A'));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByText('推荐')).toBeTruthy();
  });

  it('labelOverflows is true only when scroll width exceeds client width', () => {
    expect(labelOverflows({ scrollWidth: 120, clientWidth: 40 })).toBe(true);
    expect(labelOverflows({ scrollWidth: 40, clientWidth: 40 })).toBe(false);
    expect(labelOverflows({ scrollWidth: 10, clientWidth: 40 })).toBe(false);
  });

  it('shows the full label in a tooltip only when the row overflows', () => {
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 40 });
    try {
      render(<OptionRow index="A" label="很长的选项文本" selected={false} onClick={() => {}} />);
      expect(screen.getByTestId('option-row-label').getAttribute('title')).toBe('很长的选项文本');
    } finally {
      if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll);
      if (client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', client);
    }
  });
});
