import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRepoWikiHost, REPO_WIKI_HOST_ENTRY } from '../agent/repoWikiHostBuild';
import { RepoWikiService, type RepoWikiServiceOptions } from './repoWikiService';
import { WorkspaceService } from './workspaceService';
import { RepoWikiProcessClient } from '../../vendor/repo-wiki/packages/process/src/client';

const require = createRequire(import.meta.url);
const evidenceDir = resolve('..', '.tmp-repowiki-optimization');
const cleanup: Array<() => Promise<unknown>> = [];
let buildDir: string;
let sourceIdentity: string;
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'repo-wiki-lazy-build-'));
  const bundle = await buildRepoWikiHost(resolve('.'), buildDir);
  const sources = [...new Set([
    ...Object.keys(bundle.metafile!.inputs),
    'electron/app/repoWikiService.ts', 'electron/app/workspaceService.ts',
    'vendor/repo-wiki/packages/contracts/src/host.ts',
  ])].sort();
  const hashes = Object.fromEntries(await Promise.all(sources.map(async (file) =>
    [file, createHash('sha256').update(await readFile(resolve(file))).digest('hex')])));
  sourceIdentity = createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, 'task-5-source-snapshot.json'), JSON.stringify({
    builtAt: new Date().toISOString(), sourceIdentity, hostBundle: REPO_WIKI_HOST_ENTRY,
    boundary: 'Hashes of freshly bundled child inputs plus production host service/registry/host DTO; main test runner imports current source separately',
    hashes,
  }, null, 2));
}, 45_000);
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
afterAll(async () => { if (buildDir) await rm(buildDir, { recursive: true, force: true }); });

