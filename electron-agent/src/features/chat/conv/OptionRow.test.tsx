import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OptionRow } from './OptionRow';

describe('OptionRow', () => {
  it('fires onClick and shows recommended badge', () => {
    const onClick = vi.fn();
    render(<OptionRow index={1} label="选项 A" selected recommended onClick={onClick} />);
    fireEvent.click(screen.getByText('选项 A'));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByText('推荐')).toBeTruthy();
  });
});
