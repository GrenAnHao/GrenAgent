import { dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, isInvokeRequest, type InvokeRequest } from './contracts';
import type { SettingsService } from '../app/settingsService';
import type { McpPolicyService } from '../app/mcpPolicyService';
import type { McpConfigService } from '../app/mcpConfigService';
import type { SubagentService } from '../app/subagentService';
import type { FileService } from '../app/fileService';
import type { SkillService } from '../app/skillService';
import type { UsageService } from '../app/usageService';
import type { PiRuntimeService } from '../app/piRuntimeService';
import type { ProviderService } from '../app/providerService';
import type { WorkspaceService } from '../app/workspaceService';
import type { UiHistoryService } from '../app/uiHistoryService';
import type { WorkspaceApprovalService } from '../app/workspaceApprovalService';
import type { GitService } from '../app/gitService';
import type { TerminalService } from '../app/terminalService';
import type { CreateService } from '../app/createService';
import type { TempHtmlService } from '../app/tempHtmlService';
import type { ShellService } from '../app/shellService';
import type { TencentDbService } from '../tencentdb/service';

type CommandHandler = (event: IpcMainInvokeEvent, args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface IpcServices {
  settings?: SettingsService;
  mcpPolicy?: McpPolicyService;
  mcpConfig?: McpConfigService;
  subagent?: SubagentService;
  files?: FileService;
  skills?: SkillService;
  usage?: UsageService;
  pi?: PiRuntimeService;
  provider?: ProviderService;
  workspace?: WorkspaceService;
  uiHistory?: UiHistoryService;
  workspaceApproval?: WorkspaceApprovalService;
  git?: GitService;
  terminal?: TerminalService;
  create?: CreateService;
  tempHtml?: TempHtmlService;
  shell?: ShellService;
  tencentdb?: TencentDbService;
}

const commandHandlers = new Map<string, CommandHandler>();

export function registerCommand(command: string, handler: CommandHandler): void {
  commandHandlers.set(command, handler);
}

export function getRegisteredCommands(): string[] {
  return [...commandHandlers.keys()].sort();
}

export function registerIpcHandlers(services: IpcServices = {}): void {
  ipcMain.handle(IPC_CHANNELS.invoke, async (event, request: InvokeRequest) => {
    if (!isInvokeRequest(request)) throw new Error('Invalid Electron invoke request');
    const handler = commandHandlers.get(request.command);
    if (!handler) throw new Error(`Electron command is not registered: ${request.command}`);
    return handler(event, request.args ?? {});
  });

  ipcMain.handle(IPC_CHANNELS.pickDirectory, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.openUrl, (_event, url: string) => shell.openExternal(url));
  ipcMain.handle(IPC_CHANNELS.openPath, async (_event, path: string) => {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  ipcMain.handle(IPC_CHANNELS.revealItem, (_event, path: string) => shell.showItemInFolder(path));

  ipcMain.handle(IPC_CHANNELS.windowMinimize, (event) => event.sender.getOwnerBrowserWindow()?.minimize());
  ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, (event) => {
    const window = event.sender.getOwnerBrowserWindow();
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
  });
  ipcMain.handle(IPC_CHANNELS.windowIsMaximized, (event) => event.sender.getOwnerBrowserWindow()?.isMaximized() ?? false);
  ipcMain.handle(IPC_CHANNELS.windowClose, (event) => event.sender.getOwnerBrowserWindow()?.close());

  if (services.settings) registerSettingsCommands(services.settings);
  if (services.mcpPolicy) registerMcpPolicyCommands(services.mcpPolicy);
  if (services.mcpConfig) registerMcpConfigCommands(services.mcpConfig);
  if (services.subagent) registerSubagentCommands(services.subagent);
  if (services.files) registerFileCommands(services.files);
  if (services.skills) registerSkillCommands(services.skills);
  if (services.usage) registerCommand('usage_report', () => services.usage!.report());
  if (services.pi) registerPiCommands(services.pi);
  if (services.provider) registerProviderCommands(services.provider);
  if (services.workspace) registerWorkspaceCommands(services.workspace);
  if (services.uiHistory) registerUiHistoryCommands(services.uiHistory);
  if (services.workspaceApproval) registerWorkspaceApprovalCommands(services.workspaceApproval);
  if (services.git) registerGitCommands(services.git);
  if (services.terminal) registerTerminalCommands(services.terminal);
  if (services.create) registerCreateCommands(services.create);
  if (services.tempHtml) registerCommand('write_temp_html', (_event, args) => services.tempHtml!.write(readText(args, 'content')));
  if (services.shell) registerShellCommands(services.shell);
  if (services.tencentdb) registerTencentDbCommands(services.tencentdb);
}

function registerMcpPolicyCommands(service: McpPolicyService): void {
  registerCommand('read_mcp_policy', () => service.readPolicy());
  registerCommand('write_mcp_policy', (_event, args) => service.writePolicy(readText(args, 'content')));
  registerCommand('read_mcp_audit', () => service.readAudit());
  registerCommand('read_mcp_tools_cache', () => service.readToolsCache());
  registerCommand('probe_mcp_server', (_event, args) => service.probe(readString(args, 'configJson')));
}

function registerMcpConfigCommands(service: McpConfigService): void {
  registerCommand('list_mcp_configs', (_event, args) => service.list(readString(args, 'workspace')));
  registerCommand('upsert_mcp_config', (_event, args) => {
    if (typeof args.config !== 'object' || !args.config || Array.isArray(args.config)) throw new Error('config must be an object');
    if (typeof args.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    return service.upsert(readString(args, 'workspace'), readString(args, 'scope'), readString(args, 'name'), args.config, args.enabled);
  });
  registerCommand('remove_mcp_config', (_event, args) => service.remove(
    readString(args, 'workspace'), readString(args, 'scope'), readString(args, 'name'),
  ));
}

function registerSubagentCommands(service: SubagentService): void {
  registerCommand('subagent_list', (_event, args) => service.list(readString(args, 'workspace')));
  registerCommand('subagent_get_transcript', (_event, args) => service.transcript(
    readString(args, 'workspace'), readString(args, 'agentId'),
  ));
  registerCommand('subagent_cancel', (_event, args) => service.cancel(
    readString(args, 'workspace'), readString(args, 'agentId'),
  ));
}

function registerFileCommands(service: FileService): void {
  registerCommand('get_file_tree', (_event, args) => service.tree(readString(args, 'workspace'), args.includeGitStatus === true));
  registerCommand('read_file', (_event, args) => service.read(readString(args, 'workspace'), readString(args, 'path')));
  registerCommand('read_file_binary', (_event, args) => service.readBinary(readString(args, 'workspace'), readString(args, 'path')));
  registerCommand('register_dropped_files', (_event, args) => {
    if (!Array.isArray(args.paths) || !args.paths.every((path) => typeof path === 'string')) throw new Error('paths must be a string array');
    return service.registerDropped(args.paths);
  });
  registerCommand('read_dropped_file', (_event, args) => service.readDropped(readString(args, 'path')));
  registerCommand('import_dropped_file', (_event, args) => service.importDropped(readString(args, 'workspace'), readString(args, 'path')));
  registerCommand('write_file', (_event, args) => service.write(
    readString(args, 'workspace'), readString(args, 'path'), readText(args, 'content'),
  ));
}

function registerSkillCommands(service: SkillService): void {
  registerCommand('list_skills', () => service.list());
  registerCommand('create_skill', (_event, args) => service.create(readString(args, 'name'), readText(args, 'description'), readText(args, 'body')));
  registerCommand('delete_skill', (_event, args) => service.remove(readString(args, 'path')));
  registerCommand('import_skill_from_dir', (_event, args) => service.importDirectory(readString(args, 'src')));
  registerCommand('import_skill_from_file', (_event, args) => service.importFile(readString(args, 'src')));
  registerCommand('install_skill_from_zip', (_event, args) => service.installZip(readString(args, 'src')));
  registerCommand('open_skills_dir', async () => {
    const directory = await service.openDirectory();
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
    return directory;
  });
}

function registerProviderCommands(service: ProviderService): void {
  registerCommand('get_provider_config', () => service.getConfig());
  registerCommand('set_provider_config', (_event, args) => service.setConfig(readString(args, 'modelsJson'), readString(args, 'authJson')));
  registerCommand('refresh_model_registry', () => service.refresh());
  registerCommand('list_models_global', () => service.listModels());
  registerCommand('fetch_provider_models', (_event, args) => service.fetchModels(readString(args, 'baseUrl'), readString(args, 'apiKey'), readString(args, 'api')));
  registerCommand('fix_mermaid_diagram', (_event, args) => service.fixMermaid(readString(args, 'workspace'), readText(args, 'code'), readText(args, 'error')));
  registerCommand('diagnose_provider_model', (event, args) => {
    const channel = args.onChunk;
    const emit = channel && typeof channel === 'object' && typeof (channel as Record<string, unknown>).__grenChannelId === 'string'
      ? (chunk: string) => event.sender.send(`${IPC_CHANNELS.eventPrefix}channel:${(channel as Record<string, string>).__grenChannelId}`, chunk)
      : () => {};
    if (typeof args.stream !== 'boolean') throw new Error('stream must be a boolean');
    return service.diagnose(readString(args, 'providerId'), readString(args, 'modelId'), readText(args, 'prompt'), args.stream, emit);
  });
}

function registerSettingsCommands(service: SettingsService): void {
  registerCommand('get_settings', () => service.getAll());
  registerCommand('set_settings', async (_event, args) => {
    const settings = args.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('Settings must be an object');
    }
    if (!Object.values(settings).every((value) => typeof value === 'string')) {
      throw new Error('Settings values must be strings');
    }
    await service.replace(settings as Record<string, string>);
  });
}

function registerWorkspaceCommands(service: WorkspaceService): void {
  registerCommand('get_works_dir', () => service.getWorksDir());
  registerCommand('create_conversation', () => service.createConversation());
  registerCommand('prune_orphan_conversations', (_event, args) => {
    const keep = args.keep;
    if (!Array.isArray(keep) || !keep.every((path) => typeof path === 'string')) {
      throw new Error('Keep must be a string array');
    }
    return service.pruneOrphanConversations(keep);
  });
  registerCommand('list_all_sessions', () => service.listAllSessions());
  registerCommand('list_pi_sessions', (_event, args) => service.listSessions(readString(args, 'workspace')));
  registerCommand('delete_pi_session', (_event, args) => service.deleteSession(readString(args, 'workspace'), readString(args, 'sessionPath')));
  registerCommand('delete_conversation', (_event, args) => service.deleteConversation(readString(args, 'workspace')));
  registerCommand('remove_project', (_event, args) => service.removeProject(readString(args, 'workspace')));
}

function registerUiHistoryCommands(service: UiHistoryService): void {
  registerCommand('ui_history_read', (_event, args) => service.read(readString(args, 'workspace'), readString(args, 'sessionKey')));
  registerCommand('ui_history_write', (_event, args) => service.write(
    readString(args, 'workspace'), readString(args, 'sessionKey'), readText(args, 'content'),
  ));
  registerCommand('ui_history_delete', (_event, args) => service.delete(readString(args, 'workspace'), readString(args, 'sessionKey')));
}

function registerWorkspaceApprovalCommands(service: WorkspaceApprovalService): void {
  registerCommand('request_workspace_approval', (_event, args) => service.approve(readString(args, 'path')));
  registerCommand('is_workspace_approved', (_event, args) => service.isApproved(readString(args, 'path')));
}

function registerGitCommands(service: GitService): void {
  registerCommand('get_git_status', (_event, args) => service.status(readString(args, 'workspacePath')));
  registerCommand('get_git_diff', (_event, args) => service.diff(readString(args, 'workspacePath'), readString(args, 'filePath')));
  registerCommand('get_git_branches', (_event, args) => service.branches(readString(args, 'workspacePath')));
  registerCommand('git_checkout', (_event, args) => service.checkout(readString(args, 'workspacePath'), readString(args, 'branch')));
  registerCommand('git_create_branch', (_event, args) => {
    if (typeof args.checkout !== 'boolean') throw new Error('checkout must be a boolean');
    return service.createBranch(readString(args, 'workspacePath'), readString(args, 'name'), args.checkout);
  });
  registerCommand('get_git_log_graph', (_event, args) => {
    const limit = args.limit;
    if (limit !== null && limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) throw new Error('limit must be a positive integer or null');
    return service.logGraph(readString(args, 'workspacePath'), limit as number | null | undefined);
  });
}

function registerTerminalCommands(service: TerminalService): void {
  registerCommand('execute_command', (_event, args) => {
    if (!Array.isArray(args.args) || !args.args.every((arg) => typeof arg === 'string')) throw new Error('args must be a string array');
    if (args.workspace !== undefined && typeof args.workspace !== 'string') throw new Error('workspace must be a string');
    return service.execute(readString(args, 'command'), args.args, args.workspace);
  });
}

function registerCreateCommands(service: CreateService): void {
  registerCommand('create_list', (_event, args) => service.list(readString(args, 'workspace')));
  registerCommand('create_image', (_event, args) => service.read(readString(args, 'workspace'), readString(args, 'name')));
}

function registerShellCommands(service: ShellService): void {
  registerCommand('shell_start', (_event, args) => {
    if (args.workspace !== undefined && typeof args.workspace !== 'string') throw new Error('workspace must be a string');
    return service.start(args.workspace);
  });
  registerCommand('shell_write', (_event, args) => service.write(readString(args, 'sessionId'), readText(args, 'data')));
  registerCommand('shell_resize', (_event, args) => {
    if (typeof args.rows !== 'number' || typeof args.cols !== 'number') throw new Error('rows and cols must be numbers');
    return service.resize(readString(args, 'sessionId'), args.rows, args.cols);
  });
  registerCommand('shell_stop', (_event, args) => service.stop(readString(args, 'sessionId')));
}

function registerPiCommands(service: PiRuntimeService): void {
  registerCommand('open_workspace', (_event, args) => service.openWorkspace(readString(args, 'workspace')));
  registerCommand('warm_workspace', (_event, args) => service.warmWorkspace(readString(args, 'workspace')));
  registerCommand('close_workspace', (_event, args) => service.closeWorkspace(readString(args, 'workspace')));
  registerCommand('extension_ui_respond', (_event, args) => service.respondUi(readString(args, 'workspace'), readRecord(args, 'response')));
  for (const command of [
    'agent_prompt', 'agent_steer', 'agent_follow_up', 'agent_abort', 'agent_set_model', 'agent_cycle_model',
    'agent_get_available_models', 'agent_set_thinking_level', 'agent_cycle_thinking_level', 'agent_set_mode',
    'agent_set_approval', 'agent_exclude_entry', 'agent_restore_entry', 'agent_rewind_to', 'agent_compact',
    'agent_set_auto_compaction', 'agent_abort_retry', 'agent_get_session_stats', 'agent_get_state',
    'agent_get_messages', 'agent_get_commands', 'agent_new_session', 'agent_switch_session', 'agent_fork',
    'agent_clone', 'agent_get_fork_messages', 'agent_set_session_name',
  ]) {
    registerCommand(command, (_event, args) => {
      const { workspace, ...input } = args;
      if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('workspace must be a non-empty string');
      return service.send(workspace, command, input);
    });
  }
}

function registerTencentDbCommands(service: TencentDbService): void {
  registerCommand('tencentdb_get_config', () => service.getConfig());
  registerCommand('tencentdb_get_status', () => service.status());
  registerCommand('tencentdb_save_connection', (_event, args) => service.saveConnection(readInput(args)));
  registerCommand('tencentdb_test_connection', () => service.testConnection());
  registerCommand('tencentdb_open_panel', () => service.openPanel());
  registerCommand('tencentdb_reload_skills', () => service.reloadSkills().then(() => undefined));
  registerCommand('tencentdb_core_request', (_event, args) => {
    const input = readInput(args) as { route?: unknown; body?: unknown };
    if (typeof input.route !== 'string') throw new Error('TencentDB Core request route is required');
    const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body)
      ? input.body as Record<string, unknown>
      : {};
    return service.coreRequest(input.route, body);
  });
  registerCommand('tencentdb_sync_llm', (_event, args) => {
    const input = readInput(args) as Record<string, unknown>;
    const api = readObjectString(input, 'api');
    const protocol = api === 'anthropic-messages' ? 'anthropic' : api === 'openai-completions' || api === 'openai-responses' ? 'openai' : null;
    if (!protocol) throw new Error('TencentDB Knowledge does not support this Pi model protocol');
    return service.knowledgeRequest('/internal/llm-binding/set', {
      mode: 'byo', base_url: readObjectString(input, 'baseUrl'), api_key: readObjectString(input, 'apiKey'), model: readObjectString(input, 'modelId'), protocol, enabled: true,
    });
  });
  registerCommand('tencentdb_list_knowledge_assets', async (_event, args) => {
    const workspace = args.workspace === undefined ? undefined : readString(args, 'workspace');
    return service.listKnowledgeAssets(workspace);
  });
  registerKnowledgeCommand('tencentdb_get_wiki', service, '/wiki/get', (input) => ({ wiki_id: readObjectString(input, 'assetId') }));
  registerKnowledgeCommand('tencentdb_get_code_graph', service, '/code-graph/get', (input) => ({ code_graph_id: readObjectString(input, 'assetId') }));
  registerKnowledgeCommand('tencentdb_search_wiki', service, '/wiki/search', (input) => ({ wiki_id: readObjectString(input, 'assetId'), query: readObjectString(input, 'query'), limit: readCount(input, 'limit', 20, 100) }));
  registerKnowledgeCommand('tencentdb_list_wiki_pages', service, '/wiki/page/ls', (input) => ({ wiki_id: readObjectString(input, 'assetId') }));
  registerKnowledgeCommand('tencentdb_read_wiki_pages', service, '/wiki/page/read', (input) => ({ wiki_id: readObjectString(input, 'assetId'), refs: readStringArray(input, 'refs', 1, 20) }));
  registerKnowledgeCommand('tencentdb_search_code_graph', service, '/code-graph/search', (input) => ({ code_graph_id: readObjectString(input, 'assetId'), query: readObjectString(input, 'query'), limit: readCount(input, 'limit', 20, 100) }));
  registerKnowledgeCommand('tencentdb_explore_code_graph', service, '/code-graph/explore', (input) => ({ code_graph_id: readObjectString(input, 'assetId'), query: readObjectString(input, 'query'), maxFiles: readCount(input, 'maxFiles', 12, 200) }));
  registerKnowledgeCommand('tencentdb_get_code_graph_callers', service, '/code-graph/callers', (input) => ({ code_graph_id: readObjectString(input, 'assetId'), symbol: readObjectString(input, 'symbol'), limit: readCount(input, 'limit', 20, 200) }));
  registerKnowledgeCommand('tencentdb_get_code_graph_callees', service, '/code-graph/callees', (input) => ({ code_graph_id: readObjectString(input, 'assetId'), symbol: readObjectString(input, 'symbol'), limit: readCount(input, 'limit', 20, 200) }));
  registerKnowledgeCommand('tencentdb_analyze_code_graph_impact', service, '/code-graph/impact', (input) => ({ code_graph_id: readObjectString(input, 'assetId'), symbol: readObjectString(input, 'symbol'), depth: readCount(input, 'depth', 2, 10) }));
  registerKnowledgeCommand('tencentdb_get_code_graph_node', service, '/code-graph/node', (input) => ({ code_graph_id: readObjectString(input, 'assetId'), symbol: readObjectString(input, 'symbol'), includeCode: input.includeCode === true, ...optionalText(input, 'file'), ...optionalCount(input, 'line') }));
  registerKnowledgeCommand('tencentdb_get_code_graph_status', service, '/code-graph/status', (input) => ({ code_graph_id: readObjectString(input, 'assetId') }));
  registerKnowledgeCommand('tencentdb_list_code_graph_files', service, '/code-graph/files', (input) => ({ code_graph_id: readObjectString(input, 'assetId'), format: typeof input.format === 'string' ? input.format : 'tree', includeMetadata: input.includeMetadata !== false, ...optionalText(input, 'path'), ...optionalText(input, 'pattern'), ...optionalCount(input, 'maxDepth') }));
  registerKnowledgeCommand('tencentdb_delete_wiki', service, '/wiki/delete', (input) => ({ wiki_ids: [readObjectString(input, 'assetId')] }));
  registerKnowledgeCommand('tencentdb_delete_code_graph', service, '/code-graph/delete', (input) => ({ code_graph_ids: [readObjectString(input, 'assetId')] }));
  registerKnowledgeCommand('tencentdb_sync_code_graph', service, '/code-graph/sync', (input) => ({ code_graph_id: readObjectString(input, 'assetId'), user_id: service.getConfig().userId }));
  registerKnowledgeCommand('tencentdb_sync_wiki', service, '/wiki/ingest', (input) => ({ wiki_id: readObjectString(input, 'assetId'), user_id: service.getConfig().userId }));
  registerCommand('tencentdb_provision_workspace_assets', (_event, args) => service.provisionWorkspaceAssets(readObjectString(readInput(args) as Record<string, unknown>, 'workspace')));
  registerCommand('tencentdb_import_wiki_files', async (_event, args) => {
    const input = readInput(args) as Record<string, unknown>;
    const wikiId = readObjectString(input, 'wikiId');
    const selected = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文本知识', extensions: ['md', 'markdown', 'txt', 'rst', 'adoc', 'json', 'yaml', 'yml'] }],
    });
    if (selected.canceled || selected.filePaths.length === 0) return null;
    return service.importWikiFiles(wikiId, selected.filePaths);
  });
}

