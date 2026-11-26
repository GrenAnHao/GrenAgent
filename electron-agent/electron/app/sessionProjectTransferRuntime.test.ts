import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHost } from '../agent/agentHost.js';
import { createWorkspaceHandle } from '../agent/createWorkspaceHandle.js';
import { ModelRuntime, SessionManager } from '../../../cli/src/pi-sdk.js';
import { readSessionPreferences } from '../../../extensions/_shared/session-preferences.js';
import { getAgentMode, __resetAgentModeForTest } from '../../../extensions/agent-mode/modes.js';
import { getApprovalPolicy, __resetApprovalForTest } from '../../../extensions/_shared/approval.js';
import { PiRuntimeService, type AgentHostPort } from './piRuntimeService.js';
import type { SessionProjectTransferRequest, SessionProjectTransferAck } from './sessionProjectTransferContracts.js';
import { startLoopbackModel, type LoopbackModel } from './sessionProjectTransferRuntimeLoopback.test-helper.js';
import {
  applyTransferRegistryDiff,
  readTransferRegistryRows,
  rollbackTransferRegistryDiff,
} from '../../../extensions/multi-agent/session-project-transfer.js';

const roots: string[] = [];
const loopbacks: LoopbackModel[] = [];
const hosts: AgentHost[] = [];

afterEach(async () => {
  const step = (name: string) => console.error(`[cleanup] ${name}`);
  // Real SDK handles keep SQLite (usage ledger / origin registry) mapped on Windows:
  // dispose them before removing the temp tree. A stuck extension shutdown must not
  // hang the suite, so each dispose is bounded; leftover temp trees are best-effort.
  for (const host of hosts.splice(0)) {
    for (const workspace of host.workspaces()) {
      for (const handle of host.list(workspace)) {
        step('dispose');
        await Promise.race([
          handle.dispose().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ]);
      }
    }
  }
  step('env');
  vi.unstubAllEnvs();
  __resetAgentModeForTest();
  __resetApprovalForTest();
  step('loopback');
  await Promise.all(loopbacks.splice(0).map((loopback) => loopback.close()));
  step('rm');
  // Windows may still hold a mapped SQLite file for a moment; never let cleanup
  // turn a passing scenario into a timeout (temp dirs live under tmpdir anyway).
  for (const root of roots.splice(0)) {
    await Promise.race([
      rm(root, { recursive: true, force: true, maxRetries: 0 }).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  step('done');
}, 60_000);

interface Fixture {
  root: string;
  agentDir: string;
  source: string;
  target: string;
  sourceReal: string;
  targetReal: string;
  host: AgentHost;
  service: PiRuntimeService;
  model: LoopbackModel;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'transfer-runtime-'));
  roots.push(root);
  const agentDir = join(root, 'agent');
  const source = join(root, 'projects', 'source');
  const target = join(root, 'projects', 'target');
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(source, { recursive: true }),
    mkdir(target, { recursive: true }),
  ]);
  // Real project rules: the target must contribute its own rules on the next
  // explicit request, and the source rule must not leak into it.
  await mkdir(join(source, '.pi', 'rules'), { recursive: true });
  await mkdir(join(target, '.pi', 'rules'), { recursive: true });
  await writeFile(
    join(source, '.pi', 'rules', 'source-rule.md'),
    '---\ntitle: Source rule\nenabled: true\n---\nSOURCE_ONLY_RULE_TEXT\n',
    'utf8',
  );
  await writeFile(
    join(target, '.pi', 'rules', 'target-rule.md'),
    '---\ntitle: Target rule\nenabled: true\n---\nTARGET_ONLY_RULE_TEXT\n',
    'utf8',
  );
  // The SDK resolves sessions/settings from this env; createWorkspaceHandle uses getAgentDir().
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

  const model = await startLoopbackModel();
  loopbacks.push(model);
  const modelsJson = join(agentDir, 'models.json');
  await writeFile(
    modelsJson,
    JSON.stringify({
      providers: {
        fixture: {
          api: 'openai-completions',
          baseUrl: model.url,
          apiKey: 'fixture-only',
          models: [
            {
              id: 'fixture-model',
              name: 'Fixture',
              reasoning: true,
              input: ['text'],
              contextWindow: 64_000,
              maxTokens: 2_048,
              thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
            },
          ],
        },
      },
    }),
    'utf8',
  );
  const modelRuntime = await ModelRuntime.create({
    modelsPath: modelsJson,
    authPath: join(agentDir, 'auth.json'),
    modelsStorePath: join(agentDir, 'cache.json'),
    allowModelNetwork: false,
  });
  expect(modelRuntime.getError()).toBeUndefined();

  const host = new AgentHost({
    createHandle: async (workspace, cwd, candidatePath) => createWorkspaceHandle({
      workspace,
      cwd,
      ...(candidatePath ? { candidatePath } : {}),
      modelRuntime,
      allowedExtensionsJson: JSON.stringify([]),
      resolveConfig: async () => ({}),
      emitUiRequest: () => {},
      onEvent: () => {},
      onFatal: (error) => { throw error; },
    }),
    watchConfig: () => () => {},
    onResourceReloadRequested: () => () => {},
    getConfig: () => undefined,
  });
  hosts.push(host);

  const service = new PiRuntimeService({
    agentDir,
    agentHost: host as unknown as AgentHostPort,
    modelRuntimeHost: { refresh: async () => {} },
    resolveWorkspace: async (workspace) => workspace,
    runtimeConfigPath: join(agentDir, 'runtime-settings.json'),
    permissionManager: { authorize: async () => ({ status: 'allowed', decision: 'allow' }) },
    hasLiveJobs: () => false,
    sessionTransferPorts: {
      // Production adapter shape (runtimeGraph wires the same functions). Reading
      // is the full project registry, never a UI-limited list.
      registry: {
        read: (workspace) => readTransferRegistryRows(workspace),
        apply: async (diff) => { await applyTransferRegistryDiff(diff); },
        rollback: async (diff) => { await rollbackTransferRegistryDiff(diff); },
      },
    },
  });

  return {
    root,
    agentDir,
    source,
    target,
    sourceReal: await realpath(source),
    targetReal: await realpath(target),
    host,
    service,
    model,
  };
}

