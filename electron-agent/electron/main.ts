import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { browserWindowOptions } from "./mainConfig";
import { SettingsService } from "./app/settingsService";
import { McpPolicyService } from "./app/mcpPolicyService";
import { McpConfigService } from "./app/mcpConfigService";
import { SubagentService } from "./app/subagentService";
import { FileService } from "./app/fileService";
import { SkillService } from "./app/skillService";
import { UsageService } from "./app/usageService";
import { PiRuntimeService } from "./app/piRuntimeService";
import { ProviderService } from "./app/providerService";
import { WorkspaceService } from "./app/workspaceService";
import { UiHistoryService } from "./app/uiHistoryService";
import { WorkspaceApprovalService } from "./app/workspaceApprovalService";
import { GitService } from "./app/gitService";
import { TerminalService } from "./app/terminalService";
import { CreateService } from "./app/createService";
import { TempHtmlService } from "./app/tempHtmlService";
import { ShellService } from "./app/shellService";
import { AgentDataService } from "./app/agentDataService";
import { PermissionManager } from "./app/permissionManager";
import { registerIpcHandlers } from "./ipc/register";
import { IPC_CHANNELS } from "./ipc/contracts";
import { PiManager } from "./pi/manager";
import { resolvePiPackageDir, resolvePiProcess } from "./runtimePaths";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { attachWebviewSecurity } from "./webviewSecurity";
import { SandboxManager } from "./app/sandbox/sandboxManager";
import { EventBus } from "./app/appServer/eventBus";
import type { AppEvent } from "./app/appServer/types";
import { randomUUID } from "node:crypto";
import { AgentDataStorage } from "./agentData/storage";
import { PluginManager, type PluginDefinition } from "./app/plugin/pluginManager";
import { SystemWorkerManager } from "./pi/systemWorkerManager";

export function createWindow() {
  const window = new BrowserWindow(browserWindowOptions);
  attachWebviewSecurity(window.webContents);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, "../dist/index.html"));
  }
}

