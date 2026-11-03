import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRepoWikiHost, REPO_WIKI_HOST_ENTRY } from '../agent/repoWikiHostBuild';
import { WorkspaceService } from './workspaceService';
import { RepoWikiService } from './repoWikiService';
import { RepoWikiProcessClient } from '../../vendor/repo-wiki/packages/process/src/client';

const require = createRequire(import.meta.url);
let buildDir: string;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'repo-wiki-project-build-'));
  await buildRepoWikiHost(resolve('.'), buildDir);
});
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
afterAll(async () => { await rm(buildDir, { recursive: true, force: true }); });

async function setup(maxRestarts = 1) {
  const root = await mkdtemp(join(tmpdir(), 'repo-wiki-project-host-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'project-a'), b = join(root, 'project-b');
  await mkdir(a); await mkdir(b);
  await writeFile(join(a, 'README.md'), '# A\nLocal project A.');
  await writeFile(join(a, 'wiki_plan.json'), JSON.stringify({ include: ['**'], exclude: [], pages: [{ id: 'overview', title: 'Overview', goal: 'Document source', patterns: ['**'], depends_on: [] }] }));
  const workspace = new WorkspaceService(join(root, 'agent'));
  const commands = new Map<string, (event: any, input: any) => Promise<any>>();
  const sent: any[] = [];
  const sender = { id: 1, isDestroyed: () => false, send: (...args: any[]) => sent.push(args) };
  const event = { sender };
  const service = new RepoWikiService({
    entry: join(buildDir, REPO_WIKI_HOST_ENTRY), dataDir: join(root, 'wiki'),
    configurationPollMs: 0, processOptions: { executable: require('electron'), maxRestarts, restartDelayMs: 20 },
    registerCommand: (name, handler) => { commands.set(name, handler); return () => { commands.delete(name); }; },
    allowedWorkspaces: () => workspace.readProjectSnapshot(),
    projectSnapshot: () => workspace.getProjectSnapshot(),
    isConversationWorkspaceSnapshot: (cwd) => workspace.isConversationWorkspaceSnapshot(cwd),
    isConversationWorkspace: (cwd) => workspace.isConversationWorkspace(cwd),
    isTrustedSender: (e) => e.sender === sender,
    resolveModel: async () => ({ cacheKey: 'offline', available: false, complete: async () => { throw new Error('No model call is expected'); } }),
  });
  cleanup.push(() => service.stop());
  const call = async (name: string, input: any = {}) => commands.get(`repoWiki_${name}`)!(event, input);
  const enter = async (path: string, language = 'zh', retry = false) => {
    const active = await call('activate', { workspace: path, language, ...(retry ? { retry: true } : {}) });
    const hydrated = await call('hydrate', { __repoWikiContext: active.context_id });
    return { ...active, project_id: hydrated.project.id };
  };
  return { root, a, b, workspace, service, call, enter, sent };
}

describe('RepoWiki host project projection with the real child', () => {
  it('keeps an exhausted real supervisor stopped until an explicit activation retry', async () => {
    const t = await setup(0); await t.workspace.ensureWorkspace(t.a);
    const active = await t.enter(t.a);
    const pid = t.service.pid!;
    process.kill(pid);
    await vi.waitFor(() => {
      expect(t.service.pid).toBeUndefined();
      expect(t.sent.some((event) => event[0] === 'gren:event:repoWiki://workspaces')).toBe(true);
    }, { timeout: 10_000 });
    const bound = await t.call('activate', { workspace: t.a });
    expect(bound.status).toBe('bound');
    await expect(t.call('hydrate', { __repoWikiContext: bound.context_id })).rejects.toMatchObject({ status: 503 });
    await expect(t.call('hydrate', { __repoWikiContext: bound.context_id })).rejects.toMatchObject({ status: 503 });
    expect(t.service.pid).toBeUndefined();
    const recovered = await t.enter(t.a, 'zh', true);
    expect(recovered).toMatchObject({ status: 'bound', project_id: active.project_id });
    expect(recovered.context_id).not.toBe(active.context_id);
    expect(t.service.pid).toBeTypeOf('number');
    expect((await t.call('health', { __repoWikiContext: recovered.context_id })).status).toBe('ok');
  }, 60_000);

  it('switches real language namespaces on one authorized path and reenters from the collection', async () => {
    const t = await setup();
    await t.workspace.ensureWorkspace(t.a); await t.workspace.ensureWorkspace(t.b);
    const zh = await t.enter(t.a);
    const en = await t.call('create', { path: t.a, language: 'en', __repoWikiContext: zh.context_id });
    expect(en.id).not.toBe(zh.project_id);
    const enActive = await t.enter(t.a, 'en');
    expect(enActive).toMatchObject({ project_id: en.id });
    expect(enActive.context_id).not.toBe(zh.context_id);
    const back = await t.enter(t.a, 'zh');
    expect(back).toMatchObject({ project_id: zh.project_id, status: 'bound' });
    expect(back.context_id).not.toBe(zh.context_id);
    const b = await t.enter(t.b);
    await expect(t.call('project', { project_id: zh.project_id, __repoWikiContext: b.context_id })).rejects.toMatchObject({ status: 403 });
    await t.call('activate', { workspace: null });
    const entered = await t.enter(t.a, 'en');
    expect(entered).toMatchObject({ status: 'bound', project_id: en.id });
    expect((await t.call('project', { project_id: en.id, __repoWikiContext: entered.context_id })).language).toBe('en');
    await expect(t.call('project', { project_id: zh.project_id, __repoWikiContext: back.context_id })).rejects.toMatchObject({ status: 409 });
  }, 60_000);

  it('classifies a real scratch cwd as empty without starting or retrying a child', async () => {
    const t = await setup();
    const scratch = await t.workspace.createConversation();
    const active = await t.call('activate', { workspace: scratch.cwd });
    expect(active).toMatchObject({ workspace: scratch.cwd, project_id: null, status: 'empty' });
    const again = await t.call('activate', { workspace: scratch.cwd });
    expect(again.context_id).toBe(active.context_id);
    expect(t.service.pid).toBeUndefined();
    expect(t.sent).toEqual([]);
  });

  it('rotates authority after a real child crash and rejects the previous context', async () => {
    const t = await setup(); await t.workspace.ensureWorkspace(t.a);
    let active = await t.enter(t.a);
    const old = active, pid = t.service.pid!;
    process.kill(pid);
    await vi.waitFor(() => {
      expect(t.service.pid).not.toBe(pid);
      expect(t.sent.some((event) => event[0] === 'gren:event:repoWiki://workspaces' && event[1].context_id !== old.context_id)).toBe(true);
    }, { timeout: 10_000 });
    await expect(t.call('health', { __repoWikiContext: old.context_id })).rejects.toMatchObject({ status: 409 });
    active = await t.enter(t.a);
    expect(active.context_id).not.toBe(old.context_id);
    expect((await t.call('health', { __repoWikiContext: active.context_id })).status).toBe('ok');
  }, 60_000);

  it('preserves project pages and one child when an explicit scan detects changes across A-B-A reentry', async () => {
    const t = await setup();
    await t.workspace.ensureWorkspace(t.a); await t.workspace.ensureWorkspace(t.b);
    // Seed exactly the standalone legacy state, including real SQLite pages and
    // persisted watch preference. The host must handle it without demo fallback.
    const standalone = new RepoWikiProcessClient({
      entry: join(buildDir, REPO_WIKI_HOST_ENTRY), executable: require('electron'),
      dataDir: join(t.root, 'wiki'), allowedRoots: [t.a, t.b], maxRestarts: 0,
    });
    cleanup.push(() => standalone.stop());
    const project = await standalone.invoke('create', { path: t.a, language: 'zh' });
    const generated = await standalone.invoke('generate', { project_id: project.id, provider: 'demo' });
    await vi.waitFor(async () => expect((await standalone.invoke('run', { project_id: project.id })).status).toBe('completed'), { timeout: 10_000 });
    const before = await standalone.invoke('project', { project_id: project.id });
    expect(before.pages!.length).toBeGreaterThan(0);
    await standalone.invoke('watch', { project_id: project.id, enabled: true });
    await standalone.stop();
    let active = await t.enter(t.a);
    const pid = t.service.pid;
    await writeFile(join(t.a, 'README.md'), '# A\nChanged after leaving the standalone app.');
    await t.call('scan', { project_id: project.id, __repoWikiContext: active.context_id });
    await vi.waitFor(async () => {
      const current = await t.call('project', { project_id: project.id, __repoWikiContext: active.context_id });
      expect(current.watch_status.status).toBe('needs_generation');
    }, { timeout: 6500, interval: 200 });
    await t.enter(t.b);
    active = await t.enter(t.a);
    expect(t.service.pid).toBe(pid);
    const after = await t.call('project', { project_id: project.id, __repoWikiContext: active.context_id });
    expect(after.pages).toEqual(before.pages);
    expect((await t.call('run', { project_id: project.id, __repoWikiContext: active.context_id })).id).toBe(generated.run_id);
    // Reject demo even if a trusted main-process caller bypasses renderer checks.
    const embedded = new RepoWikiProcessClient({
      entry: join(buildDir, REPO_WIKI_HOST_ENTRY), executable: require('electron'),
      dataDir: join(t.root, 'guard-wiki'), allowedRoots: [t.a], env: { REPOWIKI_EMBEDDED: '1' }, maxRestarts: 0,
    });
    cleanup.push(() => embedded.stop());
    const guarded = await embedded.invoke('create', { path: t.a, language: 'zh' });
    await expect(embedded.invoke('generate', { project_id: guarded.id, provider: 'demo' })).rejects.toMatchObject({ status: 403 });
  }, 60_000);

  // The collection is host metadata; opening A must never hydrate B just to list it.
  it('lists registered repositories separately and hydrates only the active project without sessions', async () => {
    const t = await setup();
    await t.workspace.ensureWorkspace(t.a); await t.workspace.ensureWorkspace(t.b);
    const initial = await t.call('activate', { workspace: t.a });
    expect(initial).toMatchObject({ workspace: t.a, status: 'bound', project_id: null, context_id: expect.any(String) });
    expect(t.service.pid).toBeUndefined();
    const input = { __repoWikiContext: initial.context_id };
    const lists = await Promise.all(Array.from({ length: 4 }, () => t.call('hostProjects')));
    expect(lists[0].projects).toHaveLength(2);
    expect(new Set(lists[0].projects.map((p: any) => p.path))).toEqual(new Set([t.a, t.b]));
    expect(lists.every((snapshot) => snapshot.projects.length === 2)).toBe(true);
    expect(t.service.pid).toBeUndefined();
    const hydrated = await t.call('hydrate', input);
    expect((await t.call('projects', input)).map((p: any) => p.path)).toEqual([t.a]);
    await expect(t.workspace.listAllSessions()).resolves.toEqual([]);
    // create_project scans and validates this file BEFORE deduplication. Reentry
    // succeeding with the original ID proves the host reused metadata first.
    await writeFile(join(t.a, 'wiki_plan.json'), 'invalid JSON: repeated create must not scan');
    const again = await t.call('activate', { workspace: t.a.toUpperCase() });
    expect(again.context_id).toBe(initial.context_id);
    expect(again.project_id).toBe(hydrated.project.id);
    await expect(t.call('projects', input)).resolves.toHaveLength(1);
    expect((await t.call('health', input)).provider).toMatchObject({ mode: 'host-knowledge-scheduler', preparation: 'on-generation' });
  }, 30_000);

  // Trusting renderer paths would silently grant access before registry persistence.
  it('waits for authoritative registration, notifies once, and removes revoked projections', async () => {
    const t = await setup();
    const pending = await t.call('activate', { workspace: t.a });
    expect(pending).toMatchObject({ workspace: t.a, project_id: null, status: 'pending' });
    expect(t.service.pid).toBeUndefined();
    expect((await t.call('hostProjects')).projects).toEqual([]);
    await expect(t.call('hydrate', { __repoWikiContext: pending.context_id })).rejects.toMatchObject({ status: 403 });
    const off = t.workspace.subscribeProjectsChanged(() => { void t.service.onHostProjectsChanged(); });
    cleanup.push(async () => off());
    await t.workspace.ensureWorkspace(t.a);
    await t.service.onHostProjectsChanged();
    const ready = await t.call('activate', { workspace: t.a });
    expect(ready).toMatchObject({ status: 'bound', context_id: pending.context_id, project_id: null });
    expect(t.service.pid).toBeUndefined();
    expect(t.sent.filter((e) => e[0] === 'gren:event:repoWiki://workspaces')).toHaveLength(1);
    const scratch = await t.workspace.createConversation();
    const empty = await t.call('activate', { workspace: scratch.cwd });
    expect(empty).toMatchObject({ status: 'empty', project_id: null });
    const cleared = await t.call('activate', { workspace: null });
    expect(cleared).toMatchObject({ workspace: null, project_id: null, status: 'empty' });
    await t.workspace.removeProject(t.a); await t.service.onHostProjectsChanged();
    expect((await t.call('hostProjects')).projects).toEqual([]);
    expect(t.service.pid).toBeUndefined();
    await expect(t.call('projects', { __repoWikiContext: ready.context_id })).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(await readFile(join(t.root, 'agent', 'opened-projects.json'), 'utf8')).projects).toEqual([]);
  }, 30_000);
});
