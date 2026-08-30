import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabStrip } from './TabStrip';
import { resolveTone } from './dockTabStyles';
import type { DockTab } from '../../stores/dockStore';

afterEach(cleanup);

const pageTab: DockTab = { id: 'page:u', kind: 'page', region: 'right', title: 'Example', closable: true, order: 0, payload: { url: 'u', content: '' } };
const subTab: DockTab = { id: 's1', kind: 'subagent', region: 'right', title: '#1 task', closable: false, order: 1, payload: { messageId: 's1', toolCallId: 'c1' } };

function renderStrip(props: Partial<React.ComponentProps<typeof TabStrip>> = {}) {
  return render(
    <DndContext>
      <TabStrip
        region="right"
        tabs={[pageTab, subTab]}
        activeId="page:u"
        toneOf={(t) => resolveTone(t)}
        onActivate={props.onActivate ?? (() => {})}
        onClose={props.onClose ?? (() => {})}
        {...props}
      />
    </DndContext>,
  );
}

describe('TabStrip', () => {
  it('renders one tab per item and marks the active one', () => {
    renderStrip();
    expect(screen.getByTestId('dock-tab-page:u').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('dock-tab-s1').getAttribute('aria-selected')).toBe('false');
  });

  it('fires onActivate when a tab is clicked', () => {
    const onActivate = vi.fn();
    renderStrip({ onActivate });
    fireEvent.click(screen.getByTestId('dock-tab-s1'));
    expect(onActivate).toHaveBeenCalledWith('s1');
  });

  it('shows a close button only on closable tabs and fires onClose', () => {
    const onClose = vi.fn();
    renderStrip({ onClose });
    const closeBtn = screen.getByTestId('dock-tab-page:u').querySelector('button');
    expect(closeBtn).not.toBeNull();
    expect(screen.getByTestId('dock-tab-s1').querySelector('button')).toBeNull();
    fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalledWith('page:u');
  });
});
