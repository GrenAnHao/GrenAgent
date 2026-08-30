import { dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, isInvokeRequest, type InvokeRequest } from './contracts';
import type { SettingsService } from '../app/settingsService';
import type { PiRuntimeService } from '../app/piRuntimeService';
import type { WorkspaceService } from '../app/workspaceService';
import type { TencentDbService } from '../tencentdb/service';

type CommandHandler = (event: IpcMainInvokeEvent, args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface IpcServices {
  settings?: SettingsService;
  pi?: PiRuntimeService;
  workspace?: WorkspaceService;
  tencentdb?: TencentDbService;
}

const commandHandlers = new Map<string, CommandHandler>();

export function registerCommand(command: string, handler: CommandHandler): void {
  commandHandlers.set(command, handler);
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
  if (services.pi) registerPiCommands(services.pi);
  if (services.workspace) registerWorkspaceCommands(services.workspace);
  if (services.tencentdb) registerTencentDbCommands(services.tencentdb);
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
  registerCommand('tencentdb_test_connection', () => service.status());
  registerCommand('tencentdb_open_panel', () => service.openPanel());
  registerCommand('tencentdb_core_request', (_event, args) => {
    const input = readInput(args) as { route?: unknown; body?: unknown };
    if (typeof input.route !== 'string') throw new Error('TencentDB Core request route is required');
    const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body)
      ? input.body as Record<string, unknown>
      : {};
    return service.coreRequest(input.route, body);
  });
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

function readRecord(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}
