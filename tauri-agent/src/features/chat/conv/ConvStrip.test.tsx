import { fireEvent, render, screen } from '@testing-library/react';
import { Bot } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ConvStrip } from './ConvStrip';

describe('ConvStrip', () => {
  it('renders title/num/chip/meta and toggles', () => {
    const onToggle = vi.fn();
    render(
      <ConvStrip
        status="done"
        icon={Bot}
        title="子代理"
        num="#1"
        chip="审查改动"
        meta="完成·6步"
        open={false}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText('子代理')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getByText('审查改动')).toBeTruthy();
    fireEvent.click(screen.getByText('子代理'));
    expect(onToggle).toHaveBeenCalled();
  });

  it('does not toggle when clicking actions', () => {
    const onToggle = vi.fn();
    render(
      <ConvStrip
        status="running"
        icon={Bot}
        title="子代理"
        onToggle={onToggle}
        actions={<button>停止</button>}
      />,
    );
    fireEvent.click(screen.getByText('停止'));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
