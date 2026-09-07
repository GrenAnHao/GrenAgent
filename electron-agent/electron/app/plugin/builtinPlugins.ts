import type { PluginDefinition } from './pluginManager';

export function builtinPluginDefinitions(): PluginDefinition[] {
  return [
    { id: 'goal', manifest: { id: 'goal', version: '0.1.0', apiVersion: '1', capabilities: ['agent', 'tool', 'ui', 'event-subscriber'], permissions: { interaction: 'auto' } }, load: () => ({}) },
    { id: 'web-search', manifest: { id: 'web-search', version: '0.1.0', apiVersion: '1', capabilities: ['tool'], permissions: { network: 'full' } }, load: () => ({}) },
    { id: 'mcp', manifest: { id: 'mcp', version: '0.1.0', apiVersion: '1', capabilities: ['mcp', 'tool', 'event-subscriber'], permissions: { network: 'full', process: 'allowlist', secrets: 'selected' } }, load: () => ({}) },
    { id: 'memory', manifest: { id: 'memory', version: '0.1.0', apiVersion: '1', capabilities: ['agent', 'tool', 'event-subscriber'], permissions: { filesystem: 'none', network: 'allowlist', process: 'none' } }, load: () => ({}) },
    { id: 'wiki-rag', manifest: { id: 'wiki-rag', version: '0.1.0', apiVersion: '1', capabilities: ['tool'], permissions: { filesystem: 'workspace-read', network: 'allowlist', process: 'none' } }, load: () => ({}) },
    { id: 'code-retrieval', manifest: { id: 'code-retrieval', version: '0.1.0', apiVersion: '1', capabilities: ['tool'], permissions: { filesystem: 'workspace-read', network: 'allowlist', process: 'none' } }, load: () => ({}) },
  ];
}
