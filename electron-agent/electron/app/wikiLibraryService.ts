import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import type { JobStore } from '../agentData/jobStore';
import { normalizeWikiWorkspace, type WikiLibraryStore } from '../agentData/wikiLibraryStore';
import type { WikiSourceStore } from '../agentData/wikiSourceStore';
import type { WikiStore } from '../agentData/wikiStore';
import { wikiHash, wikiRelativePath } from '../agentData/wikiFiles';
import type { WikiDeletePreview, WikiDeleteResult, WikiImportPreview, WikiIngestItem, WikiIngestPreview, WikiIngestReceipt, WikiIngestRun, WikiIngestSummary, WikiReindexResult, WikiSource, WikiSourceInput, WikiTarget } from '../agentData/wikiContracts';
import type { QueueTaskInput } from './appServer/taskQueue';
import { readWorkspaceSource } from './wikiSyncService';

export interface WikiLibraryServiceOptions {
  libraries: WikiLibraryStore;
  sources: WikiSourceStore;
  pages: WikiStore;
  jobs: JobStore;
  runServiceTask: (input: Omit<QueueTaskInput, 'system'>) => Promise<unknown>;
  modelLabel: () => Promise<string>;
  validateProject: (workspace: string) => Promise<string>;
  cancelJob?: (jobId: string) => unknown;
}