if (!process.env.VITEST) {
  app.whenReady().then(async () => {
    const settings = new SettingsService(app.getPath('userData'));
    const dataPath = join(app.getPath('userData'), 'agent-data.db');
    const sequenceStorage = new AgentDataStorage(dataPath);
    sequenceStorage.migrate();
    const latestSequence = Number((sequenceStorage.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM app_events').get() as { sequence: number }).sequence);
    sequenceStorage.close();
    const eventBus = new EventBus(1024, latestSequence + 1);
    let piRuntime: PiRuntimeService | undefined;
    let agentData: AgentDataService;
    const publishAppEvent = (input: Omit<AppEvent, 'sequence'>) => {
      const event = eventBus.publish(withEventProject(input));
      void agentData?.appendAppEvent(event).catch((error) => console.error('Failed to persist app event', error));
      broadcastPiEvent('app://event', { workspace: event.projectId ?? '__global__', event });
    };
    const permissions = new PermissionManager({ dataDir: app.getPath('userData'), publish: publishAppEvent, resolveProfile: (operation, requested) => {
      const workspace = typeof operation.workspace === 'string' ? operation.workspace : undefined;
      return workspace ? (piRuntime?.permissionProfile(workspace) ?? requested) : requested;
    } });
    const sandbox = new SandboxManager({ publish: publishAppEvent });
    const mcpConfig = new McpConfigService(app.getPath('home'), settings);
    const workspace = new WorkspaceService(process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent'));
    const piProcess = resolvePiProcess({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged });
    const systemWorker = new SystemWorkerManager({
      processCommand: piProcess,
      cwd: app.getPath('userData'),
      idleTimeoutMs: 60_000,
      sandbox,
      env: {
        PI_PACKAGE_DIR: resolvePiPackageDir({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }),
        PI_RUNTIME_CONFIG: join(app.getPath('userData'), 'runtime-settings.json'),
      },
    });
    agentData = new AgentDataService({
      dataPath,
      executeServiceTask: (task) => systemWorker.run({ id: task.id, kind: task.kind, input: task.input }),
      publishAppEvent,
      methods: {
        'turn.start': (params) => piRuntime?.enqueueTurn(
          readRpcString(params, 'workspace'),
          readRpcString(params, 'input'),
          typeof params.permissionProfile === 'string' ? params.permissionProfile : 'workspace',
        ),
        'permission.authorize': (params) => permissions.authorize(
          isRecord(params.operation) ? params.operation : {},
          typeof params.profile === 'string' ? params.profile : 'workspace',
        ),
        'mcp.state.publish': (params) => {
          publishAppEvent({ id: randomUUID(), type: 'mcp.state_changed', timestamp: Date.now(), projectId: readRpcString(params, 'workspace'), data: { servers: Array.isArray(params.servers) ? params.servers : [] } });
          return null;
        },
      },
    });
    await agentData.start();
    const pluginStorage = new AgentDataStorage(dataPath);
    pluginStorage.migrate();
    const plugins = new PluginManager({ storage: pluginStorage, apiVersion: '1', publish: publishAppEvent });
    plugins.discover(builtinPluginDefinitions());
    await plugins.startAll();
    const pi = new PiManager(
      piProcess,
      {
        onEvent: (workspace, event) => {
          void piRuntime?.handlePiEvent(workspace, event);
          broadcastPiEvent('pi://event', { workspace, event });
        },
        onUiRequest: (workspace, request) => broadcastPiEvent('pi://ui-request', { workspace, request }),
        onExit: (workspace, code) => broadcastPiEvent('pi://exit', { workspace, code }),
        onLog: (message) => console.error(message),
      },
      sandbox,
    );
    registerIpcHandlers({
      settings,
      mcpPolicy: new McpPolicyService(app.getPath('home'), {
        piCommand: piProcess,
        piPackageDir: resolvePiPackageDir({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }),
        permissionManager: permissions,
        publish: publishAppEvent,
      }),
      mcpConfig,
      subagent: new SubagentService(sandbox),
      files: new FileService(),
      skills: new SkillService(app.getPath('home')),
      usage: new UsageService(process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent')),
      pi: piRuntime = new PiRuntimeService({
        manager: pi,
        processCommand: resolvePiProcess({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }),
        agentDir: resolvePiPackageDir({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }),
        runtimeConfigPath: join(app.getPath('userData'), 'runtime-settings.json'),
        agentDataEndpoint: () => {
          const endpoint = agentData.endpoint();
          return endpoint ? JSON.stringify(endpoint) : undefined;
        },
        resolveWorkspace: (path) => workspace.ensureWorkspace(path),
        permissionManager: permissions,
        mcpConfig,
        allowedPluginIds: () => plugins.allowedPluginIds(),
        threadStore: agentData,
        eventBus,
        emitAppEvent: (event) => broadcastPiEvent('app://event', { workspace: event.projectId ?? '__global__', event }),
      }),
      provider: new ProviderService({
        agentDir: process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent'),
        probeModels: async () => {
          const probeArgs = piProcess.args[0]?.endsWith('.ts') ? [piProcess.args[0], 'probe-models'] : ['probe-models'];
          const { stdout } = await promisify(execFile)(piProcess.command, probeArgs, { windowsHide: true });
          return stdout;
        },
        refresh: () => new PiRuntimeService({ manager: pi, processCommand: piProcess, agentDir: resolvePiPackageDir({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }) }).refreshModelRegistry(),
        activeModel: async (workspace) => {
          const client = pi.get(workspace);
          if (!client) throw new Error(`workspace not open: ${workspace}`);
          const state = await client.send<Record<string, unknown>>({ type: 'get_state' });
          const model = state.model;
          if (!model || typeof model !== 'object') throw new Error('workspace has no active model');
          const value = model as Record<string, unknown>;
          if (typeof value.provider !== 'string' || typeof value.id !== 'string') throw new Error('workspace active model is invalid');
          return { provider: value.provider, modelId: value.id };
        },
        oneshot: (request, onLine) => runPiOneshot(piProcess, resolvePiPackageDir({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }), request, onLine),
      }),
      workspace,
      uiHistory: new UiHistoryService((path) => workspace.ensureWorkspace(path)),
      workspaceApproval: new WorkspaceApprovalService(app.getPath('userData')),
      git: new GitService(),
      terminal: new TerminalService((event, payload) => broadcastPiEvent(event, payload), sandbox),
      create: new CreateService(),
      tempHtml: new TempHtmlService(app.getPath('temp')),
      shell: new ShellService(
        (event, payload) => broadcastPiEvent(event, payload),
        undefined,
        (path) => workspace.ensureWorkspace(path),
        sandbox,
      ),
      agentData,
      permissions,
      plugins,
    });
    app.on('before-quit', () => {
      void pi.closeAll();
      systemWorker?.close();
      void agentData.stop();
      pluginStorage.close();
    });
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}

function runPiOneshot(
  processCommand: ReturnType<typeof resolvePiProcess>, packageDir: string, request: Record<string, unknown>, onLine?: (line: string) => void,
): Promise<void> {
  const entry = processCommand.args[0];
  const args = entry?.endsWith('.ts') ? [entry, 'oneshot'] : ['oneshot'];
  return new Promise((resolve, reject) => {
    const child = spawn(processCommand.command, args, {
      env: { ...process.env, PI_PACKAGE_DIR: packageDir, ONESHOT_REQUEST: JSON.stringify(request) },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let buffered = ''; let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/); buffered = lines.pop() ?? '';
      lines.map((line) => line.trim()).filter(Boolean).forEach((line) => onLine?.(line));
    });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => reject(error));
    child.once('close', (code) => {
      if (buffered.trim()) onLine?.(buffered.trim());
      if (code === 0) resolve(); else reject(new Error(`pi oneshot exited (${code}): ${stderr.trim()}`));
    });
  });
}

function broadcastPiEvent(event: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(`${IPC_CHANNELS.eventPrefix}${event}`, payload);
  }
}

function withEventProject(event: Omit<AppEvent, 'sequence'>): Omit<AppEvent, 'sequence'> {
  if (event.projectId) return event;
  const data = isRecord(event.data) ? event.data : {};
  const request = isRecord(data.request) ? data.request : undefined;
  const operation = request && isRecord(request.operation) ? request.operation : undefined;
  const workspace = typeof data.workspace === 'string' ? data.workspace : operation && typeof operation.workspace === 'string' ? operation.workspace : undefined;
  return workspace ? { ...event, projectId: workspace } : event;
}

function readRpcString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function builtinPluginDefinitions(): PluginDefinition[] {
  return [
    { id: 'goal', manifest: { id: 'goal', version: '0.1.0', apiVersion: '1', capabilities: ['agent', 'ui', 'event-subscriber'], permissions: { interaction: 'auto' } }, load: () => ({}) },
    { id: 'web-search', manifest: { id: 'web-search', version: '0.1.0', apiVersion: '1', capabilities: ['tool'], permissions: { network: 'full' } }, load: () => ({}) },
    { id: 'mcp', manifest: { id: 'mcp', version: '0.1.0', apiVersion: '1', capabilities: ['mcp', 'tool', 'event-subscriber'], permissions: { network: 'full', process: 'allowlist', secrets: 'selected' } }, load: () => ({}) },
  ];
}
