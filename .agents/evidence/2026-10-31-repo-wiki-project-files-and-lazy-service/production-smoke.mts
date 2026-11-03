import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RepoWikiProcessClient } from '../electron-agent/vendor/repo-wiki/packages/process/src/client.ts';

const require = createRequire(new URL('../electron-agent/package.json', import.meta.url));
const root = await mkdtemp(resolve('.tmp-repowiki-optimization/production-smoke-'));
const repository = join(root, 'project');
const dataDir = join(root, 'userData', 'repo-wiki');
const entry = join(root, 'resources', 'app.asar.unpacked', 'out', 'main', 'repo-wiki-host.cjs');
await mkdir(repository, { recursive: true });
await mkdir(dataDir, { recursive: true });
await mkdir(join(root, 'resources', 'app.asar.unpacked', 'out', 'main'), { recursive: true });
await writeFile(join(repository, 'README.md'), '# Source fixture\n');
const productionBundle = resolve('electron-agent/out-pkg/main/repo-wiki-host.cjs');
await copyFile(productionBundle, entry);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const namespace = hash(JSON.stringify(['local', 'zh'])).slice(0, 24);
const legacyPath = join(dataDir, 'workspace.sqlite3');
const database = new DatabaseSync(legacyPath);
database.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE pages(project_id TEXT,namespace TEXT,slug TEXT,data TEXT,PRIMARY KEY(project_id,namespace,slug)); CREATE TABLE snapshots(project_id TEXT,namespace TEXT,data TEXT,PRIMARY KEY(project_id,namespace)); CREATE TABLE revisions(id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE generation_cache(fingerprint TEXT PRIMARY KEY,data TEXT);');
const plan = { include: ['README.md'], exclude: [], pages: [{ id: 'overview', title: 'Overview', goal: 'Document source', patterns: ['README.md'], depends_on: [] }] };
database.prepare('INSERT INTO projects VALUES (?,?)').run('portable-fixture', JSON.stringify({ id: 'portable-fixture', path: repository, language: 'zh', name: 'Production fixture', watch: false, plan }));
database.prepare('INSERT INTO pages VALUES (?,?,?,?)').run('portable-fixture', namespace, 'overview', JSON.stringify({ id: 'overview', title: 'Overview', markdown: '# Human document\n', baseline: '# Generated baseline\n', pending_markdown: null, status: 'edited', revision: 1, sources: [], dependencies: [], kind: 'wiki' }));
database.prepare('INSERT INTO snapshots VALUES (?,?,?)').run('portable-fixture', namespace, JSON.stringify({ hashes: {}, edges: [], identity: { branch: 'local', language: 'zh' } }));
database.prepare('INSERT INTO revisions VALUES (?)').run(1);
database.close();
const original = await readFile(legacyPath);
let modelCalls = 0;
const client = new RepoWikiProcessClient({ entry, dataDir, executable: require('electron'), allowedRoots: [repository], env: { REPOWIKI_EMBEDDED: '1' }, maxRestarts: 0,
  modelCacheKey: 'unused-production-fixture', complete: async () => { modelCalls++; throw new Error('No model call expected'); } });
let result: Record<string, unknown>;
try {
  const project = await client.invokeScoped('create', { path: repository, language: 'zh' }, { contextId: 'view-one' });
  const childPid = client.pid;
  assert.notEqual(childPid, process.pid);
  assert.equal(project.portable_id, 'portable-fixture');
  const page = await client.invokeScoped('page', { project_id: project.id, slug: 'overview' }, { contextId: 'view-one' });
  assert.equal(page.markdown, '# Human document\n');
  const saved = await client.invokeScoped('edit', { project_id: project.id, slug: page.id, markdown: '# Saved project fact\n', expected_revision: page.revision, expected_storage_token: page.storage_token }, { contextId: 'view-one' });
  assert.equal(saved.markdown, '# Saved project fact\n');
  const file = join(repository, 'docs', 'repo-wiki', 'zh', 'namespaces', namespace, 'pages', 'overview.md');
  assert.equal(await readFile(file, 'utf8'), saved.markdown);
  await client.cancelContext('view-one');
  await assert.rejects(client.invokeScoped('health', {}, { contextId: 'view-one' }));
  const reentered = await client.invokeScoped('create', { path: repository, language: 'zh' }, { contextId: 'view-two' });
  assert.equal(reentered.id, project.id);
  assert.equal(client.pid, childPid);
  assert.deepEqual(await readFile(legacyPath), original);
  assert.equal(modelCalls, 0);
  result = { productionBundle: true, bundleSha256: hash(await readFile(entry)), unpackedResourcePath: true, workerMigration: true, originalLegacyUnchanged: true,
    portableId: project.portable_id, runtimeId: project.id, nativeFileSave: true, staleContextRejected: true, sameChildOnReentry: true, parentPid: process.pid, childPid, modelCalls };
} finally {
  await client.stop();
}
result = { ...result!, stopped: client.pid === undefined };
assert.equal(result.stopped, true);
await writeFile(resolve('.tmp-repowiki-optimization/production-smoke-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
