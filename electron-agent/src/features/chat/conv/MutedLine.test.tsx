import { fireEvent, render, screen } from '@testing-library/react';
import { Brain } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { MutedLine } from './MutedLine';

describe('MutedLine', () => {
  it('renders text with count and toggles', () => {
    const onToggle = vi.fn();
    render(<MutedLine icon={Brain} text="已注入长期记忆" count={3} open={false} onToggle={onToggle} />);
    expect(screen.getByText('已注入长期记忆')).toBeTruthy();
    expect(screen.getByText(/3 条/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalled();
  });
});
