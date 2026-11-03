/** Manual-only, offline native service + actual project-file projection workflow. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceService } from '../../vendor/repo-wiki/packages/service/src/service';
import { ProjectFiles } from '../../vendor/repo-wiki/packages/core/src/project-files';
import { hash } from '../../vendor/repo-wiki/packages/core/src/scanner';
import { NativeWikiProjectAdapter } from './projectAdapter';
import { WikiStore } from './store';
import { WikiService } from './service';
import { createWikiExecutor } from './runner';
import type { WikiStartInput } from './contracts';
import type { WikiModelRequest, WikiModelTurn } from './sessionRuntime';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const delay = () => new Promise<void>(resolve => setTimeout(resolve, 10));
function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'native-wiki-fixture-')); roots.push(temporary);
  const repository = join(temporary, 'repository'); mkdirSync(join(repository, 'src'), { recursive: true });
  writeFileSync(join(repository, 'src', 'a.ts'), 'export const value = 1;\n'); writeFileSync(join(repository, 'excluded.txt'), 'outside source scope\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT:'0', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Native fixture'); git('add', 'src/a.ts', 'excluded.txt'); git('commit', '-m', 'fixture initial');
  const workspace = new WorkspaceService({ dataDir: join(temporary, 'workspace'), allowedRoots: [repository], watchInterval: 0, automaticGeneration: false });
  const store = new WikiStore(join(temporary, 'native'));
  const modelCalls: Array<{ purpose: string; prompt: string; system: string }> = [];
  const golden = JSON.parse(readFileSync(new URL('./reference/qoder-0.5.1/render-fixtures.json', import.meta.url), 'utf8')) as { cases: Array<{ purpose: string; systemPrompt: string }> };
  const referencePage = golden.cases.find(item => item.purpose === 'wiki.full.page');
  if (!referencePage?.systemPrompt.includes('Call only the exact tool names supplied in this request.')) throw new Error('FIXTURE_REFERENCE_MISSING');
  let failBeta = true, gate: { entered(): void; wait: Promise<void> } | undefined;
  const model = async (request: WikiModelRequest): Promise<WikiModelTurn> => {
    const prompt = request.messages[0].content; modelCalls.push({ purpose: request.purpose, prompt, system: request.systemPrompt });
    if (request.purpose === 'wiki.full.page' && !request.systemPrompt.includes('Call only the exact tool names supplied in this request.')) throw new Error('FIXTURE_REFERENCE_PROMPT_MISMATCH');
    if (gate && request.purpose === 'wiki.full.page') { const current = gate; gate = undefined; current.entered(); await current.wait; }
    if (request.purpose === 'wiki.incremental.commit-analysis') return { text: '<commit_summary>Changed a.ts.</commit_summary>', stopReason: 'done', usage: { totalTokens: 2 } };
    if (request.purpose === 'wiki.incremental.catalogue-analysis') return { text: '<documentation_structure>[{"action":"update","target_ref":"W001","change_reason":"Source changed","dependent_file":["src/a.ts"]}]</documentation_structure>', stopReason: 'done', usage: { totalTokens: 2 } };
    if (request.purpose === 'wiki.full.page' && prompt.includes('Beta objective') && failBeta) return { text: 'model failure', stopReason: 'error', usage: { totalTokens: 2 } };
    if (!['wiki.full.page', 'wiki.incremental.page-update'].includes(request.purpose)) throw new Error(`unexpected fixture purpose ${request.purpose}`);
    const title = prompt.includes('Beta objective') ? 'Beta' : 'Alpha';
    const variant = request.purpose === 'wiki.incremental.page-update' ? 'updated source' : 'initial source';
    return { text: `<docs># ${title}\n\n${variant} ${'documented repository behavior '.repeat(20)}</docs>`, stopReason: 'done', usage: { totalTokens: 2 } };
  };
  const service = new WikiService(store, { admission: { acquire: async () => ({ release() {} }) }, executeOperation: createWikiExecutor({ requestModel: model }) });
  const adapter = new NativeWikiProjectAdapter(workspace);
  return { temporary, repository: realpathSync(repository), git, workspace, store, service, adapter, modelCalls,
    succeedBeta: () => { failBeta = false; }, hold: (value: typeof gate) => { gate = value; },
    close: async () => { await service.close(); store.close(); await workspace.close(); } };
}
async function createProject(f: ReturnType<typeof fixture>) {
  const project = await f.workspace.dispatch('create', { path: f.repository, language: 'zh' }) as { id: string };
  const prepared = await f.adapter.invoke('native.project.prepare', { projectId: project.id }) as { branch: string; targetCommit: string };
  return { id: project.id, ...prepared };
}
function input(f: ReturnType<typeof fixture>, project: Awaited<ReturnType<typeof createProject>>, requestId: string): WikiStartInput {
  return { requestId, projectId: project.id, repositoryRoot: f.repository, branch: project.branch, locale: 'zh', action: 'full', targetCommit: f.git('rev-parse', 'HEAD'), engine: 'qoder-wiki-local-v1', templateVersion: 'qoder-0.5.1', model: { id: 'offline-fixed' },
    author: { mode:'pages', constraints:[], notes:[], pages:[{ id:'alpha', title:'Alpha', prompt:'Alpha objective', children:[] }, { id:'beta', title:'Beta', prompt:'Beta objective', children:[] }] },
    plan: { include:['src/**'], exclude:[] }, spendingPolicy: {}, effectiveProfile: {}, authorization: { confirmed:true } };
}
function pageFile(f: ReturnType<typeof fixture>, branch: string, id: string) { return join(f.repository, 'docs', 'repo-wiki', 'zh', 'namespaces', hash([branch, 'zh']).slice(0,24), 'pages', `${id}.md`); }

describe('manual offline native workflow', () => {
  it('persists idempotent partial results, replays filesystem projection, repairs, advances without model and updates', async () => {
    const f = fixture();
    try {
      const project = await createProject(f), files = new ProjectFiles(f.repository, 'zh'), ns = hash([project.branch, 'zh']).slice(0,24);
      // Seed a legacy page in the same namespace before native publication.
      const initial = files.load(); initial.pages[ns] = { ...(initial.pages[ns] ?? {}), legacy: { id:'legacy', title:'Legacy', markdown:'# Legacy\n\nKeep human text.', baseline:'# Legacy\n\nKeep human text.', status:'edited', revision:1, sources:[], dependencies:[] } };
      initial.snapshots[ns] = { ...(initial.snapshots[ns] ?? {}), identity:{ branch:project.branch, language:'zh' }, hashes:{}, edges:[] }; files.commit(initial);
      const start = input(f, project, 'accepted-response-lost'); const accepted = f.service.start(start);
      expect(f.service.start(start).id).toBe(accepted.id); // Simulate lost response and retry same request.
      expect(f.store.list()).toHaveLength(1);
      await f.service.run(accepted.id);
      const finished = f.service.query(accepted.id); expect(finished.state).toBe('completed');
      const partial = f.service.partition(project.branch, 'zh')!; expect(partial.coverage).toMatchObject({ partial:true, planned:2, published:1, failed:['beta'] });
      expect(f.modelCalls.filter(call => call.purpose === 'wiki.full.page' && call.prompt.includes('Beta objective'))).toHaveLength(2);
      const publicationEvent = f.service.outbox().find(event => event.kind === 'publication' && event.id === partial.id)!; expect(publicationEvent).toBeDefined();
      const beforeReplayCalls = f.modelCalls.length;
      // Block the real project lock after SQLite commit, then release and replay the same publication.
      const lock = join(f.repository, 'docs/repo-wiki/zh/.write-lock'); writeFileSync(lock, JSON.stringify({ pid:process.pid, instance:'fixture-held' }));
      try { await expect(f.adapter.invoke('native.project.project', { projectId:project.id, publication:partial })).rejects.toThrow(); } finally { if (existsSync(lock)) unlinkSync(lock); }
      expect(f.service.partition(project.branch, 'zh')?.id).toBe(partial.id);
      expect(await f.adapter.invoke('native.project.project', { projectId:project.id, publication:partial })).toMatchObject({ status:'ready', publication_id:partial.id });
      expect(f.modelCalls).toHaveLength(beforeReplayCalls);
      f.service.ackOutbox(publicationEvent.id); expect(f.service.outbox().some(event => event.id === publicationEvent.id)).toBe(false);
      let projected = new ProjectFiles(f.repository, 'zh').load(); expect(projected.pages[ns].legacy.markdown).toContain('Keep human text'); expect(projected.pages[ns].alpha.markdown).toContain('initial source');
      const alphaFile = pageFile(f, project.branch, 'alpha'); writeFileSync(alphaFile, readFileSync(alphaFile, 'utf8') + '\nHuman edit preserved.\n');
      f.succeedBeta(); const repair = f.service.start({ ...start, requestId:'repair-only', action:'repair', parentOperationId:accepted.id, expectedRevision:finished.revision });
      const alphaCallsBefore = f.modelCalls.filter(call => call.purpose === 'wiki.full.page' && call.prompt.includes('Alpha objective')).length;
      await f.service.run(repair.id); const repaired = f.service.partition(project.branch, 'zh')!;
      expect(repaired.coverage).toMatchObject({ partial:false, planned:2, published:2, failed:[] });
      expect(f.modelCalls.filter(call => call.purpose === 'wiki.full.page' && call.prompt.includes('Alpha objective'))).toHaveLength(alphaCallsBefore);
      await f.adapter.invoke('native.project.project', { projectId:project.id, publication:repaired, previousPublicationId:partial.id });
      projected = new ProjectFiles(f.repository, 'zh').load(); expect(projected.pages[ns].alpha.markdown).toContain('Human edit preserved.'); expect(projected.pages[ns].legacy.markdown).toContain('Keep human text');
      writeFileSync(join(f.repository, 'excluded.txt'), 'excluded-only commit\n'); f.git('add', 'excluded.txt'); f.git('commit', '-m', 'excluded only');
      const advance = f.service.start({ ...start, requestId:'advance', action:'sync', targetCommit:f.git('rev-parse','HEAD') }); const beforeAdvance = f.modelCalls.length;
      await f.service.run(advance.id); const advanced = f.service.partition(project.branch, 'zh')!;
      expect(advanced.baseline).toBe(advance.targetCommit); expect(f.modelCalls).toHaveLength(beforeAdvance); expect(advanced.pages).toEqual(repaired.pages);
      await f.adapter.invoke('native.project.project', { projectId:project.id, publication:advanced, previousPublicationId:repaired.id });
      writeFileSync(join(f.repository, 'src', 'a.ts'), 'export const value = 2;\n'); f.git('add', 'src/a.ts'); f.git('commit', '-m', 'source change');
      const update = f.service.start({ ...start, requestId:'incremental', action:'update', targetCommit:f.git('rev-parse','HEAD') }); await f.service.run(update.id);
      const updated = f.service.partition(project.branch, 'zh')!; expect(updated.baseline).toBe(update.targetCommit);
      expect((updated.pages.alpha as { markdown:string }).markdown).toContain('updated source');
      await f.adapter.invoke('native.project.project', { projectId:project.id, publication:updated, previousPublicationId:advanced.id });
      projected = new ProjectFiles(f.repository, 'zh').load(); expect(projected.pages[ns].alpha.markdown).toContain('Human edit preserved.'); expect(projected.pages[ns].legacy.markdown).toContain('Keep human text');
      expect(f.modelCalls.map(call => call.purpose)).toContain('wiki.incremental.catalogue-analysis');
    } finally { await f.close(); }
  }, 60_000);

  it('waits for the real runner to drain before pause, then explicitly resumes', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    try {
      const project = await createProject(f); f.succeedBeta();
      let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
      f.hold({ entered, wait: blocked }); const op = f.service.start(input(f, project, 'pause-drain'));
      const running = f.service.run(op.id); await Promise.race([ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fixed provider was not reached')), 10_000))]);
      const pausing = f.service.control(op.id, 'pause', f.service.query(op.id).revision); expect(pausing.state).toBe('pausing');
      let settled = false; void running.then(() => { settled = true; }); await delay(); expect(settled).toBe(false);
      release!(); await running; expect(f.service.query(op.id).state).toBe('paused');
      const resumed = f.service.control(op.id, 'resume', f.service.query(op.id).revision); expect(resumed.state).toBe('queued');
      await f.service.run(op.id); expect(f.service.query(op.id).state).toBe('completed');
    } finally { release?.(); await f.close(); }
  }, 60_000);
});
