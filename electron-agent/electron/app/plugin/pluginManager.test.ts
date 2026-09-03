import { describe, expect, it } from 'vitest';
import { AgentDataStorage } from '../../agentData/storage';
import { PluginManager, type PluginDefinition, type PluginStateName } from './pluginManager';

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
  it('moves a plugin through the complete lifecycle and publishes every state', async () => {
    const storage = new AgentDataStorage(':memory:');
    storage.migrate();
    const states: PluginStateName[] = [];
    const manager = new PluginManager({
      storage,
      apiVersion: '1',
      now: () => states.length + 1,
      publish: (event) => states.push((event.data as { state: PluginStateName }).state),
    });

    manager.discover([definition('goal')]);
    await manager.start('goal');
    await manager.stop('goal');

    expect(states).toEqual(['discovered', 'validated', 'loaded', 'started', 'ready', 'stopping', 'stopped']);
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
    const events: string[] = [];
    const manager = new PluginManager({
      storage,
      apiVersion: '1',
      publish: (event) => events.push(`${(event.data as { id: string }).id}:${(event.data as { state: string }).state}`),
    });
    manager.discover([
      definition('broken', { load: async () => ({ start: async () => { throw new Error('startup exploded'); } }) }),
      definition('healthy'),
    ]);

    await manager.startAll();

    expect(manager.get('broken')).toMatchObject({ state: 'start_failed', error: 'startup exploded' });
    expect(manager.get('healthy')).toMatchObject({ state: 'ready' });
    expect(manager.allowedPluginIds()).toEqual(['healthy']);
    expect(events).toContain('broken:start_failed');

    const restored = new PluginManager({ storage, apiVersion: '1' });
    expect(restored.get('broken')).toMatchObject({ state: 'start_failed', error: 'startup exploded' });
    storage.close();
  });
});
