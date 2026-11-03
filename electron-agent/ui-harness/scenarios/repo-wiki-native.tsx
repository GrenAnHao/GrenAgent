import { useState } from 'react';
import { ConfigProvider, theme } from 'antd';
import { NativeWikiPanel } from '../../vendor/repo-wiki/apps/web/src/workspace/NativeWikiPanel';
import { Markdown } from '../../vendor/repo-wiki/apps/web/src/workspace/Markdown';
import { GenerationOverview } from '../../vendor/repo-wiki/apps/web/src/workspace/GenerationOverview';
import type { NativeAuthor, NativeOperation, NativeRequest, NativeResponse, RepoWikiClient } from '../../vendor/repo-wiki/packages/contracts/src/index';
import { exposeActions, exposeData, track } from '../stubs';
import '../../vendor/repo-wiki/apps/web/src/index.css';

let author: NativeAuthor = { schema_version: 1, engine: 'qoder-wiki-local-v1', branch: 'main', locale: 'zh', revision: 1, storage_token: 'token-1', mode: 'auto', constraints: [], notes: [{ Text: '已知约束', Author: 'Ada' }], pages: [] };
let operation: NativeOperation | null = null;
const calls: NativeRequest[] = [];
const client = {
  async invoke(_action: string, args: NativeRequest): Promise<NativeResponse> {
    calls.push(args); track(`native:${args.command}`);
    switch (args.command) {
      case 'status': return { command: 'status', value: { engine: 'qoder-wiki-local-v1', executionEnabled: true, operation: operation ? { ...operation, executor_active: operation.state === 'running', recoverable: operation.state === 'paused' } : null, publication: { id: 'pub-1', published_count: 9, failed_count: 2, partial: true, failed_items: ['page-a','page-b'] }, projection: { publication_id: 'pub-1', status: 'pending' } } };
      case 'author.read': return { command: 'author.read', value: author };
      case 'author.save': author = { ...args.author, revision: author.revision + 1, storage_token: 'token-2' }; return { command: 'author.save', value: author };
      case 'author.convert': return { command: 'author.convert', value: { author: { ...author, mode:'pages', pages:[{ id:'overview', title:'概览', prompt:'说明结构' }] }, dropped_depends_on:['old-a -> old-b'] } };
      case 'prepare': return { command: 'prepare', value: { confirmation_id:'confirm-1', intent:args.intent, model_identity:'fixture/model', author_revision:author.revision, scope:{ files:['src/a.ts'] }, branch:'main', target_commit:'abc123', task_revision:operation?.revision ?? null, ...(args.operation_id ? { operation_id:args.operation_id } : {}) } };
      case 'start': operation = { id:'operation-1', revision:1, state:'running' }; return { command:'start', value:operation };
      case 'control': operation = { id:args.operation_id, revision:args.expected_revision+1, state:args.action === 'pause' ? 'paused' : 'cancelled' }; return { command:'control', value:operation };
      case 'drafts': return { command:'drafts', value:{ items:[{ id:'page-a', title:'阶段页', markdown:'# 阶段页\n正文' }] } };
      case 'projection.repair': return { command:'projection.repair', value:{ publication_id:args.publication_id, status:'ready' } };
    }
  },
  subscribe() { return () => {}; },
} as unknown as RepoWikiClient;
exposeData({ calls });
exposeActions({ calls: () => calls, author: () => author });
export default function NativeWikiScenario() {
  const [open, setOpen] = useState(true);
  return <ConfigProvider theme={{ inherit: false, algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#2e7165', colorText: '#33362f', colorTextSecondary: '#77796f', colorBorderSecondary: '#e9e6df', borderRadius: 6, fontSize: 13 } }}>
    <div className="repo-wiki-root" style={{height:'100vh'}}>{open ? <NativeWikiPanel client={client} projectId="forest" onClose={() => setOpen(false)} /> : <><button onClick={() => setOpen(true)}>原版 Wiki</button><GenerationOverview project={{id:'forest',name:'Forest',path:'/forest',language:'zh',watch:false,knowledge:{wiki:{engine:'qoder-wiki-local-v1',count:11,native_coverage:{partial:true,published:9,readable:11,failed:['a','b']}}}}} mode="wiki" run={null} busy={false} provider="real" onLanguage={() => {}} onGenerate={() => {}} onNativeOpen={() => setOpen(true)} /><Markdown nativeCitations value={'[源码](file://src/a.ts#L1-L3)\n\n[危险](file://../secret#L1-L2)'} onSource={ref => track(`source:${ref.path}:${ref.start_line}-${ref.end_line}`)} onPage={() => {}} /></>}</div>
  </ConfigProvider>;
}
