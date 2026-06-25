import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodeGraphButton } from './CodeGraphPanel';

vi.mock('../../../../lib/codeGraphIo', () => ({
  getRichGraph: vi.fn().mockResolvedValue({
    nodes: [{ path: 'src/a.ts', lines: 10, exportCount: 1, complexity: 0.2, inDegree: 0 }],
    edges: [],
    circularPaths: [],
  }),
}));
vi.mock('sigma', () => ({
  default: class {
    on = vi.fn(); kill = vi.fn(); refresh = vi.fn();
    getCamera = vi.fn(() => ({ animate: vi.fn() }));
    getNodeDisplayData = vi.fn();
  },
}));
vi.mock('graphology', () => ({
  default: class {
    addNode = vi.fn(); addDirectedEdgeWithKey = vi.fn();
    hasNode = vi.fn(() => true); source = vi.fn(); target = vi.fn();
  },
}));
vi.mock('../../../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

describe('CodeGraphButton', () => {
  it('renders the chip button', () => {
    render(<CodeGraphButton />);
    expect(screen.getByTestId('code-graph-button')).toBeInTheDocument();
  });

  it('opens modal on click', async () => {
    render(<CodeGraphButton />);
    fireEvent.click(screen.getByTestId('code-graph-button'));
    expect(await screen.findByTestId('code-graph-content')).toBeInTheDocument();
  });
});
