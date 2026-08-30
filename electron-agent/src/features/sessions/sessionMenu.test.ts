import { describe, expect, it, vi } from 'vitest';
import { buildSessionMenuItems } from './useSessionMenu';
import { buildProjectMenuItems } from './useProjectMenu';

interface ClickItem {
  key?: string;
  label?: unknown;
  danger?: boolean;
  onClick?: () => void;
}

describe('buildSessionMenuItems', () => {
  it('shows pin when not pinned, unpin label when pinned', () => {
    const a = buildSessionMenuItems({
      pinned: false,
      onPinToggle: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
    }) as ClickItem[];
    expect(a.find((i) => i.key === 'pin')!.label).toBe('置顶');

    const b = buildSessionMenuItems({
      pinned: true,
      onPinToggle: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
    }) as ClickItem[];
    expect(b.find((i) => i.key === 'pin')!.label).toBe('取消置顶');
  });

  it('delete item is danger and fires callback', () => {
    const onDelete = vi.fn();
    const items = buildSessionMenuItems({
      pinned: false,
      onPinToggle: vi.fn(),
      onRename: vi.fn(),
      onDelete,
    }) as ClickItem[];
    const del = items.find((i) => i.key === 'delete')!;
    expect(del.danger).toBe(true);
    del.onClick!();
    expect(onDelete).toHaveBeenCalledOnce();
  });
});

describe('buildProjectMenuItems', () => {
  it('has pin/reveal/rename/hide/remove and remove is danger', () => {
    const items = buildProjectMenuItems({
      pinned: false,
      onPinToggle: vi.fn(),
      onReveal: vi.fn(),
      onRename: vi.fn(),
      onHide: vi.fn(),
      onRemove: vi.fn(),
    }) as ClickItem[];
    const keys = items.map((i) => i.key).filter(Boolean);
    expect(keys).toEqual(['pin', 'reveal', 'rename', 'hide', 'remove']);
    expect(items.find((i) => i.key === 'remove')!.danger).toBe(true);
  });

  it('reveal fires its callback', () => {
    const onReveal = vi.fn();
    const items = buildProjectMenuItems({
      pinned: true,
      onPinToggle: vi.fn(),
      onReveal,
      onRename: vi.fn(),
      onHide: vi.fn(),
      onRemove: vi.fn(),
    }) as ClickItem[];
    items.find((i) => i.key === 'reveal')!.onClick!();
    expect(onReveal).toHaveBeenCalledOnce();
  });
});
