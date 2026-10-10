import { describe, expect, it } from 'vitest';
import { fromWireError, RpcPeer, toWireError, type WireMessage } from './rpcPeer.js';

/** 两个 peer 对接，消息走 structuredClone，和 Node IPC 的 advanced 序列化一样会丢掉函数和原型。 */
function pair() {
  let a!: RpcPeer;
  let b!: RpcPeer;
  const sentByA: WireMessage[] = [];
  a = new RpcPeer({ send: (m) => { sentByA.push(m); queueMicrotask(() => b.receive(structuredClone(m))); } });
  b = new RpcPeer({ send: (m) => { queueMicrotask(() => a.receive(structuredClone(m))); } });
  return { a, b, sentByA };
}

describe('RpcPeer', () => {
  it('请求经对端处理后拿到结果', async () => {
    const { a, b } = pair();
    b.handle('sum', (params) => (params.x as number) + (params.y as number));
    await expect(a.request('sum', { x: 2, y: 3 })).resolves.toBe(5);
  });

  it('两个方向都能发请求', async () => {
    const { a, b } = pair();
    a.handle('host.resolveWorkspace', (params) => `resolved:${String(params.path)}`);
    b.handle('pi.open', async (params) => b.request('host.resolveWorkspace', { path: params.workspace }));
    await expect(a.request('pi.open', { workspace: 'D:/p' })).resolves.toBe('resolved:D:/p');
  });

  it('处理函数抛错时原样带回 message 和 code', async () => {
    const { a, b } = pair();
    b.handle('agent_switch_session', () => {
      const error = new Error('SESSION_BUSY') as NodeJS.ErrnoException;
      error.code = 'EBUSY';
      throw error;
    });
    const error = await a.request('agent_switch_session').catch((e: unknown) => e) as NodeJS.ErrnoException;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('SESSION_BUSY');
    expect(error.code).toBe('EBUSY');
  });

  it('对端没有这个方法时请求失败，不会一直挂着', async () => {
    const { a } = pair();
    await expect(a.request('nope')).rejects.toThrow('agent process method not found: nope');
  });

  it('事件只投递给监听器，不需要回复', async () => {
    const { a, b } = pair();
    const seen: Array<[string, unknown]> = [];
    a.onEvent((channel, payload) => seen.push([channel, payload]));
    b.emit('broadcast', { channel: 'pi://event', payload: { n: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual([['broadcast', { channel: 'pi://event', payload: { n: 1 } }]]);
  });

  it('关闭时在途请求全部失败，之后的请求立即失败', async () => {
    const transportSent: WireMessage[] = [];
    const peer = new RpcPeer({ send: (m) => { transportSent.push(m); } });
    const inflight = peer.request('slow');
    expect(peer.pendingCount).toBe(1);
    peer.close(new Error('AGENT_HOST_EXITED'));
    await expect(inflight).rejects.toThrow('AGENT_HOST_EXITED');
    await expect(peer.request('later')).rejects.toThrow('AGENT_HOST_EXITED');
    expect(peer.pendingCount).toBe(0);
  });

  it('发送时通道已断，请求立即失败并移出等待表', async () => {
    const peer = new RpcPeer({ send: () => { throw new Error('ERR_IPC_CHANNEL_CLOSED'); } });
    await expect(peer.request('x')).rejects.toThrow('ERR_IPC_CHANNEL_CLOSED');
    expect(peer.pendingCount).toBe(0);
  });

  it('结果不能结构化克隆时，对端收到的是失败而不是一直等', async () => {
    let a!: RpcPeer;
    const b = new RpcPeer({ send: (m) => { const copy = structuredClone(m); queueMicrotask(() => a.receive(copy)); } });
    a = new RpcPeer({ send: (m) => { queueMicrotask(() => b.receive(structuredClone(m))); } });
    b.handle('bad', () => ({ fn: () => 1 }));
    await expect(a.request('bad')).rejects.toThrow();
  });

  it('不认识的消息直接丢弃', () => {
    const peer = new RpcPeer({ send: () => {} });
    expect(() => peer.receive({ t: 'res', id: 'x' })).not.toThrow();
    expect(() => peer.receive(null)).not.toThrow();
    expect(() => peer.receive('text')).not.toThrow();
  });

  it('错误往返保留 name 与 stack', () => {
    const original = new TypeError('bad arg');
    const restored = fromWireError(toWireError(original));
    expect(restored.name).toBe('TypeError');
    expect(restored.message).toBe('bad arg');
    expect(restored.stack).toBe(original.stack);
    expect(toWireError('plain')).toEqual({ message: 'plain' });
  });
});
