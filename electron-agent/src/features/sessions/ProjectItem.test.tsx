import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectItem } from './ProjectItem';

const base = {
  name: 'order-service',
  expanded: false,
  pinned: false,
  onToggle: vi.fn(),
  onNew: vi.fn(),
  onPinToggle: vi.fn(),
  onReveal: vi.fn(),
  onRename: vi.fn(),
  onHide: vi.fn(),
  onClearSessions: vi.fn(),
  onRemove: vi.fn(),
};

describe('ProjectItem attention summary', () => {
  it('shows the summary only when collapsed', () => {
    const { rerender } = render(<ProjectItem {...base} attention={{ kind: 'approval', count: 2 }} />);
    expect(screen.getByTestId('project-attention').getAttribute('data-kind')).toBe('approval');
    expect(screen.getByTestId('project-attention-count').textContent).toBe('2');
    rerender(<ProjectItem {...base} expanded attention={{ kind: 'approval', count: 2 }} />);
    expect(screen.queryByTestId('project-attention')).toBeNull();
  });

  it('hides the count when it is zero', () => {
    render(<ProjectItem {...base} attention={{ kind: 'done', count: 0 }} />);
    expect(screen.getByTestId('project-attention').getAttribute('data-kind')).toBe('done');
    expect(screen.queryByTestId('project-attention-count')).toBeNull();
  });

  it('shows a spinner for a running group', () => {
    render(<ProjectItem {...base} attention={{ kind: 'running', count: 0 }} />);
    expect(screen.getByTestId('project-attention').getAttribute('data-kind')).toBe('running');
  });
});
