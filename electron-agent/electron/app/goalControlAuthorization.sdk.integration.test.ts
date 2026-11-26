import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAgentSessionFromServices, createAgentSessionServices, resolveCliModel } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager, SettingsManager } from '../../../cli/src/pi-sdk.js';
import { __resetApprovalForTest, setApprovalPolicy } from '../../../extensions/_shared/approval.js';
import goalExtension from '../../../extensions/goal/index.js';
import { foldGoal } from '../../../extensions/goal/fold.js';
import safetyExtension from '../../../extensions/safety/index.js';
import { WorkspaceHandle } from '../agent/workspaceHandle.js';
import { MinimalExtensionEndpoint } from '../agentData/minimalEndpoint.js';
import { AgentDataStorage } from '../agentData/storage.js';
import { PiRuntimeService } from './piRuntimeService.js';
import { ToolAuditStore } from './toolPermission/auditStore.js';
import { ToolRuleStore } from './toolPermission/ruleStore.js';
import { ToolDecisionService } from './toolPermission/toolDecisionService.js';
import { toolPermissionMethods } from './toolPermission/rpc.js';

it('a desktop Goal resume sends the first and following round through the original session authorization', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'gren-goal-auth-sdk-'));
  const agentDir = join(workspace, 'agent');
  const path = process.platform === 'win32'
    ? '\\\\.\\pipe\\gren-goal-auth-' + randomUUID()
    : join(workspace, 'auth.sock');
  const token = 'fixture-owner-token';
  const storage = new AgentDataStorage(join(workspace, 'audit.db'));
  let handle: WorkspaceHandle | undefined;
  const audit = new ToolAuditStore(storage.db);
  const rules = new ToolRuleStore(storage.db);
  const decisions = new ToolDecisionService(rules, audit);
  const auditCall = vi.spyOn(audit, 'record');
  const evaluate = vi.fn(async (owner: string, call: unknown) => toolPermissionMethods(decisions, owner)['permission.tool.evaluate']!({ call }));
  const endpoint = new MinimalExtensionEndpoint({
    listenPath: path, workspaceTokens: new Map([[token, workspace]]),
    codeRetrieval: { call: async () => null },
    toolPermission: { evaluate, remember: async () => null, settle: async () => null },
  });
  try {
    storage.migrate();
    await endpoint.start();
    const modelRuntime = await ModelRuntime.create({ authPath: join(workspace, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider({ provider: 'faux', models: [{ id: 'local' }] });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('get_goal', {})),
      fauxAssistantMessage(fauxText('first round done')),
      fauxAssistantMessage(fauxToolCall('create_goal', { condition: 'must not execute' })),
    ]);
    const manager = SessionManager.create(workspace, join(workspace, 'sessions'));
    manager.appendMessage({ role: 'user', content: 'goal fixture', timestamp: 1 });
    const sessionId = manager.getSessionId();
    manager.appendCustomEntry('goal', { kind: 'create', goalId: 'test-goal', revision: 1, at: new Date(2).toISOString(),
      payload: { condition: 'fixture', maxRounds: 2 } });
    manager.appendCustomEntry('goal', { kind: 'pause', goalId: 'test-goal', revision: 2, at: new Date(3).toISOString(), payload: {} });
    const deny = rules.add({ scope: 'session', scopeKey: sessionId, tool: 'create_goal', matcherKind: 'any', matcher: '', effect: 'deny' });
    const services = await createAgentSessionServices({
      cwd: workspace, agentDir, modelRuntime,
      settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false } }),
      resourceLoaderOptions: { extensionFactories: [safetyExtension, goalExtension] as never,
        noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true },
    });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager,
      model: resolveCliModel({ cliModel: 'faux/local', modelRuntime }).model });
    const host = { get: () => handle, list: () => handle ? [handle] : [], workspaces: () => [workspace] };
    const service = new PiRuntimeService({ agentDir, agentHost: host as never, modelRuntimeHost: {} as never,
      agentDataEndpoint: async () => JSON.stringify({ path, token }) });
    handle = new WorkspaceHandle({ workspace, cwd: workspace,
      runtime: { session, setRebindSession() {}, setBeforeSessionInvalidate() {}, dispose: () => session.dispose() } as never,
      resolveConfig: (origin) => service.turnConfig(workspace, workspace, origin),
      onEvent: vi.fn(), emitUiRequest: vi.fn(), onFatal: vi.fn() });
    await handle.start();
    setApprovalPolicy('full', workspace, sessionId);
    const receipt = await service.send(workspace, 'agent_goal_control', { targetSessionPath: manager.getSessionFile(),
      operationId: 'resume-fixture', action: 'resume', goalId: 'test-goal', expectedRevision: 2, expectedConditionRevision: 1 });
    expect(receipt).toMatchObject({ outcome: 'committed' });
    await vi.waitFor(() => {
      expect(foldGoal(manager.getEntries())).toMatchObject({ status: 'paused', roundsStarted: 2 });
      expect(auditCall.mock.calls.map(([row]) => row)).toMatchObject([
        { sessionId, workspace, tool: 'get_goal', origin: 'goal', decision: 'allow' },
        { sessionId, workspace, tool: 'create_goal', origin: 'goal', decision: 'deny', ruleId: deny.id },
      ]);
    }, { timeout: 4000 });
    expect(evaluate.mock.calls.map(([, call]) => call)).toMatchObject([{ preset: 'full' }, { preset: 'full' }]);
    const results = manager.getEntries().flatMap((entry) => entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []);
    expect(results).toMatchObject([{ toolName: 'get_goal', isError: false }, { toolName: 'create_goal', isError: true }]);
  } finally {
    await handle?.dispose();
    await endpoint.close();
    storage.close();
    __resetApprovalForTest();
    await rm(workspace, { recursive: true, force: true });
  }
}, 15_000);
