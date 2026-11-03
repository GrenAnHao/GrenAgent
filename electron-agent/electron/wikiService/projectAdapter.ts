import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hash } from '../../vendor/repo-wiki/packages/core/src/scanner';
import { ProjectFiles, type ProjectPublicationClaim } from '../../vendor/repo-wiki/packages/core/src/project-files';
import { three_way_merge } from '../../vendor/repo-wiki/packages/core/src/engine';
import type { WorkspaceService } from '../../vendor/repo-wiki/packages/service/src/service';
import { validateNativeRequest, type NativeAuthor, type NativeProjection } from '../../vendor/repo-wiki/packages/contracts/src/native';
import type { WikiPublication } from './contracts';

type Data = Record<string, any>;
const ENGINE = 'qoder-wiki-local-v1' as const;
const namespace = (branch: string, locale: string) => hash([branch, locale]).slice(0, 24);

/** Child-only adapter. Native SQLite is authoritative; these are versioned editable projections. */
export class NativeWikiProjectAdapter {
  constructor(private readonly service: WorkspaceService) {}
  private read(projectId: string, requireGit = true) {
    this.service.engine.refreshKnowledgeProject(projectId);
    const project = this.service.engine.get_project(projectId);
    const root = realpathSync(project.path);
    const files = new ProjectFiles(root, project.language);
    const facts = files.load();
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }).trim();
    let branch: string, targetCommit: string;
    try { targetCommit = git(['rev-parse', 'HEAD']); try { branch = git(['symbolic-ref', '--short', 'HEAD']); } catch { branch = `detached:${targetCommit.slice(0, 12)}`; } }
    catch { if (requireGit) throw new Error('NATIVE_GIT_REQUIRED'); branch = String(project.identity?.branch ?? 'local'); targetCommit = ''; }
    return { project, root, files, facts, branch, targetCommit };
  }
  private author(meta: ReturnType<NativeWikiProjectAdapter['read']>): NativeAuthor {
    const saved = meta.files.readNativeAuthor(meta.branch);
    const value = saved.value ?? { schema_version: 1, engine: ENGINE, branch: meta.branch, locale: meta.project.language, revision: 0, mode: 'auto', constraints: [], notes: [], pages: [] };
    validateNativeRequest({ project_id: meta.project.id, command: 'author.save', author: value, expected_revision: value.revision, expected_storage_token: saved.token });
    if (value.branch !== meta.branch || value.locale !== meta.project.language) throw new Error('AUTHOR_BRANCH_OR_LOCALE_MISMATCH');
    return { ...value, storage_token: saved.token } as NativeAuthor;
  }
  async invoke(method: string, input: Data): Promise<unknown> {
    const meta = this.read(input.projectId, !['native.project.project', 'native.project.projectionStatus'].includes(method));
    if (method === 'native.project.prepare') {
      const author = this.author(meta);
      const plan = { include: meta.facts.project.plan.include ?? ['**'], exclude: meta.facts.project.plan.exclude ?? [] };
      return { projectId: meta.project.id, root: meta.root, locale: meta.project.language, branch: meta.branch, targetCommit: meta.targetCommit, author, plan, planToken: hash([plan, author]), guardFloor: meta.files.readExecutionGuard()?.generation ?? 0 };
    }
    if (method === 'native.project.authorRead') return this.author(meta);
    if (method === 'native.project.authorSave') {
      validateNativeRequest({ project_id: input.projectId, command: 'author.save', author: input.author, expected_revision: input.expectedRevision, expected_storage_token: input.expectedStorageToken });
      if (input.author.branch !== meta.branch || input.author.locale !== meta.project.language) throw new Error('AUTHOR_BRANCH_OR_LOCALE_MISMATCH');
      meta.facts.project.native_engine = ENGINE;
      meta.files.commit(meta.facts);
      const saved = meta.files.saveNativeAuthor(input.author, input.expectedRevision, input.expectedStorageToken);
      return { ...saved.value, storage_token: saved.token };
    }
    if (method === 'native.project.authorConvert') {
      const author = this.author(meta);
      if (author.revision !== input.expectedRevision || author.storage_token !== input.expectedStorageToken) throw new Error('AUTHOR_REVISION_CONFLICT');
      const dropped: string[] = [];
      const pages = (meta.facts.project.plan.pages ?? []).map((page: Data) => {
        if (Array.isArray(page.depends_on) && page.depends_on.length) dropped.push(String(page.id));
        return { id: String(page.id), title: String(page.title), prompt: String(page.goal || page.title), children: [] };
      });
      const converted = { ...author, mode: pages.length ? 'pages' : 'auto', pages };
      validateNativeRequest({ project_id: input.projectId, command: 'author.save', author: converted, expected_revision: author.revision, expected_storage_token: author.storage_token });
      return { author: converted, dropped_depends_on: dropped };
    }
    const publication = input.publication as WikiPublication;
    if (!publication || publication.locale !== meta.project.language) throw new Error('PUBLICATION_IDENTITY_MISMATCH');
    const ns = namespace(publication.branch, publication.locale);
    const prior = meta.facts.snapshots[ns];
    if (method === 'native.project.projectionStatus') return this.projectionStatus(publication, prior, meta.facts.pages[ns]);
    if (method !== 'native.project.project') throw new Error('UNKNOWN_NATIVE_PROJECT_METHOD');
    if (prior?.nativePublicationId === publication.id) return this.projectionStatus(publication, prior, meta.facts.pages[ns]);
    if (prior?.nativeOperationId && prior.nativePublicationId !== input.previousPublicationId && input.previousPublicationId !== undefined) throw new Error('PROJECTION_BASELINE_CHANGED');
    const pages = { ...(meta.facts.pages[ns] ?? {}) };
    let revision = Number(meta.facts.project.next_revision) || 0;
    const catalogue = new Map(publication.catalogue.map(section => [section.id, section]));
    for (const id of publication.requiredPageIds) {
      const generated = (publication.pages[id] as { markdown?: unknown })?.markdown;
      if (typeof generated !== 'string' || !generated.trim()) throw new Error('INVALID_NATIVE_PUBLICATION');
      const old = pages[id], section = catalogue.get(id);
      let [markdown, conflict] = old ? three_way_merge(old.baseline ?? '', old.markdown, generated) : [generated, false];
      if (old?.status === 'conflict') { markdown = old.markdown; conflict = true; }
      // A replay never recreates or overwrites a user's pending merge.
      pages[id] = { ...old, id, kind: 'wiki', title: section?.sectionName ?? section?.title ?? old?.title ?? id, markdown,
        baseline: conflict && old ? old.baseline : generated, pending_markdown: conflict ? generated : null,
        status: conflict ? 'conflict' : markdown === generated ? 'ready' : 'edited', revision: ++revision,
        sources: conflict ? old?.sources ?? [] : [], dependencies: [],
        identity: { branch: publication.branch, language: publication.locale, commit: publication.baseline },
        native_section: section ? { parentId: section.parentId, ordinal: section.ordinal, sectionName: section.sectionName } : old?.native_section,
        inputManifest: { engine: ENGINE, nativePublicationId: publication.id }, updated_at: new Date().toISOString() };
    }
    for (const id of publication.manifest.deletedPageIds) {
      const old = pages[id];
      // Explicit deletion archives rather than destroys an edited body or draft.
      if (old && old.status !== 'archived') pages[id] = { ...old, status: 'archived', revision: ++revision };
    }
    meta.facts.pages[ns] = pages;
    meta.facts.project.next_revision = revision;
    meta.facts.project.native_engine = ENGINE;
    meta.facts.snapshots[ns] = { ...prior, target: 'wiki', identity: { branch: publication.branch, language: publication.locale, commit: publication.baseline },
      hashes: Object.fromEntries(publication.sourceManifest.map(file => [file.path, file.hash])), edges: [],
      coverage: publication.coverage, nativePublicationId: publication.id, nativeOperationId: publication.operationId,
      nativeCatalogue: publication.catalogue, engine: ENGINE, updated_at: new Date().toISOString() };
    // New projection claims use the existing file journal/CAS and fence, not a second filesystem writer.
    const oldGuard = meta.files.readExecutionGuard();
    const fence = { ledgerId: `native-projection:${publication.operationId}`, controllerEpoch: 'native-projection-v1', ownerId: randomUUID(), generation: (oldGuard?.generation ?? 0) + 1 };
    meta.files.installExecutionFence({ version: 1, scopeIdentity: hash([meta.root, publication.branch, publication.locale]), taskId: publication.operationId, ...fence });
    const claim: ProjectPublicationClaim = { version: 1, taskId: publication.operationId, claimId: publication.id, publicationId: publication.id, namespace: ns, fence, intentHash: hash([ENGINE, publication.id]), outputSetHash: '' };
    claim.outputSetHash = meta.files.publicationOutputHash(meta.facts, claim);
    meta.files.bindPublicationClaim(claim);
    meta.files.commitPublication(meta.facts, claim);
    this.service.engine.refreshKnowledgeProject(input.projectId, { branch: meta.branch, language: meta.project.language });
    return this.projectionStatus(publication, meta.facts.snapshots[ns], pages);
  }
  private projectionStatus(publication: WikiPublication, snapshot?: Data, pages?: Data): NativeProjection {
    if (snapshot?.nativePublicationId !== publication.id) return { publication_id: publication.id, status: 'pending' };
    const conflict = publication.requiredPageIds.some(id => pages?.[id]?.status === 'conflict');
    return { publication_id: publication.id, status: conflict ? 'conflict' : 'ready' };
  }
}
