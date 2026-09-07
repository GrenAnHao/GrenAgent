import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manifestExtensions } from '../../extensions/index.js';
import { filterManagedExtensions } from './extension-profile.js';
import { builtinPluginDefinitions } from '../../electron-agent/electron/app/plugin/builtinPlugins.js';
import { PluginManager } from '../../electron-agent/electron/app/plugin/pluginManager.js';
import { AgentDataStorage } from '../../electron-agent/electron/agentData/storage.js';

const dataPlugins = ['memory', 'code-retrieval', 'wiki-rag'];
const allowedIds = ['goal', 'web-search', 'mcp', ...dataPlugins];

test('AgentData extensions have managed manifests and survive the Electron allowlist', () => {
  const loaded = filterManagedExtensions(manifestExtensions, JSON.stringify(allowedIds));

  assert.deepEqual(loaded.filter((entry) => dataPlugins.includes(entry.name)).map((entry) => entry.name), dataPlugins);
  for (const id of dataPlugins) {
    assert.equal(loaded.find((entry) => entry.name === id)?.manifest?.id, id);
  }
  assert.equal(loaded.some((entry) => entry.name === 'code-exec'), false);
});

test('loaded AgentData factories register their real tools', () => {
  const tools: string[] = [];
  const pi = { registerTool: (tool: { name: string }) => tools.push(tool.name), on: () => {} };
  const loaded = filterManagedExtensions(manifestExtensions, JSON.stringify(allowedIds));
  for (const entry of loaded.filter((entry) => dataPlugins.includes(entry.name))) entry.factory(pi as never);

  assert.deepEqual(tools.sort(), [
    'memory_search', 'conversation_search', 'wiki_search', 'wiki_update', 'wiki_read', 'wiki_list', 'wiki_reindex',
    'code_search', 'code_explore', 'code_callers', 'code_callees', 'code_impact', 'code_node', 'code_files',
  ].sort());
});

test('AgentData plugins are not implicitly enabled by an empty or unrelated allowlist', () => {
  for (const ids of [[], ['goal']]) {
    const loaded = filterManagedExtensions(manifestExtensions, JSON.stringify(ids));
    assert.equal(loaded.some((entry) => dataPlugins.includes(entry.name)), false);
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
    assert.deepEqual(loaded.filter((entry) => dataPlugins.includes(entry.name)).map((entry) => entry.name), dataPlugins);
    for (const id of dataPlugins) {
      assert.deepEqual(definitions.find((entry) => entry.id === id)?.manifest, manifestExtensions.find((entry) => entry.name === id)?.manifest);
    }

    await manager.stop('memory');
    const remaining = filterManagedExtensions(manifestExtensions, JSON.stringify(manager.allowedPluginIds()));
    assert.equal(remaining.some((entry) => entry.name === 'memory'), false);
    assert.equal(remaining.some((entry) => entry.name === 'wiki-rag'), true);
    assert.equal(remaining.some((entry) => entry.name === 'code-exec'), false);
  } finally {
    storage.close();
  }
});
