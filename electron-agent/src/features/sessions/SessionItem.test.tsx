import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionItem } from './SessionItem';

const base = {
  title: '修复登录 bug',
  active: false,
  running: false,
  pinned: false,
  onClick: vi.fn(),
  onPinToggle: vi.fn(),
  onRequestRename: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
};

describe('SessionItem', () => {
  it('renders title and fires onClick', () => {
    const onClick = vi.fn();
    render(<SessionItem {...base} onClick={onClick} />);
    fireEvent.click(screen.getByText('修复登录 bug'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows running indicator only when running', () => {
    const { rerender } = render(<SessionItem {...base} running={false} />);
    expect(screen.queryByTestId('session-running')).toBeNull();
    rerender(<SessionItem {...base} running />);
    expect(screen.getByTestId('session-running')).toBeTruthy();
  });

  it('enters inline edit and submits new name on Enter', () => {
    const onRename = vi.fn();
    render(<SessionItem {...base} onRename={onRename} editing />);
    const input = screen.getByTestId('session-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('新标题');
  });

  it('mounts row actions only after first hover', () => {
    const { container } = render(<SessionItem {...base} />);
    const row = container.querySelector('.pi-session-row') as HTMLElement;
    expect(within(row).queryAllByRole('button', { hidden: true })).toHaveLength(0);
    fireEvent.mouseEnter(row);
    expect(within(row).queryAllByRole('button', { hidden: true }).length).toBeGreaterThan(0);
  });

  it('opens the same menu on right-click and fires delete', () => {
    const onDelete = vi.fn();
    const { container } = render(<SessionItem {...base} onDelete={onDelete} />);
    const row = container.querySelector('.pi-session-row') as HTMLElement;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText('删除'));
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
