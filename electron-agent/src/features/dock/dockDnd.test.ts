import { describe, expect, it } from 'vitest';
import { planDrop } from './dockDnd';
import type { DockTab } from '../../stores/dockStore';

const t = (id: string, kind: DockTab['kind'], region: DockTab['region'], order: number): DockTab => ({
  id,
  kind,
  region,
  order,
  title: id,
  closable: kind !== 'subagent',
  payload: kind === 'terminal' ? { status: 'idle' } : kind === 'page' ? { url: id, content: '' } : { messageId: id, toolCallId: id },
});

const tabs: DockTab[] = [
  t('p1', 'page', 'right', 0),
  t('p2', 'page', 'right', 1),
  t('term1', 'terminal', 'bottom', 0),
];

describe('planDrop', () => {
  it('reorders within the same region when dropped on a sibling tab', () => {
    expect(planDrop(tabs, 'p1', 'p2')).toEqual({ type: 'reorder', region: 'right', from: 0, to: 1 });
  });

  it('moves a page across regions when dropped on the bottom strip', () => {
    expect(planDrop(tabs, 'p1', 'dock:bottom')).toEqual({ type: 'move', id: 'p1', region: 'bottom', insertIndex: 1 });
  });

  it('moves a page across regions when dropped on a tab in the other region', () => {
    expect(planDrop(tabs, 'p2', 'term1')).toEqual({ type: 'move', id: 'p2', region: 'bottom', insertIndex: 0 });
  });

  it('rejects dragging a terminal to the right region', () => {
    expect(planDrop(tabs, 'term1', 'dock:right')).toBeNull();
    expect(planDrop(tabs, 'term1', 'p1')).toBeNull();
  });

  it('returns null for no-op (same index, missing target)', () => {
    expect(planDrop(tabs, 'p1', 'p1')).toBeNull();
    expect(planDrop(tabs, 'nope', 'p1')).toBeNull();
  });
});
