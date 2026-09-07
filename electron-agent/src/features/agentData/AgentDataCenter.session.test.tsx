// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../lib/agentData', () => ({ agentDataApi: {
  status: vi.fn(async () => ({ state: 'ready', version: 1 })), jobs: { list: vi.fn(async () => []) },
  tasks: { list: vi.fn(async () => ({ items: [] })), read: vi.fn() }, overview: vi.fn(async () => ({ recentPages: [], recentMemories: [], errors: [] })),
  memory: { overview: vi.fn(async () => ({ total: 0, byLevel: { L0: 0, L1: 0, L2: 0, L3: 0 } })) },
  wiki: { overview: vi.fn(async () => ({ pages: 0, latestUpdatedAt: null })) },
} }));
vi.mock('./MemoryPanel', () => ({ MemoryPanel: ({ onOpenSession }: { onOpenSession?: (cwd: string, path: string) => void }) => <button onClick={() => onOpenSession?.('/source-project', '/real/source-session.jsonl')}>打开已存在来源</button> }));
vi.mock('./WikiPanel', () => ({ WikiPanel: () => null }));
vi.mock('./CodeRetrievalPanel', () => ({ CodeRetrievalPanel: () => null }));
vi.mock('./JobsPanel', () => ({ JobsPanel: () => null }));
vi.mock('./AuditDiagnosticsPanel', () => ({ AuditDiagnosticsPanel: () => null }));
vi.mock('./OverviewPanel', () => ({ OverviewPanel: () => null }));
import { AgentDataCenter } from './AgentDataCenter';

afterEach(cleanup);
it('forwards an existing session through the center and uses the current host callback', () => {
  const first = vi.fn(), next = vi.fn();
  const { rerender } = render(<AgentDataCenter userId="u" initialProject="/unrelated-chat" onOpenSession={first} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
  fireEvent.click(screen.getByRole('button', { name: '打开已存在来源' }));
  expect(first).toHaveBeenCalledExactlyOnceWith('/source-project', '/real/source-session.jsonl');
  rerender(<AgentDataCenter userId="u" initialProject="/another-chat" onOpenSession={next} />);
  fireEvent.click(screen.getByRole('button', { name: '打开已存在来源' }));
  expect(first).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledExactlyOnceWith('/source-project', '/real/source-session.jsonl');
});
