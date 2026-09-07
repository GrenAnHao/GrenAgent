// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../lib/agentData', () => ({ agentDataApi: {
  status: vi.fn(async () => ({ state: 'ready', version: 1 })), overview: vi.fn(async () => ({ recentPages: [], recentMemories: [], errors: [] })),
  memory: { overview: vi.fn(async () => ({ total: 0, byLevel: { L0: 0, L1: 0, L2: 0, L3: 0 } })) }, wiki: { overview: vi.fn(async () => ({ pages: 0, latestUpdatedAt: null })) },
  tasks: { list: vi.fn(async () => ({ items: [] })), read: vi.fn() },
} }));
vi.mock('./OverviewPanel', () => ({ OverviewPanel: ({ onOpenResource }: { onOpenResource?: (value: unknown) => void }) => <><button onClick={() => onOpenResource?.({ view: 'wiki', kbId: 'kb-b', pageId: 'same' })}>最近页面B</button><button onClick={() => onOpenResource?.({ view: 'jobs', task: { source: 'system', id: 'same' } })}>后台任务</button></> }));
vi.mock('./WikiPanel', () => ({ WikiPanel: ({ navigation }: { navigation?: unknown }) => <output data-testid="wiki-target">{JSON.stringify(navigation)}</output> }));
vi.mock('./JobsPanel', () => ({ JobsPanel: ({ selectedTask }: { selectedTask?: unknown }) => <output data-testid="task-target">{JSON.stringify(selectedTask)}</output> }));
vi.mock('./MemoryPanel', () => ({ MemoryPanel: () => null }));
vi.mock('./CodeRetrievalPanel', () => ({ CodeRetrievalPanel: () => null }));
vi.mock('./AuditDiagnosticsPanel', () => ({ AuditDiagnosticsPanel: () => null }));
import { AgentDataCenter } from './AgentDataCenter';
afterEach(cleanup);
it('passes both library and page IDs, and keeps the system task source when navigating', () => {
  render(<AgentDataCenter userId="u" />);
  fireEvent.click(screen.getByRole('button', { name: '最近页面B' }));
  expect(screen.getByTestId('wiki-target').textContent).toBe(JSON.stringify({ view: 'wiki', kbId: 'kb-b', pageId: 'same' }));
  fireEvent.click(screen.getByRole('tab', { name: '概览' }));
  fireEvent.click(screen.getByRole('button', { name: '后台任务' }));
  expect(screen.getByTestId('task-target').textContent).toBe(JSON.stringify({ source: 'system', id: 'same' }));
});
