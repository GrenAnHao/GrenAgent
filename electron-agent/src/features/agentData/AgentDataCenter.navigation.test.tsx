// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../lib/agentData', () => ({ agentDataApi: {
  status: vi.fn(async () => ({ state: 'ready', version: 1 })), overview: vi.fn(async () => ({ recentPages: [], errors: [] })),
  wiki: { list: vi.fn(async () => []) }, code: { projects: vi.fn(async () => []) },
  tasks: { list: vi.fn(async () => ({ items: [] })), read: vi.fn() },
} }));
vi.mock('./OverviewPanel', () => ({ OverviewPanel: ({ onOpenResource }: { onOpenResource?: (value: unknown) => void }) => <><button onClick={() => onOpenResource?.({ view: 'wiki', kbId: 'kb-b', pageId: 'same' })}>最近页面B</button><button onClick={() => onOpenResource?.({ view: 'jobs', task: { source: 'system', id: 'same' } })}>后台任务</button></> }));
vi.mock('./WikiPanel', () => ({ WikiPanel: ({ navigation }: { navigation?: unknown }) => <output data-testid="wiki-target">{JSON.stringify(navigation)}</output> }));
vi.mock('./JobsPanel', () => ({ JobsPanel: ({ selectedTask }: { selectedTask?: unknown }) => <output data-testid="task-target">{JSON.stringify(selectedTask)}</output> }));
vi.mock('./CodeRetrievalPanel', () => ({ CodeRetrievalPanel: () => null }));
vi.mock('./AuditDiagnosticsPanel', () => ({ AuditDiagnosticsPanel: () => null }));
vi.mock('../repoWiki/RepoWikiWorkspace', () => ({ RepoWikiWorkspace: () => <input aria-label="Repo Wiki 阅读位置" defaultValue="overview" /> }));
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

it('hosts Repo Wiki beside the existing Wiki and retains it across tab changes', async () => {
  render(<AgentDataCenter userId="u" />);
  fireEvent.click(screen.getByRole('tab', { name: 'Repo Wiki' }));
  const reader = await screen.findByRole('textbox', { name: 'Repo Wiki 阅读位置' });
  fireEvent.change(reader, { target: { value: 'architecture' } });
  fireEvent.click(screen.getByRole('tab', { name: '资料 Wiki', exact: true }));
  fireEvent.click(screen.getByRole('tab', { name: 'Repo Wiki' }));
  expect(screen.getByRole('textbox', { name: 'Repo Wiki 阅读位置' })).toBe(reader);
  expect((reader as HTMLInputElement).value).toBe('architecture');
});

it('opens the compatibility Repo Wiki request after the center has already been visited', async () => {
  const view = render(<AgentDataCenter userId="u" />);
  view.rerender(<AgentDataCenter userId="u" requestedTab="repoWiki" />);
  expect(await screen.findByRole('textbox', { name: 'Repo Wiki 阅读位置' })).toBeTruthy();
});
