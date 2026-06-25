import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphSidebar } from './GraphSidebar';
import type { RichGraph } from '../../../../lib/codeGraphTypes';

const graph: RichGraph = {
  nodes: [{ path: 'src/a.ts', lines: 100, exportCount: 3, complexity: 0.4, inDegree: 2, x: 0, y: 0 }],
  edges: [{ source: 'src/a.ts', target: 'src/b.ts', kind: 'import-value', weight: 1 }],
  circularPaths: [],
};

describe('GraphSidebar', () => {
  it('shows hint when nothing selected', () => {
    render(<GraphSidebar selected={null} graph={graph} pathSource={null} pathTarget={null} paths={[]} onPick={vi.fn()} />);
    expect(screen.getByText(/点击/)).toBeInTheDocument();
  });

  it('shows filename when file selected', () => {
    render(<GraphSidebar selected="src/a.ts" graph={graph} pathSource={null} pathTarget={null} paths={[]} onPick={vi.fn()} />);
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });
});
