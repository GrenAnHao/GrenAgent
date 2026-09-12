import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
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
import type { AgentDataService } from '../app/agentDataService';
import type { WikiVersion, WikiSourceInput, WikiSourceRef } from '../agentData/wikiContracts';
import type { PermissionManager } from '../app/permissionManager';
import type { PluginManager } from '../app/plugin/pluginManager';
import type { DevService } from '../app/devService';

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
  agentData?: AgentDataService;
  permissions?: PermissionManager;
  plugins?: Pick<PluginManager, 'list' | 'start' | 'stop' | 'allowedPluginIds'>;
  /** 仅开发期注入（见 main.ts）：未注入则 dev_* 诊断命令不注册。 */
  dev?: DevService;
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

  ipcMain.handle(IPC_CHANNELS.windowMinimize, (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
  });
  ipcMain.handle(IPC_CHANNELS.windowIsMaximized, (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);
  ipcMain.handle(IPC_CHANNELS.windowClose, (event) => BrowserWindow.fromWebContents(event.sender)?.close());

  if (services.settings) registerSettingsCommands(services.settings);
  if (services.mcpPolicy) registerMcpPolicyCommands(services.mcpPolicy);
  if (services.mcpConfig) registerMcpConfigCommands(services.mcpConfig);
  if (services.permissions) registerPermissionCommands(services.permissions);
  if (services.plugins) registerPluginCommands(services.plugins);
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
  if (services.dev) registerDevCommands(services.dev);
  if (services.agentData) {
    registerCommand('agentData_tasks_list', (_event, args) => services.agentData!.requestAdmin('admin.tasks.list', args));
    registerCommand('agentData_tasks_read', (_event, args) => services.agentData!.requestAdmin('admin.tasks.read', args));
    registerCommand('agentData_tasks_previewRetry', (_event, args) => services.agentData!.requestAdmin('admin.tasks.previewRetry', args));
    registerCommand('agentData_tasks_retry', (_event, args) => services.agentData!.requestAdmin('admin.tasks.retry', args));
    registerCommand('agentData_audit_query', (_event, args) => services.agentData!.requestAdmin('admin.audit.query', args));
    registerCommand('agentData_audit_export', (_event, args) => services.agentData!.requestAdmin('admin.audit.export', args));
    registerCommand('agentData_diagnostics_check', () => services.agentData!.requestAdmin('admin.diagnostics.check', {}));
    registerCommand('agentData_overview', (_event, args) => services.agentData!.requestAdmin('admin.overview', { userId: readString(args, 'userId') }));
    registerCommand('agentData_diagnostics_open', async (_event, args) => {
      const path = await services.agentData!.resolveDiagnosticPath(readString(args, 'id'));
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    });
    registerCommand('thread_create', (_event, args) => services.agentData!.createThread({
      id: readString(args, 'id'), projectId: readString(args, 'projectId'), workspace: readString(args, 'workspace'),
      ...(args.title === undefined ? {} : { title: readText(args, 'title') }),
    }));
    registerCommand('thread_list', () => services.agentData!.listThreads());
    registerCommand('thread_read', (_event, args) => services.agentData!.readThread(readString(args, 'id')));
    registerCommand('turn_create', (_event, args) => services.agentData!.createTurn({
      id: readString(args, 'id'), threadId: readString(args, 'threadId'), input: readText(args, 'input'),
      permissionProfile: readString(args, 'permissionProfile'), ...(args.mode === undefined ? {} : { mode: args.mode as 'interactive' | 'non-interactive' }),
    }));
    registerCommand('turn_update', (_event, args) => services.agentData!.updateTurn(readString(args, 'id'), {
      ...(args.status === undefined ? {} : { status: args.status as never }),
      ...(args.startedAt === undefined ? {} : { startedAt: args.startedAt as number }),
      ...(args.completedAt === undefined ? {} : { completedAt: args.completedAt as number }),
      ...(args.error === undefined ? {} : { error: readText(args, 'error') }),
    }));
    registerCommand('item_upsert', (_event, args) => services.agentData!.upsertItem(args as never));
    registerCommand('item_list', (_event, args) => services.agentData!.listItems(readString(args, 'threadId'), args.turnId === undefined ? undefined : readString(args, 'turnId')));
    registerCommand('agentData_status', () => services.agentData!.status());
    registerCommand('agentData_start', () => services.agentData!.start());
    registerCommand('agentData_stop', () => services.agentData!.stop());
    registerCommand('agentData_admin_jobs_list', () => services.agentData!.request('admin.jobs.list'));
    registerCommand('agentData_admin_jobs_get', (_event, args) => services.agentData!.request('admin.jobs.get', { id: readString(args, 'id') }));
    registerCommand('agentData_admin_jobs_cancel', (_event, args) => services.agentData!.request('admin.jobs.cancel', { id: readString(args, 'id') }));
    registerCommand('agentData_admin_jobs_remove', (_event, args) => services.agentData!.request('admin.jobs.remove', { id: readString(args, 'id') }));
    registerCommand('agentData_admin_jobs_clear', (_event, args) => services.agentData!.request('admin.jobs.clear', { ids: args.ids }));
    registerCommand('agentData_admin_config_get', (_event, args) => services.agentData!.request('admin.config.get', { module: readString(args, 'module') }));
    registerCommand('agentData_admin_config_update', (_event, args) => services.agentData!.request('admin.config.update', { module: readString(args, 'module'), value: readRecord(args, 'value'), version: args.version }));
    registerCommand('agentData_admin_audit_list', () => services.agentData!.request('admin.audit.list'));
    registerCommand('agentData_admin_diagnostics', () => services.agentData!.request('admin.diagnostics'));
    registerCommand('agentData_admin_export', () => services.agentData!.request('admin.export'));
    registerCommand('agentData_admin_import', (_event, args) => services.agentData!.request('admin.import', { data: readRecord(args, 'data') }));
    registerCommand('agentData_memory_overview', (_event, args) => services.agentData!.request('memory.admin.overview', {
      userId: readString(args, 'userId'),
      ...(args.workspace === undefined ? {} : { workspace: readString(args, 'workspace') }),
      ...(args.projectId === undefined ? {} : { projectId: readString(args, 'projectId') }),
      ...(args.sessionId === undefined ? {} : { sessionId: readString(args, 'sessionId') }),
      ...(args.includeOtherProjects === true ? { includeOtherProjects: true } : {}),
    }));
    registerWikiManagement(services.agentData);
    registerCommand('agentData_wiki_overview', (_event, args) => services.agentData!.requestAdmin('wiki.admin.overview', {
      ...(args.workspace === undefined ? {} : { workspace: readString(args, 'workspace') }),
    }));
    registerCommand('agentData_code_status', (_event, args) => services.agentData!.request('codeRetrieval.admin.status', {
      workspace: readString(args, 'workspace'),
    }));
    registerCommand('agentData_code_projects', () => services.agentData!.request('codeRetrieval.admin.projects', {}));
    registerCommand('agentData_jobs_create', (_event, args) => services.agentData!.request('admin.jobs.create', {
      kind: readString(args, 'kind'),
      workspace: readString(args, 'workspace'),
    }));
    registerCommand('agentData_memory_search', (_event, args) => services.agentData!.request('memory.search', {
      userId: readString(args, 'userId'),
      ...(args.workspace === undefined ? {} : { workspace: readString(args, 'workspace') }),
      ...(args.projectId === undefined ? {} : { projectId: readString(args, 'projectId') }),
      ...(args.sessionId === undefined ? {} : { sessionId: readString(args, 'sessionId') }),
      ...(args.includeOtherProjects === true ? { includeOtherProjects: true } : {}),
      query: readString(args, 'query'),
      limit: readPositiveInteger(args, 'limit', 50),
    }));
    registerCommand('agentData_memory_list', (_event, args) => services.agentData!.requestAdmin('memory.list', args));
    registerCommand('agentData_memory_read', (_event, args) => services.agentData!.requestAdmin('memory.read', args));
    registerCommand('agentData_memory_create', (_event, args) => services.agentData!.requestAdmin('memory.create', args));
    registerCommand('agentData_memory_update', (_event, args) => services.agentData!.requestAdmin('memory.update', args));
    registerCommand('agentData_memory_conversations_list', (_event, args) => services.agentData!.requestAdmin('memory.conversations.list', args));
    registerCommand('agentData_memory_conversations_read', (_event, args) => services.agentData!.requestAdmin('memory.conversations.read', args));
    registerCommand('agentData_memory_delete', (_event, args) => services.agentData!.requestAdmin('memory.delete', {
      userId: readString(args, 'userId'),
      id: readString(args, 'id'),
    }));
    registerCommand('agentData_wiki_search', (_event, args) => services.agentData!.requestAdmin('wiki.search', {
      ...(args.workspace === undefined ? {} : { workspace: readString(args, 'workspace') }),
      query: readString(args, 'query'),
      limit: readPositiveInteger(args, 'limit', 50),
    }));
    registerCommand('agentData_code_search', (_event, args) => services.agentData!.request('codeRetrieval.search', {
      workspace: readString(args, 'workspace'),
      query: readString(args, 'query'),
      limit: readPositiveInteger(args, 'limit', 20),
    }));
    registerCommand('agentData_code_call', (_event, args) => services.agentData!.request('codeRetrieval.call', {
      workspace: readString(args, 'workspace'), tool: readString(args, 'tool'), args: readRecord(args, 'args'),
    }));
  }
}

