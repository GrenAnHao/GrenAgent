import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, isInvokeRequest, type InvokeRequest } from './contracts';
import type { SettingsService } from '../app/settingsService';
import type { McpPolicyService } from '../app/mcpPolicyService';
import type { McpConfigService } from '../app/mcpConfigService';
import type { SubagentService } from '../app/subagentService';
import type { FileService } from '../app/fileService';
import type { SkillService } from '../app/skillService';
import type { PromptLibraryService } from '../app/promptLibraryService';
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
import type { PermissionManager } from '../app/permissionManager';
import type { PluginManager } from '../app/plugin/pluginManager';
import type { DevService } from '../app/devService';
import type { PiPackageService } from '../app/piPackageService';
import type { JobsBridgeService } from '../app/jobsBridge';
import { isHexColor, type WindowBackgroundStore } from '../app/windowBackground';
import { recordIpc } from '../runtimeDiag';
import { startCursorLogin } from '../agent/cursorLogin';

type CommandHandler = (event: IpcMainInvokeEvent, args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface IpcServices {
  settings?: SettingsService;
  mcpPolicy?: McpPolicyService;
  mcpConfig?: McpConfigService;
  subagent?: SubagentService;
  files?: FileService;
  skills?: SkillService;
  promptLibrary?: PromptLibraryService;
  usage?: UsageService;
  pi?: PiRuntimeService;
  provider?: ProviderService;
  enhancePrompt?: {
    run(input: { workspace: string; text: string; goalText?: string }, emit: (chunk: string) => void): Promise<unknown>;
    abort(workspace: string): void;
  };
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
  piPackages?: PiPackageService;
  /** 后台 job 的界面通道：快照与用户停止（实时帧走 pi://jobs 广播）。 */
  jobs?: JobsBridgeService;
  /** 记住原生窗口底色，供下次启动建窗口时使用。 */
  windowBackground?: Pick<WindowBackgroundStore, 'save'>;
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
    const started = performance.now();
    try {
      return await handler(event, request.args ?? {});
    } finally {
      recordIpc(request.command, performance.now() - started);
    }
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
  ipcMain.handle(IPC_CHANNELS.windowSetBackground, async (event, color: unknown) => {
    if (!isHexColor(color)) throw new Error('backgroundColor must be a hex color');
    BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(color);
    await services.windowBackground?.save(color);
  });

  if (services.settings) registerSettingsCommands(services.settings);
  if (services.mcpPolicy) registerMcpPolicyCommands(services.mcpPolicy);
  if (services.mcpConfig) registerMcpConfigCommands(services.mcpConfig);
  if (services.permissions) registerPermissionCommands(services.permissions);
  if (services.plugins) registerPluginCommands(services.plugins);
  if (services.piPackages) registerPiPackageCommands(services.piPackages);
  if (services.subagent) registerSubagentCommands(services.subagent);
  if (services.jobs) registerJobCommands(services.jobs);
  if (services.files) registerFileCommands(services.files);
  if (services.skills) registerSkillCommands(services.skills);
  if (services.promptLibrary) registerPromptLibraryCommands(services.promptLibrary);
  if (services.usage) registerCommand('usage_report', () => services.usage!.report());
  if (services.pi) registerPiCommands(services.pi);
  if (services.provider) registerProviderCommands(services.provider);
  if (services.enhancePrompt) {
    registerCommand('enhance_prompt', (event, args) => {
      const channel = args.onChunk;
      const emit = channel && typeof channel === 'object' && typeof (channel as Record<string, unknown>).__grenChannelId === 'string'
        ? (chunk: string) => event.sender.send(`${IPC_CHANNELS.eventPrefix}channel:${(channel as Record<string, string>).__grenChannelId}`, chunk)
        : () => {};
      const goalText = typeof args.goalText === 'string' ? args.goalText : '';
      return services.enhancePrompt!.run(
        { workspace: readString(args, 'workspace'), text: readText(args, 'text'), goalText },
        emit,
      );
    });
    registerCommand('enhance_prompt_abort', (_event, args) => {
      services.enhancePrompt!.abort(readString(args, 'workspace'));
    });
  }
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

function registerPiPackageCommands(service: PiPackageService): void {
  registerCommand('package_list', (_event, args) => service.list(readOptionalWorkspace(args)));
  registerCommand('package_search', (_event, args) => service.search(readText(args, 'query')));
  registerCommand('package_install', (_event, args) => service.install(
    readOptionalWorkspace(args),
    readString(args, 'name'),
    readString(args, 'version'),
    readPackageScope(args),
  ));
  registerCommand('package_remove', (_event, args) => service.remove(
    readOptionalWorkspace(args),
    readString(args, 'source'),
    readPackageScope(args),
  ));
  registerCommand('package_set_enabled', (_event, args) => service.setEnabled(
    readOptionalWorkspace(args),
    readString(args, 'source'),
    readPackageScope(args),
    readBoolean(args, 'enabled'),
  ));
}

function readOptionalWorkspace(args: Record<string, unknown>): string {
  const value = args.workspace;
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('workspace must be a string');
  return value;
}

function readPackageScope(args: Record<string, unknown>): 'user' | 'project' {
  const value = args.scope;
  if (value !== 'user' && value !== 'project') throw new Error('scope must be user or project');
  return value;
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
  registerCommand('reload_mcp_server', (_event, args) =>
    service.reload(readString(args, 'workspace'), readString(args, 'name')));
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

function registerJobCommands(service: JobsBridgeService): void {
  registerCommand('job_snapshot', (_event, args) => service.snapshot(readString(args, 'jobId'), readFiniteNumber(args, 'startedAt')));
  registerCommand('job_kill', (_event, args) => service.kill(readString(args, 'jobId'), readFiniteNumber(args, 'startedAt')));
}

function readFiniteNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function registerSubagentCommands(service: SubagentService): void {
  registerCommand('subagent_list', (_event, args) => service.list(
    readString(args, 'workspace'),
    typeof args.sessionPath === 'string' && args.sessionPath.trim() ? args.sessionPath : undefined,
  ));
  registerCommand('subagent_get_transcript', (_event, args) => service.transcript(
    readString(args, 'workspace'), readString(args, 'agentId'),
  ));
  registerCommand('subagent_get_session_messages', (_event, args) => ({
    messages: service.sessionMessages(readString(args, 'sessionPath')),
  }));
  registerCommand('subagent_cancel', (_event, args) => service.cancel(
    readString(args, 'workspace'), readString(args, 'agentId'),
  ));
  registerCommand('subagent_catalog', (_event, args) => service.catalog(readString(args, 'parentSessionPath')));
  registerCommand('subagent_catalog_row', (_event, args) => service.catalogRowSample(readString(args, 'sessionPath')));
  registerCommand('subagent_prompt', (_event, args) => service.promptChild(
    readString(args, 'workspace'),
    readString(args, 'parentSessionPath'),
    readString(args, 'sessionPath'),
    readText(args, 'message'),
    readDelivery(args, 'delivery'),
  ));
  registerCommand('subagent_interrupt', (_event, args) => service.interruptChild(
    readString(args, 'workspace'),
    readString(args, 'parentSessionPath'),
    readString(args, 'sessionPath'),
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

function readRuleScope(args: Record<string, unknown>, key: string): 'global' | 'project' {
  const value = args[key];
  if (value !== 'global' && value !== 'project') throw new Error(`${key} must be "global" or "project"`);
  return value;
}

function registerPromptLibraryCommands(service: PromptLibraryService): void {
  registerCommand('list_prompt_commands', () => service.listCommands());
  registerCommand('save_prompt_command', (_event, args) => service.saveCommand({
    originalName: typeof args.originalName === 'string' && args.originalName ? args.originalName : undefined,
    name: readString(args, 'name'),
    description: readText(args, 'description'),
    body: readText(args, 'body'),
    reserved: Array.isArray(args.reserved) ? args.reserved.filter((item): item is string => typeof item === 'string') : [],
  }));
  registerCommand('delete_prompt_command', (_event, args) => service.deleteCommand(readString(args, 'name')));
  registerCommand('list_context_rules', (_event, args) => service.listRules(readOptionalWorkspace(args)));
  registerCommand('save_context_rule', (_event, args) => {
    const original = args.original && typeof args.original === 'object' ? (args.original as Record<string, unknown>) : undefined;
    return service.saveRule({
      workspace: readOptionalWorkspace(args),
      scope: readRuleScope(args, 'scope'),
      original: original ? { scope: readRuleScope(original, 'scope'), id: readString(original, 'id') } : undefined,
      title: readText(args, 'title'),
      enabled: readBoolean(args, 'enabled'),
      body: readText(args, 'body'),
    });
  });
  registerCommand('set_context_rule_enabled', (_event, args) => service.setRuleEnabled(
    { scope: readRuleScope(args, 'scope'), id: readString(args, 'id') },
    readBoolean(args, 'enabled'),
    readOptionalWorkspace(args),
  ));
  registerCommand('delete_context_rule', (_event, args) => service.deleteRule(
    { scope: readRuleScope(args, 'scope'), id: readString(args, 'id') },
    readOptionalWorkspace(args),
  ));
}

function registerProviderCommands(service: ProviderService): void {
  registerCommand('cursor_login', async () => {
    const { agentDir } = await service.getConfig();
    await startCursorLogin({
      agentDir,
      openLoginUrl: (url) => shell.openExternal(url),
    });
  });
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
  registerCommand('list_projects', () => service.listProjects());
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
    const skip = args.skip ?? 0;
    if (typeof skip !== 'number' || !Number.isInteger(skip) || skip < 0) throw new Error('skip must be a non-negative integer');
    return service.logGraph(readString(args, 'workspacePath'), limit as number | null | undefined, skip);
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
  registerCommand('agent_list_running_turns', () => service.listRunningTurns());
  registerCommand('warm_workspace', (_event, args) => service.warmWorkspace(readString(args, 'workspace')));
  registerCommand('close_workspace', (_event, args) => service.closeWorkspace(readString(args, 'workspace')));
  registerCommand('extension_ui_respond', (_event, args) => service.respondUi(readString(args, 'workspace'), readRecord(args, 'response')));
  for (const command of [
    'agent_prompt', 'agent_steer', 'agent_follow_up', 'agent_abort', 'agent_take_steering', 'agent_set_model', 'agent_cycle_model',
    'agent_get_available_models', 'agent_set_thinking_level', 'agent_cycle_thinking_level', 'agent_set_mode',
    'agent_set_approval', 'agent_exclude_entry', 'agent_restore_entry', 'agent_rewind_to', 'agent_truncate_to',
    'agent_compact', 'agent_set_auto_compaction', 'agent_abort_retry', 'agent_get_session_stats', 'agent_get_state',
    'agent_get_messages', 'agent_get_commands', 'agent_new_session', 'agent_switch_session', 'agent_fork',
    'agent_clone', 'agent_get_fork_messages', 'agent_set_session_name',
    'ask_user_draft_read', 'ask_user_draft_write', 'ask_user_draft_delete',
    'agent_complete_ask_user',
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
  registerCommand('agentData_wiki_create', (_event, args) => service.requestAdmin('wiki.create', {
    name: readString(args, 'name'), ...(args.wikiId === undefined ? {} : { wikiId: readString(args, 'wikiId') }),
  }));
  registerCommand('agentData_wiki_read', (_event, args) => service.requestAdmin('wiki.read', { wikiId: readString(args, 'wikiId') }));
  registerCommand('agentData_wiki_list', () => service.requestAdmin('wiki.list', {}));
  registerCommand('agentData_wiki_update', (_event, args) => service.requestAdmin('wiki.update', {
    wikiId: readString(args, 'wikiId'),
    ...(args.name === undefined ? {} : { name: readString(args, 'name') }),
    ...(args.summary === undefined ? {} : { summary: args.summary === null ? null : readText(args, 'summary') }),
  }));
  registerCommand('agentData_wiki_remove', (_event, args) => service.requestAdmin('wiki.remove', { wikiId: readString(args, 'wikiId') }));
  registerCommand('agentData_wiki_resetDraft', (_event, args) => service.requestAdmin('wiki.resetDraft', { wikiId: readString(args, 'wikiId') }));
  registerCommand('agentData_wiki_ingest', (_event, args) => service.requestAdmin('wiki.ingest', { wikiId: readString(args, 'wikiId') }));
  registerCommand('agentData_wiki_rawWrite', (_event, args) => service.requestAdmin('wiki.rawWrite', {
    wikiId: readString(args, 'wikiId'), filename: readString(args, 'filename'), content: readText(args, 'content'),
  }));
  registerCommand('agentData_wiki_rawRemove', (_event, args) => service.requestAdmin('wiki.rawRemove', {
    wikiId: readString(args, 'wikiId'), filename: readString(args, 'filename'),
  }));
  registerCommand('agentData_wiki_rawList', (_event, args) => service.requestAdmin('wiki.rawList', { wikiId: readString(args, 'wikiId') }));
  registerCommand('agentData_wiki_rawRead', (_event, args) => service.requestAdmin('wiki.rawRead', {
    wikiId: readString(args, 'wikiId'), filename: readString(args, 'filename'),
  }));
  registerCommand('agentData_wiki_writeTemplate', (_event, args) => service.requestAdmin('wiki.writeTemplate', {
    wikiId: readString(args, 'wikiId'), name: readString(args, 'name'), content: readText(args, 'content'),
  }));
  registerCommand('agentData_wiki_pageWrite', (_event, args) => service.requestAdmin('wiki.pageWrite', {
    wikiId: readString(args, 'wikiId'), ref: readString(args, 'ref'), content: readText(args, 'content'),
  }));
  registerCommand('agentData_wiki_pageRemove', (_event, args) => service.requestAdmin('wiki.pageRemove', {
    wikiId: readString(args, 'wikiId'), ref: readString(args, 'ref'),
  }));
  registerCommand('agentData_wiki_pageList', (_event, args) => service.requestAdmin('wiki.pageList', { wikiId: readString(args, 'wikiId') }));
  registerCommand('agentData_wiki_pageRead', (_event, args) => service.requestAdmin('wiki.pageRead', {
    wikiId: readString(args, 'wikiId'), ref: readString(args, 'ref'),
  }));
  registerCommand('agentData_wiki_search', (_event, args) => service.requestAdmin('wiki.search', {
    wikiId: readString(args, 'wikiId'),
    query: readString(args, 'query'),
    ...(args.limit === undefined ? {} : { limit: readPositiveInteger(args, 'limit', 20) }),
    ...(args.hop === undefined ? {} : { hop: Number(args.hop) }),
    ...(args.decay === undefined ? {} : { decay: Number(args.decay) }),
    ...(args.minScore === undefined ? {} : { minScore: Number(args.minScore) }),
  }));
  registerCommand('agentData_wiki_graph', (_event, args) => service.requestAdmin('wiki.graph', { wikiId: readString(args, 'wikiId') }));
}

function readDelivery(args: Record<string, unknown>, key: string): 'followUp' | 'steer' {
  const value = args[key];
  if (value !== 'followUp' && value !== 'steer') throw new Error(`${key} must be followUp or steer`);
  return value;
}

function readBoolean(args: Record<string, unknown>, key: string): boolean {
  if (typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  return args[key] as boolean;
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