/** Seed a real managed session in the source project with a confirmed leaf. */
async function seedSourceSession(f: Fixture) {
  const handle = await f.host.open(f.source, f.source);
  const manager = handle.session.sessionManager;
  // A named saved conversation avoids an unrelated auto-title request after the
  // explicit test turn; the migration itself must still make exactly zero calls.
  manager.appendSessionInfo('Transfer runtime fixture');
  const leafId = manager.appendMessage({ role: 'user', content: 'hello from source', timestamp: 1 } as never);
  handle.session.refreshContext();
  const sessionPath = handle.session.sessionFile!;
  const sessionId = handle.session.sessionId;
  const workflows = (f.service as unknown as { workflows: { savePosition(session: unknown): Promise<void> } }).workflows;
  await workflows.savePosition(handle.session);
  return { handle, sessionPath, sessionId, leafId };
}

function transfer(f: Fixture, request: SessionProjectTransferRequest): Promise<SessionProjectTransferAck> {
  return f.service.sessionProjectTransfer(request.sourceWorkspace, request);
}

function commitOf(preview: Extract<SessionProjectTransferAck, { status: 'preview' }>) {
  return {
    action: 'commit' as const,
    sourceWorkspace: preview.sourceWorkspace,
    sessionPath: preview.sessionPath,
    operationId: preview.operationId,
    ticket: preview.ticket,
    expectedSessionId: preview.sessionId,
    expectedLeafId: preview.leafId,
    expectedRevision: preview.revision,
  };
}

async function previewMove(f: Fixture, sessionPath: string) {
  const preview = await transfer(f, {
    action: 'preview',
    sourceWorkspace: f.source,
    sessionPath,
    targetWorkspace: f.target,
  });
  if (preview.status !== 'preview') throw new Error(`preview failed: ${JSON.stringify(preview)}`);
  return preview;
}

