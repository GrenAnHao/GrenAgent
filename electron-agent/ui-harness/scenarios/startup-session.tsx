import { lazy, Suspense } from 'react';
import shell from '../../index.html?raw';
import { readLastOpen, writeLastOpen } from '../../src/lib/lastOpen';
import { rememberScratch } from '../../src/lib/startupConversation';
import { bumpSessionMutationEpoch, getAllSessionsInflight } from '../../src/lib/sessionCache';
import { useSessionStore } from '../../src/store';
import { deferred, exposeActions, exposeData, installBridge, track } from '../stubs';

const workspace = 'D:/startup/current-owner';
const works = 'D:/startup/works';
const scratch = works + '/unused';
const row = { path: 'D:/sessions/last.jsonl', id: 'last', cwd: workspace, name: '恢复的会话', timestamp: null };
const other = { ...row, path: 'D:/sessions/other.jsonl', id: 'other', name: '后台载入的会话' };
const body = '这是上次停下来的消息。';
const lookup = deferred<void>();
const history = deferred<void>();
const directory = deferred<void>();
let staleDirectory = false;
let failCreate = false;
let failLookup = sessionStorage.getItem('startup-test.fail-once') === 'yes';
sessionStorage.removeItem('startup-test.fail-once');
if (!failLookup) writeLastOpen({ workspace: 'D:/startup/old-owner', sessionPath: row.path });
rememberScratch(scratch);
const boot = new DOMParser().parseFromString(shell, 'text/html');
document.head.appendChild(boot.querySelector('style')!);
document.body.appendChild(boot.getElementById('boot-splash')!);
exposeData({ body, workspace, scratch, path: row.path, other: other.name });
exposeActions({
  lookup: () => lookup.resolve(), history: () => history.resolve(), directory: () => directory.resolve(),
  failNextLaunch: () => sessionStorage.setItem('startup-test.fail-once', 'yes'),
  failNextDraft: () => { failCreate = true; },
  remembered: () => readLastOpen(),
  expireDirectory: async () => {
    const pending = getAllSessionsInflight();
    if (!pending) throw new Error('没有待返回的目录查询');
    bumpSessionMutationEpoch();
    staleDirectory = true;
    directory.resolve();
    await pending;
    await new Promise(requestAnimationFrame);
    const state = useSessionStore.getState();
    return [state.sessions, state.allSessions].map(rows => rows.map(item => item.path));
  },
});

installBridge({
  subscribe: async () => () => {},
  window: { isMaximized: async () => false, onResized: async () => () => {}, setBackgroundColor: async () => {} },
  webview: { onDragDropEvent: async () => () => {} },
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'get_works_dir': return works;
      case 'lookup_startup_session':
        track('lookup:' + args.sessionPath);
        if (failLookup) { failLookup = false; throw new Error('无法读取会话文件：文件正在被其他程序使用'); }
        await lookup.promise;
        return row;
      case 'create_conversation':
        track('draft:create');
        if (failCreate) { failCreate = false; throw new Error('暂时无法创建对话目录'); }
        return { cwd: works + '/new' };
      case 'startup_scratch_has_sessions': track('draft:check'); return true;
      case 'open_workspace': track('open:' + args.workspace); return { sessionFile: row.path, restoredSession: row.path };
      case 'agent_get_messages':
        track('history:' + args.workspace + ':' + args.targetSessionPath);
        await history.promise;
        return { messages: [{ role: 'user', content: [{ type: 'text', text: body }], timestamp: 1 }] };
      case 'ui_history_read': return { content: '' };
      case 'agent_list_running_turns': return [];
      case 'list_pi_sessions': track('unexpected:project-list'); return [];
      case 'list_all_sessions': case 'list_projects': {
        const splash = document.getElementById('boot-splash');
        track(command + ':' + (splash && !splash.classList.contains('is-leaving') ? 'covered' : 'ready'));
        await directory.promise;
        return command === 'list_projects' ? [workspace] : staleDirectory ? [] : [row, other];
      }
      case 'prune_orphan_conversations': track('prune:' + JSON.stringify(args.keep)); return [];
      case 'get_settings': return {};
      case 'agent_get_commands': return { commands: [] };
      case 'list_prompt_commands': case 'subagent_list': case 'get_git_status': return [];
      case 'list_models_global': case 'agent_get_available_models': return { models: [] };
      case 'get_model_fast_preferences': case 'agent_get_session_defaults': case 'agent_get_state': return {};
      case 'get_provider_config': return { modelsJson: '{}', authJson: '{}', agentDir: 'D:/agent' };
      case 'get_git_branches': return { current: '', branches: [] };
      default: throw new Error('unavailable test service: ' + command);
    }
  },
});
const App = lazy(() => import('../../src/App'));
export default function StartupSessionScenario() {
  return <Suspense fallback={null}><App /></Suspense>;
}
