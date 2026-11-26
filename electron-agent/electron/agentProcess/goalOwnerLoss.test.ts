import { describe, expect, it } from 'vitest';
import { GoalOwnerLossTracker } from './goalOwnerLoss.js';
import { createAgentBroadcaster, createHostMethods } from './mainBindings.js';
import { hostApiOverRequest } from './hostApi.js';
import { RpcPeer, type WireMessage } from './rpcPeer.js';
import { BROADCAST_CHANNEL, GOAL_WORKSLOT_CHANNEL, type BroadcastPayload, type GoalWorkslotNotice, type HostApi } from './contract.js';

const slot = (over: Partial<GoalWorkslotNotice> = {}): GoalWorkslotNotice => ({
  workspace: '/repo', sessionPath: '/sessions/a.jsonl', sessionId: 'session-a', ownerEpoch: 'old-owner',
  goalId: 'goal-a', revision: 2, runNumber: 1, conditionRevision: 1,
  roundId: 'round-a', sequence: 1, occupied: true, ...over,
});

function trackerHostMethods(tracker: GoalOwnerLossTracker) {
  return createHostMethods({
    resolveWorkspace: async path => path, agentDataEndpoint: () => undefined,
    mcpRuntime: async () => [], allowedPluginIds: () => [],
    authorize: async () => ({ status: 'allowed', decision: 'allow' }) as never,
    mergeRuntimeSettings: async () => {}, invalidateSessionRecords: () => {},
    goalLossClaim: (path, id) => tracker.claim(path, id), goalLossAck: loss => tracker.ack(loss),
    thread: { createThread: async () => {}, createTurn: async () => {}, updateTurn: async () => {}, upsertItem: async () => {} },
  });
}

function loopback(tracker: GoalOwnerLossTracker): HostApi {
  const methods = trackerHostMethods(tracker);
  return hostApiOverRequest(async (method, params) => methods[method](params ?? {}) as never);
}

describe('confirmed agent-host Goal owner loss', () => {
  it('only confirms a still occupied slot on an unexpected process exit; normal exit makes no pause fact', async () => {
    const tracker = new GoalOwnerLossTracker(); const host = loopback(tracker);
    tracker.report(slot());
    tracker.report(slot({ sequence: 2, occupied: false }));
    expect(tracker.confirmUnexpectedExit()).toEqual([]);
    await expect(host.goalLossClaim('/sessions/a.jsonl', 'session-a')).resolves.toBeUndefined();
    tracker.report(slot()); tracker.clearExpectedExit();
    expect(tracker.confirmUnexpectedExit()).toEqual([]);
    const next = slot({ ownerEpoch: 'second-host', sequence: 1 });
    tracker.report(next);
    const losses = tracker.confirmUnexpectedExit();
    expect(losses).toEqual([next]);
    await expect(host.goalLossClaim('/sessions/a.jsonl', 'wrong-session')).resolves.toBeUndefined();
    await expect(host.goalLossClaim('/sessions/a.jsonl', 'session-a')).resolves.toEqual(next);
  });

  it('old releases and stale ACKs cannot remove a newer owner fence', async () => {
    const tracker = new GoalOwnerLossTracker(); const host = loopback(tracker);
    tracker.report(slot()); tracker.report(slot({ sequence: 2, roundId: 'other', occupied: false }));
    tracker.report(slot({ sequence: 1, occupied: false })); // queued old release
    tracker.report(slot({ ownerEpoch: 'new-owner', roundId: 'new-round', sequence: 1, revision: 3 }));
    const [loss] = tracker.confirmUnexpectedExit();
    tracker.report(slot({ ownerEpoch: 'new-owner', roundId: 'new-round', sequence: 2 }));
    expect(tracker.confirmUnexpectedExit()).toEqual([]); // late event from the dead owner
    expect(loss.ownerEpoch).toBe('new-owner');
    await expect(host.goalLossAck({ ...slot(), occupied: true })).resolves.toBe(false);
    await expect(host.goalLossAck({ ...loss, sequence: loss.sequence + 1 })).resolves.toBe(false);
    await expect(host.goalLossClaim(loss.sessionPath, loss.sessionId)).resolves.toEqual(loss);
    await expect(host.goalLossAck(loss)).resolves.toBe(true);
    await expect(host.goalLossClaim(loss.sessionPath, loss.sessionId)).resolves.toBeUndefined();
  });

  it('a stale release after a newer sequence from the same owner cannot revoke the slot', () => {
    const tracker = new GoalOwnerLossTracker();
    tracker.report(slot({ sequence: 3, roundId: 'new-round' }));
    tracker.report(slot({ sequence: 2, occupied: false }));
    expect(tracker.confirmUnexpectedExit()).toMatchObject([{ roundId: 'new-round' }]);
  });
});

