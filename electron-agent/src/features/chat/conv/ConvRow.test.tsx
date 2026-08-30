import { fireEvent, render, screen } from '@testing-library/react';
import { Boxes } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ConvRow } from './ConvRow';

describe('ConvRow', () => {
  it('shows name and args, toggles body on click when expandable', () => {
    const onToggle = vi.fn();
    render(
      <ConvRow
        status="done"
        icon={Boxes}
        name="read"
        args="agents.ts"
        meta="+52"
        open={false}
        onToggle={onToggle}
        body={<div>BODY</div>}
      />,
    );
    expect(screen.getByText('read')).toBeTruthy();
    expect(screen.getByText('agents.ts')).toBeTruthy();
    expect(screen.queryByText('BODY')).toBeNull();
    fireEvent.click(screen.getByText('read'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders body when open', () => {
    render(
      <ConvRow
        status="done"
        icon={Boxes}
        name="bash"
        open
        body={<div>OUT</div>}
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText('OUT')).toBeTruthy();
  });
});
