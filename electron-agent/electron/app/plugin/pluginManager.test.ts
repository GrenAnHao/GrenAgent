import { describe, expect, it } from 'vitest';
import { AgentDataStorage } from '../../agentData/storage';
import { PluginManager, type PluginDefinition } from './pluginManager';

function definition(id: string, overrides: Partial<PluginDefinition> = {}): PluginDefinition {
  return {
    id,
    manifest: {
      id,
      version: '1.0.0',
      apiVersion: '1',
      capabilities: ['tool'],
      permissions: { filesystem: 'workspace-read' },
    },
    load: async () => ({ start: async () => {}, stop: async () => {} }),
    ...overrides,
  };
}

describe('PluginManager', () => {
  it('moves a plugin through the complete lifecycle', async () => {
    const storage = new AgentDataStorage(':memory:');
    storage.migrate();
    let tick = 0;
    const manager = new PluginManager({ storage, apiVersion: '1', now: () => ++tick });

    // 按阶段断言公开可观测状态。内部微状态（loaded/started/stopping）此前靠 publish 回调观测，
    // 该回调是 AppEvent 的注入口、已随之移除；这里改为校验每个阶段结束后的对外状态。
    manager.discover([definition('goal')]);
    expect(manager.get('goal')).toMatchObject({ id: 'goal', state: 'validated' });

    await manager.start('goal');
    expect(manager.get('goal')).toMatchObject({ state: 'ready' });
    expect(manager.allowedPluginIds()).toEqual(['goal']);

    await manager.stop('goal');
    expect(manager.list()).toEqual([expect.objectContaining({ id: 'goal', state: 'stopped' })]);
    expect(manager.get('goal')).not.toHaveProperty('error');
    storage.close();
  });

  it('isolates an incompatible apiVersion as validation_failed', () => {
    const storage = new AgentDataStorage(':memory:');
    storage.migrate();
    const manager = new PluginManager({ storage, apiVersion: '1' });

    manager.discover([
      definition('old-plugin', { manifest: { id: 'old-plugin', version: '1.0.0', apiVersion: '0', capabilities: ['tool'] } }),
      definition('valid-plugin'),
    ]);

    expect(manager.get('old-plugin')).toMatchObject({ state: 'validation_failed', error: expect.stringContaining('apiVersion') });
    expect(manager.get('valid-plugin')).toMatchObject({ state: 'validated' });
    storage.close();
  });

  it('isolates startup failures, persists faults, and only allows ready plugins', async () => {
    const storage = new AgentDataStorage(':memory:');
    storage.migrate();
    const manager = new PluginManager({ storage, apiVersion: '1' });
    manager.discover([
      definition('broken', { load: async () => ({ start: async () => { throw new Error('startup exploded'); } }) }),
      definition('healthy'),
    ]);

    await manager.startAll();

    expect(manager.get('broken')).toMatchObject({ state: 'start_failed', error: 'startup exploded' });
    expect(manager.get('healthy')).toMatchObject({ state: 'ready' });
    expect(manager.allowedPluginIds()).toEqual(['healthy']);

    const restored = new PluginManager({ storage, apiVersion: '1' });
    expect(restored.get('broken')).toMatchObject({ state: 'start_failed', error: 'startup exploded' });
    storage.close();
  });
});
