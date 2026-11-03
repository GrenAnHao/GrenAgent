/** Manual-only filesystem fixtures; no repository, Git, or model is touched until this test is explicitly run. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectFiles } from '../../vendor/repo-wiki/packages/core/src/project-files';
import { hash } from '../../vendor/repo-wiki/packages/core/src/scanner';
import { NativeWikiProjectAdapter } from './projectAdapter';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const author = (branch: string) => ({ schema_version: 1, engine: 'qoder-wiki-local-v1', branch, locale: 'zh', revision: 0, mode: 'auto', constraints: [], notes: [], pages: [] });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-projection-'))); roots.push(root);
  const files = new ProjectFiles(root, 'zh');
  files.commit({ project: { id: 'p', language: 'zh', next_revision: 0, plan: { include: ['**'], exclude: [], pages: [{ id: 'legacy', title: 'Legacy', goal: 'Explain', patterns: ['**'], depends_on: [] }] } }, pages: {}, snapshots: {} });
  return { root, files };
}
function gitRepo() {
  const f = fixture();
  const git = (...args: string[]) => execFileSync('git', ['-C', f.root, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  writeFileSync(join(f.root, 'source.ts'), 'export const x = 1;\n'); git('add', 'source.ts'); git('commit', '-m', 'fixture');
  const service: any = { engine: { refreshKnowledgeProject: () => {}, get_project: () => ({ id: 'p', path: f.root, language: 'zh' }) } };
  return { ...f, git, adapter: new NativeWikiProjectAdapter(service) };
}
function publication(id: string, changes: Partial<any> = {}): any {
  return { id, operationId: `op-${id}`, branch: 'main', locale: 'zh', baseline: 'a'.repeat(40), sourceManifest: [{ path: 'source.ts', hash: 'hash' }], sourceScope: { include: ['**'], exclude: [] },
    catalogue: [{ id: 'parent', parentId: '', ordinal: 0, sectionName: 'Parent', title: 'parent', prompt: 'parent', dependentFiles: [], meta: {} }, { id: 'child', parentId: 'parent', ordinal: 2, sectionName: 'Child', title: 'child', prompt: 'child', dependentFiles: [], meta: {} }],
    pages: { child: { markdown: '# Child\n\n[Source](file://source.ts#L1-L2)' } }, requiredPageIds: ['child'],
    coverage: { partial: true, planned: 2, published: 1, readable: 1, failed: ['parent'] },
    manifest: { catalogue: [], pages: [], requiredStages: [], deletedPageIds: [], baseline: 'a'.repeat(40), mode: 'full', expectedPriorPublicationId: null }, ...changes };
}

describe('native author storage', () => {
  it('restores each branch configuration independently and rejects an external same-revision edit', () => {
    const { files } = fixture();
    const main0 = files.readNativeAuthor('main'), main1 = files.saveNativeAuthor({ ...author('main'), constraints: ['main'] }, 0, main0.token);
    const other0 = files.readNativeAuthor('feature'), other1 = files.saveNativeAuthor({ ...author('feature'), constraints: ['feature'] }, 0, other0.token);
    expect(files.readNativeAuthor('main').value?.constraints).toEqual(['main']);
    expect(files.readNativeAuthor('feature').value?.constraints).toEqual(['feature']);
    expect(main1.value.revision).toBe(1); expect(other1.value.revision).toBe(1);
    const restored = files.readNativeAuthor('main'); files.saveNativeAuthor({ ...restored.value, constraints: ['main again'] }, 1, restored.token);
    expect(files.readNativeAuthor('feature').value?.constraints).toEqual(['feature']);
    const current = files.readNativeAuthor('main'), path = join(files.directory, 'author-config.qoder-v1.json');
    writeFileSync(path, JSON.stringify({ ...current.value, constraints: ['externally changed'], revision: 2 }));
    expect(() => files.saveNativeAuthor({ ...current.value, constraints: ['ours'] }, 2, current.token)).toThrow('AUTHOR_REVISION_CONFLICT');
    expect(files.readNativeAuthor('main').value?.constraints).toEqual(['externally changed']);
  });
  it('writes schema 2 with the engine marker and remains readable by the new reader', () => {
    const { files } = fixture(), facts = files.load();
    expect(JSON.parse(readFileSync(join(files.directory, 'project.json'), 'utf8')).schema_version).toBe(1);
    facts.project.native_engine = 'qoder-wiki-local-v1'; files.commit(facts);
    const project = JSON.parse(readFileSync(join(files.directory, 'project.json'), 'utf8'));
    expect(project).toMatchObject({ schema_version: 2, native_engine: 'qoder-wiki-local-v1' });
    expect(files.load().project.native_engine).toBe('qoder-wiki-local-v1');
    // The frozen pre-native reader admits only schema_version === 1. This assertion checks the persisted downgrade barrier.
    const legacySupports = (value: { schema_version: number }) => value.schema_version === 1;
    expect(legacySupports(project)).toBe(false);
    writeFileSync(join(files.directory, 'project.json'), JSON.stringify({ ...project, native_engine: 'unknown' }));
    expect(() => new ProjectFiles(files.root, 'zh').load()).toThrow('Unrecognized project knowledge format');
  });
});

describe('native filesystem projection', () => {
  it('retains failed-page drafts, archives only explicit deletes and persists tree/citation identity', async () => {
    const f = gitRepo(), ns = hash(['main', 'zh']).slice(0, 24), facts = f.files.load();
    const old = (id: string, text: string) => ({ id, kind: 'wiki', title: id, markdown: text, baseline: '# old\n', pending_markdown: '# pending\n', status: 'conflict', revision: 1, sources: [], dependencies: [] });
    facts.pages[ns] = { parent: old('parent', '# Human draft\n'), obsolete: old('obsolete', '# Delete but preserve\n') };
    facts.snapshots[ns] = { identity: { branch: 'main', language: 'zh' }, hashes: {}, edges: [] }; f.files.commit(facts);
    const pub = publication('pub', { manifest: { ...publication('pub').manifest, deletedPageIds: ['obsolete'] } });
    await expect(f.adapter.invoke('native.project.project', { projectId: 'p', publication: pub })).resolves.toMatchObject({ status: 'ready' });
    const result = new ProjectFiles(f.root, 'zh').load(), pages = result.pages[ns];
    expect(pages.parent).toMatchObject({ status: 'conflict', markdown: '# Human draft\n', pending_markdown: '# pending\n' });
    expect(pages.obsolete).toMatchObject({ status: 'archived', markdown: '# Delete but preserve\n', pending_markdown: '# pending\n' });
    expect(pages.child).toMatchObject({ native_section: { parentId: 'parent', ordinal: 2, sectionName: 'Child' }, inputManifest: { engine: 'qoder-wiki-local-v1', nativePublicationId: 'pub' } });
    expect(pages.child.markdown).toContain('file://source.ts#L1-L2');
    expect(result.snapshots[ns]).toMatchObject({ engine: 'qoder-wiki-local-v1', nativePublicationId: 'pub', nativeCatalogue: pub.catalogue });
  });
  it('keeps the already published snapshot untouched if an explicit prior receipt mismatches', async () => {
    const f = gitRepo(), first = publication('first');
    await f.adapter.invoke('native.project.project', { projectId: 'p', publication: first });
    const before = new ProjectFiles(f.root, 'zh').load();
    await expect(f.adapter.invoke('native.project.project', { projectId: 'p', publication: publication('second'), previousPublicationId: 'wrong' })).rejects.toThrow('PROJECTION_BASELINE_CHANGED');
    expect(new ProjectFiles(f.root, 'zh').load().snapshots).toEqual(before.snapshots);
  });
});
