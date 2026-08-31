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
import { registerIpcHandlers } from "./ipc/register";
import { IPC_CHANNELS } from "./ipc/contracts";
import { PiManager } from "./pi/manager";
import { resolvePiPackageDir, resolvePiProcess } from "./runtimePaths";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { attachWebviewSecurity } from "./webviewSecurity";

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
    const agentData = new AgentDataService({ dataPath: join(app.getPath('userData'), 'agent-data.db') });
    await agentData.start();
    const workspace = new WorkspaceService(process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent'));
    const piProcess = resolvePiProcess({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged });
    const pi = new PiManager(
      piProcess,
      {
        onEvent: (workspace, event) => broadcastPiEvent('pi://event', { workspace, event }),
        onUiRequest: (workspace, request) => broadcastPiEvent('pi://ui-request', { workspace, request }),
        onExit: (workspace, code) => broadcastPiEvent('pi://exit', { workspace, code }),
        onLog: (message) => console.error(message),
      },
    );
    registerIpcHandlers({
      settings,
      mcpPolicy: new McpPolicyService(app.getPath('home'), {
        piCommand: piProcess,
        piPackageDir: resolvePiPackageDir({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }),
      }),
      mcpConfig: new McpConfigService(app.getPath('home'), settings),
      subagent: new SubagentService(),
      files: new FileService(),
      skills: new SkillService(app.getPath('home')),
      usage: new UsageService(process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent')),
      pi: new PiRuntimeService({
        manager: pi,
        processCommand: resolvePiProcess({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }),
        agentDir: resolvePiPackageDir({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }),
        runtimeConfigPath: join(app.getPath('userData'), 'runtime-settings.json'),
        resolveWorkspace: (path) => workspace.ensureWorkspace(path),
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
      terminal: new TerminalService((event, payload) => broadcastPiEvent(event, payload)),
      create: new CreateService(),
      tempHtml: new TempHtmlService(app.getPath('temp')),
      shell: new ShellService(
        (event, payload) => broadcastPiEvent(event, payload),
        undefined,
        (path) => workspace.ensureWorkspace(path),
      ),
    });
    app.on('before-quit', () => {
      void pi.closeAll();
      void agentData.stop();
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