/**
 * 子进程 hostEntry 与主进程 main.ts 之间的真实 RpcPeer 环回（同进程内传消息，不是 OS 进程）。
 * sent 收子进程发出的每条 wire 消息。
 */
function connectedPeers() {
  let host!: RpcPeer;
  let main!: RpcPeer;
  const sent: WireMessage[] = [];
  host = new RpcPeer({ send: (message) => { sent.push(message); main.receive(message); } });
  main = new RpcPeer({ send: (message) => host.receive(message) });
  return { host, main, sent };
}

describe('agent-host Goal workslot broadcast over RpcPeer', () => {
  it('occupancy evidence goes out on GOAL_WORKSLOT_CHANNEL, then main confirms and serves claim/ACK', async () => {
    const { host, main, sent } = connectedPeers();
    const tracker = new GoalOwnerLossTracker();
    main.handleAll(trackerHostMethods(tracker));
    const renderer: Array<{ channel: string; payload: unknown }> = [];
    // main.ts onEvent 的分支语义：DIAG / GOAL_WORKSLOT 就地消费并 return，只有 broadcast 信封解包后进渲染层。
    main.onEvent((channel, payload) => {
      if (channel === GOAL_WORKSLOT_CHANNEL) {
        tracker.report(payload);
        return;
      }
      if (channel !== BROADCAST_CHANNEL) return;
      const message = payload as BroadcastPayload;
      if (typeof message?.channel === 'string') renderer.push({ channel: message.channel, payload: message.payload });
    });
    const broadcast = createAgentBroadcaster((channel, payload) => host.emit(channel, payload));

    const notice = slot();
    broadcast(GOAL_WORKSLOT_CHANNEL, notice);

    // 内部通道和 DIAG 同级直发：外层不是 broadcast 信封，main 不会把它当渲染层事件。
    expect(sent).toEqual([{ t: 'evt', channel: GOAL_WORKSLOT_CHANNEL, payload: notice }]);
    expect(renderer).toEqual([]);
    const losses = tracker.confirmUnexpectedExit();
    expect(losses).toEqual([notice]);

    const api = hostApiOverRequest((method, params) => host.request(method, params));
    await expect(api.goalLossClaim(notice.sessionPath, notice.sessionId)).resolves.toEqual(losses[0]);
    await expect(api.goalLossAck(losses[0])).resolves.toBe(true);
  });

  it('ordinary runtime events keep the broadcast envelope and still reach the renderer', () => {
    const { host, main, sent } = connectedPeers();
    const renderer: Array<{ channel: string; payload: unknown }> = [];
    main.onEvent((channel, payload) => {
      if (channel === GOAL_WORKSLOT_CHANNEL) return;
      if (channel !== BROADCAST_CHANNEL) return;
      const message = payload as BroadcastPayload;
      if (typeof message?.channel === 'string') renderer.push({ channel: message.channel, payload: message.payload });
    });
    const broadcast = createAgentBroadcaster((channel, payload) => host.emit(channel, payload));
    const event = { type: 'message_update', message: { id: 'm1' } };

    broadcast('pi://event', event);

    expect(sent).toEqual([{ t: 'evt', channel: BROADCAST_CHANNEL, payload: { channel: 'pi://event', payload: event } }]);
    expect(renderer).toEqual([{ channel: 'pi://event', payload: event }]);
  });
});
