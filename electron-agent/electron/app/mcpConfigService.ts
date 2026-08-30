import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Config = Record<string, unknown>;
type Scope = 'settings' | 'global' | 'project';

interface SettingsPort {
  getAll(): Promise<Record<string, string>>;
  replace(settings: Record<string, string>): Promise<void>;
}

export interface McpConfigEntry {
  name: string;
  config: Config;
  enabled: boolean;
  scope: Scope;
}

export class McpConfigService {
  constructor(private readonly home: string, private readonly settings: SettingsPort) {}

  async list(workspace: string): Promise<McpConfigEntry[]> {
    const result = new Map<string, McpConfigEntry>();
    const settings = await this.settings.getAll();
    mergeLayer(result, 'settings', parseCollection(settings.MCP_SERVERS), parseCollection(settings.MCP_SERVERS_DISABLED));
    const { globalPath, projectPath } = this.paths(workspace);
    for (const [scope, path] of [['global', globalPath], ['project', projectPath]] as const) {
      const document = await readDocument(path);
      mergeLayer(result, scope, document.mcpServers, document.disabledMcpServers);
    }
    return [...result.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async upsert(workspace: string, scope: string, name: string, config: unknown, enabled: boolean): Promise<void> {
    const validScope = validateScope(scope);
    const validConfig = validateConfig(config);
    if (validScope === 'settings') {
      await this.mutateSettings(name, validConfig, enabled);
      return;
    }
    await this.mutateFile(workspace, validScope, name, validConfig, enabled);
  }

  async remove(workspace: string, scope: string, name: string): Promise<void> {
    const validScope = validateScope(scope);
    if (validScope === 'settings') {
      await this.mutateSettings(name, undefined, true);
      return;
    }
    await this.mutateFile(workspace, validScope, name, undefined, true);
  }

  private async mutateSettings(name: string, config: Config | undefined, enabled: boolean): Promise<void> {
    const next = await this.settings.getAll();
    const active = parseCollection(next.MCP_SERVERS);
    const disabled = parseCollection(next.MCP_SERVERS_DISABLED);
    delete active[name];
    delete disabled[name];
    if (config) (enabled ? active : disabled)[name] = config;
    next.MCP_SERVERS = serializeCollection(active);
    next.MCP_SERVERS_DISABLED = serializeCollection(disabled);
    await this.settings.replace(next);
  }

  private async mutateFile(workspace: string, scope: Exclude<Scope, 'settings'>, name: string, config: Config | undefined, enabled: boolean): Promise<void> {
    const { globalPath, projectPath } = this.paths(workspace);
    const path = scope === 'global' ? globalPath : projectPath;
    const document = await readDocument(path);
    delete document.mcpServers[name];
    delete document.disabledMcpServers[name];
    if (config) (enabled ? document.mcpServers : document.disabledMcpServers)[name] = config;
    await writeDocument(path, document);
  }

  private paths(workspace: string): { globalPath: string; projectPath: string } {
    return {
      globalPath: join(this.home, '.pi', 'agent', 'mcp.json'),
      projectPath: join(workspace, '.pi', 'mcp.json'),
    };
  }
}

interface McpDocument {
  extras: Record<string, unknown>;
  mcpServers: Record<string, Config>;
  disabledMcpServers: Record<string, Config>;
}

function parseCollection(raw: string | undefined): Record<string, Config> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const candidate = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
    return Object.fromEntries(Object.entries(candidate).filter(([, value]) => isRecord(value))) as Record<string, Config>;
  } catch {
    return {};
  }
}

function mergeLayer(target: Map<string, McpConfigEntry>, scope: Scope, enabled: Record<string, Config>, disabled: Record<string, Config>): void {
  for (const [name, config] of Object.entries(enabled)) target.set(name, { name, config, enabled: true, scope });
  for (const [name, config] of Object.entries(disabled)) target.set(name, { name, config, enabled: false, scope });
}

function serializeCollection(configs: Record<string, Config>): string {
  return Object.keys(configs).length === 0 ? '' : JSON.stringify({ mcpServers: configs }, null, 2);
}

function validateScope(scope: string): Scope {
  if (scope === 'settings' || scope === 'global' || scope === 'project') return scope;
  throw new Error(`未知 MCP 作用域: ${scope}`);
}

function validateConfig(value: unknown): Config {
  if (!isRecord(value)) throw new Error('MCP 配置必须是对象');
  if (typeof value.command !== 'string' && typeof value.url !== 'string') {
    throw new Error('MCP 配置必须包含 command 或 url');
  }
  return value;
}

async function readDocument(path: string): Promise<McpDocument> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { extras: {}, mcpServers: {}, disabledMcpServers: {} };
    if (error instanceof SyntaxError) throw new Error(`MCP 配置 JSON 损坏 (${path}): ${error.message}`);
    throw error;
  }
  if (!isRecord(parsed)) throw new Error(`MCP 配置 JSON 损坏 (${path}): root must be an object`);
  const { mcpServers, disabledMcpServers, ...extras } = parsed;
  if (mcpServers !== undefined && !isRecord(mcpServers)) throw new Error(`MCP 配置 JSON 损坏 (${path}): mcpServers must be an object`);
  if (disabledMcpServers !== undefined && !isRecord(disabledMcpServers)) throw new Error(`MCP 配置 JSON 损坏 (${path}): disabledMcpServers must be an object`);
  return {
    extras,
    mcpServers: filterConfigs(mcpServers),
    disabledMcpServers: filterConfigs(disabledMcpServers),
  };
}

async function writeDocument(path: string, document: McpDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const target = {
    ...document.extras,
    mcpServers: document.mcpServers,
    ...(Object.keys(document.disabledMcpServers).length ? { disabledMcpServers: document.disabledMcpServers } : {}),
  };
  const temporary = join(dirname(path), `mcp.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(target, null, 2));
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new Error(`写入 MCP 配置失败 (${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function filterConfigs(value: unknown): Record<string, Config> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, config]) => isRecord(config))) as Record<string, Config>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
