import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import { PiRuntimeService } from './piRuntimeService.js';
import { RpcPeer } from '../agentProcess/rpcPeer.js';
import { createAgentPorts } from '../agentProcess/mainBindings.js';
import { beginGoalOwner, __resetGoalActivationsForTest } from '../../../extensions/goal/status.js';
import { registerGoalControl, __resetGoalControlsForTest } from '../../../extensions/goal/control.js';
import { createGoal, pauseGoal, readSnapshot } from '../../../extensions/goal/session.js';
import { __resetGoalAuthForTest } from '../../../extensions/goal/auth.js';
import { __resetGoalContinueForTest } from '../../../extensions/goal/continue.js';
import { __resetApprovalForTest, getApprovalPolicy, setApprovalPolicy } from '../../../extensions/_shared/approval.js';
import { currentWorkspaceContext, currentSessionId } from '../../../extensions/_shared/workspace-context.js';
import { getConfig } from '../../../extensions/_shared/runtime-config.js';
import { WorkspaceHandle } from '../agent/workspaceHandle.js';

const directories: string[] = [];
afterEach(async () => {
  __resetGoalControlsForTest(); __resetGoalActivationsForTest(); __resetGoalAuthForTest(); __resetGoalContinueForTest();
  __resetApprovalForTest();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'goal-control-host-')); directories.push(dir);
  const workspace = join(dir, 'project');
  const manager = SessionManager.create(workspace, join(dir, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'work', timestamp: 1 } as never);
  const id = manager.getSessionId();
  const ctx = { cwd: workspace, sessionManager: manager, ui: { notify: vi.fn(), setStatus: vi.fn() } };
  const append = vi.fn((type, event) => manager.appendCustomEntry(type, event));
  const pi = { appendEntry: append, sendMessage: vi.fn() };
  beginGoalOwner(id); registerGoalControl(pi as never, ctx as never);
  createGoal(pi as never, ctx as never, 'first');
  const session = { sessionId: id, sessionFile: manager.getSessionFile(), sessionManager: manager, isStreaming: true };
  const agentDataEndpoint = vi.fn(async () => 'workspace-endpoint');
  const owner = new WorkspaceHandle({ workspace, cwd: workspace, runtime: { session } as never,
    resolveConfig: (origin) => service.turnConfig(workspace, workspace, origin),
    emitUiRequest: vi.fn(), onEvent: vi.fn(), onFatal: vi.fn() });
  vi.spyOn(owner, 'prompt').mockResolvedValue(undefined);
  const front = { workspace, cwd: workspace, session: { ...session, sessionId: 'other', sessionFile: join(dir, 'other.jsonl') }, prompt: vi.fn() };
  const host = { get: vi.fn(() => front), list: vi.fn(() => [front, owner]), workspaces: () => [workspace], focus: vi.fn(), open: vi.fn() };
  const service = new PiRuntimeService({ agentDir: join(dir, 'agent'), agentHost: host as never, modelRuntimeHost: {} as never, agentDataEndpoint });
  const snapshot = readSnapshot(ctx as never)!;
  const request = { operationId: 'host-edit-1', action: 'edit', goalId: snapshot.goalId, expectedRevision: snapshot.revision, expectedConditionRevision: snapshot.conditionRevision, condition: 'second' };
  return { workspace, manager, id, ctx: ctx as never, pi, append, owner, front, host, service, request, path: manager.getSessionFile()!, agentDataEndpoint };
}

