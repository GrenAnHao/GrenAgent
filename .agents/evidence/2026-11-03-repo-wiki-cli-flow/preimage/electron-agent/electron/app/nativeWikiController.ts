import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { RepoWikiProcessClient } from '../../vendor/repo-wiki/packages/process/src/client';
import type { NativeRequest, NativeResponse, NativeProjection } from '../../vendor/repo-wiki/packages/contracts/src/native';
import type { NativeWikiBridge } from './nativeWikiModel';
import type { WikiOperation, WikiStartInput, WikiPublication } from '../wikiService/contracts';
import { REFERENCE_IDENTITY, REFERENCE_PROFILE } from '../wikiService/referenceProfiles';

type Data = Record<string, any>;
interface Project { projectId: string; workspace: string; language: string }
interface Prepared { projectId: string; root: string; locale: string; branch: string; targetCommit: string; author: Data; plan: Data; planToken: string }
interface Confirmation { projectId: string; contextId: string; prepared: Prepared; input: WikiStartInput; intent: string; parent?: WikiOperation; requestId?: string; operationId?: string; acceptedRevision?: number }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const operationView = (op: WikiOperation) => ({ id: op.id, task_id: `native:${op.id}`, revision: op.revision, state: op.state, ...(op.error ? { error: op.error } : {}) });

