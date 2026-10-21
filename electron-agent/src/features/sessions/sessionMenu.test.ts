import { describe, expect, it, vi } from 'vitest';
import { buildSessionMenuItems } from './useSessionMenu';
import { buildProjectMenuItems } from './useProjectMenu';

interface ClickItem {
  key?: string;
  label?: unknown;
  danger?: boolean;
  disabled?: boolean;
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

  it('archive only appears when wired, sits before delete and is disabled while running', () => {
    const common = { pinned: false, onPinToggle: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
    expect((buildSessionMenuItems(common) as ClickItem[]).some((i) => i.key === 'archive')).toBe(false);

    const onArchive = vi.fn();
    const idle = buildSessionMenuItems({ ...common, onArchive }) as ClickItem[];
    const keys = idle.map((i) => i.key).filter(Boolean);
    expect(keys.indexOf('archive')).toBe(keys.indexOf('delete') - 1);
    const item = idle.find((i) => i.key === 'archive')!;
    expect(item.label).toBe('归档');
    expect(item.disabled).toBeFalsy();
    item.onClick!();
    expect(onArchive).toHaveBeenCalledOnce();

    const running = buildSessionMenuItems({ ...common, onArchive, archiveDisabled: true }) as ClickItem[];
    expect(running.find((i) => i.key === 'archive')!.disabled).toBe(true);
  });

  it('regenerate title only appears when wired, right after rename', () => {
    const common = { pinned: false, onPinToggle: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
    expect((buildSessionMenuItems(common) as ClickItem[]).some((i) => i.key === 'regenerate-title')).toBe(false);

    const onRegenerateTitle = vi.fn();
    const items = buildSessionMenuItems({ ...common, onRegenerateTitle }) as ClickItem[];
    const keys = items.map((i) => i.key).filter(Boolean);
    expect(keys.indexOf('regenerate-title')).toBe(keys.indexOf('rename') + 1);
    const item = items.find((i) => i.key === 'regenerate-title')!;
    expect(item.label).toBe('重新生成标题');
    item.onClick!();
    expect(onRegenerateTitle).toHaveBeenCalledOnce();
  });
});

describe('buildProjectMenuItems', () => {
  it('has pin/reveal/rename/hide/clear/remove and danger items fire', () => {
    const onClearSessions = vi.fn();
    const onRemove = vi.fn();
    const items = buildProjectMenuItems({
      pinned: false,
      onPinToggle: vi.fn(),
      onReveal: vi.fn(),
      onRename: vi.fn(),
      onHide: vi.fn(),
      onClearSessions,
      onRemove,
    }) as ClickItem[];
    const keys = items.map((i) => i.key).filter(Boolean);
    expect(keys).toEqual(['pin', 'reveal', 'rename', 'hide', 'clear-sessions', 'remove']);
    expect(items.find((i) => i.key === 'clear-sessions')!.label).toBe('清空会话');
    expect(items.find((i) => i.key === 'clear-sessions')!.danger).toBe(true);
    expect(items.find((i) => i.key === 'remove')!.label).toBe('移除项目');
    expect(items.find((i) => i.key === 'remove')!.danger).toBe(true);
    items.find((i) => i.key === 'clear-sessions')!.onClick!();
    items.find((i) => i.key === 'remove')!.onClick!();
    expect(onClearSessions).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('reveal fires its callback', () => {
    const onReveal = vi.fn();
    const items = buildProjectMenuItems({
      pinned: true,
      onPinToggle: vi.fn(),
      onReveal,
      onRename: vi.fn(),
      onHide: vi.fn(),
      onClearSessions: vi.fn(),
      onRemove: vi.fn(),
    }) as ClickItem[];
    items.find((i) => i.key === 'reveal')!.onClick!();
    expect(onReveal).toHaveBeenCalledOnce();
  });
});
