import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeWikiController } from './nativeWikiController';
import { RepoWikiService } from './repoWikiService';

const tempDirs: string[] = [];
const makeTemp = () => { const path = mkdtempSync(join(tmpdir(), 'native-controller-')); tempDirs.push(path); return path; };
afterEach(() => { for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** In-memory service port exercises controller routing without starting a child or model. */
function fixture() {
  const dataDir = makeTemp();
  const root = 'D:/repo', project = { projectId: 'p', workspace: root, language: 'zh' };
  let enabled = true, authorized = true, modelAvailable = true, modelConfiguration = 'cfg1', projectionFailure = false, dispatchFailures = 0, taskProjectionFailures = 0;
  let prepared: any = { projectId: 'p', root, locale: 'zh', branch: 'main', targetCommit: 'a'.repeat(40), author: { schema_version: 1, engine: 'qoder-wiki-local-v1', branch: 'main', locale: 'zh', revision: 1, storage_token: 't1', mode: 'auto', constraints: [], notes: [], pages: [] }, plan: { include: ['src/**'], exclude: [] }, planToken: 'plan1' };
  const operations = new Map<string, any>(), byRequest = new Map<string, { input: any; id: string }>(), publications = new Map<string, any>();
  const checkpoints = new Map<string, any[]>(), drafts = new Map<string, any>();
  const actions: Array<{ method: string; input: any }> = [], outbox: any[] = [];
  let reverse: ((kind: string, input: any, signal: AbortSignal) => Promise<unknown>) | undefined;
  const client: any = { setNativeRequestHandler: (handler: typeof reverse) => { reverse = handler; }, onLifecycle: () => {},
    invokeNative: async (method: string, input: any) => {
      actions.push({ method, input: structuredClone(input) });
      switch (method) {
        case 'native.project.prepare': return structuredClone(prepared);
        case 'native.list': { const all = [...operations.values()].reverse(), offset = input.offset ?? 0; return input.summary ? { items: all.slice(offset, offset + 2).map(({ id, revision, state, branch, locale }) => ({ id, revision, state, branch, locale })), nextOffset: offset + 2 < all.length ? offset + 2 : null } : all; }
        case 'native.query': { const op = operations.get(input.operationId); if (!op) throw new Error('OPERATION_NOT_FOUND'); return structuredClone(op); }
        case 'native.start': {
          if (input.input.action === 'repair') { const parent = operations.get(input.input.parentOperationId); if (!parent || parent.revision !== input.input.expectedRevision) throw new Error('REVISION_OR_IDENTITY_CONFLICT'); }
          const old = byRequest.get(input.input.requestId);
          if (old) { if (JSON.stringify(old.input) !== JSON.stringify(input.input)) throw new Error('IDEMPOTENCY_CONFLICT'); return operations.get(old.id); }
          const id = `op${operations.size + 1}`, op = { ...structuredClone(input.input), id, state: 'queued', revision: 0 };
          operations.set(id, op); byRequest.set(input.input.requestId, { input: structuredClone(input.input), id }); return op;
        }
        case 'native.configure': return { enabled: input.enabled };
        case 'native.dispatch': if (dispatchFailures > 0) { dispatchFailures--; throw new Error('DISPATCH_FAILED'); } return operations.get(input.operationId);
        case 'native.control': { const op = operations.get(input.operationId); if (op.revision !== input.expectedRevision) throw new Error('REVISION_CONFLICT'); op.state = input.action === 'pause' ? 'paused' : 'cancelled'; op.revision++; return structuredClone(op); }
        case 'native.outbox': return outbox.filter(event => event.seq > (input.afterSeq ?? 0)).slice(0, input.limit ?? 100);
        case 'native.ack': { const index = outbox.findIndex(event => event.id === input.id); if (index >= 0) outbox.splice(index, 1); return { acknowledged: true }; }
        case 'native.inspect': { const all = checkpoints.get(input.operationId) ?? []; const offset = input.offset ?? 0; return { active: false, accounting: {}, checkpoints: all.slice(offset, offset + 100), nextOffset: offset + 100 < all.length ? offset + 100 : null }; }
        case 'native.draftChunk': { const value = drafts.get(`${input.operationId}:${input.stage}:${input.itemId}`); const text = JSON.stringify(value), offset = input.offset ?? 0, end = Math.min(text.length, offset + 20); return { chunk: text.slice(offset, end), nextOffset: end < text.length ? end : null }; }
        case 'native.publicationChunk': { const text = JSON.stringify(publications.get(input.publicationId)), offset = input.offset ?? 0, end = Math.min(text.length, offset + 20); return { chunk: text.slice(offset, end), nextOffset: end < text.length ? end : null }; }
        case 'native.partition': return [...publications.values()].at(-1) ?? null;
        case 'native.project.projectionStatus': return { publication_id: input.publicationId, status: projectionFailure ? 'error' : 'ready' };
        case 'native.project.project': if (projectionFailure) throw new Error('PROJECTION_FAILED'); return { publication_id: input.publicationId, status: 'ready' };
        default: throw new Error(`unexpected method ${method}`);
      }
    },
  };
  const bridgeCalls: string[] = []; let leaseHeld = false, bindSequence = 0;
  const bridge: any = { bind: async () => { if (!modelAvailable) throw new Error('MODEL_UNAVAILABLE'); return { bindingId: `binding-${++bindSequence}`, expectedModel: 'p/m', expectedConfiguration: modelConfiguration, contextWindow: 100000, maxOutputTokens: 8000 }; },
    handle: async (kind: string) => { bridgeCalls.push(kind); if (kind === 'native.admission') { leaseHeld = true; return { leaseId: 'l' }; } if (kind === 'native.release') leaseHeld = false; return null; },
    project: async (op: any) => { actions.push({ method: 'bridge.project', input: structuredClone(op) }); if (taskProjectionFailures > 0) { taskProjectionFailures--; throw new Error('TASK_PROJECTION_FAILED'); } }, publication: async () => {}, stage: async () => {}, withProjection: async (_op: any, work: () => Promise<unknown>) => work(), recover: async () => {}, abortAndDrain: async () => {}, activateModelDispatch: () => {} };
  const controller = new NativeWikiController({ dataDir, bridge, project: async () => { if (!authorized) throw new Error('REVOKED'); return project; }, client: async () => client, enabled: () => enabled });
  controller.bindClient(client);
  const invoke = (request: any) => controller.invoke({ project_id: 'p', ...request }, 'view');
  return { dataDir, controller, client, invoke, actions, outbox, operations, publications, checkpoints, drafts, bridgeCalls,
    setPrepared: (patch: any) => { prepared = { ...prepared, ...patch }; }, getPrepared: () => structuredClone(prepared),
    setModel: (value: string) => { modelConfiguration = value; }, setModelAvailable: (value: boolean) => { modelAvailable = value; }, setEnabled: (value: boolean) => { enabled = value; },
    failNextDispatch: () => { dispatchFailures++; }, failNextTaskProjection: () => { taskProjectionFailures++; }, leaseHeld: () => leaseHeld, setAuthorized: (value: boolean) => { authorized = value; }, setProjectionFailure: (value: boolean) => { projectionFailure = value; },
    reverse: (kind: string, input: any) => reverse!(kind, input, new AbortController().signal) };
}
async function prepare(f: ReturnType<typeof fixture>, intent: 'full' | 'repair' | 'resume' = 'full', operation_id?: string) {
  return (await f.invoke({ command: 'prepare', intent, ...(operation_id ? { operation_id } : {}) }) as any).value.confirmation_id as string;
}
async function start(f: ReturnType<typeof fixture>, confirmation_id: string, request_id: string) {
  return (await f.invoke({ command: 'start', confirmation_id, request_id, confirm_external: true }) as any).value;
}

describe('native controller confirmation and routing', () => {
  it('returns the persisted AgentData task ID and projects it before enabling dispatch', async () => {
    const f = fixture(), op = await start(f, await prepare(f), 'primary-entry');
    expect(op.task_id).toBe(`native:${op.id}`);
    const methods = f.actions.map(action => action.method);
    expect(methods.indexOf('bridge.project')).toBeGreaterThan(methods.indexOf('native.start'));
    expect(methods.indexOf('native.configure')).toBeGreaterThan(methods.indexOf('bridge.project'));
    expect(methods.indexOf('native.dispatch')).toBeGreaterThan(methods.indexOf('native.configure'));
    expect((await f.invoke({ command: 'status', operation_id: op.id }) as any).value.operation.task_id).toBe(op.task_id);
  });
  it('does not dispatch after task projection fails and retries the same accepted operation', async () => {
    const f = fixture(), confirmation = await prepare(f); f.failNextTaskProjection();
    await expect(start(f, confirmation, 'same-projection-request')).rejects.toThrow('TASK_PROJECTION_FAILED');
    expect(f.operations.size).toBe(1);
    const accepted = [...f.operations.values()][0];
    expect(accepted).toMatchObject({ state: 'queued', revision: 0 });
    expect(f.actions.some(action => ['native.configure', 'native.dispatch'].includes(action.method))).toBe(false);
    expect(await start(f, confirmation, 'same-projection-request')).toMatchObject({ id: accepted.id, task_id: `native:${accepted.id}` });
    expect(f.operations.size).toBe(1);
    expect(f.actions.filter(action => action.method === 'native.dispatch').map(action => action.input.operationId)).toEqual([accepted.id]);
  });
  it('sends a reused request ID with different frozen input to the service idempotency check', async () => {
    const f = fixture(); const first = await prepare(f); const accepted = await start(f, first, 'request-1');
    expect((await start(f, first, 'request-1')).id).toBe(accepted.id);
    const old = f.getPrepared(); f.setPrepared({ author: { ...old.author, revision: 2, constraints: ['different'] } });
    const second = await prepare(f);
    await expect(start(f, second, 'request-1')).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    const starts = f.actions.filter(a => a.method === 'native.start');
    expect(starts).toHaveLength(3);
    expect(starts[0].input.input).toEqual(starts[1].input.input);
    expect(starts[0].input.input.requestId).toBe(starts[2].input.input.requestId);
    expect(starts[0].input.input.author.constraints).toEqual([]);
    expect(starts[2].input.input.author.constraints).toEqual(['different']);
  });
  it('retries dispatch after an accepted queued operation without creating another operation', async () => {
    const f = fixture(), confirmation = await prepare(f); f.failNextDispatch();
    await expect(start(f, confirmation, 'same-request')).rejects.toThrow('DISPATCH_FAILED');
    expect(f.operations.size).toBe(1);
    const accepted = [...f.operations.values()][0];
    expect(accepted).toMatchObject({ state: 'queued', revision: 0 });
    expect(await start(f, confirmation, 'same-request')).toMatchObject({ id: accepted.id });
    expect(f.operations.size).toBe(1);
    expect(f.actions.filter(a => a.method === 'native.start').map(a => a.input.input)).toEqual([f.actions.find(a => a.method === 'native.start')!.input.input, f.actions.find(a => a.method === 'native.start')!.input.input]);
    expect(f.actions.filter(a => a.method === 'native.dispatch').map(a => a.input.operationId)).toEqual([accepted.id, accepted.id]);
  });
  it('rejects a queued accepted operation whose revision changed before retry', async () => {
    const f = fixture(), confirmation = await prepare(f); f.failNextDispatch();
    await expect(start(f, confirmation, 'same-request')).rejects.toThrow('DISPATCH_FAILED');
    const accepted = [...f.operations.values()][0]; accepted.revision++;
    await expect(start(f, confirmation, 'same-request')).rejects.toThrow('REVISION_CONFLICT');
    expect(f.operations.size).toBe(1);
    expect(f.actions.filter(a => a.method === 'native.dispatch')).toHaveLength(1);
  });
  it('rejects author revision, scope and model drift after confirmation', async () => {
    for (const change of ['author', 'scope', 'model'] as const) {
      const f = fixture(), confirmation = await prepare(f), before = f.getPrepared();
      if (change === 'author') f.setPrepared({ author: { ...before.author, revision: 2 } });
      if (change === 'scope') f.setPrepared({ plan: { include: ['other/**'], exclude: [] }, planToken: 'plan2' });
      if (change === 'model') f.setModel('cfg2');
      await expect(start(f, confirmation, `r-${change}`)).rejects.toThrow(change === 'model' ? 'MODEL_CHANGED' : 'CONFIRMATION_INPUT_CHANGED');
      expect(f.actions.filter(a => a.method === 'native.start')).toHaveLength(0);
    }
  });
  it('does not repair a parent whose revision changed after confirmation', async () => {
    const f = fixture(), op = await start(f, await prepare(f), 'original');
    f.operations.get(op.id).state = 'failed';
    const confirmation = await prepare(f, 'repair', op.id);
    f.operations.get(op.id).revision++;
    await expect(start(f, confirmation, 'repair')).rejects.toThrow('REVISION_OR_IDENTITY_CONFLICT');
  });
  it('shows an explicitly requested historical operation even when a newer one exists', async () => {
    const f = fixture(), a = await start(f, await prepare(f), 'a'), b = await start(f, await prepare(f), 'b');
    f.operations.get(a.id).state = 'failed'; f.operations.get(b.id).state = 'cancelled';
    const view: any = await f.invoke({ command: 'status', operation_id: a.id });
    expect(view.value.operation).toMatchObject({ id: a.id, state: 'failed' });
  });
  it('finds the current branch operation after paginated summary pages', async () => {
    const f = fixture(), a = await start(f, await prepare(f), 'a'), b = await start(f, await prepare(f), 'b'), c = await start(f, await prepare(f), 'c');
    f.operations.get(b.id).branch = 'other'; f.operations.get(c.id).branch = 'other';
    const view: any = await f.invoke({ command: 'status' });
    expect(view.value.operation.id).toBe(a.id);
    expect(f.actions.filter(action => action.method === 'native.list').map(action => action.input.offset)).toContain(2);
  });
  it('keeps status, paginated drafts and projection repair available with execution disabled', async () => {
    const f = fixture(), op = await start(f, await prepare(f), 'a');
    const stored = f.operations.get(op.id); stored.state = 'completed'; stored.publicationId = 'pub';
    const publication = { id: 'pub', operationId: op.id, branch: 'main', locale: 'zh', coverage: { readable: 1, published: 1, failed: [], partial: false } };
    f.publications.set('pub', publication);
    f.checkpoints.set(op.id, Array.from({ length: 101 }, (_, i) => ({ stage: 'page', itemId: `p${i}`, disposition: 'done' })));
    for (let i = 0; i < 101; i++) f.drafts.set(`${op.id}:page:p${i}`, { parsed: { markdown: `# Page ${i}` }, raw: '' });
    f.setEnabled(false); f.setModelAvailable(false);
    expect((await f.invoke({ command: 'status', operation_id: op.id }) as any).value.executionEnabled).toBe(false);
    expect((await f.invoke({ command: 'drafts', operation_id: op.id }) as any).value.items).toHaveLength(101);
    expect((await f.invoke({ command: 'projection.repair', publication_id: 'pub' }) as any).value.status).toBe('ready');
    expect(f.actions.filter(a => a.method === 'native.publicationChunk').length).toBeGreaterThan(1);
    await expect(f.invoke({ command: 'prepare', intent: 'full' })).rejects.toThrow('NATIVE_EXECUTION_DISABLED');
  });
  it('keeps SQLite publication readable after file projection fails and retains its outbox entry', async () => {
    const f = fixture(), op = await start(f, await prepare(f), 'a');
    f.operations.get(op.id).state = 'completed'; f.operations.get(op.id).publicationId = 'pub';
    f.publications.set('pub', { id: 'pub', operationId: op.id, branch: 'main', locale: 'zh', coverage: { readable: 1, published: 1, failed: [], partial: false } });
    f.outbox.push({ id: 'pub', seq: 1, kind: 'publication', payload: { operationId: op.id, publicationId: 'pub' } }); f.setProjectionFailure(true);
    const view: any = await f.invoke({ command: 'status', operation_id: op.id });
    expect(view.value.publication.id).toBe('pub'); expect(view.value.projection.status).toBe('error');
    expect(f.outbox.map(e => e.id)).toContain('pub');
  });
  it('releases a previously admitted operation after workspace authorization is revoked', async () => {
    const f = fixture(), op = await start(f, await prepare(f), 'a');
    const input = f.actions.find(a => a.method === 'native.start')!.input;
    await f.reverse('native.admission', { dataDir: input.dataDir, operation: f.operations.get(op.id) });
    expect(f.leaseHeld()).toBe(true); f.setAuthorized(false);
    await expect(f.reverse('native.release', { dataDir: input.dataDir, operation: f.operations.get(op.id), leaseId: 'l' })).resolves.toBeNull();
    expect(f.bridgeCalls).toContain('native.release'); expect(f.leaseHeld()).toBe(false);
  });
  it('does not pause an operation when the same approved view roots are retained', async () => {
    const f = fixture(), op = await start(f, await prepare(f), 'a'); f.operations.get(op.id).state = 'running';
    await f.controller.revoke(['D:/repo'], f.client);
    expect(f.actions.filter(a => a.method === 'native.control')).toHaveLength(0);
  });
});

describe('native service survives a same-project view transfer', () => {
  it('cancels the old view context without stopping or controlling the native service', async () => {
    const commands = new Map<string, (event: any, args: any) => Promise<any>>(), actions: string[] = [];
    const client: any = { cancelContext: async () => { actions.push('cancelContext'); }, invokeNative: async (method: string) => { actions.push(method); return {}; }, stop: async () => { actions.push('stop'); } };
    const service = new RepoWikiService({ entry: 'unused', dataDir: makeTemp(), configurationPollMs: 0,
      allowedWorkspaces: async () => ['D:/repo'], projectSnapshot: () => ['D:/repo'], isTrustedSender: () => true,
      resolveModel: async () => ({ cacheKey: 'test', complete: async () => '' }), native: {} as any,
      registerCommand: (name, handler) => { commands.set(name, handler as any); return () => commands.delete(name); } });
    const event: any = { sender: { id: 1, isDestroyed: () => false }, senderFrame: {} };
    try {
      await commands.get('repoWiki_activate')!(event, { workspace: 'D:/repo', view_id: 'old' });
      (service as any).client = client;
      await commands.get('repoWiki_activate')!(event, { workspace: 'D:/repo', view_id: 'new' });
      expect(actions).toContain('cancelContext');
      expect(actions).not.toContain('native.control'); expect(actions).not.toContain('native.drain'); expect(actions).not.toContain('stop');
    } finally { await service.stop(); }
  });
});


describe('native read-only project recovery', () => {
  it('restores only canonical project metadata from disk without binding or calling a model', async () => {
    const f = fixture(); await f.invoke({ command: 'status' });
    const registry = JSON.parse(readFileSync(join(f.dataDir, 'native', 'projects.json'), 'utf8'));
    expect(registry).toEqual([{ projectId: 'p', workspace: 'D:/repo', language: 'zh' }]);
    let modelCalls = 0;
    const reader = new NativeWikiController({ dataDir: f.dataDir, bridge: { bind: async () => { modelCalls++; throw new Error('unexpected'); } } as any,
      project: async () => { throw new Error('unused'); }, client: async () => { throw new Error('unused'); }, enabled: () => false });
    await expect(reader.restoreProject('D:/repo', 'zh')).resolves.toEqual({ projectId: 'p', workspace: 'D:/repo', language: 'zh' });
    await expect(reader.restoreProject('D:/repo', 'en')).resolves.toBeUndefined(); expect(modelCalls).toBe(0);
  });
  it('hydrates a registered native read-only shell when file projection loading fails', async () => {
    const temporary = makeTemp(), workspace = join(temporary, 'repo'), dataDir = join(temporary, 'data'); mkdirSync(workspace);
    const canonical = realpathSync(workspace); mkdirSync(join(dataDir, 'native'), { recursive: true });
    writeFileSync(join(dataDir, 'native', 'projects.json'), JSON.stringify([{ projectId: 'native-project', workspace: canonical, language: 'zh' }]));
    const commands = new Map<string, (event: any, args: any) => Promise<any>>(); let modelCalls = 0;
    const client: any = { cancelContext: async () => {}, invokeScoped: async () => { throw new Error('PROJECTION_CONFLICT'); }, stop: async () => {} };
    const service = new RepoWikiService({ entry: 'unused', dataDir, configurationPollMs: 0, allowedWorkspaces: async () => [canonical], projectSnapshot: () => [canonical],
      isTrustedSender: () => true, resolveModel: async () => { modelCalls++; throw new Error('unexpected model'); }, native: {} as any,
      registerCommand: (name, handler) => { commands.set(name, handler as any); return () => commands.delete(name); } });
    const event: any = { sender: { id: 1, isDestroyed: () => false }, senderFrame: {} };
    try {
      const activation: any = await commands.get('repoWiki_activate')!(event, { workspace: canonical });
      (service as any).client = client;
      const key = (value: string) => { const normalized = value.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? normalized.toLowerCase() : normalized; };
      (service as any).clientRootsKey = JSON.stringify([key(canonical)]);
      const result: any = await commands.get('repoWiki_hydrate')!(event, { __repoWikiContext: activation.context_id });
      expect(result.project).toMatchObject({ id: 'native-project', path: canonical, native_readonly: true, native_projection_error: 'PROJECTION_CONFLICT' });
      expect(modelCalls).toBe(0);
    } finally { await service.stop(); }
  });
});