/** Trusted host routing only; the child service remains the sole operation scheduler. */
export class NativeWikiController {
  private readonly projects = new Map<string, Project>();
  private readonly confirmations = new Map<string, Confirmation>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly projectionErrors = new Map<string, NativeProjection>();
  private readonly admitted = new Set<string>();
  private readonly stages = new Map<string, string>();
  private registryLoaded?: Promise<void>;
  private registryTail: Promise<void> = Promise.resolve();
  constructor(private readonly ports: { dataDir: string; bridge: NativeWikiBridge; project(id: string): Promise<Project>; client(): Promise<RepoWikiProcessClient>; enabled(): boolean }) {}
  private dataDir(project: Project): string { return join(this.ports.dataDir, 'native', fingerprint([project.workspace, project.projectId])); }
  private loadRegistry(): Promise<void> {
    return this.registryLoaded ??= (async () => {
      const file = join(this.ports.dataDir, 'native', 'projects.json');
      try {
        if ((await stat(file)).size > 512_000) throw new Error('NATIVE_REGISTRY_TOO_LARGE');
        const entries: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (!Array.isArray(entries) || entries.some(p => !p || typeof p !== 'object' || typeof p.projectId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.projectId) || typeof p.workspace !== 'string' || typeof p.language !== 'string')) throw new Error('NATIVE_REGISTRY_INVALID');
        for (const project of entries as Project[]) if (!this.projects.has(project.projectId)) this.projects.set(project.projectId, project);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    })();
  }
  async restoreProject(workspace: string, language: string): Promise<Project | undefined> {
    await this.loadRegistry();
    return [...this.projects.values()].find(project => project.workspace === workspace && project.language === language);
  }
  private async remember(project: Project): Promise<void> {
    await this.loadRegistry();
    if (fingerprint(this.projects.get(project.projectId)) === fingerprint(project)) { await this.registryTail; return; }
    const previous = this.projects.get(project.projectId);
    this.projects.set(project.projectId, project);
    const next = this.registryTail.catch(() => {}).then(async () => {
      const directory = join(this.ports.dataDir, 'native'); await mkdir(directory, { recursive: true });
      const temporary = join(directory, `projects-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify([...this.projects.values()]), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, join(directory, 'projects.json'));
    });
    this.registryTail = next;
    try { await next; }
    catch (error) { if (this.projects.get(project.projectId) === project) { if (previous) this.projects.set(project.projectId, previous); else this.projects.delete(project.projectId); } throw error; }
  }
  private async call<T>(client: RepoWikiProcessClient, project: Project, method: string, input: Data = {}): Promise<T> { return client.invokeNative(method, { dataDir: this.dataDir(project), projectId: project.projectId, ...input }) as Promise<T>; }
  private async operation(client: RepoWikiProcessClient, project: Project, id: string): Promise<WikiOperation> {
    const op = await this.call<WikiOperation>(client, project, 'native.query', { operationId: id });
    if (op.projectId !== project.projectId || op.repositoryRoot !== project.workspace || op.locale !== project.language) throw new Error('NATIVE_SCOPE_MISMATCH');
    return op;
  }
  private async list(client: RepoWikiProcessClient, project: Project): Promise<Array<Pick<WikiOperation, 'id' | 'revision' | 'state' | 'branch' | 'locale'>>> {
    const items: Array<Pick<WikiOperation, 'id' | 'revision' | 'state' | 'branch' | 'locale'>> = [];
    let offset: number | null = 0;
    while (offset !== null) { const page: Data = await this.call(client, project, 'native.list', { summary: true, offset }); items.push(...page.items); offset = page.nextOffset; }
    return items;
  }
  bindClient(client: RepoWikiProcessClient): void {
    client.setNativeRequestHandler(async (kind, raw, signal) => {
      const input = raw as Data;
      const project = [...this.projects.values()].find(p => this.dataDir(p) === input.dataDir);
      if (!project) throw new Error('NATIVE_SCOPE_MISMATCH');
      let approved = false;
      try { const current = await this.ports.project(project.projectId); approved = current.workspace === project.workspace && current.language === project.language; }
      catch (error) { if (kind !== 'native.release') throw error; }
      if (!approved && kind !== 'native.release') throw new Error('NATIVE_SCOPE_MISMATCH');
      if (kind === 'native.event') { void this.sync(client, project).catch(() => {}); return null; }
      const op = input.operation as WikiOperation;
      const saved = await this.operation(client, project, op?.id);
      const identity = (value: WikiOperation) => [value.id, value.projectId, value.repositoryRoot, value.branch, value.locale, value.targetCommit, value.engine, value.templateVersion, value.model, value.author, value.plan, value.spendingPolicy, value.effectiveProfile];
      if (fingerprint(identity(op)) !== fingerprint(identity(saved))) throw new Error('NATIVE_SCOPE_MISMATCH');
      if (kind === 'native.release') {
        // Projection failures leave durable outbox debt, but must not strand a drained target lock.
        try { if (approved) await this.sync(client, project); } catch { /* Replay independently on the next read/repair. */ }
        try { return await this.ports.bridge.handle(kind, input, signal); }
        finally { this.admitted.delete(op.id); }
      }
      const result = await this.ports.bridge.handle(kind, input, signal);
      if (kind === 'native.admission') this.admitted.add(op.id);
      return result;
    });
    client.onLifecycle(state => {
      if (state.status === 'crashed' || state.status === 'failed') {
        this.admitted.clear();
      }
    });
  }
  async recordDispatch(operation: WikiOperation, requestId: string): Promise<void> {
    if (!this.admitted.has(operation.id)) throw new Error('NATIVE_NOT_ADMITTED');
    const project = await this.ports.project(operation.projectId);
    if (project.workspace !== operation.repositoryRoot || project.language !== operation.locale) throw new Error('NATIVE_SCOPE_MISMATCH');
    const client = await this.ports.client();
    await this.call(client, project, 'native.requestDispatched', { operationId: operation.id, requestId });
  }
  async revoke(roots: string[], client: RepoWikiProcessClient): Promise<void> {
    const key = (path: string) => process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
    for (const project of this.projects.values()) {
      if (roots.some(root => key(root) === key(project.workspace))) continue;
      for (const op of await this.list(client, project)) {
        if (['queued', 'running'].includes(op.state)) await this.call(client, project, 'native.control', { operationId: op.id, action: 'pause', expectedRevision: op.revision });
      }
    }
  }
  private sync(client: RepoWikiProcessClient, project: Project): Promise<void> {
    const key = this.dataDir(project);
    const next = (this.tails.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      let afterSeq = 0;
      for (;;) {
        const events = await this.call<Array<{ id: string; seq: number; kind: string; payload: Data }>>(client, project, 'native.outbox', { afterSeq, limit: 100 });
        if (!events.length) return;
        for (const event of events) {
          afterSeq = event.seq;
          const op = await this.operation(client, project, event.payload.operationId);
          if (event.kind === 'operation') await this.ports.bridge.project(op);
          else if (event.kind === 'stage') { this.stages.set(op.id, event.payload.stage); await this.ports.bridge.stage(event.id, op.id, event.payload.stage, event.payload.detail); }
          else if (event.kind === 'publication') {
            const latest = await this.call<Data>(client, project, 'native.partition', { branch: op.branch, locale: op.locale, summary: true });
            const summary = latest?.id === event.payload.publicationId ? latest : await this.publication(client, project, event.payload.publicationId);
            if (latest?.id !== event.payload.publicationId) {
              await this.ports.bridge.publication(op, { id: summary.id, coverage: summary.coverage, projection: { status: 'error', error: 'PROJECTION_SUPERSEDED' } });
              await this.call(client, project, 'native.ack', { id: event.id }); continue;
            }
            let status: NativeProjection;
            try {
              status = await this.ports.bridge.withProjection(op, () => this.call<NativeProjection>(client, project, 'native.project.project', { publicationId: event.payload.publicationId }));
              this.projectionErrors.delete(event.payload.publicationId);
              if (status.status === 'conflict') this.projectionErrors.set(status.publication_id, status);
            } catch (error) {
              status = { publication_id: event.payload.publicationId, status: 'error', error: error instanceof Error ? error.message : 'PROJECTION_FAILED' };
              this.projectionErrors.set(event.payload.publicationId, status);
            }
            await this.ports.bridge.publication(op, { id: summary.id, coverage: summary.coverage, projection: status });
            if (status.status === 'error') continue; // Durable event stays unacknowledged; no model work is replayed.
          } else throw new Error('UNKNOWN_NATIVE_OUTBOX_EVENT');
          await this.call(client, project, 'native.ack', { id: event.id });
        }
      }
    });
    this.tails.set(key, next);
    void next.finally(() => { if (this.tails.get(key) === next) this.tails.delete(key); }).catch(() => {});
    return next;
  }
  async invoke(request: NativeRequest, contextId: string): Promise<NativeResponse> {
    const project = await this.ports.project(request.project_id);
    await this.remember(project);
    const client = await this.ports.client();
    const command = request.command;
    if (command === 'author.read') return { command, value: await this.call(client, project, 'native.project.authorRead') };
    if (command === 'author.save') return { command, value: await this.call(client, project, 'native.project.authorSave', { author: request.author, expectedRevision: request.expected_revision, expectedStorageToken: request.expected_storage_token }) };
    if (command === 'author.convert') return { command, value: await this.call(client, project, 'native.project.authorConvert', { expectedRevision: request.expected_revision, expectedStorageToken: request.expected_storage_token }) };
    if (command === 'status') {
      try { await this.sync(client, project); } catch { /* Task projection must not make native records unreadable. */ }
      const all = await this.list(client, project);
      let currentBranch: string | undefined;
      try { currentBranch = (await this.call<Prepared>(client, project, 'native.project.prepare')).branch; } catch { /* Native records stay readable without source access. */ }
      const selectedId = request.operation_id ?? all.find(op => op.locale === project.language && (!currentBranch || op.branch === currentBranch))?.id;
      const op = selectedId ? await this.operation(client, project, selectedId) : undefined;
      const inspect = op ? await this.call<Data>(client, project, 'native.inspect', { operationId: op.id }) : null;
      const selectedBranch = currentBranch ?? op?.branch;
      const publication = request.operation_id ? op?.publicationId ? await this.publication(client, project, op.publicationId) : null : selectedBranch ? await this.call<Data>(client, project, 'native.partition', { branch: selectedBranch, locale: project.language, summary: true }) : null;
      let projection: NativeProjection | null = publication ? this.projectionErrors.get(publication.id) ?? null : null;
      if (publication && !projection) {
        try { projection = await this.call(client, project, 'native.project.projectionStatus', { publicationId: publication.id }); }
        catch (error) { projection = { publication_id: publication.id, status: 'error', error: error instanceof Error ? error.message : 'PROJECTION_UNREADABLE' }; }
      }
      return { command, value: { engine: 'qoder-wiki-local-v1', executionEnabled: this.ports.enabled(), operation: op ? { ...operationView(op), stage: this.stages.get(op.id), executor_active: !!inspect?.active, recoverable: !inspect?.active && ['queued', 'paused', 'running', 'pausing'].includes(op.state) } : null,
        publication: publication ? { id: publication.id, published_count: publication.coverage.published, readable_count: publication.coverage.readable, failed_count: publication.coverage.failed.length, partial: publication.coverage.partial, failed_items: publication.coverage.failed } : null, projection, ...(inspect ? { accounting: inspect.accounting } : {}) } };
    }
    if (command === 'projection.repair') {
      // Read-only repair is available even when native execution/model access is disabled.
      const publication = await this.publication(client, project, request.publication_id);
      const op = await this.operation(client, project, publication.operationId);
      const latest = await this.call<Data>(client, project, 'native.partition', { branch: publication.branch, locale: publication.locale, summary: true });
      if (latest?.id !== publication.id) throw new Error('PROJECTION_SUPERSEDED');
      let value: NativeProjection;
      try { value = await this.ports.bridge.withProjection(op, () => this.call<NativeProjection>(client, project, 'native.project.project', { publicationId: publication.id })); }
      catch (error) {
        await this.ports.bridge.publication(op, { id: publication.id, coverage: publication.coverage, projection: { status: 'error', error: error instanceof Error ? error.message : 'PROJECTION_FAILED' } });
        throw error;
      }
      await this.ports.bridge.publication(op, { id: publication.id, coverage: publication.coverage, projection: value });
      this.projectionErrors.delete(publication.id);
      await this.sync(client, project);
      return { command, value };
    }
    if (command === 'control') {
      let current = await this.operation(client, project, request.operation_id);
      if (current.revision !== request.expected_revision) throw new Error('REVISION_CONFLICT');
      const inspect = await this.call<Data>(client, project, 'native.inspect', { operationId: current.id });
      if (!inspect.active && ['running', 'pausing', 'cancelling'].includes(current.state)) {
        await this.ports.bridge.recover(current, { previousExecutorExited: true });
        current = await this.call(client, project, 'native.recover', { operationId: current.id, previousExecutorExited: true });
        if (current.state === 'cancelled' || (current.state === 'paused' && request.action === 'pause')) return { command, value: operationView(current) };
      }
      const op = await this.call<WikiOperation>(client, project, 'native.control', { operationId: current.id, action: request.action, expectedRevision: current.revision });
      return { command, value: operationView(op) };
    }
    if (command === 'drafts') {
      await this.operation(client, project, request.operation_id);
      const items: Array<{ id: string; title: string; markdown: string }> = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const inspect: Data = await this.call(client, project, 'native.inspect', { operationId: request.operation_id, offset });
        for (const cp of inspect.checkpoints ?? []) {
          if (!['page', 'overview', 'plan', 'catalogue-root', 'catalogue-child', 'commit-analysis', 'catalogue-analysis'].includes(cp.stage)) continue;
          const value = await this.draft(client, project, request.operation_id, cp.stage, cp.itemId);
          const markdown = value.parsed?.markdown ?? value.raw;
          if (typeof markdown === 'string' && markdown) items.push({ id: `${cp.stage}:${cp.itemId}`, title: `${cp.stage} / ${cp.itemId || '根'}`, markdown });
        }
        offset = inspect.nextOffset;
      }
      return { command, value: { items } };
    }
    if (!this.ports.enabled()) throw new Error('NATIVE_EXECUTION_DISABLED');
    if (command === 'prepare') {
      if (request.operation_id && !['repair', 'resume'].includes(request.intent)) throw new Error('INVALID_NATIVE_INTENT');
      const prepared = await this.call<Prepared>(client, project, 'native.project.prepare');
      if (!prepared.author.revision) throw new Error('AUTHOR_SAVE_REQUIRED');
      const parent = request.operation_id ? await this.operation(client, project, request.operation_id) : undefined;
      if (parent && (parent.targetCommit !== prepared.targetCommit || parent.branch !== prepared.branch || fingerprint(parent.author) !== fingerprint(prepared.author) || fingerprint([parent.plan.include, parent.plan.exclude]) !== fingerprint([prepared.plan.include, prepared.plan.exclude]))) throw new Error('REPAIR_INPUT_CHANGED');
      if (request.intent === 'repair' && (!parent || !['failed', 'completed'].includes(parent.state))) throw new Error('INVALID_REPAIR_STATE');
      if (request.intent === 'resume' && (!parent || !['queued', 'paused', 'running', 'pausing'].includes(parent.state))) throw new Error('INVALID_RESUME_STATE');
      const model = await this.ports.bridge.bind(randomUUID());
      if (parent && (parent.model.expectedModel !== model.expectedModel || parent.model.expectedConfiguration !== model.expectedConfiguration)) throw new Error('MODEL_CHANGED');
      const spendingPolicy = { ...(request.spending_policy?.max_model_requests !== undefined ? { maxModelRequests: request.spending_policy.max_model_requests } : {}), ...(request.spending_policy?.max_total_tokens !== undefined ? { maxTotalTokens: request.spending_policy.max_total_tokens } : {}) };
      if (parent && request.spending_policy && fingerprint(spendingPolicy) !== fingerprint(parent.spendingPolicy)) throw new Error('SPENDING_POLICY_CHANGED');
      const parentInput = parent ? (({ id: _id, state: _state, revision: _revision, runId: _run, error: _error, publicationId: _publication, ...input }) => input)(parent) : undefined;
      const input: WikiStartInput = parentInput ? { ...parentInput, requestId: '', action: request.intent === 'repair' ? 'repair' : parentInput.action, ...(request.intent === 'repair' ? { parentOperationId: parent!.id, expectedRevision: parent!.revision } : {}) } : {
        requestId: '', projectId: project.projectId, repositoryRoot: project.workspace, branch: prepared.branch, locale: project.language, action: request.intent === 'resume' ? 'full' : request.intent,
        targetCommit: prepared.targetCommit, engine: REFERENCE_IDENTITY.engine, templateVersion: `${REFERENCE_IDENTITY.qoder}:${REFERENCE_IDENTITY.context}:${REFERENCE_IDENTITY.revision}`,
        model, author: prepared.author, plan: { ...prepared.plan, allowFullFallback: request.intent === 'sync' }, spendingPolicy, effectiveProfile: structuredClone(REFERENCE_PROFILE), authorization: { confirmed: true } };
      const id = randomUUID(); this.confirmations.set(id, { projectId: project.projectId, contextId, prepared, input, intent: request.intent, parent });
      return { command, value: { confirmation_id: id, intent: request.intent, model_identity: String(model.expectedModel), author_revision: prepared.author.revision, scope: input.plan, branch: input.branch, target_commit: input.targetCommit, task_revision: parent?.revision ?? null,
        spending_policy: { ...(input.spendingPolicy.maxModelRequests !== undefined ? { max_model_requests: input.spendingPolicy.maxModelRequests } : {}), ...(input.spendingPolicy.maxTotalTokens !== undefined ? { max_total_tokens: input.spendingPolicy.maxTotalTokens } : {}) },
        effective_profile: { context_window: Math.min(Number(model.contextWindow) || REFERENCE_PROFILE.contextWindow, REFERENCE_PROFILE.contextWindow), max_output_tokens: Math.min(Number(model.maxOutputTokens) || REFERENCE_PROFILE.maxOutputTokens, REFERENCE_PROFILE.maxOutputTokens), work_steps: REFERENCE_PROFILE.maxSteps, closing_turns: REFERENCE_PROFILE.closingTurns }, ...(parent ? { operation_id: parent.id } : {}) } };
    }
    if (command === 'start') {
      const confirmation = this.confirmations.get(request.confirmation_id);
      if (!confirmation || confirmation.projectId !== project.projectId || confirmation.contextId !== contextId) throw new Error('CONFIRMATION_EXPIRED');
      if (confirmation.requestId && confirmation.requestId !== request.request_id) throw new Error('CONFIRMATION_ALREADY_USED');
      if (confirmation.operationId) {
        const accepted = await this.operation(client, project, confirmation.operationId);
        if (accepted.state !== 'queued') return { command, value: operationView(accepted) };
        if (confirmation.acceptedRevision !== accepted.revision) throw new Error('REVISION_CONFLICT');
      }
      const prepared = await this.call<Prepared>(client, project, 'native.project.prepare');
      if (fingerprint(prepared) !== fingerprint(confirmation.prepared)) throw new Error('CONFIRMATION_INPUT_CHANGED');
      const bound = await this.ports.bridge.bind(randomUUID());
      if (bound.expectedModel !== confirmation.input.model.expectedModel || bound.expectedConfiguration !== confirmation.input.model.expectedConfiguration) throw new Error('MODEL_CHANGED');
      let op: WikiOperation;
      if (confirmation.intent === 'resume') {
        op = await this.operation(client, project, confirmation.parent!.id);
        if (op.revision !== (confirmation.acceptedRevision ?? confirmation.parent!.revision)) throw new Error('REVISION_CONFLICT');
        if (['running', 'pausing', 'cancelling'].includes(op.state)) {
          const inspect = await this.call<Data>(client, project, 'native.inspect', { operationId: op.id });
          if (inspect.active) throw new Error('OLD_EXECUTOR_NOT_DRAINED');
          // A current child rejects recovery of its active executor. On a new main process no old provider survives.
          await this.ports.bridge.recover(op, { previousExecutorExited: true });
          op = await this.call(client, project, 'native.recover', { operationId: op.id, previousExecutorExited: true });
        }
        if (op.state === 'paused') op = await this.call(client, project, 'native.control', { operationId: op.id, action: 'resume', expectedRevision: op.revision });
      } else {
        op = await this.call(client, project, 'native.start', { input: { ...confirmation.input, requestId: request.request_id } });
      }
      confirmation.requestId = request.request_id; confirmation.operationId = op.id; confirmation.acceptedRevision = op.revision;
      // The task center must be able to resolve the returned task_id before dispatch starts.
      await this.ports.bridge.project(op);
      await client.invokeNative('native.configure', { enabled: true });
      if (op.state === 'queued') op = await this.call(client, project, 'native.dispatch', { operationId: op.id });
      return { command, value: operationView(op) };
    }
    throw new Error('UNKNOWN_NATIVE_COMMAND');
  }
  private async publication(client: RepoWikiProcessClient, project: Project, publicationId: string): Promise<WikiPublication> {
    let json = '', offset: number | null = 0;
    while (offset !== null) { const part = await this.call<{ chunk: string; nextOffset: number | null }>(client, project, 'native.publicationChunk', { publicationId, offset }); json += part.chunk; offset = part.nextOffset; }
    return JSON.parse(json) as WikiPublication;
  }
  private async draft(client: RepoWikiProcessClient, project: Project, operationId: string, stage: string, itemId: string): Promise<Data> {
    let json = '', offset: number | null = 0;
    while (offset !== null) { const part = await this.call<{ chunk: string; nextOffset: number | null }>(client, project, 'native.draftChunk', { operationId, stage, itemId, offset }); json += part.chunk; offset = part.nextOffset; }
    return JSON.parse(json);
  }
}
