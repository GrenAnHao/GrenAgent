import { useState } from 'react';
import { CodeRetrievalPanel } from '../../src/features/agentData/CodeRetrievalPanel';
import { useSessionStore } from '../../src/store';
import { useSidebarPrefsStore } from '../../src/stores/sidebarPrefsStore';
import { pathKey } from '../../src/lib/pathUtils';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

const projects = [
  'D:/Workspaces/GrenAgent',
  'D:/Studio/客户项目/产品设计与交付/2026 年度研究与档案/Engineering Decision Management',
  'D:/Workspaces/云机系统',
  'D:/Labs/gren-ssh',
  'D:/Products/省心掌柜',
  'D:/Services/search-service',
  'D:/Labs/query-studio',
  'D:/Workspaces/docs-site',
  'D:/Services/event-router',
  'D:/Labs/file-inspector',
  'D:/Libraries/ui-kit',
  'D:/Workspaces/data-console',
  'D:/Products/mobile-client',
  'D:/Labs/worker-tools',
  'D:/Libraries/theme-tokens',
  'D:/Studio/design-system',
  'D:/Workspaces/admin',
  'D:/Labs/parser',
];
const [stale, long, empty, unknown, stale2, stale3] = projects;
const start = Date.now(),
  day = 86400_000,
  lastSuccessAt = start - 180_000;
const dirty = new Set([stale, stale2, stale3]),
  missing = new Set([empty]);
const stamps = new Map(
  projects
    .filter((w) => w !== empty && w !== unknown)
    .map((w) => [w, start - (w === stale ? 2 : w === long ? 8 : (projects.indexOf(w) % 9) + 1) * day]),
);
const jobs = new Map<string, { id: string; state: 'running' | 'completed'; processed: number; updatedAt: number }>();
let id = 0,
  picked = long,
  remount: () => void;
function status(workspace: string) {
  const task = jobs.get(workspace),
    busy = task?.state === 'running',
    indexed = !missing.has(workspace);
  const i = projects.indexOf(workspace),
    files = [3062, 846, 2600, 181, 912, 56][i] ?? 65 + i * 4;
  return {
    workspace,
    connected: indexed,
    indexed,
    state: !indexed ? 'unavailable' : dirty.has(workspace) && workspace !== stale ? 'stale' : 'indexed',
    files: indexed ? files : undefined,
    nodes: indexed ? files * 6 : undefined,
    edges: indexed ? files * 12 : undefined,
    // A full build can be newer than every file row. An incomplete/legacy
    // task can also have recent rows without a known completed build.
    lastIndexedAt:
      workspace === stale ? start - 12 * day : workspace === unknown ? lastSuccessAt : stamps.get(workspace),
    syncedAt: workspace === stale ? stamps.get(workspace) : workspace === unknown ? null : undefined,
    lastSuccessAt,
    pendingChanges: dirty.has(workspace) && workspace === stale ? 3 : 0,
    watcher: { active: true, degraded: false },
    phase: busy ? 'syncing' : 'idle',
    manualTask: task
      ? { ...task, workspace, kind: 'codegraph.sync', stage: '解析代码', total: files }
      : workspace === long || workspace === unknown
        ? { id: 'old', workspace, state: 'completed', updatedAt: lastSuccessAt }
        : undefined,
  };
}
exposeData({ stale, long, empty, unknown, stale2, stale3, last: projects.at(-1), count: projects.length });
exposeActions({
  advance: (path: string) => {
    jobs.get(path)!.processed = 2345;
  },
  finish: (path: string) => {
    const at = Date.now();
    Object.assign(jobs.get(path)!, { state: 'completed', updatedAt: at });
    dirty.delete(path);
    missing.delete(path);
    stamps.set(path, at);
  },
  remount: () => remount(),
  pick: (path: string) => {
    picked = path;
  },
});
installBridge({
  pickDirectory: async () => picked,
  openPath: async (path: string) => {
    track('open:' + path);
  },
  invoke: async (command: string, args: Record<string, unknown>) => {
    const path = String(args.workspace);
    if (command === 'agentData_code_status') return status(path);
    if (command === 'agentData_jobs_create') {
      track((args.rebuild === true ? 'rebuild:' : 'sync:') + path);
      const processed = path === long ? 117 : path === stale2 ? 418 : path === stale3 ? 19 : 1240;
      const job = { id: 'manual-' + ++id, state: 'running' as const, processed, updatedAt: Date.now() };
      jobs.set(path, job);
      return job;
    }
    if (command === 'agentData_code_call')
      return { structuredContent: { rows: [], nodes: [], edges: [], extra: { languages: {} } } };
    throw new Error('unexpected ' + command);
  },
});
useSidebarPrefsStore.setState({ keptProjects: [] });
useSessionStore.setState({ activeWorkspace: '', registeredProjects: projects, allSessions: [] });
localStorage.removeItem('pi-code-index-hidden-projects');
localStorage.setItem('pi-code-index-recent', JSON.stringify(projects.map(pathKey)));
export default function Scenario() {
  const [version, setVersion] = useState(0);
  remount = () => setVersion((v) => v + 1);
  return (
    <main
      style={{ height: '100vh', boxSizing: 'border-box', padding: '20px 24px', background: 'var(--gren-content-bg)' }}
    >
      <CodeRetrievalPanel key={version} />
    </main>
  );
}
