import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { cancelQueuedSteer, type SteerQueueSession } from './cancelQueuedSteer';

/**
 * 用 pi 1.3.0 真实的 AgentSession 原型方法和真实 Agent 队列拼一个最小会话：
 * pi 改了内部队列的名字或形状，这里会先红。
 */
function realQueueSession() {
  const session = Object.create(AgentSession.prototype) as Record<string, unknown>;
  const events: Array<{ type: string; steering?: string[]; followUp?: string[] }> = [];
  session._steeringMessages = [];
  session._followUpMessages = [];
  session._eventListeners = [(event: (typeof events)[number]) => events.push(event)];
  session.agent = new Agent({} as never);
  const queueSteer = (text: string, images?: unknown[]) =>
    (AgentSession.prototype as unknown as { _queueSteer: (t: string, i?: unknown[]) => Promise<void> })._queueSteer.call(session, text, images);
  const agentQueue = () =>
    ((session.agent as { steeringQueue: { messages: Array<{ content: unknown[] }> } }).steeringQueue.messages);
  return { session: session as unknown as SteerQueueSession & Record<string, unknown>, events, queueSteer, agentQueue };
}

describe('cancelQueuedSteer', () => {
  it('从真实 pi 队列里只撤下那一条，其余引导连同图片原样留着', async () => {
    const { session, events, queueSteer, agentQueue } = realQueueSession();
    const image = { type: 'image', mimeType: 'image/png', data: 'AAAA' };
    await queueSteer('改用 chrome');
    await queueSteer('再补登录态', [image]);
    await queueSteer('多账号自动填充');

    await expect(cancelQueuedSteer(session, '再补登录态')).resolves.toEqual({ cancelled: true });

    expect(session.getSteeringMessages!()).toEqual(['改用 chrome', '多账号自动填充']);
    expect(agentQueue().map((m) => (m.content[0] as { text: string }).text)).toEqual(['改用 chrome', '多账号自动填充']);
    expect(events.at(-1)).toMatchObject({ type: 'queue_update', steering: ['改用 chrome', '多账号自动填充'] });

    await expect(cancelQueuedSteer(session, '改用 chrome')).resolves.toEqual({ cancelled: true });
    expect(agentQueue()).toHaveLength(1);
  });

  it('同样的正文排了两条时只撤一条', async () => {
    const { session, queueSteer, agentQueue } = realQueueSession();
    await queueSteer('继续');
    await queueSteer('继续');
    await cancelQueuedSteer(session, '继续');
    expect(agentQueue()).toHaveLength(1);
    expect(session.getSteeringMessages!()).toEqual(['继续']);
  });

  it('已经被取走、正在注入的引导撤不回来', async () => {
    const { session, queueSteer, agentQueue } = realQueueSession();
    await queueSteer('改用 chrome');
    // agent 循环取走了消息，message_start 还没发：正文队列里还有，agent 队列里已经没有。
    agentQueue().splice(0, 1);
    await expect(cancelQueuedSteer(session, '改用 chrome')).resolves.toEqual({ cancelled: false });
    expect(session.getSteeringMessages!()).toEqual(['改用 chrome']);
  });

  it('正文对不上时，只有允许且队列只剩一条才撤', async () => {
    const { session, queueSteer, agentQueue } = realQueueSession();
    await queueSteer('展开后的模板正文');
    await expect(cancelQueuedSteer(session, '/tpl 参数')).resolves.toEqual({ cancelled: false });
    expect(agentQueue()).toHaveLength(1);
    await expect(cancelQueuedSteer(session, '/tpl 参数', { allowSole: true })).resolves.toEqual({ cancelled: true });
    expect(agentQueue()).toHaveLength(0);
  });

  it('拿不到内部队列时退回 clearQueue，按原顺序把其余引导和跟进排回去', async () => {
    const steer = vi.fn();
    const followUp = vi.fn();
    const session: SteerQueueSession = {
      getSteeringMessages: () => ['a', 'b', 'c'],
      clearQueue: vi.fn(() => ({ steering: ['a', 'b', 'c'], followUp: ['稍后'] })),
      steer,
      followUp,
    };
    await expect(cancelQueuedSteer(session, 'b')).resolves.toEqual({ cancelled: true });
    expect(steer.mock.calls.map((call) => call[0])).toEqual(['a', 'c']);
    expect(followUp).toHaveBeenCalledWith('稍后');
  });

  it('退回路径下队列里没有这条时什么都不动', async () => {
    const session: SteerQueueSession = {
      getSteeringMessages: () => ['a'],
      clearQueue: vi.fn(() => ({ steering: ['a'], followUp: [] })),
      steer: vi.fn(),
      followUp: vi.fn(),
    };
    await expect(cancelQueuedSteer(session, 'zzz')).resolves.toEqual({ cancelled: false });
    expect(session.clearQueue).not.toHaveBeenCalled();
  });
});
