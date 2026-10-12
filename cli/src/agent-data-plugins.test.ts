import { describe, expect, test } from 'vitest';
import { manifestExtensions } from '../../extensions/index.js';
import { CHAT_EXCLUDED, CORE_ALWAYS_ON, filterManagedExtensions } from './extension-profile.js';
import { builtinPluginDefinitions } from '../../electron-agent/electron/app/plugin/builtinPlugins.js';
import { PluginManager } from '../../electron-agent/electron/app/plugin/pluginManager.js';
import { AgentDataStorage } from '../../electron-agent/electron/agentData/storage.js';

const dataPlugins = ['memory', 'code-retrieval', 'wiki-rag'];
const allowedIds = ['goal', 'web-search', 'mcp', ...dataPlugins];

describe('agent-data-plugins', () => {
  test('AgentData extensions have managed manifests and survive the Electron allowlist', () => {
    const loaded = filterManagedExtensions(manifestExtensions, JSON.stringify(allowedIds));

    expect(loaded.filter((entry) => dataPlugins.includes(entry.name)).map((entry) => entry.name)).toEqual(dataPlugins);
    for (const id of dataPlugins) {
      expect(loaded.find((entry) => entry.name === id)?.manifest?.id).toBe(id);
    }
    expect(loaded.some((entry) => entry.name === 'code-exec')).toBe(false);
    expect(loaded.some((entry) => entry.name === 'multi-agent')).toBe(true);
    expect(loaded.some((entry) => entry.name === 'approval')).toBe(true);
    expect(loaded.some((entry) => entry.name === 'todo')).toBe(true);
    expect(loaded.some((entry) => entry.name === 'web-fetch')).toBe(true);
  });

  test('every unmanaged bundled extension is either product-core or heavy-gated', () => {
    for (const entry of manifestExtensions.filter((item) => !item.manifest)) {
      expect(
        CORE_ALWAYS_ON.has(entry.name) || CHAT_EXCLUDED.has(entry.name),
        `${entry.name} has no manifest and is neither CORE_ALWAYS_ON nor CHAT_EXCLUDED`,
      ).toBe(true);
    }
  });

  test('loaded AgentData factories register their real tools', () => {
    const tools: string[] = [];
    const pi = { registerTool: (tool: { name: string }) => tools.push(tool.name), on: () => {} };
    const loaded = filterManagedExtensions(manifestExtensions, JSON.stringify(allowedIds));
    for (const entry of loaded.filter((entry) => dataPlugins.includes(entry.name))) entry.factory(pi as never);

    expect(tools.sort()).toEqual([
      'memory_search', 'conversation_search', 'wiki_list', 'wiki_read', 'wiki_search',
      'code_explore',
    ].sort());
  });

  test('parked IM extensions are not loaded in the product extension list', () => {
    for (const name of ['im-gateway', 'im-platforms']) {
      expect(CORE_ALWAYS_ON.has(name)).toBe(false);
      expect(manifestExtensions.some((entry) => entry.name === name)).toBe(false);
    }
  });

  test('AgentData plugins are not implicitly enabled by an empty or unrelated allowlist', () => {
    for (const ids of [[], ['goal']]) {
      const loaded = filterManagedExtensions(manifestExtensions, JSON.stringify(ids));
      expect(loaded.some((entry) => dataPlugins.includes(entry.name))).toBe(false);
    }
  });

  test('Electron ready plugin states load matching AgentData manifests and revoke stopped plugins', async () => {
    const storage = new AgentDataStorage(':memory:');
    storage.migrate();
    try {
      const manager = new PluginManager({ storage, apiVersion: '1' });
      const definitions = builtinPluginDefinitions();
      manager.discover(definitions);
      await manager.startAll();

      const loaded = filterManagedExtensions(manifestExtensions, JSON.stringify(manager.allowedPluginIds()));
      expect(loaded.filter((entry) => dataPlugins.includes(entry.name)).map((entry) => entry.name)).toEqual(dataPlugins);
      for (const id of dataPlugins) {
        expect(definitions.find((entry) => entry.id === id)?.manifest).toEqual(manifestExtensions.find((entry) => entry.name === id)?.manifest);
      }

      await manager.stop('memory');
      const remaining = filterManagedExtensions(manifestExtensions, JSON.stringify(manager.allowedPluginIds()));
      expect(remaining.some((entry) => entry.name === 'memory')).toBe(false);
      expect(remaining.some((entry) => entry.name === 'wiki-rag')).toBe(true);
      expect(remaining.some((entry) => entry.name === 'code-exec')).toBe(false);
    } finally {
      storage.close();
    }
  });
});
