import { describe, it, expect, beforeEach, vi } from 'vitest';

const eventHandlers: Array<(e: { workspace: string; event: unknown }) => void> = [];
vi.mock('../lib/pi', () => ({
  onPiEvent: (h: (e: { workspace: string; event: unknown }) => void) => {
    eventHandlers.push(h);
    return Promise.resolve(() => {});
  },
  onPiExit: () => Promise.resolve(() => {}),
}));

import { createAgentStoreRegistry } from './agentStoreRegistry';

beforeEach(() => {
  eventHandlers.length = 0;
});

describe('agentStoreRegistry', () => {
  it('getOrCreate 复用同 key 的 store', () => {
    const reg = createAgentStoreRegistry();
    const a1 = reg.getOrCreate('/ws/a');
    const a2 = reg.getOrCreate('/ws/a');
    expect(a1).toBe(a2);
    expect(reg.keys()).toEqual(['/ws/a']);
    reg.destroyAll();
  });

  it('release 销毁并移除', () => {
    const reg = createAgentStoreRegistry();
    reg.getOrCreate('/ws/a');
    reg.release('/ws/a');
    expect(reg.keys()).toEqual([]);
    reg.destroyAll();
  });

  it('LRU 超限淘汰最久未 active（且不淘汰当前 active）', () => {
    const reg = createAgentStoreRegistry(2);
    reg.getOrCreate('/ws/a');
    reg.getOrCreate('/ws/b');
    reg.setActive('/ws/b');
    reg.getOrCreate('/ws/c'); // 超限 → 淘汰最久未 active 的 /ws/a
    expect(reg.keys().sort()).toEqual(['/ws/b', '/ws/c']);
    reg.destroyAll();
  });

  it('setActive 把 active 标志下发给各 store', () => {
    const reg = createAgentStoreRegistry();
    const a = reg.getOrCreate('/ws/a');
    const spy = vi.spyOn(a, 'setActive');
    reg.setActive('/ws/a');
    expect(spy).toHaveBeenCalledWith(true);
    reg.destroyAll();
  });
});