describe('session project transfer runtime integration (real SDK)', () => {
  it('moves the same session identity and path and issues zero model requests', async () => {
    const f = await fixture();
    const seeded = await seedSourceSession(f);
    const before = await readFile(seeded.sessionPath, 'utf8');
    const requestsBefore = f.model.requests.length;

    const preview = await previewMove(f, seeded.sessionPath);
    expect(preview.sessionId).toBe(seeded.sessionId);
    expect(preview.leafId).toBe(seeded.leafId);

    const committed = await transfer(f, commitOf(preview));
    expect(committed.status).toBe('opened');
    expect(f.model.requests).toHaveLength(requestsBefore);

    const after = await readFile(seeded.sessionPath, 'utf8');
    const header = JSON.parse(after.split('\n')[0]) as { id: string; cwd: string };
    expect(header.id).toBe(seeded.sessionId);
    expect(header.cwd).toBe(f.targetReal);
    // Existing history lines are byte-identical; only append-only metadata was added.
    const beforeLines = before.split('\n').filter(Boolean);
    const afterLines = after.split('\n').filter(Boolean);
    expect(afterLines.slice(1, beforeLines.length)).toEqual(beforeLines.slice(1));

    // The confirmed leaf survives the appended migration metadata.
    const reopened = SessionManager.open(seeded.sessionPath);
    const workflows = (f.service as unknown as {
      workflows: { restoreReadOnlyPosition(manager: unknown, path: string): Promise<void> };
    }).workflows;
    await workflows.restoreReadOnlyPosition(reopened, seeded.sessionPath);
    expect(reopened.getLeafId()).toBe(seeded.leafId);

    // A real target handle owns the same canonical path and identity.
    const targetHandle = f.host.list(f.target).find((handle) => handle.session.sessionFile === seeded.sessionPath);
    expect(targetHandle).toBeDefined();
    expect(targetHandle!.session.sessionId).toBe(seeded.sessionId);
    expect(targetHandle!.session.sessionManager.getSessionName()).toBe('Transfer runtime fixture');
    expect(f.host.get(f.target)).toBe(targetHandle);
    // The source runtime no longer holds the moved session.
    expect(f.host.list(f.source).some((handle) => handle.session.sessionFile === seeded.sessionPath)).toBe(false);
  }, 180_000);

  it('refuses to open the moved session under the source project', async () => {
    const f = await fixture();
    const seeded = await seedSourceSession(f);
    const preview = await previewMove(f, seeded.sessionPath);
    expect((await transfer(f, commitOf(preview))).status).toBe('opened');

    // After the move the header names the target: the source cannot reclaim it.
    await expect(
      f.service.send(f.source, 'agent_switch_session', { sessionPath: seeded.sessionPath }),
    ).rejects.toThrow(/SESSION_WORKSPACE_MISMATCH/);
    const reopened = await f.host.open(f.source, f.source);
    expect(reopened.session.sessionFile).not.toBe(seeded.sessionPath);
  }, 180_000);

  it('refuses a transfer while the source turn is still streaming and leaves the history untouched', async () => {
    const f = await fixture();
    const seeded = await seedSourceSession(f);
    // A slow stream keeps the turn active: busy must be detected from the real
    // runtime session, not from a UI flag.
    f.model.lineDelayMs = 60_000;
    const pending = f.service.send(f.source, 'agent_prompt', { message: 'still running' }).catch(() => undefined);
    await vi.waitFor(() => expect(seeded.handle.session.isStreaming).toBe(true));

    const before = await readFile(seeded.sessionPath, 'utf8');
    const preview = await transfer(f, {
      action: 'preview',
      sourceWorkspace: f.source,
      sessionPath: seeded.sessionPath,
      targetWorkspace: f.target,
    });
    expect(preview.status).toBe('busy');
    if (preview.status === 'busy') expect(preview.busyReason).toBe('turn-active');
    // The task is not cancelled by the refusal and nothing moved.
    expect(seeded.handle.session.isStreaming).toBe(true);
    const header = JSON.parse((await readFile(seeded.sessionPath, 'utf8')).split('\n')[0]) as { cwd: string };
    expect(header.cwd).toBe(f.sourceReal);

    f.model.release();
    await pending;
    await f.service.send(f.source, 'agent_abort', {}).catch(() => undefined);
    expect(before.length).toBeGreaterThan(0);
  }, 180_000);

  it('keeps a busy target project session running while the moved session opens as an additional handle', async () => {
    const f = await fixture();
    const seeded = await seedSourceSession(f);
    const busy = await f.host.open(f.target, f.target);
    busy.session.sessionManager.appendSessionInfo('Busy target fixture');
    const busyPath = busy.session.sessionFile!;
    const busyId = busy.session.sessionId;
    // Hold a real loopback response, not merely an idle handle named "busy".
    f.model.lineDelayMs = 1;
    await f.service.send(f.target, 'agent_prompt', {message:'keep the unrelated target turn streaming'});
    await vi.waitFor(() => expect(busy.session.isStreaming).toBe(true));
    await vi.waitFor(() => expect(f.model.requests.length).toBe(1));
    try {
      const preview = await previewMove(f, seeded.sessionPath);
      expect((await transfer(f, commitOf(preview))).status).toBe('opened');
      expect(f.model.requests).toHaveLength(1); // Transfer did not start a second model request.
      const handles = f.host.list(f.target);
      const busyHandle = handles.find((handle) => handle.session.sessionId === busyId);
      expect(busyHandle).toBeDefined();
      expect(busyHandle!.session.sessionFile).toBe(busyPath);
      expect(busyHandle!.session.isStreaming).toBe(true);
      const movedHandle = handles.find((handle) => handle.session.sessionFile === seeded.sessionPath);
      expect(movedHandle?.session.sessionId).toBe(seeded.sessionId);
      expect(f.host.get(f.target)).toBe(movedHandle);
    } finally {
      f.model.lineDelayMs = 0; f.model.release(); await busy.session.waitForIdle();
    }
  }, 180_000);

  it('preserves model, thinking and Fast but never widens target permissions', async () => {
    const f = await fixture();
    const seeded = await seedSourceSession(f);
    await f.service.send(f.source, 'agent_set_model', {
      provider: 'fixture',
      modelId: 'fixture-model',
      targetSessionPath: seeded.sessionPath,
    });
    await f.service.send(f.source, 'agent_set_thinking_level', { level: 'high', targetSessionPath: seeded.sessionPath });
    await f.service.send(f.source, 'agent_set_fast_mode', { enabled: true, targetSessionPath: seeded.sessionPath });
    await f.service.send(f.source, 'agent_set_mode', { mode: 'agent', targetSessionPath: seeded.sessionPath });
    await f.service.send(f.source, 'agent_set_approval', { level: 'full', targetSessionPath: seeded.sessionPath });
    const beforePrefs = readSessionPreferences(SessionManager.open(seeded.sessionPath).getEntries() as never);
    expect(beforePrefs).toMatchObject({
      model: { provider: 'fixture', id: 'fixture-model' },
      thinkingLevel: 'high',
      fastMode: true,
      mode: 'agent',
      approval: 'full',
    });

    const preview = await previewMove(f, seeded.sessionPath);
    expect((await transfer(f, commitOf(preview))).status).toBe('opened');

    const afterPrefs = readSessionPreferences(SessionManager.open(seeded.sessionPath).getEntries() as never);
    // Explicit prefs kept.
    expect(afterPrefs.model).toEqual({ provider: 'fixture', id: 'fixture-model' });
    expect(afterPrefs.thinkingLevel).toBe('high');
    expect(afterPrefs.fastMode).toBe(true);
    // No local grant in the target → ask / readonly, never the source's `full`.
    expect(afterPrefs.mode).toBe('ask');
    expect(afterPrefs.approval).toBe('readonly');
    expect(afterPrefs.revision).toBeGreaterThan(beforePrefs.revision);

    const targetHandle = f.host.list(f.target).find((handle) => handle.session.sessionFile === seeded.sessionPath)!;
    expect(getAgentMode(f.target, targetHandle.session.sessionId)).toBe('ask');
    expect(getApprovalPolicy(f.target, targetHandle.session.sessionId)).toBe('readonly');
    // Live model/thinking on the reopened runtime are the preserved values.
    expect(targetHandle.session.model).toMatchObject({ provider: 'fixture', id: 'fixture-model' });
    expect(targetHandle.session.thinkingLevel).toBe('high');
  }, 180_000);

  it('keeps an unavailable requested model and rejects a prompt rather than sending through a fallback', async () => {
    const f = await fixture();
    const seeded = await seedSourceSession(f);
    const missing = { provider: 'removed-provider', id: 'removed-model' };
    await f.service.send(f.source, 'agent_set_model', {
      provider: missing.provider, modelId: missing.id, targetSessionPath: seeded.sessionPath,
    });
    // Model history may name a provider removed since the last successful turn.
    seeded.handle.session.sessionManager.appendModelChange(missing.provider, missing.id);
    const preview = await previewMove(f, seeded.sessionPath);
    expect((await transfer(f, commitOf(preview))).status).toBe('opened');
    const preferences = readSessionPreferences(SessionManager.open(seeded.sessionPath).getEntries() as never);
    expect(preferences.model).toEqual(missing);
    expect(await f.service.send(f.target, 'agent_get_state', {})).toMatchObject({
      preferences: { model: missing }, unavailable: expect.arrayContaining(['model']),
    });
    await expect(f.service.send(f.target, 'agent_prompt', { message: 'must not use a fallback model' }))
      .rejects.toThrow('SESSION_MODEL_UNAVAILABLE');
    expect(f.model.requests).toHaveLength(0);
  }, 180_000);

  it('injects target project rules on the next explicit request only', async () => {
    const f = await fixture();
    const seeded = await seedSourceSession(f);
    const preview = await previewMove(f, seeded.sessionPath);
    const afterMove = f.model.requests.length;
    expect((await transfer(f, commitOf(preview))).status).toBe('opened');
    expect(f.model.requests).toHaveLength(afterMove);

    await f.service.send(f.target, 'agent_prompt', { message: 'explicit request after move' });
    await vi.waitFor(() => expect(f.model.requests.length).toBe(afterMove + 1));
    const sent = f.model.requests.at(-1)!;
    expect(sent.body).toContain('TARGET_ONLY_RULE_TEXT');
    expect(sent.body).not.toContain('SOURCE_ONLY_RULE_TEXT');
    expect(sent.body).toContain('explicit request after move');
  }, 180_000);

  it('reports committed-needs-open when the target runtime fails, then retry-open is idempotent', async () => {
    const f = await fixture();
    const seeded = await seedSourceSession(f);
    const preview = await previewMove(f, seeded.sessionPath);

    const spy = vi.spyOn(f.host, 'openAdditional').mockRejectedValue(new Error('fixture target runtime failure'));
    const failed = await transfer(f, commitOf(preview));
    spy.mockRestore();
    expect(failed.status).toBe('committed-needs-open');
    if (failed.status === 'committed-needs-open') {
      expect(failed.operationId).toBe(preview.operationId);
      expect(failed.targetWorkspace).toBe(f.targetReal);
      expect(failed.retryable).toBe(true);
    }

    // The durable move happened even though the runtime did not open.
    expect(JSON.parse((await readFile(seeded.sessionPath, 'utf8')).split('\n')[0]).cwd).toBe(f.targetReal);

    const beforeRetry = f.model.requests.length;
    const retried = await transfer(f, {
      action: 'retry-open',
      sourceWorkspace: f.source,
      sessionPath: seeded.sessionPath,
      operationId: preview.operationId,
    });
    expect(retried.status).toBe('opened');
    expect(f.model.requests).toHaveLength(beforeRetry);

    // Repeat retry and status return the same fact without a second move.
    expect((await transfer(f, {
      action: 'retry-open',
      sourceWorkspace: f.source,
      sessionPath: seeded.sessionPath,
      operationId: preview.operationId,
    })).status).toBe('opened');
    expect((await transfer(f, {
      action: 'status',
      sourceWorkspace: f.source,
      sessionPath: seeded.sessionPath,
      operationId: preview.operationId,
    })).status).toBe('opened');

    // Exactly one target handle for the moved path after the idempotent retry.
    expect(f.host.list(f.target).filter((handle) => handle.session.sessionFile === seeded.sessionPath)).toHaveLength(1);
    const before = await readFile(seeded.sessionPath, 'utf8');
    expect(before.match(/"customType":"session_project_transfer"/g) ?? []).toHaveLength(1);
  }, 180_000);
});
