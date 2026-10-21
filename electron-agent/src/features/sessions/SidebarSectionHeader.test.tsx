import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import { resetSessionAttentionForTest, useAttentionStore } from '../../stores/sessionAttention';
import { sessionControlKey } from '../../stores/modeStore';

const P = 'D:/repo/.pi/a.jsonl';
const Q = 'D:/repo/.pi/b.jsonl';

afterEach(() => resetSessionAttentionForTest());

describe('SidebarSectionHeader attention summary', () => {
  it('shows the summary of hidden sessions only while collapsed', () => {
    useAttentionStore.setState({
      pending: { [sessionControlKey(P)]: { path: P, workspace: 'D:/repo', kind: 'approval', title: 't' } },
      unread: { [sessionControlKey(Q)]: { path: Q, workspace: 'D:/repo', outcome: { kind: 'failed', seq: 1 } } },
    });
    const props = { id: 'projects' as const, label: '项目', onToggle: vi.fn(), sessionPaths: [P, Q], runningSessionPaths: new Set<string>() };
    const { rerender } = render(<SidebarSectionHeader {...props} collapsed />);
    expect(screen.getByTestId('sidebar-section-attention').getAttribute('data-kind')).toBe('approval');
    expect(screen.getByTestId('sidebar-section-attention-count').textContent).toBe('2');
    rerender(<SidebarSectionHeader {...props} collapsed={false} />);
    expect(screen.queryByTestId('sidebar-section-attention')).toBeNull();
  });

  it('shows nothing when no hidden session needs attention', () => {
    render(<SidebarSectionHeader id="conversations" label="对话" onToggle={vi.fn()} collapsed sessionPaths={[P]} runningSessionPaths={new Set()} />);
    expect(screen.queryByTestId('sidebar-section-attention')).toBeNull();
  });
});
