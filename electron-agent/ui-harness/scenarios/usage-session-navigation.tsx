import { lazy, Suspense } from 'react';
import { writeLastOpen } from '../../src/lib/lastOpen';
import type { UsageReport } from '../../src/lib/usageReport';
import { installBridge, track } from '../stubs';

// Real App, ModuleRail, UsagePanel and chat loader. Only file/agent I/O is stubbed.
const project = 'D:/usage-nav/GrenAgent', other = 'D:/usage-nav/Second';
const rows = ['start','same','cross'].map((id, i) => ({
  id, cwd: i === 2 ? other : project, name: ['原始会话','同项目历史','跨项目历史'][i],
  path: 'D:/usage-nav/sessions/' + id + '.jsonl', timestamp:'2026-11-25T01:00:00Z',
}));
const unavailable = { ...rows[0], path:'D:/usage-nav/deleted.jsonl', id:'deleted', name:'已删除的历史' };
const report: UsageReport = {
  projects:[], totals:{sessions:4,messages:4,totalTokens:400,input:400,output:0,cost:10,cacheRead:0,cacheWrite:0,cacheHitRate:0},
  byDay:[],byModel:[],byProject:[],calls:[],
  recentSessions:[...rows,unavailable].map(r => ({ ...r, tokens:100, cost:2.5 })),
};
writeLastOpen({ workspace:project, sessionPath:rows[0].path });
installBridge({
  subscribe: async () => () => {},
  window: {isMaximized:async()=>false,onResized:async()=>()=>{},setBackgroundColor:async()=>{}},
  webview: {onDragDropEvent:async()=>()=>{}},
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'get_works_dir': return 'D:/usage-nav/works';
      case 'lookup_startup_session': return rows[0];
      case 'list_projects': return [project,other];
      case 'list_all_sessions': return rows;
      case 'list_pi_sessions': return rows.filter(r=>r.cwd === args.workspace);
      case 'open_workspace': {
        track('open:' + args.workspace);
        const path = rows.find(r=>r.cwd === args.workspace)?.path;
        return {sessionFile:path, restoredSession:path};
      }
      case 'agent_switch_session': track('switch:' + args.sessionPath); return {};
      case 'agent_get_messages': {
        const r = rows.find(r=>r.path === args.targetSessionPath);
        if (!r) throw Error('unexpected session: ' + args.targetSessionPath);
        track('history:' + r.id + ':' + args.workspace);
        return {messages:[{role:'user',content:[{type:'text',text:'历史正文 / ' + r.name}],timestamp:1}]};
      }
      case 'usage_report': return report;
      case 'enhance_prompt_abort': return;
      case 'ui_history_read': return {content:''};
      case 'agent_list_running_turns': case 'list_prompt_commands': case 'subagent_list': case 'get_git_status': case 'prune_orphan_conversations': return [];
      case 'get_settings': case 'get_model_fast_preferences': case 'agent_get_session_defaults': case 'agent_get_state': return {};
      case 'agent_get_commands': return {commands:[]};
      case 'list_models_global': case 'agent_get_available_models': return {models:[]};
      case 'get_provider_config': return {modelsJson:'{}',authJson:'{}',agentDir:'D:/usage-nav'};
      case 'get_git_branches': return {current:'',branches:[]};
      default: throw Error('unused test service: ' + command);
    }
  },
});
const App = lazy(() => import('../../src/App'));
export default function Scenario() { return <Suspense fallback={null}><App/></Suspense>; }