function registerKnowledgeCommand(command: string, service: TencentDbService, route: string, body: (input: Record<string, unknown>) => Record<string, unknown>): void {
  registerCommand(command, (_event, args) => service.knowledgeRequest(route, body(readInput(args) as Record<string, unknown>)));
}

function readItems(value: unknown): unknown[] {
  return value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).items) ? (value as Record<string, unknown>).items as unknown[] : [];
}

function readObjectString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) throw new Error(`${key} must be a non-empty string`);
  return field;
}

function readStringArray(value: Record<string, unknown>, key: string, min: number, max: number): string[] {
  const items = value[key];
  if (!Array.isArray(items) || items.length < min || items.length > max || !items.every((item) => typeof item === 'string' && item.trim())) throw new Error(`${key} must contain ${min} to ${max} non-empty strings`);
  return items;
}

function readCount(value: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const count = value[key] ?? fallback;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > max) throw new Error(`${key} must be an integer from 1 to ${max}`);
  return count;
}

function optionalText(value: Record<string, unknown>, key: string): Record<string, string> {
  if (value[key] === undefined || value[key] === null) return {};
  return { [key]: readObjectString(value, key) };
}

function optionalCount(value: Record<string, unknown>, key: string): Record<string, number> {
  if (value[key] === undefined || value[key] === null) return {};
  return { [key]: readCount(value, key, 1, Number.MAX_SAFE_INTEGER) };
}

function readInput(args: Record<string, unknown>): any {
  const input = args.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Command input must be an object');
  return input;
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function readText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function readRecord(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}
