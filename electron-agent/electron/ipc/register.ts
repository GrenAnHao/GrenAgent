import { dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, isInvokeRequest, type InvokeRequest } from './contracts';
import type { TencentDbService } from '../tencentdb/service';

type CommandHandler = (event: IpcMainInvokeEvent, args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface IpcServices {
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

  if (services.tencentdb) registerTencentDbCommands(services.tencentdb);
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