function registerPluginCommands(service: Pick<PluginManager, 'list' | 'start' | 'stop' | 'allowedPluginIds'>): void {
  registerCommand('plugin_list', () => service.list());
  registerCommand('plugin_start', (_event, args) => service.start(readString(args, 'id')));
  registerCommand('plugin_stop', (_event, args) => service.stop(readString(args, 'id')));
  registerCommand('plugin_allowed_list', () => service.allowedPluginIds());
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
  registerCommand('effective_mcp_configs', (_event, args) => service.effective(readString(args, 'workspace')));
  registerCommand('upsert_mcp_config', (_event, args) => {
    if (typeof args.config !== 'object' || !args.config || Array.isArray(args.config)) throw new Error('config must be an object');
    if (typeof args.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    return service.upsert(readString(args, 'workspace'), readString(args, 'scope'), readString(args, 'name'), args.config, args.enabled);
  });
  registerCommand('remove_mcp_config', (_event, args) => service.remove(
    readString(args, 'workspace'), readString(args, 'scope'), readString(args, 'name'),
  ));
}

function registerPermissionCommands(service: PermissionManager): void {
  registerCommand('permission_evaluate', (_event, args) => {
    const operation = readRecord(args, 'operation');
    return service.authorize(
      { ...operation, kind: typeof operation.kind === 'string' ? operation.kind : 'unknown' },
      readString(args, 'profile'),
    );
  });
  registerCommand('permission_resolve', (_event, args) => service.resolve(
    readString(args, 'requestId'), args.resolution === 'allow' ? 'allow' : 'deny',
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
  registerCommand('fetch_provider_models', (_event, args) => service.fetchModels(readString(args, 'baseUrl'), readString(args, 'apiKey'), readString(args, 'api'), readOptionalHeaders(args, 'headers')));
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
  registerCommand('set_session_display_name', (_event, args) =>
    service.setSessionDisplayName(readString(args, 'sessionPath'), readText(args, 'name')),
  );
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

/**
 * 开发期诊断命令。dev_list_commands 复用 register 内部的注册表，故 DevService 不需要反向依赖本文件。
 * 这些命令只查询、不写入，但仍仅在非打包时注册，避免成为生产版本的额外攻击面。
 */
function registerDevCommands(service: DevService): void {
  registerCommand('dev_runtime_info', () => service.info());
  registerCommand('dev_list_commands', () => getRegisteredCommands());
}

function registerWikiManagement(service: AgentDataService): void {
  registerCommand('agentData_wiki_libraries_list', (_event, args) => service.requestAdmin('wiki.libraries.list', {
    ...(args.query === undefined ? {} : { query: readText(args, 'query') }), ...(args.project === undefined ? {} : { project: readString(args, 'project') }),
  }));
  registerCommand('agentData_wiki_libraries_read', (_event, args) => service.requestAdmin('wiki.libraries.read', { kbId: readString(args, 'kbId') }));
  registerCommand('agentData_wiki_libraries_create', (_event, args) => service.requestAdmin('wiki.libraries.create', readLibraryInput(args)));
  registerCommand('agentData_wiki_libraries_update', (_event, args) => service.requestAdmin('wiki.libraries.update', { kbId: readString(args, 'kbId'), ...readLibraryInput(args), expectedRevision: readRevision(args, 'expectedRevision') }));
  registerCommand('agentData_wiki_libraries_previewDelete', (_event, args) => service.requestAdmin('wiki.libraries.previewDelete', { kbId: readString(args, 'kbId') }));
  registerCommand('agentData_wiki_libraries_remove', (_event, args) => service.requestAdmin('wiki.libraries.remove', { kbId: readString(args, 'kbId'), cancelActive: readBoolean(args, 'cancelActive') }));
  registerCommand('agentData_wiki_libraries_previewIngest', (_event, args) => service.requestAdmin('wiki.libraries.previewIngest', readIngestInput(args)));
  registerCommand('agentData_wiki_libraries_ingest', (_event, args) => service.requestAdmin('wiki.libraries.ingest', { ...readIngestInput(args), ...(args.expectedModel === undefined ? {} : { expectedModel: readString(args, 'expectedModel') }) }));
  registerCommand('agentData_wiki_libraries_reindex', (_event, args) => service.requestAdmin('wiki.libraries.reindex', { kbId: readString(args, 'kbId') }));
  registerCommand('agentData_wiki_sources_list', (_event, args) => service.requestAdmin('wiki.sources.list', { kbId: readString(args, 'kbId') }));
  registerCommand('agentData_wiki_sources_read', (_event, args) => service.requestAdmin('wiki.sources.read', { kbId: readString(args, 'kbId'), sourceId: readString(args, 'sourceId'), ...(args.revision === undefined ? {} : { revision: readRevision(args, 'revision') }) }));
  registerCommand('agentData_wiki_sources_previewImport', (_event, args) => service.requestAdmin('wiki.sources.previewImport', { kbId: readString(args, 'kbId'), projectWorkspace: readString(args, 'projectWorkspace'), relativePath: readString(args, 'relativePath') }));
  registerCommand('agentData_wiki_sources_create', (_event, args) => service.requestAdmin('wiki.sources.create', { kbId: readString(args, 'kbId'), ...readWikiSourceInput(args) }));
  registerCommand('agentData_wiki_sources_update', (_event, args) => service.requestAdmin('wiki.sources.update', { kbId: readString(args, 'kbId'), sourceId: readString(args, 'sourceId'), content: readText(args, 'content'), expected: readVersion(args) }));
  registerCommand('agentData_wiki_sources_previewDelete', (_event, args) => service.requestAdmin('wiki.sources.previewDelete', { kbId: readString(args, 'kbId'), sourceId: readString(args, 'sourceId') }));
  registerCommand('agentData_wiki_sources_remove', (_event, args) => service.requestAdmin('wiki.sources.remove', { kbId: readString(args, 'kbId'), sourceId: readString(args, 'sourceId'), cancelActive: readBoolean(args, 'cancelActive') }));
  registerCommand('agentData_wiki_pages_list', (_event, args) => service.requestAdmin('wiki.pages.list', { kbId: readString(args, 'kbId') }));
  registerCommand('agentData_wiki_pages_read', (_event, args) => service.requestAdmin('wiki.pages.read', { kbId: readString(args, 'kbId'), pageId: readString(args, 'pageId') }));
  registerCommand('agentData_wiki_pages_create', (_event, args) => service.requestAdmin('wiki.pages.create', { kbId: readString(args, 'kbId'), ...readPageInput(args) }));
  registerCommand('agentData_wiki_pages_update', (_event, args) => service.requestAdmin('wiki.pages.update', { kbId: readString(args, 'kbId'), pageId: readString(args, 'pageId'), ...readPageInput(args), expected: readVersion(args) }));
  registerCommand('agentData_wiki_pages_setLocked', (_event, args) => service.requestAdmin('wiki.pages.setLocked', { kbId: readString(args, 'kbId'), pageId: readString(args, 'pageId'), locked: readBoolean(args, 'locked'), expected: readVersion(args) }));
  registerCommand('agentData_wiki_pages_previewDelete', (_event, args) => service.requestAdmin('wiki.pages.previewDelete', { kbId: readString(args, 'kbId'), pageId: readString(args, 'pageId') }));
  registerCommand('agentData_wiki_pages_remove', (_event, args) => service.requestAdmin('wiki.pages.remove', { kbId: readString(args, 'kbId'), pageId: readString(args, 'pageId'), cancelActive: readBoolean(args, 'cancelActive') }));
}

function readLibraryInput(args: Record<string, unknown>) { return { name: readString(args, 'name'), description: readText(args, 'description'), bindings: readStringArray(args, 'bindings') }; }
function readPageInput(args: Record<string, unknown>) { return { title: readString(args, 'title'), content: readText(args, 'content'), sourceRefs: readSourceRefs(args) }; }
function readIngestInput(args: Record<string, unknown>) { return { kbId: readString(args, 'kbId'), ...(args.sourceIds === undefined ? {} : { sourceIds: readStringArray(args, 'sourceIds') }), ...(args.regenerateSourceIds === undefined ? {} : { regenerateSourceIds: readStringArray(args, 'regenerateSourceIds') }) }; }
function readBoolean(args: Record<string, unknown>, key: string): boolean { if (typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean`); return args[key]; }
function readRevision(args: Record<string, unknown>, key: string): number { if (!Number.isInteger(args[key]) || Number(args[key]) < 0) throw new Error(`${key} must be a nonnegative integer`); return Number(args[key]); }
function readStringArray(args: Record<string, unknown>, key: string): string[] {
  const values = args[key];
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !v.trim())) throw new Error(`${key} must be a string array`);
  return [...new Set(values as string[])];
}
function readVersion(args: Record<string, unknown>): WikiVersion {
  const expected = readRecord(args, 'expected');
  if (!Number.isInteger(expected.revision) || Number(expected.revision) < 0 || typeof expected.contentHash !== 'string' || !expected.contentHash) throw new Error('expected version is required');
  return { revision: Number(expected.revision), contentHash: expected.contentHash };
}
function readSourceRefs(args: Record<string, unknown>): WikiSourceRef[] {
  if (!Array.isArray(args.sourceRefs)) throw new Error('invalid sourceRefs');
  const refs = new Map<string, WikiSourceRef>();
  for (const ref of args.sourceRefs) {
    if (!ref || typeof ref.sourceId !== 'string' || !ref.sourceId.trim() || !Number.isInteger(ref.revision) || ref.revision < 1) throw new Error('invalid sourceRefs');
    refs.set(JSON.stringify([ref.sourceId, ref.revision]), { sourceId: ref.sourceId, revision: ref.revision });
  }
  return [...refs.values()];
}
function readWikiSourceInput(args: Record<string, unknown>): WikiSourceInput {
  if (args.kind === 'manual' || args.kind === 'upload') return { kind: args.kind, name: readString(args, 'name'), content: readText(args, 'content') };
  if (args.kind === 'project') return { kind: args.kind, projectWorkspace: readString(args, 'projectWorkspace'), relativePath: readString(args, 'relativePath'), expectedContentHash: readString(args, 'expectedContentHash') };
  throw new Error('invalid source kind');
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

function readPositiveInteger(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return value;
}
function readRecord(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}

function readOptionalHeaders(args: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object`);
  const record = value as Record<string, unknown>;
  if (!Object.values(record).every((v) => typeof v === 'string')) throw new Error(`${key} values must be strings`);
  return record as Record<string, string>;
}