export class WikiLibraryService {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly options: WikiLibraryServiceOptions) {
    options.libraries.db.exec(`CREATE TABLE IF NOT EXISTS wiki_ingest_runs (
      job_id TEXT PRIMARY KEY, kb_id TEXT NOT NULL, items TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL, model TEXT NOT NULL);`);
  }

  async previewImport(kbId: string, projectWorkspace: string, relativePath: string): Promise<WikiImportPreview> {
    const { libraries } = this.options;
    libraries.assertAccess({ kind: 'project', workspace: projectWorkspace }, kbId);
    const path = wikiRelativePath(relativePath);
    if (!['.md', '.txt'].includes(extname(path).toLowerCase())) throw new Error('INVALID_SOURCE_TYPE: only md/txt files can be imported');
    const workspace = normalizeWikiWorkspace(await this.options.validateProject(projectWorkspace));
    libraries.assertAccess({ kind: 'project', workspace }, kbId);
    const content = await readWorkspaceSource(workspace, path);
    libraries.assertAccess({ kind: 'project', workspace }, kbId);
    return { projectWorkspace: workspace, relativePath: path, name: basename(path), contentHash: wikiHash(content), bytes: Buffer.byteLength(content, 'utf8') };
  }

  async addSource(kbId: string, input: WikiSourceInput): Promise<WikiSource> {
    const { libraries, sources } = this.options;
    libraries.assertActive(kbId);
    if (input.kind !== 'project') return sources.createText(kbId, input);
    const preview = await this.previewImport(kbId, input.projectWorkspace, input.relativePath);
    libraries.assertAccess({ kind: 'project', workspace: preview.projectWorkspace }, kbId);
    if (preview.contentHash !== input.expectedContentHash) throw new Error('SOURCE_CHANGED');
    const content = await readWorkspaceSource(preview.projectWorkspace, preview.relativePath);
    libraries.assertAccess({ kind: 'project', workspace: preview.projectWorkspace }, kbId);
    if (wikiHash(content) !== input.expectedContentHash) throw new Error('SOURCE_CHANGED');
    return sources.createProject(kbId, preview, content);
  }

  async previewIngest(kbId: string, sourceIds?: string[], regenerateSourceIds?: string[]): Promise<WikiIngestPreview> {
    this.options.libraries.assertActive(kbId);
    const model = await this.model();
    this.options.libraries.assertActive(kbId);
    const sources = this.selectSources(kbId, sourceIds, regenerateSourceIds);
    return { sourceIds: sources.map((source) => source.sourceId), targetCount: sources.length, model };
  }

  async startIngest(kbId: string, sourceIds?: string[], regenerateSourceIds?: string[], expectedModel?: string, retryOf?: string): Promise<WikiIngestReceipt> {
    const { libraries, sources, jobs } = this.options;
    libraries.assertActive(kbId);
    const model = await this.model();
    if (expectedModel !== undefined && model !== expectedModel) throw new Error('MODEL_CHANGED');
    return libraries.transaction(() => {
      const previous = retryOf !== undefined ? jobs.get(retryOf) : undefined;
      const previousPayload = previous?.metadata?.payload;
      if (retryOf !== undefined && (!previous || !['failed', 'cancelled'].includes(previous.state) || previous.kind !== 'wiki.ingest'
        || previous.metadata?.target?.type !== 'wiki' || previous.metadata.target.id !== kbId
        || !previousPayload || !('kbId' in previousPayload) || previousPayload.kbId !== kbId)) throw new Error('TASK_RETRY_UNAVAILABLE');
      libraries.assertActive(kbId);
      const active = libraries.db.prepare(`SELECT 1 FROM wiki_ingest_runs r JOIN agent_jobs j ON j.id=r.job_id
        WHERE r.kb_id=? AND (j.state IN ('pending','running') OR EXISTS
          (SELECT 1 FROM wiki_task_targets t WHERE t.task_source='agent_job' AND t.task_id=j.id AND t.active=1)) LIMIT 1`).get(kbId);
      if (active || libraries.activeTasks({ kind: 'library', kbId }).length) throw new Error('WIKI_INGEST_ACTIVE: a library ingest is already active');
      const selected = this.selectSources(kbId, sourceIds, regenerateSourceIds);
      if (retryOf !== undefined && previousPayload && 'sourceIds' in previousPayload
        && selected.some((source) => !previousPayload.sourceIds.includes(source.sourceId))) throw new Error('TASK_RETRY_UNAVAILABLE');
      if (!selected.length) throw new Error('NO_PENDING_SOURCES');
      const regenerate = new Set(regenerateSourceIds);
      const items = selected.map((source): WikiIngestItem => {
        if (regenerate.has(source.sourceId)) sources.allowRegeneration(kbId, source.sourceId);
        const current = sources.get(kbId, source.sourceId)!;
        return { sourceId: current.sourceId, sourceRevision: current.revision, contentHash: current.contentHash, permit: libraries.acquirePermit(kbId, current.sourceId) };
      });
      const resourceName = libraries.get(kbId)!.name;
      const job = jobs.create({ kind: 'wiki.ingest', workspace: '', metadata: { target: { type: 'wiki', id: kbId }, payload: { kbId, sourceIds: items.map((item) => item.sourceId) }, resourceName, ...(retryOf ? { retryOf } : {}) } });
      jobs.recordStage(job.id, '已选择资料', { processed: 0, total: items.length });
      const summary: WikiIngestSummary = { succeeded: 0, skipped: 0, failed: 0 };
      libraries.db.prepare('INSERT INTO wiki_ingest_runs(job_id,kb_id,items,cancel_requested,summary,model) VALUES(?,?,?,?,?,?)')
        .run(job.id, kbId, JSON.stringify(items), 0, JSON.stringify(summary), model);
      for (const item of items) libraries.recordTask({ taskSource: 'agent_job', taskId: job.id, kbId, sourceId: item.sourceId, pageId: item.permit.pageId, active: true, canCancel: true });
      this.audit('wiki.ingest.enqueue', { jobId: job.id, kbId, resource: { type: 'wiki', id: kbId }, resourceName, sourceIds: items.map((item) => item.sourceId), model });
      return { jobId: job.id, targetCount: items.length, model };
    });
  }

  private async model(): Promise<string> {
    try {
      const model = await this.options.modelLabel();
      if (typeof model !== 'string' || !model.trim()) throw new Error('MODEL_UNAVAILABLE');
      return model;
    } catch { throw new Error('MODEL_UNAVAILABLE'); }
  }

  private selectSources(kbId: string, sourceIds?: string[], regenerateSourceIds: string[] = []): WikiSource[] {
    const { sources } = this.options;
    const requireSource = (sourceId: string): WikiSource => {
      const source = sources.get(kbId, sourceId);
      if (!source || source.lifecycle !== 'active') throw new Error('WIKI_SOURCE_NOT_FOUND: source must belong to the active library');
      return source;
    };
    for (const sourceId of regenerateSourceIds) requireSource(sourceId);
    const selected = sourceIds === undefined ? sources.list(kbId) : [...new Set([...sourceIds, ...regenerateSourceIds])].map(requireSource);
    const regenerate = new Set(regenerateSourceIds);
    return selected.filter((source) => source.lifecycle === 'active' && source.status !== 'processing'
      && (regenerate.has(source.sourceId) || (!source.generationSuppressed && (source.status === 'failed' || source.processedHash !== source.contentHash))));
  }

  private readRun(jobId: string): WikiIngestRun | undefined {
    const row = this.options.libraries.db.prepare('SELECT * FROM wiki_ingest_runs WHERE job_id=?').get(jobId);
    return row ? { jobId, kbId: String(row.kb_id), items: JSON.parse(String(row.items)), cancelRequested: Boolean(row.cancel_requested), summary: JSON.parse(String(row.summary)), model: String(row.model) } : undefined;
  }

  summary(jobId: string): WikiIngestSummary | undefined { return this.readRun(jobId)?.summary; }

  runIngest(jobId: string): Promise<void> {
    const active = this.running.get(jobId);
    if (active) return active;
    const run = this.executeIngest(jobId).finally(() => {
      try { this.options.libraries.settleTask('agent_job', jobId); }
      finally { this.running.delete(jobId); }
    });
    this.running.set(jobId, run);
    return run;
  }

  private async executeIngest(jobId: string): Promise<void> {
    const { libraries, sources, pages, jobs } = this.options;
    const run = this.readRun(jobId);
    if (!run) throw new Error('WIKI_INGEST_NOT_FOUND');
    const job = jobs.get(jobId);
    if (!job || !['pending', 'running'].includes(job.state)) return;
    let fatal: string | undefined;
    try {
      jobs.start(jobId);
      for (const [index, item] of run.items.entries()) {
        if (this.cancelled(jobId)) break;
        let taskId: string | undefined;
        let processing = false;
        try {
          jobs.recordStage(jobId, '正在读取', { processed: index, total: run.items.length });
          const skip = this.skipReason(item);
          if (skip) { this.skip(run, item, skip); continue; }
          if (!sources.markProcessing(run.kbId, item.sourceId, item.sourceRevision)) { this.skip(run, item, 'changed'); continue; }
          processing = true;
          const source = sources.get(run.kbId, item.sourceId)!;
          const snapshot = sources.readSnapshot(run.kbId, { sourceId: item.sourceId, revision: item.sourceRevision });
          taskId = randomUUID();
          libraries.recordTask({ taskSource: 'service_task', taskId, kbId: run.kbId, sourceId: item.sourceId, pageId: item.permit.pageId, active: true, canCancel: false });
          jobs.recordStage(jobId, '正在生成', { processed: index, total: run.items.length });
          const output = await this.options.runServiceTask({ id: taskId, kind: 'wiki_page_generate', capabilities: ['llm_completion'],
            input: { kbId: run.kbId, sourceId: item.sourceId, sourceRevision: item.sourceRevision, expectedModel: run.model, sourcePath: source.name, source: snapshot } });
          const lateSkip = this.cancelled(jobId) ? 'cancelled' : this.skipReason(item);
          if (lateSkip) { this.skip(run, item, lateSkip); continue; }
          if (typeof output !== 'string' || !output.trim()) throw new Error('Wiki generation returned empty content');
          jobs.recordStage(jobId, '正在发布', { processed: index, total: run.items.length });
          const result = libraries.transaction(() => {
            sources.readSnapshot(run.kbId, { sourceId: item.sourceId, revision: item.sourceRevision });
            const published = pages.publishGenerated(item.permit, { title: source.name.replace(/\.[^.]+$/, '') || source.name, content: output.trim() });
            if (published.state === 'published') {
              if (!sources.markResult(run.kbId, item.sourceId, item.sourceRevision, { status: 'succeeded', contentHash: item.contentHash })) throw new Error('SOURCE_CHANGED');
              this.audit('wiki.ingest.publish', { jobId, kbId: run.kbId, sourceId: item.sourceId, sourceRevision: item.sourceRevision, pageId: item.permit.pageId });
            }
            return published;
          });
          if (result.state === 'skipped') this.skip(run, item, result.reason);
          else {
            processing = false;
            run.summary.succeeded += 1;
          }
        } catch (error) {
          const skip = this.cancelled(jobId) ? 'cancelled' : this.staleReason(item);
          if (skip) this.skip(run, item, skip);
          else {
            const message = error instanceof Error ? error.message : String(error);
            run.summary.failed += 1;
            sources.markResult(run.kbId, item.sourceId, item.sourceRevision, { status: 'failed', error: message });
            processing = false;
            this.audit('wiki.ingest.fail', { jobId, kbId: run.kbId, sourceId: item.sourceId, error: message.slice(0, 2000) });
          }
        } finally {
          if (taskId) libraries.settleTask('service_task', taskId);
          if (processing) sources.markResult(run.kbId, item.sourceId, item.sourceRevision, { status: 'pending' });
          this.saveSummary(run);
          jobs.recordStage(jobId, '已处理', { processed: index + 1, total: run.items.length });
          jobs.progress(jobId, ((index + 1) / run.items.length) * 100);
        }
      }
    } catch (error) {
      fatal = error instanceof Error ? error.message : String(error);
      run.summary.failed += 1;
    } finally {
      this.restorePending(run);
      this.saveSummary(run);
      if (this.cancelled(jobId)) jobs.cancel(jobId);
      else if (run.summary.failed) jobs.fail(jobId, fatal ?? `${run.summary.failed} Wiki source(s) failed`);
      else { jobs.recordStage(jobId, '已完成', { processed: run.items.length, total: run.items.length }); jobs.complete(jobId); }
    }
  }

  /** Startup only: do not replay model calls or pretend persisted system writers have stopped. */
  recover(): void {
    const { libraries, jobs } = this.options;
    const rows = libraries.db.prepare("SELECT r.job_id FROM wiki_ingest_runs r JOIN agent_jobs j ON j.id=r.job_id WHERE j.state IN ('pending','running')").all();
    for (const row of rows) {
      const jobId = String(row.job_id);
      if (this.running.has(jobId)) continue;
      const run = this.readRun(jobId)!;
      libraries.transaction(() => {
        this.restorePending(run);
        if (run.cancelRequested) jobs.cancel(jobId);
        else {
          run.summary.failed += Math.max(0, run.items.length - run.summary.succeeded - run.summary.skipped - run.summary.failed);
          this.saveSummary(run);
          jobs.fail(jobId, 'WIKI_INGEST_INTERRUPTED: extraction was interrupted; retry explicitly');
        }
        libraries.settleTask('agent_job', jobId);
        this.audit('wiki.ingest.recover', { jobId, kbId: run.kbId, cancelled: run.cancelRequested });
      });
    }
    libraries.recoverTasks();
  }

  private restorePending(run: WikiIngestRun): void {
    const { sources } = this.options;
    for (const item of run.items) {
      const source = sources.get(run.kbId, item.sourceId);
      if (source?.status === 'processing') sources.markResult(run.kbId, item.sourceId, item.sourceRevision, { status: 'pending' });
    }
  }

  private staleReason(item: WikiIngestItem): string | undefined {
    const { libraries, sources } = this.options;
    const source = sources.get(item.permit.kbId, item.sourceId);
    if (!source || source.lifecycle !== 'active') return 'deleted';
    if (source.revision !== item.sourceRevision || source.contentHash !== item.contentHash) return 'changed';
    if (source.generationSuppressed) return 'suppressed';
    if (!libraries.permitActive(item.permit)) return 'deleted';
    return undefined;
  }

  private skipReason(item: WikiIngestItem): string | undefined {
    const stale = this.staleReason(item);
    if (stale) return stale;
    const page = this.options.pages.readById(item.permit.kbId, item.permit.pageId);
    if (page?.locked) return 'locked';
    if (page && page.sourceRefs.length > 1) return 'multi_source';
    const expected = item.permit.expected;
    if (page ? !expected || page.revision !== expected.revision || page.contentHash !== expected.contentHash : expected !== null) return 'changed';
    return undefined;
  }

  private skip(run: WikiIngestRun, item: WikiIngestItem, reason: string): void {
    run.summary.skipped += 1;
    this.audit('wiki.ingest.skip', { jobId: run.jobId, kbId: run.kbId, sourceId: item.sourceId, sourceRevision: item.sourceRevision, reason });
  }

  private saveSummary(run: WikiIngestRun): void {
    this.options.libraries.db.prepare('UPDATE wiki_ingest_runs SET summary=? WHERE job_id=?').run(JSON.stringify(run.summary), run.jobId);
  }

  private cancelled(jobId: string): boolean {
    return Boolean(this.options.libraries.db.prepare('SELECT cancel_requested FROM wiki_ingest_runs WHERE job_id=?').get(jobId)?.cancel_requested);
  }

  requestCancel(jobId: string): boolean {
    const { libraries, jobs } = this.options;
    return libraries.transaction(() => {
      const job = jobs.get(jobId);
      if (!job || !['pending', 'running'].includes(job.state) || !this.readRun(jobId)) return false;
      const result = libraries.db.prepare(`UPDATE wiki_ingest_runs SET cancel_requested=1 WHERE job_id=? AND cancel_requested=0
        AND EXISTS (SELECT 1 FROM agent_jobs WHERE id=? AND state IN ('pending','running'))`).run(jobId, jobId);
      jobs.requestCancellation(jobId);
      if (Number(result.changes)) this.audit('wiki.ingest.cancel_requested', { jobId, resource: job.metadata?.target, resourceName: job.metadata?.resourceName });
      return true;
    });
  }

  async previewDelete(target: WikiTarget): Promise<WikiDeletePreview> {
    const { libraries, sources } = this.options;
    const library = libraries.get(target.kbId);
    if (!library || library.lifecycle === 'deleted') throw new Error('WIKI_LIBRARY_NOT_FOUND');
    const db = libraries.db;
    if (target.kind === 'library') {
      const sourceCount = db.prepare("SELECT count(*) AS count FROM wiki_sources WHERE kb_id=? AND lifecycle!='deleted'").get(target.kbId)!;
      const pageCount = db.prepare('SELECT count(*) AS count FROM wiki_documents WHERE kb_id=?').get(target.kbId)!;
      return { target, name: library.name, revision: library.revision, sources: Number(sourceCount.count), pages: Number(pageCount.count), bindings: library.bindings };
    }
    if (target.kind === 'source') {
      const source = sources.get(target.kbId, target.sourceId);
      if (!source || source.lifecycle === 'deleted') throw new Error('WIKI_SOURCE_NOT_FOUND');
      const pageRefs = db.prepare('SELECT source_refs FROM wiki_documents WHERE kb_id=?').all(target.kbId);
      const pageCount = pageRefs.filter((row) => (JSON.parse(String(row.source_refs)) as Array<{ sourceId: string }>).some((ref) => ref.sourceId === target.sourceId)).length;
      return { target, name: source.name, revision: source.revision, sources: 1, pages: pageCount, bindings: library.bindings };
    }
    const page = db.prepare('SELECT title,revision,source_refs FROM wiki_documents WHERE kb_id=? AND page=?').get(target.kbId, target.pageId);
    if (!page) throw new Error('WIKI_PAGE_NOT_FOUND');
    return { target, name: String(page.title), revision: Number(page.revision), sources: (JSON.parse(String(page.source_refs)) as unknown[]).length, pages: 1, bindings: library.bindings };
  }

  async remove(target: WikiTarget, cancelActive: boolean): Promise<WikiDeleteResult> {
    const { libraries } = this.options;
    libraries.beginDelete(target);
    if (cancelActive) {
      for (const task of libraries.activeTasks(target)) {
        if (task.canCancel && task.taskSource === 'agent_job' && !this.requestCancel(task.taskId)) await this.options.cancelJob?.(task.taskId);
      }
    }
    const tasks = libraries.activeTasks(target);
    return tasks.length ? { state: 'waiting', tasks } : libraries.finishDelete(target);
  }

  async reindex(kbId: string): Promise<WikiReindexResult> {
    this.options.libraries.assertActive(kbId);
    return this.options.pages.reindexLibrary(kbId);
  }

  private audit(action: string, detail: Record<string, unknown>): void {
    const { libraries, jobs } = this.options;
    const job = typeof detail.jobId === 'string' ? jobs.get(detail.jobId) : undefined;
    const kbId = typeof detail.kbId === 'string' ? detail.kbId : job?.metadata?.target?.type === 'wiki' ? job.metadata.target.id : undefined;
    const snapshot = { ...detail, resource: detail.resource ?? (kbId ? { type: 'wiki', id: kbId } : undefined),
      resourceName: detail.resourceName ?? (kbId ? libraries.get(kbId)?.name : undefined) ?? job?.metadata?.resourceName };
    libraries.db.prepare('INSERT INTO agent_audit(id,action,detail,created_at) VALUES(?,?,?,?)').run(randomUUID(), action, JSON.stringify(snapshot), Date.now());
  }
}