describe('agent_goal_control original-owner host route', () => {
  it('keeps a real RPC acknowledgement pending until delivery and replays the committed operation after a lost receipt', async () => {
    const f = await fixture();
    let held: unknown;
    let releaseAck: (() => void) | undefined;
    const main = new RpcPeer({ send: (message) => queueMicrotask(() => child.receive(structuredClone(message))) });
    const child = new RpcPeer({ send: (message) => {
      if (message.t === 'res' && message.ok && !held) {
        held = structuredClone(message);
        releaseAck = () => main.receive(held);
      } else queueMicrotask(() => main.receive(structuredClone(message)));
    } });
    child.handle('pi.send', (input) => f.service.send(String(input.workspace), String(input.command), input.args as Record<string, unknown>));
    const ports = createAgentPorts((method, params) => main.request(method, params));
    let acknowledged = false;
    const pending = ports.pi.send(f.workspace, 'agent_goal_control', { targetSessionPath: f.path, ...f.request }).then((receipt) => { acknowledged = true; return receipt; });
    await vi.waitUntil(() => !!releaseAck);
    expect(acknowledged).toBe(false);
    expect(readSnapshot(f.ctx)?.condition).toBe('second');
    const writes = f.append.mock.calls.length;
    // Same operation over a second RPC obtains its durable result without append.
    const replay = await ports.pi.send(f.workspace, 'agent_goal_control', { targetSessionPath: f.path, ...f.request });
    expect(replay).toMatchObject({ outcome: 'committed', replayed: true, operationId: f.request.operationId, sessionId: f.id });
    expect(f.append).toHaveBeenCalledTimes(writes);
    releaseAck!();
    const original = await pending;
    expect(original).toMatchObject({ outcome: 'committed', committedRevision: 2, sessionId: f.id });
    await writeFile(join(process.cwd(), '../.agents/evidence/2026-11-17-visual-review-and-goal-lifecycle/goal-control-rpc-receipts.json'), JSON.stringify({ transport: 'production RpcPeer + createAgentPorts + PiRuntimeService, structuredClone loopback', original, replay }, null, 2));
    main.close(new Error('fixture completed')); child.close(new Error('fixture completed'));
  });

  it('commits only to the requested background session, not via prompt acceptance', async () => {
    const f = await fixture();
    const result = await f.service.send(f.workspace, 'agent_goal_control', { targetSessionPath: f.path, ...f.request });
    expect(result).toMatchObject({ outcome: 'committed', operationId: f.request.operationId, sessionId: f.id, goalId: f.request.goalId, committedRevision: 2, snapshot: { condition: 'second' } });
    expect(f.owner.prompt).not.toHaveBeenCalled(); expect(f.front.prompt).not.toHaveBeenCalled(); expect(f.host.focus).not.toHaveBeenCalled(); expect(f.host.open).not.toHaveBeenCalled();
    const persisted = SessionManager.open(f.path).getEntries().filter((entry: any) => entry.customType === 'goal');
    expect(persisted).toHaveLength(2);
    expect(f.agentDataEndpoint).not.toHaveBeenCalled();
  });

  it('resumes under the original owner approval and endpoint, without borrowing the foreground session', async () => {
    const f = await fixture();
    pauseGoal(f.pi as never, f.ctx);
    setApprovalPolicy('full', f.workspace, f.id);
    setApprovalPolicy('readonly', f.workspace, 'other');
    const dispatches: unknown[] = [];
    f.pi.sendMessage.mockImplementation(async () => {
      dispatches.push({ origin: currentWorkspaceContext()?.origin, sessionId: currentSessionId(),
        endpoint: getConfig('AGENT_DATA_ENDPOINT'), preset: getApprovalPolicy(), human: getConfig('PI_HUMAN_ORIGIN_TOKEN') });
    });
    const snapshot = readSnapshot(f.ctx)!;
    const request = { targetSessionPath: f.path, operationId: 'resume-original', action: 'resume', goalId: snapshot.goalId,
      expectedRevision: snapshot.revision, expectedConditionRevision: snapshot.conditionRevision };
    const receipt = await f.service.send(f.workspace, 'agent_goal_control', request);
    expect(receipt).toMatchObject({ outcome: 'committed', sessionId: f.id });
    await vi.waitFor(() => expect(dispatches).toEqual([{ origin: 'goal', sessionId: f.id, endpoint: 'workspace-endpoint', preset: 'full', human: '0' }]));
    expect(f.agentDataEndpoint).toHaveBeenCalledWith(f.workspace);
    expect(f.owner.prompt).not.toHaveBeenCalled(); expect(f.front.prompt).not.toHaveBeenCalled();
    expect(await f.service.send(f.workspace, 'agent_goal_control', request)).toMatchObject({ outcome: 'committed', replayed: true });
    expect(f.agentDataEndpoint).toHaveBeenCalledTimes(1);
    expect(dispatches).toHaveLength(1);
  });

  it('keeps a committed receipt replayable if the original owner cannot prepare the round', async () => {
    const f = await fixture();
    pauseGoal(f.pi as never, f.ctx);
    f.agentDataEndpoint.mockRejectedValueOnce(new Error('endpoint details must not be persisted'));
    const snapshot = readSnapshot(f.ctx)!;
    const request = { targetSessionPath: f.path, operationId: 'resume-no-endpoint', action: 'resume', goalId: snapshot.goalId,
      expectedRevision: snapshot.revision, expectedConditionRevision: snapshot.conditionRevision };
    expect(await f.service.send(f.workspace, 'agent_goal_control', request)).toMatchObject({ outcome: 'committed' });
    await vi.waitFor(() => expect(readSnapshot(f.ctx)).toMatchObject({ status: 'paused', roundsStarted: 0,
      pauseReason: { code: 'runtime-error' } }));
    expect(f.pi.sendMessage).not.toHaveBeenCalled();
    expect(await f.service.send(f.workspace, 'agent_goal_control', request)).toMatchObject({ outcome: 'committed', replayed: true });
    expect(f.agentDataEndpoint).toHaveBeenCalledTimes(1);
  });

  it('recovers an acknowledgement after owner reload without duplicating the append', async () => {
    const f = await fixture();
    await f.service.send(f.workspace, 'agent_goal_control', { targetSessionPath: f.path, ...f.request });
    beginGoalOwner(f.id); registerGoalControl(f.pi as never, f.ctx);
    const before = f.append.mock.calls.length;
    const recovered = await f.service.send(f.workspace, 'agent_goal_control', { targetSessionPath: f.path, ...f.request });
    expect(recovered).toMatchObject({ outcome: 'committed', replayed: true, committedRevision: 2 });
    expect(f.append).toHaveBeenCalledTimes(before);
    expect(await f.service.send(f.workspace, 'agent_goal_control', { targetSessionPath: f.path, ...f.request, operationId: 'stale-edit' })).toMatchObject({ outcome: 'conflict' });
  });

  it('reports unavailable or write failure rather than claiming a nonexistent commit', async () => {
    const f = await fixture();
    f.append.mockImplementation(() => { throw new Error('disk unavailable'); });
    expect(await f.service.send(f.workspace, 'agent_goal_control', { targetSessionPath: f.path, ...f.request })).toMatchObject({ outcome: 'failed', message: 'disk unavailable' });
    expect(readSnapshot(f.ctx)?.condition).toBe('first');
    f.host.list.mockReturnValue([f.front]);
    expect(await f.service.send(f.workspace, 'agent_goal_control', { targetSessionPath: f.path, ...f.request })).toMatchObject({ outcome: 'unavailable', operationId: f.request.operationId });
    expect(f.host.open).not.toHaveBeenCalled();
    await expect(f.service.send(join(f.workspace, 'other'), 'agent_goal_control', { targetSessionPath: f.path, ...f.request })).rejects.toThrow('SESSION_WORKSPACE_MISMATCH');
  });
});
