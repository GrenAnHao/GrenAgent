import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { RepoWikiService } from './repoWikiService';
import { createNativeWikiModelBridge } from './nativeWikiModel';
import { JobStore } from '../agentData/jobStore';
import { migrateKnowledgeKernel } from '../agentData/knowledgeKernel/store';
import { NativeWikiProjection } from '../agentData/nativeWikiProjection';
import { TaskViewStore } from '../agentData/taskViewStore';
import { createGrenRepoWikiClient } from '../../vendor/repo-wiki/packages/renderer/src/index';
import { ProjectFiles } from '../../vendor/repo-wiki/packages/core/src/project-files';

if (!process.env.REPOWIKI_TEST_ENTRY || !process.env.REPOWIKI_TEST_EXECUTABLE) {
  throw new Error('Repo Wiki flow requires its built child; run npm run test:repo-wiki-flow.');
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(modelOverride?: (n: number, text: string, transcript: any) => string | undefined) {
  const base = resolve(tmpdir()), temp = mkdtempSync(join(base, 'gren-wiki-flow-case-'));
  const dir = join(temp, 'repo'); mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'src/a.ts'), 'export const flowValue = 42;\n'); writeFileSync(join(dir, 'README.md'), '# Flow fixture\nA committed README for the native overview.\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Flow fixture'); git('add', 'src', 'README.md'); git('commit', '-m', 'fixture');
  mkdirSync(join(dir, '.qoder/repowiki/zh/content'), { recursive: true }); writeFileSync(join(dir, '.qoder/repowiki/zh/content/previous.md'), '# old external wiki\n');
  const root = realpathSync(dir), db = new DatabaseSync(join(temp, 'agentdata.db')); new JobStore(db); migrateKnowledgeKernel(db);
  const projection = new NativeWikiProjection(db), views = new TaskViewStore(db), calls: any[] = []; let slot = Promise.resolve(), service!: RepoWikiService;
  const binding: any = { bindingId: 'offline-fixed', expectedModel: 'fixture/model', expectedConfiguration: 'fixed', model: { provider: 'fixture', id: 'model', name: 'Fixed', api: 'openai-completions', contextWindow: 150000, maxTokens: 16000 } };
  const model: any = { bindKnowledgeModel: async () => binding, requestKnowledgeMessage: async (_b: any, transcript: any) => {
    calls.push(transcript); const n = calls.length;
    const response = (content: any[], stopReason = 'stop') => ({ role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: 'model', stopReason, usage: { input: 2, output: 2, totalTokens: 4 }, timestamp: 1 });
    if (n === 1) return response([{ type: 'toolCall', id: 'read-1', name: 'Read', arguments: { path: 'src/a.ts' } }, { type: 'toolCall', id: 'glob-1', name: 'Glob', arguments: { pattern: '**/*.ts' } }, { type: 'toolCall', id: 'grep-1', name: 'Grep', arguments: { pattern: 'flowValue', path: 'src' } }, { type: 'toolCall', id: 'list-1', name: 'ListDir', arguments: { path: '.' } }], 'toolUse');
    let text: string;
    if (n === 2) text = `Overview: ${'The repository exports a constant and is used as a deterministic example. '.repeat(5)}`;
    else if (n === 3) text = '<analysis>Document the exported constant and its source.</analysis>';
    else if (n === 4) text = `<documentation_structure>${JSON.stringify([{ name: 'overview', title: 'Overview', prompt: 'Explain the exported constant and repository structure. '.repeat(5), dependent_file: ['src/a.ts'], has_children: 'false', children_plan: '', children: [] }])}</documentation_structure>`;
    else text = `<docs># Overview\n\n${'The repository exports flowValue from src/a.ts as a stable constant. '.repeat(7)}</docs>`;
    const overridden = modelOverride?.(n, text, transcript);
    return response([{ type: 'text', text: overridden ?? text }]);
  } };
  const scope = (op: any) => JSON.stringify([op.repositoryRoot, op.locale]);
  const bridge = createNativeWikiModelBridge({ model, gate: { admit: async op => projection.admit(op, scope(op)), release: async (op, id) => projection.release(op, id), project: async op => projection.apply(op), publication: async (op, summary) => projection.publication(op, summary), stage: async (id, op, stage, detail) => projection.stage(id, op, stage, detail), recover: async op => projection.recover(op), dispatched: async (op, id) => service.recordNativeDispatch(op, id), withSlot: async (_id, work, signal) => { let release!: () => void; const next = new Promise<void>(r => { release = r; }); const previous = slot; slot = next; await previous; try { if (signal.aborted) throw new Error('aborted'); return await work(); } finally { release(); } } } });
  const handlers = new Map<string, any>(), sender = { id: 1, isDestroyed: () => false, send: () => {} }, event = { sender };
  service = new RepoWikiService({ entry: process.env.REPOWIKI_TEST_ENTRY!, dataDir: join(temp, 'wiki'), configurationPollMs: 0, processOptions: { executable: process.env.REPOWIKI_TEST_EXECUTABLE!, maxRestarts: 0 }, projectSnapshot: () => [root], allowedWorkspaces: async () => [root], isTrustedSender: e => e.sender === sender, resolveModel: async () => ({ cacheKey: 'unused', available: false, complete: async () => { throw new Error('legacy model unexpectedly called'); } }), native: bridge, registerCommand: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); } });
  const active = await handlers.get('repoWiki_activate')(event, { workspace: root, language: 'zh' }); const hydrated = await handlers.get('repoWiki_hydrate')(event, { __repoWikiContext: active.context_id });
  const client = createGrenRepoWikiClient({ invoke: (name, input) => handlers.get(name)(event, { ...input, __repoWikiContext: active.context_id }), subscribe: async () => () => {} });
  const invoke = async (command: string, args: any = {}) => (await client.invoke('native', { command, project_id: hydrated.project.id, ...args } as any) as any).value;
  return { temp, base, root, db, views, calls, service, client, invoke, project: hydrated.project, close: async () => { await service.stop(); db.close(); if (dirname(resolve(temp)) !== base || !basename(temp).startsWith('gren-wiki-flow-case-')) throw new Error('Unsafe fixture path'); rmSync(temp, { recursive: true, force: true }); } };
}
async function saveDefault(f: Awaited<ReturnType<typeof fixture>>) { const author = await f.invoke('author.read'); expect(author).toMatchObject({ mode: 'auto', revision: 0 }); return f.invoke('author.save', { author, expected_revision: 0, expected_storage_token: author.storage_token ?? '' }); }
describe('offline native Repo Wiki full flow', () => {
  it('runs default auto generation through public validation, IPC and real child into publication and task view', async () => {
    const f = await fixture(); try {
      await saveDefault(f); const confirmation = await f.invoke('prepare', { intent: 'full', spending_policy: { max_model_requests: 20, max_total_tokens: 2000000 } }); expect(confirmation.spending_policy).toEqual({ max_model_requests: 20, max_total_tokens: 2000000 });
      const args = { confirmation_id: confirmation.confirmation_id, request_id: 'offline-response-lost', confirm_external: true }; const started = await f.invoke('start', args); expect(started.task_id).toBe(`native:${started.id}`); expect((await f.invoke('start', args)).id).toBe(started.id);
      let status: any; const deadline = Date.now() + 45000; do { await pause(100); status = await f.invoke('status', { operation_id: started.id }); if (status.operation.state === 'failed') throw new Error(JSON.stringify(status)); } while ((status.operation.state !== 'completed' || status.projection?.status !== 'ready') && Date.now() < deadline);
      expect(status.operation.state).toBe('completed'); expect(status.publication).toMatchObject({ partial: false, published_count: 1, failed_count: 0 }); expect(status.projection.status).toBe('ready'); const callCount = f.calls.length; expect((await f.invoke('start', args)).id).toBe(started.id); expect(f.calls).toHaveLength(callCount); expect((f.db.prepare("SELECT count(*) AS n FROM agent_jobs WHERE kind='repoWiki.native'").get() as any).n).toBe(1);
      const drafts = await f.invoke('drafts', { operation_id: started.id }); expect(drafts.items.map((x: any) => x.id)).toEqual(expect.arrayContaining(['overview:', 'plan:', 'catalogue-root:'])); expect(drafts.items.find((x: any) => x.id === 'overview:').markdown).toContain('Overview:'); expect(drafts.items.find((x: any) => x.id.startsWith('page:')).markdown).toContain('flowValue');
      expect(f.calls[0].messages[0].toolsAdded.map((t: any) => t.name).sort()).toEqual(['Glob', 'Grep', 'ListDir', 'Read']); expect(JSON.stringify(f.calls[0].messages)).toContain('A committed README for the native overview.'); const results = f.calls[1].messages.filter((m: any) => m.role === 'toolResult'); expect(results.map((m: any) => m.toolName).sort()).toEqual(['Glob', 'Grep', 'ListDir', 'Read']); expect(results.every((m: any) => !m.isError)).toBe(true); expect(JSON.stringify(results)).toContain('flowValue'); expect(f.calls).toHaveLength(5);
      const detail = f.views.readDetail({ source: 'user', id: started.task_id }); expect(detail).toMatchObject({ status: 'completed', workspace: f.root, resource: { language: 'zh' }, nativeWiki: { projectId: f.project.id, operationId: started.id, publication: { projection: { status: 'ready' } } } });
      const project: any = await f.client.invoke('project', { project_id: f.project.id }); expect(project.pages.length).toBeGreaterThan(0); const files = new ProjectFiles(f.root, 'zh').load(); const entries: any[] = Object.values(files.pages).flatMap((x: any) => Object.values(x)); const published = entries.find((x: any) => x.markdown.includes('flowValue')); expect(published).toBeDefined(); const page: any = await f.client.invoke('page', { project_id: f.project.id, slug: published.id }); expect(page.markdown).toBe(published.markdown); const namespace = Object.entries(files.pages).find(([, pages]: any) => pages[published.id])![0]; const id = published.id.split('/').map((part: string) => /^[a-z0-9_-]+$/.test(part) && !part.startsWith('_rw_') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part) ? part : '_rw_' + Buffer.from(part).toString('hex')).join('/'); expect(readFileSync(join(f.root, 'docs/repo-wiki/zh/namespaces', namespace, 'pages', id + '.md'), 'utf8')).toBe(page.markdown); expect(project.pages.find((x: any) => x.id === published.id)?.markdown).toBe(published.markdown);
    } finally { await f.close(); }
  });
  it('publishes and serves a catalogue the model returned as YAML with scalar field shapes', async () => {
    // Same chain as above; only the catalogue-root answer changes to the two shapes that a real
    // model produced when it ignored the JSON instruction (see wikiService/fixtures).
    const yamlCatalogue = (marker: string) => `<documentation_structure>\n\n\`\`\`yaml\n- title: Overview\n  name: overview\n  dependent_file: src/a.ts\n  prompt: Explain the exported constant and repository structure in enough detail to pass the minimum content check. ${marker}\n  children_plan:\n    - 源码结构（src/a.ts 的入口与导出）\n    - 导出常量 flowValue 的用途与不变式\n  has_children: false\n\`\`\`\n\n</documentation_structure>`;
    for (const [label, reply] of [['yaml fence', yamlCatalogue('fenced')], ['json scalar shapes', `<documentation_structure>${JSON.stringify([{ name: 'overview', title: 'Overview', prompt: 'Explain the exported constant and repository structure in enough detail to pass the minimum content check. scalar', dependent_file: 'src/a.ts', has_children: false, children_plan: ['源码结构（src/a.ts 的入口与导出）', '导出常量 flowValue 的用途与不变式'], children: [] }])}</documentation_structure>`]] as const) {
      const f = await fixture(n => n === 4 ? reply : undefined);
      try {
        await saveDefault(f);
        const confirmation = await f.invoke('prepare', { intent: 'full', spending_policy: {} });
        const started = await f.invoke('start', { confirmation_id: confirmation.confirmation_id, request_id: `yaml-${label}`, confirm_external: true });
        let status: any; const deadline = Date.now() + 45000;
        // Publication and the filesystem projection settle independently; wait for both.
        do { await pause(100); status = await f.invoke('status', { operation_id: started.id }); } while ((status.operation.state !== 'completed' || status.projection?.status !== 'ready') && status.operation.state !== 'failed' && Date.now() < deadline);
        expect(status.operation.error ?? null, label).toBeNull();
        expect(status.operation.state, label).toBe('completed');
        expect(status.publication, label).toMatchObject({ published_count: 1, failed_count: 0 });
        expect(status.projection.status, label).toBe('ready');
        // The read side must serve the same body that was projected to disk.
        const files = new ProjectFiles(f.root, 'zh').load();
        const namespace = Object.keys(files.pages)[0];
        const pageId = Object.keys(files.pages[namespace])[0];
        const page: any = await f.client.invoke('page', { project_id: f.project.id, slug: pageId });
        expect(page.markdown, label).toContain('flowValue');
        expect(readFileSync(join(f.root, 'docs/repo-wiki/zh/namespaces', namespace, 'pages', pageId + '.md'), 'utf8'), label).toBe(page.markdown);
      } finally { await f.close(); }
    }
  });
  it('classifies a bad catalogue answer and lets an explicit repair finish the run', async () => {
    // First attempt answers with a catalogue that is genuinely unusable (truncated JSON, no closing
    // structure); the run must fail with a class that names the cause. A repair then reaches the
    // same stage again and must publish, which is the path the "修复失败项" button takes.
    // A repair re-runs the same stage, so the answer must be chosen from the request itself rather
    // than from a global call counter. The first run answers garbage twice; the repaired run answers
    // YAML, which is exactly the shape that used to fail the stage.
    // Identify the stage from the request itself. A repair re-enters catalogue-root with a new
    // operation, so a global call counter cannot distinguish "first run" from "repaired run".
    const garbageReplies = { remaining: 2 };
    const isCatalogueRoot = (request: any) => JSON.stringify(request.messages ?? []).includes('documentation_structure');
    const f = await fixture((n, original, request) => {
      if (!isCatalogueRoot(request)) return undefined;
      if (garbageReplies.remaining > 0) { garbageReplies.remaining--; return `<documentation_structure>[{"title":"Overview","name":"overview","prompt":"Explain the exported constant and repository structure in enough detail."`; }
      // Same YAML-in-a-fence shape that a real model produced and that used to fail the stage.
      return ['<documentation_structure>', '', '```yaml',
        '- title: Overview', '  name: overview', '  dependent_file: src/a.ts',
        '  prompt: Explain the exported constant and repository structure in enough detail to pass the minimum content check. repaired',
        '  children_plan:', '    - 源码结构（src/a.ts 的入口与导出）', '  has_children: false', '```', '',
        '</documentation_structure>'].join('\n');
    });
    try {
      await saveDefault(f);
      const first = await f.invoke('prepare', { intent: 'full', spending_policy: {} });
      const failed = await f.invoke('start', { confirmation_id: first.confirmation_id, request_id: 'bad-catalogue', confirm_external: true });
      let status: any; const deadline = Date.now() + 45000;
      do { await pause(100); status = await f.invoke('status', { operation_id: failed.id }); } while (!['failed', 'completed'].includes(status.operation.state) && Date.now() < deadline);
      expect(status.operation.state).toBe('failed');
      // The code must distinguish a malformed answer from a provider failure or a truncation.
      expect(status.operation.error).toBe('CATALOGUE_OUTPUT_INVALID');
      expect(status.publication).toBeNull();

      const repair = await f.invoke('prepare', { intent: 'repair', operation_id: failed.id });
      const started = await f.invoke('start', { confirmation_id: repair.confirmation_id, request_id: 'repair-after-bad-catalogue', confirm_external: true });
      const repairDeadline = Date.now() + 45000;
      do { await pause(100); status = await f.invoke('status', { operation_id: started.id }); } while ((status.operation.state !== 'completed' || status.projection?.status !== 'ready') && status.operation.state !== 'failed' && Date.now() < repairDeadline);
      expect(status.operation.error ?? null).toBeNull();
      expect(status.operation.state).toBe('completed');
      expect(status.publication).toMatchObject({ partial: false, published_count: 1 });
      const files = new ProjectFiles(f.root, 'zh').load();
      const namespace = Object.keys(files.pages)[0];
      const pageId = Object.keys(files.pages[namespace])[0];
      expect((await f.client.invoke('page', { project_id: f.project.id, slug: pageId }) as any).markdown).toContain('flowValue');
    } finally { await f.close(); }
  });
  it('rejects dirty source and invalid public requests without provider calls', async () => { const f = await fixture(); try { await saveDefault(f); await expect(f.client.invoke('native', { command: 'author.read', project_id: f.project.id, dataDir: f.temp } as any)).rejects.toThrow(); await expect(f.invoke('start', { confirmation_id: 'expired', request_id: 'x', confirm_external: true })).rejects.toThrow('CONFIRMATION_EXPIRED'); await expect(f.invoke('start', { confirmation_id: 'expired', request_id: 'x', confirm_external: false })).rejects.toThrow(); await expect(f.client.invoke('project', { project_id: 'other' })).rejects.toThrow(); writeFileSync(join(f.root, 'src/a.ts'), 'uncommitted change\n'); const confirmation = await f.invoke('prepare', { intent: 'full', spending_policy: {} }); const started = await f.invoke('start', { confirmation_id: confirmation.confirmation_id, request_id: 'dirty-source', confirm_external: true }); let status: any; const deadline = Date.now() + 15000; do { await pause(100); status = await f.invoke('status', { operation_id: started.id }); } while (!['failed', 'completed'].includes(status.operation.state) && Date.now() < deadline); expect(status.operation).toMatchObject({ state: 'failed', error: 'DIRTY_WORKTREE_REQUIRES_REVIEW' }); expect(f.calls).toHaveLength(0); } finally { await f.close(); } });
});
