import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphToolbar } from './GraphToolbar';
import type { GraphState } from './useGraphState';

const base: GraphState = {
  searchQuery: '', selected: null, depth: 1,
  pathSource: null, pathTarget: null, collapsed: false,
  expandedDirs: new Set(),
  visibleKinds: new Set(['import-value', 'import-type', 'reexport', 'dynamic', 'call', 'circular']),
};

describe('GraphToolbar', () => {
  it('renders edge kind chips', () => {
    render(<GraphToolbar state={base} onSearch={vi.fn()} onDepth={vi.fn()} onToggleKind={vi.fn()} />);
    expect(screen.getByText('import')).toBeInTheDocument();
    expect(screen.getByText('type')).toBeInTheDocument();
  });

  it('disables depth slider when nothing selected', () => {
    render(<GraphToolbar state={base} onSearch={vi.fn()} onDepth={vi.fn()} onToggleKind={vi.fn()} />);
    expect(screen.getByRole('slider')).toBeDisabled();
  });
});
