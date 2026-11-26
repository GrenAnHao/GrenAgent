import { CodeRetrievalPanel } from '../../src/features/agentData/CodeRetrievalPanel';
import { useSidebarPrefsStore } from '../../src/stores/sidebarPrefsStore';
import { useSessionStore } from '../../src/store';
import { registerComposerInsertFile } from '../../src/features/chat/input/composerBridge';
import { useModuleStore } from '../../src/stores/moduleStore';
import { exposeActions, exposeData, installBridge, track } from '../stubs';

const app = 'D:/Projects/atlas-console',
  long = 'D:/Studio/Engineering Decision Management and Documentation',
  fresh = 'D:/Local/new-workspace';
const projects = [app, long, 'D:/Projects/sdk', 'D:/Projects/console-tools'];
const stamp = Date.parse('2026-11-24T09:12:00+08:00');
const catalog = [
  { file: 'src/app.ts', incomingFiles: 8 },
  { file: 'src/core/graph.ts', incomingFiles: 32 },
  { file: 'src/core/paths.ts', incomingFiles: 12 },
  { file: '.agents/rules.ts', incomingFiles: 45 },
  { file: 'README.md', incomingFiles: 0 },
  { file: 'build/bundle.js', incomingFiles: 0 },
];
let phase: 'idle' | 'running' | 'completed' = 'idle',
  completedAt = 0,
  done = 1240,
  picked: string | null = fresh;
const result = (rows: unknown[], extra?: Record<string, unknown>) => ({
  structuredContent: { schemaVersion: 1, rows, nodes: [], edges: [], extra },
});
function status(workspace: string) {
  const indexed = workspace !== fresh && workspace !== projects[3];
  const task =
    phase === 'idle' || workspace !== app
      ? undefined
      : {
          id: 'manual-1',
          kind: 'codegraph.sync',
          workspace: app,
          state: phase,
          stage: '解析代码',
          processed: done,
          total: 3062,
          progress: 40,
          createdAt: stamp + 1,
          updatedAt: phase === 'completed' ? completedAt : stamp + 1,
        };
  return {
    workspace,
    indexed,
    connected: indexed,
    state: workspace === long ? 'stale' : indexed ? 'indexed' : 'unavailable',
    files: indexed ? 3062 : undefined,
    nodes: indexed ? 18240 : undefined,
    edges: indexed ? 42936 : undefined,
    lastIndexedAt: indexed ? (workspace === app && phase === 'completed' ? task?.updatedAt : stamp) : undefined,
    phase: task?.state === 'running' ? 'syncing' : 'idle',
    generation: phase === 'completed' ? 1 : 0,
    watcher: { active: indexed, degraded: false },
    manualTask: task,
  };
}
exposeData({ app, long, fresh });
exposeActions({
  advance: () => {
    done = 2345;
  },
  finish: () => {
    completedAt = Date.now();
    phase = 'completed';
  },
  cancelPicker: () => {
    picked = null;
  },
  restorePicker: () => {
    picked = fresh;
  },
});
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      track('clipboard:' + text);
    },
  },
});
registerComposerInsertFile((f) => track('composer:' + f.absolute));
useModuleStore.setState({ activeModule: 'codeIndex' });
useModuleStore.subscribe((s) => track('module:' + s.activeModule));
installBridge({
  pickDirectory: async () => {
    track('picker');
    return picked;
  },
  invoke: async (command: string, args: Record<string, unknown>) => {
    const ws = String(args.workspace);
    if (command === 'agentData_code_status') {
      track('status:' + ws);
      return status(ws);
    }
    if (command === 'agentData_jobs_create') {
      track('sync:' + ws);
      phase = 'running';
      return status(ws).manualTask;
    }
    if (command === 'read_file') {
      track('source:' + args.path);
      return 'export const atlas = 1;';
    }
    if (command === 'agentData_code_call') {
      const a = args.args as {
        hideIgnored: boolean;
        format: string;
        sort: string;
        languageCounts?: boolean;
        path?: string;
        query?: string;
        file?: string;
      };
      const visible = catalog.filter((r) => !a.hideIgnored || !/^(?:\.|build\/)/.test(r.file));
      if (args.tool === 'codegraph_deps') return result([{ file: 'src/app.ts', snippet: 'dependent' }]);
      if (args.tool === 'codegraph_search')
        return result(visible.filter((r) => r.file.includes(a.query || '')).map((r) => ({ ...r, kind: 'file' })));
      if (args.tool !== 'codegraph_files') return result([]);
      if (a.languageCounts)
        return result(
          [...visible].sort((x, y) => y.incomingFiles - x.incomingFiles),
          {
            languages: { typescript: a.hideIgnored ? 3 : 4, markdown: 1, ...(a.hideIgnored ? {} : { javascript: 1 }) },
          },
        );
      if (a.format === 'children') {
        const parent = a.path ? a.path + '/' : '';
        const dirs = new Map<string, number>();
        const rows: unknown[] = [];
        for (const r of visible.filter((r) => r.file.startsWith(parent))) {
          const tail = r.file.slice(parent.length),
            i = tail.indexOf('/');
          if (i < 0) rows.push({ ...r, kind: 'file' });
          else {
            const f = parent + tail.slice(0, i);
            dirs.set(f, (dirs.get(f) || 0) + 1);
          }
        }
        for (const [file, fileCount] of dirs) rows.unshift({ file, kind: 'directory', fileCount });
        return result(rows, { page: { offset: 0, total: rows.length } });
      }
      return result(
        [...visible]
          .sort((x, y) =>
            a.sort === 'references'
              ? y.incomingFiles - x.incomingFiles
              : x.file.split('/').pop()!.localeCompare(y.file.split('/').pop()!),
          )
          .map((r) => ({
            file: r.file,
            kind: 'file',
            ...(a.sort === 'references' ? { incomingFiles: r.incomingFiles } : {}),
          })),
        { page: { offset: 0, total: visible.length } },
      );
    }
    throw new Error('unexpected ' + command);
  },
});
useSidebarPrefsStore.setState({ keptProjects: [] });
localStorage.removeItem('pi-code-index-recent');
useSessionStore.setState({
  registeredProjects: projects,
  activeWorkspace: '',
  allSessions: [{ cwd: app, timestamp: '2026-11-25T01:00:00Z', id: 's1', path: '/s/1', name: null }],
});
export default function Scenario() {
  return (
    <main
      style={{
        height: '100vh',
        boxSizing: 'border-box',
        padding: '20px 24px',
        background: 'var(--gren-content-bg)',
        overflow: 'auto',
      }}
    >
      <CodeRetrievalPanel />
    </main>
  );
}