async function setup(seedLegacy = false) {
  const root = await mkdtemp(join(tmpdir(), 'repo-wiki-lazy-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = new WorkspaceService(join(root, 'agent'));
  const paths = Array.from({ length: 7 }, (_, index) => join(root, `project-${index + 1}`));
  for (const path of paths) {
    await mkdir(path);
    await writeFile(join(path, 'README.md'), '# Fixture\nLocal source only.\n');
    await writeFile(join(path, 'wiki_plan.json'), JSON.stringify({ include: ['README.md'], exclude: [],
      pages: [{ id: 'overview', title: 'Overview', goal: 'Document source', patterns: ['README.md'], depends_on: [] }] }));
    await workspace.ensureWorkspace(path);
  }
  const legacyPath = join(root, 'wiki', 'workspace.sqlite3');
  let legacyBytes: Buffer | undefined;
  if (seedLegacy) {
    await mkdir(join(root, 'wiki'));
    const db = new DatabaseSync(legacyPath);
    try {
      db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE pages(project_id TEXT,namespace TEXT,slug TEXT,data TEXT,PRIMARY KEY(project_id,namespace,slug)); CREATE TABLE snapshots(project_id TEXT,namespace TEXT,data TEXT,PRIMARY KEY(project_id,namespace)); CREATE TABLE revisions(id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE generation_cache(fingerprint TEXT PRIMARY KEY,data TEXT);');
      db.prepare('INSERT INTO revisions VALUES (?)').run(1);
      for (const [index, path] of paths.entries()) {
        const id = `legacy-${index + 1}`, namespace = '56b177511d9eabc175c73a0b';
        const plan = { include: ['README.md'], exclude: [], pages: [{ id: 'overview', title: 'Overview', goal: 'Legacy document', patterns: ['README.md'], depends_on: [] }] };
        db.prepare('INSERT INTO projects VALUES (?,?)').run(id, JSON.stringify({ id, path, language: 'zh', name: `Legacy ${index + 1}`, watch: false, plan }));
        db.prepare('INSERT INTO pages VALUES (?,?,?,?)').run(id, namespace, 'overview', JSON.stringify({ id: 'overview', title: 'Overview', kind: 'wiki',
          markdown: `# Human legacy ${index + 1}\n`, baseline: `# Generated legacy ${index + 1}\n`, pending_markdown: null, sources: [], status: 'edited', revision: 1 }));
        db.prepare('INSERT INTO snapshots VALUES (?,?,?)').run(id, namespace, JSON.stringify({ hashes: {}, edges: [], identity: { branch: 'local', language: 'zh' } }));
      }
    } finally { db.close(); }
    legacyBytes = await readFile(legacyPath);
  }
  const commands = new Map<string, (event: any, args: any) => Promise<any>>();
  const events: any[] = [];
  const sender = { id: 901, isDestroyed: () => false, send: (...args: any[]) => events.push(args) };
  let authorityReads = 0, modelResolutions = 0;
  const options = {
    entry: join(buildDir, REPO_WIKI_HOST_ENTRY), dataDir: join(root, 'wiki'), configurationPollMs: 0,
    processOptions: { executable: require('electron'), maxRestarts: 0, requestTimeoutMs: 15_000 },
    registerCommand: (name: string, handler: any) => { commands.set(name, handler); return () => { commands.delete(name); }; },
    allowedWorkspaces: async () => { authorityReads++; return workspace.readProjectSnapshot(); },
    projectSnapshot: () => workspace.getProjectSnapshot(),
    isConversationWorkspaceSnapshot: (path: string) => workspace.isConversationWorkspaceSnapshot(path),
    isConversationWorkspace: (path: string) => workspace.isConversationWorkspace(path),
    isTrustedSender: (event: any) => event.sender === sender,
    resolveModel: async () => {
      modelResolutions++;
      return { cacheKey: 'offline', available: false, complete: async () => { throw new Error('No model is expected while reading metadata'); } };
    },
  } satisfies RepoWikiServiceOptions;
  const service = new RepoWikiService(options);
  cleanup.push(() => service.stop());
  const call = async (name: string, args: any = {}, event: any = { sender }) => {
    const handler = commands.get(`repoWiki_${name}`);
    if (!handler) throw new Error(`Missing command repoWiki_${name}`);
    return handler(event, args);
  };
  return { root, paths, workspace, service, call, events, legacyPath, legacyBytes, get authorityReads() { return authorityReads; }, get modelResolutions() { return modelResolutions; } };
}

describe('Repo Wiki lazy host with real OS child and isolated project files', () => {
  // Reintroducing eager authority/model/child preparation makes this fail before
  // the renderer could receive a bound context for the seven host registrations.
  it('binds seven registered projects without authority I/O, model resolution, child startup or project writes', async () => {
    const t = await setup(true);
    const started = performance.now();
    const active = await t.call('activate', { workspace: t.paths[0] });
    const activationMs = performance.now() - started;
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'cold-activation-sample.json'), JSON.stringify({
      at: new Date().toISOString(), activationMs, platform: process.platform, node: process.version,
      sourceIdentity, sourceSnapshotFile: 'task-5-source-snapshot.json',
      registrations: 7, root: t.root, childPid: t.service.pid ?? null, authorityReads: t.authorityReads, modelResolutions: t.modelResolutions,
      boundary: 'API only; seven newly registered temp projects and seven seeded legacy DB records; in-memory WorkspaceService snapshot primed; real production service; child build excluded from measured interval; no renderer paint or OneDrive cold filesystem measurement',
      oldSampleMs: 33_480, oldSampleBoundary: 'Earlier observed real seven-project activation; different source/data/cache state, not a matched statistical benchmark',
    }, null, 2));
    console.info(`cold activation API ${activationMs.toFixed(3)}ms; child=${t.service.pid ?? 'none'} authority=${t.authorityReads} model=${t.modelResolutions}`);
    expect(active).toMatchObject({ workspace: t.paths[0], project_id: null, status: 'bound', language: 'zh', projects_revision: expect.any(Number) });
    expect(t.service.pid).toBeUndefined();
    expect(t.authorityReads).toBe(0);
    expect(t.modelResolutions).toBe(0);
    expect(activationMs).toBeLessThan(250);
    const snapshot = await t.call('hostProjects');
    expect(snapshot).toMatchObject({ state: 'ready', revision: active.projects_revision });
    expect(snapshot.projects.map((item: any) => item.path)).toEqual(t.paths);
    expect(snapshot.projects.every((item: any) => typeof item.key === 'string' && typeof item.name === 'string' && !('id' in item))).toBe(true);
    for (const path of t.paths) expect(existsSync(join(path, 'docs', 'repo-wiki'))).toBe(false);
    expect(existsSync(join(t.root, 'wiki', 'project-index.sqlite3'))).toBe(false);
    expect(await readFile(t.legacyPath)).toEqual(t.legacyBytes);
    expect(t.authorityReads).toBe(0);
    expect(t.modelResolutions).toBe(0);
  });

  // Returning cached metadata must remain possible even when the source plan
  // becomes unreadable; scanning any of the other six roots is also a bug.
  it('hydrates only the current root and reads metadata without a source scan or a model lease', async () => {
    const t = await setup(true);
    const active = await t.call('activate', { workspace: t.paths[0] });
    for (const path of t.paths.slice(1)) await writeFile(join(path, 'wiki_plan.json'), 'invalid source plan: this root must remain unopened');
    const input = { __repoWikiContext: active.context_id };
    const hydrated = await t.call('hydrate', input);
    expect(hydrated).toMatchObject({ context_id: active.context_id, project: { path: t.paths[0], language: 'zh' } });
    expect(hydrated.project.id).toMatch(/^[a-f0-9]{24}$/);
    expect(hydrated.project.portable_id).toBe('legacy-1');
    expect(t.service.pid).toBeTypeOf('number');
    const pid = t.service.pid;
    expect(existsSync(join(t.paths[0], 'docs', 'repo-wiki', 'zh', 'project.json'))).toBe(true);
    const migratedManifest = JSON.parse(await readFile(join(t.paths[0], 'docs', 'repo-wiki', 'zh', 'project.json'), 'utf8'));
    expect(migratedManifest.id).toBe('legacy-1');
    for (const path of t.paths.slice(1)) expect(existsSync(join(path, 'docs', 'repo-wiki'))).toBe(false);
    await writeFile(join(t.paths[0], 'wiki_plan.json'), 'invalid source plan: status reads must not scan');
    const projectId = hydrated.project.id;
    const [project, changes, run, projects, health] = await Promise.all([
      t.call('project', { ...input, project_id: projectId }), t.call('changes', { ...input, project_id: projectId }),
      t.call('run', { ...input, project_id: projectId }), t.call('projects', input), t.call('health', input),
    ]);
    expect(project.id).toBe(projectId);
    expect(changes).toBeTypeOf('object'); expect(run.status).toBeTypeOf('string');
    expect(projects).toHaveLength(1); expect(health.status).toBe('ok');
    expect(t.service.pid).toBe(pid); expect(t.modelResolutions).toBe(0);
    expect((await t.call('page', { ...input, project_id: projectId, slug: 'overview' })).markdown).toBe('# Human legacy 1\n');
    expect(await readFile(t.legacyPath)).toEqual(t.legacyBytes);
    const migrationEvidence = join(evidenceDir, 'task-5-current-root-migration');
    await mkdir(migrationEvidence, { recursive: true });
    await cp(join(t.paths[0], 'docs', 'repo-wiki'), join(migrationEvidence, 'repo-wiki'), { recursive: true });
    await writeFile(join(migrationEvidence, 'migration-evidence.json'), JSON.stringify({ seededLegacyProjects: 7, migratedProject: projectId,
      portableId: hydrated.project.portable_id, diskProjectId: migratedManifest.id,
      legacySha256Unchanged: createHash('sha256').update(t.legacyBytes!).digest('hex'), unhydratedRoots: t.paths.slice(1),
      otherSixDocumentDirectoriesAbsent: true, authorityModelCalls: t.modelResolutions }, null, 2));
    await expect(t.call('hydrate', { __repoWikiContext: 'unauthorized' })).rejects.toMatchObject({ status: 409 });
    await expect(t.call('hydrate', input, { sender: { id: 902 } })).rejects.toMatchObject({ status: 403 });
  }, 45_000);

  // A synchronous scanner in the child would finish the whole walk before it
  // could answer health/run/cancel, and would reach the completion callback.
  it('answers health and run while a real source scan is in flight and cancels before provider dispatch', async () => {
    const t = await setup();
    const source = join(t.paths[0], 'source');
    await mkdir(source);
    const contents = `export const fixture = '${'x'.repeat(96 * 1024)}';\n`;
    for (let batch = 0; batch < 25; batch++) await Promise.all(Array.from({ length: 40 }, (_, offset) =>
      writeFile(join(source, `part-${String(batch * 40 + offset).padStart(4, '0')}.ts`), contents)));
    let modelCalls = 0;
    const client = new RepoWikiProcessClient({ entry: join(buildDir, REPO_WIKI_HOST_ENTRY), executable: require('electron'),
      dataDir: join(t.root, 'scan-index'), allowedRoots: [t.paths[0]], maxRestarts: 0,
      modelCacheKey: 'local-never-dispatch', complete: async () => { modelCalls++; throw new Error('Scan cancel must prevent model dispatch'); } });
    cleanup.push(() => client.stop());
    const project = await client.invoke('create', { path: t.paths[0], language: 'zh' });
    await client.invoke('plan', { project_id: project.id, plan: { include: ['**'], exclude: [],
      pages: [{ id: 'overview', title: 'Overview', goal: 'Document all fixture source', patterns: ['**'], depends_on: [] }] } });
    let scanning!: () => void;
    const enteredScan = new Promise<void>((resolveScan) => { scanning = resolveScan; });
    const unsubscribe = client.subscribe((event) => { if (event.project_id === project.id && event.run.stage === 'scanning') scanning(); });
    cleanup.push(async () => unsubscribe());
    await client.invoke('generate', { project_id: project.id, provider: 'real', confirm_external: true });
    await Promise.race([enteredScan, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('No real scanning progress')), 10_000); timer.unref(); })]);
    const started = performance.now();
    const [health, run] = await Promise.all([client.invoke('health', {}), client.invoke('run', { project_id: project.id })]);
    const statusMs = performance.now() - started;
    expect(health.status).toBe('ok'); expect(run.stage).toBe('scanning');
    expect(statusMs).toBeLessThan(1000);
    await client.invoke('cancel', { project_id: project.id });
    await vi.waitFor(async () => expect((await client.invoke('run', { project_id: project.id })).status).toBe('canceled'), { timeout: 10_000 });
    expect(modelCalls).toBe(0);
    expect((await client.invoke('project', { project_id: project.id })).pages).toEqual([]);
    const identityBeforeTimeout = (await client.invoke('project', { project_id: project.id })).current_identity;
    client.options.requestTimeoutMs = 1;
    try { await expect(client.invoke('scan', { project_id: project.id })).rejects.toMatchObject({ status: 504 }); }
    finally { client.options.requestTimeoutMs = 15_000; }
    expect((await client.invoke('health', {})).status).toBe('ok');
    expect((await client.invoke('project', { project_id: project.id })).current_identity).toEqual(identityBeforeTimeout);
    const retryStarted = performance.now();
    expect(await client.invoke('scan', { project_id: project.id })).toHaveProperty('identity');
    const retryScanMs = performance.now() - retryStarted;
    expect(modelCalls).toBe(0);
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'scan-responsiveness-sample.json'), JSON.stringify({ statusMs, files: 1000, bytesPerFile: Buffer.byteLength(contents),
      sourceIdentity, sourceSnapshotFile: 'task-5-source-snapshot.json',
      health: health.status, runStageWhenRead: run.stage, finalStatus: 'canceled', modelCalls, pid: client.pid,
      explicitScanTimeoutMs: 1, timedOutScanDidNotPublishIdentity: true, retryScanMs }, null, 2));
    console.info(`real scan health/run API ${statusMs.toFixed(3)}ms; canceled before model dispatch`);
  }, 60_000);

  // The DB must be disposable: only project files can preserve this edit once
  // the fixture's real OS child and complete new cache have both been removed.
  it('rebuilds the real child index after deletion without losing Markdown edits or revision metadata', async () => {
    const t = await setup();
    const dataDir = join(t.root, 'standalone-index');
    const options = { entry: join(buildDir, REPO_WIKI_HOST_ENTRY), executable: require('electron'), dataDir, allowedRoots: [t.paths[0]], maxRestarts: 0 };
    const first = new RepoWikiProcessClient(options); cleanup.push(() => first.stop());
    const project = await first.invoke('create', { path: t.paths[0], language: 'zh' });
    await first.invoke('generate', { project_id: project.id, provider: 'demo' });
    await vi.waitFor(async () => expect((await first.invoke('run', { project_id: project.id })).status).toBe('completed'), { timeout: 15_000 });
    const original = await first.invoke('page', { project_id: project.id, slug: 'overview' });
    const edited = await first.invoke('edit', { project_id: project.id, slug: 'overview', expected_revision: original.revision,
      markdown: '# Human edit\nThis Markdown survives the deleted disposable cache.\n' });
    const firstPid = first.pid;
    await first.stop();
    expect(existsSync(join(dataDir, 'project-index.sqlite3'))).toBe(true);
    for (const suffix of ['', '-wal', '-shm']) await rm(join(dataDir, `project-index.sqlite3${suffix}`), { force: true });
    const second = new RepoWikiProcessClient(options); cleanup.push(() => second.stop());
    const restored = await second.invoke('create', { path: t.paths[0], language: 'zh' });
    expect(restored.id).toBe(project.id);
    expect(restored.portable_id).toBe(project.portable_id);
    const page = await second.invoke('page', { project_id: restored.id, slug: 'overview' });
    expect(page).toMatchObject({ markdown: edited.markdown, baseline: edited.baseline, revision: edited.revision, status: 'edited', sources: edited.sources });
    expect(existsSync(join(dataDir, 'project-index.sqlite3'))).toBe(true);
    const manifest = JSON.parse(await readFile(join(t.paths[0], 'docs', 'repo-wiki', 'zh', 'project.json'), 'utf8'));
    expect(manifest.id).toBe(project.portable_id);
    const filesEvidence = join(evidenceDir, 'task-5-index-rebuild');
    await mkdir(filesEvidence, { recursive: true });
    await cp(join(t.paths[0], 'docs', 'repo-wiki'), join(filesEvidence, 'repo-wiki'), { recursive: true });
    await writeFile(join(filesEvidence, 'rebuild-evidence.json'), JSON.stringify({ projectId: project.id, portableId: project.portable_id,
      diskProjectId: manifest.id, firstPid, restoredPid: second.pid,
      deletedFixtureCache: join(dataDir, 'project-index.sqlite3'), original, edited, restored: page }, null, 2));
  }, 60_000);
});
