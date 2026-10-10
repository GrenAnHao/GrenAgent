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

  it('puts the running indicator and the row actions in one slot', () => {
    const { container } = render(<SessionItem {...base} running />);
    const row = container.querySelector('.pi-session-row') as HTMLElement;
    const slot = screen.getByTestId('session-running').parentElement as HTMLElement;
    expect(slot.parentElement).toBe(row);
    expect(slot.dataset.running).toBe('true');
    // 悬停只靠 CSS 在这一格里换转圈和按钮，所以按钮不等悬停就已经挂在同一格里
    const buttons = within(slot).queryAllByRole('button', { hidden: true });
    expect(buttons.length).toBeGreaterThan(0);
    expect(within(row).queryAllByRole('button', { hidden: true })).toHaveLength(buttons.length);
  });

  it('keeps the row actions mounted when the run state flips', () => {
    const { container, rerender } = render(<SessionItem {...base} />);
    const row = container.querySelector('.pi-session-row') as HTMLElement;
    fireEvent.mouseEnter(row);
    const [button] = within(row).queryAllByRole('button', { hidden: true });
    expect(button).toBeTruthy();
    rerender(<SessionItem {...base} running />);
    expect(within(row).queryAllByRole('button', { hidden: true })[0]).toBe(button);
    rerender(<SessionItem {...base} running={false} />);
    expect(within(row).queryAllByRole('button', { hidden: true })[0]).toBe(button);
  });

  it('opens the same menu on right-click and asks before delete', () => {
    const onDelete = vi.fn();
    const { container } = render(<SessionItem {...base} onDelete={onDelete} />);
    const row = container.querySelector('.pi-session-row') as HTMLElement;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('确定删除「修复登录 bug」吗？此操作不可恢复。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('session-delete-confirm'));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('does not delete when the confirm dialog is canceled', () => {
    const onDelete = vi.fn();
    const { container } = render(<SessionItem {...base} onDelete={onDelete} />);
    fireEvent.contextMenu(container.querySelector('.pi-session-row') as HTMLElement);
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }));
    expect(screen.getByText('确定删除「修复登录 bug」吗？此操作不可恢复。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('session-delete-cancel'));
    expect(onDelete).not.toHaveBeenCalled();
  });
});
