import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { browserWindowOptions, resolveAppIcon, resolveRendererHtml } from "./mainConfig";
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
import { DevService } from "./app/devService";
import { createEnhancePrompt } from "./app/enhancePrompt";
import { registerIpcHandlers } from "./ipc/register";
import { IPC_CHANNELS } from "./ipc/contracts";
import { attachWebviewSecurity } from "./webviewSecurity";
import { attachDevToolsShortcut } from "./devtoolsShortcut";
import { SandboxManager } from "./app/sandbox/sandboxManager";
import { AgentDataStorage } from "./agentData/storage";
import { PluginManager } from "./app/plugin/pluginManager";
import { builtinPluginDefinitions } from "./app/plugin/builtinPlugins";
import { SystemWorkerManager } from "./pi/systemWorkerManager";
import { randomUUID } from "node:crypto";
import { WikiSyncService, scanWorkspaceMarkdown, readWorkspaceSource } from "./app/wikiSyncService";
import { CodeGraphService } from "./app/codeGraph/codeGraphService";
import { CodeGraphJobs } from "./app/codeGraph/codeGraphJobs";
import { validateProject } from "./app/validateProject";
import { bootstrapRuntimeConfig } from "./agent/runtimeConfigBootstrap";
import { resolveWorkerEntry } from "./agent/workerEntry";
import { AgentHost } from "./agent/agentHost";
import { createWorkspaceHandle } from "./agent/createWorkspaceHandle";
import { ModelRuntimeHost } from "./agent/modelRuntimeHost";
import { getAgentDir, ModelRegistry, ModelRuntime, SettingsManager } from "../../cli/src/pi-sdk.js";
import { collectModels } from "../../cli/src/probe-models.js";
import { runHostOneshot } from "./agent/hostOneshotAdapter";
import { killAllSubagents } from "../../extensions/multi-agent/subagentProcessRegistry.js";
import { releaseSubagentControlPlane } from "../../extensions/multi-agent/controlPlane.js";

export function createWindow() {
  const window = new BrowserWindow({
    ...browserWindowOptions,
    icon: resolveAppIcon(app.isPackaged, app.getAppPath(), __dirname),
  });
  attachWebviewSecurity(window.webContents);
  attachDevToolsShortcut(window);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(resolveRendererHtml(app.getAppPath()));
  }
}

if (!process.env.VITEST) {
  app.whenReady().then(async () => {
    // userData 随应用名变化（dev 用 package.json name，打包用 productName），
    // 早期版本的数据留在旧目录；读不到时回退到 com.rxstudio.grenagent。
    const settings = new SettingsService(app.getPath('userData'), [
      join(app.getPath('appData'), 'com.rxstudio.grenagent'),
    ].filter((dir) => dir !== app.getPath('userData')));
    const dataPath = join(app.getPath('userData'), 'agent-data.db');
    let piRuntime: PiRuntimeService | undefined;
    let agentData: AgentDataService;
    const permissions = new PermissionManager({ dataDir: app.getPath('userData'), resolveProfile: (operation, requested) => {
      const workspace = typeof operation.workspace === 'string' ? operation.workspace : undefined;
      const args = isRecord(operation.args) ? operation.args : undefined;
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
      return workspace ? (piRuntime?.permissionProfile(workspace, sessionId) ?? requested) : requested;
    } });
    const sandbox = new SandboxManager({});
    const mcpConfig = new McpConfigService(app.getPath('home'), settings);
    const workspace = new WorkspaceService(process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent'));
    const worksDir = await workspace.getWorksDir();
    const runtimeConfigPath = join(app.getPath('userData'), 'runtime-settings.json');
    bootstrapRuntimeConfig(runtimeConfigPath);
    process.env.PI_WORKER_ENTRY = resolveWorkerEntry({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      mainDir: __dirname,
    });
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent');
    const modelRuntimeHost = new ModelRuntimeHost({
      create: async () => ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') }),
      resolveSettings: async () => {
        const defaults = SettingsManager.create(app.getPath('userData'), getAgentDir());
        return { provider: defaults.getDefaultProvider() ?? '', modelId: defaults.getDefaultModel() ?? '' };
      },
    });
    const systemWorker = new SystemWorkerManager({
      describeModel: () => modelRuntimeHost.describeModel(),
      complete: (input) => modelRuntimeHost.completeSimple(input),
    });
    const knownWorkspaces = new Set<string>();
    const codeGraph = new CodeGraphService({ listWorkspaces: () => [...knownWorkspaces] });
    const codeGraphJobs = new CodeGraphJobs(codeGraph, {
      start: (id) => agentData.request('admin.jobs.start', { id }),
      complete: (id) => agentData.request('admin.jobs.complete', { id }),
      fail: (id, error) => agentData.request('admin.jobs.fail', { id, error }),
      cancelled: (id) => agentData.request('admin.jobs.markCancelled', { id }),
      stage: (id, stage, processed, total) => agentData.recordJobStage(id, stage, processed, total),
    });
    const wikiCancelled = new Set<string>();
    const wikiSync = new WikiSyncService({
      jobs: {
        start: (id) => void agentData.request('admin.jobs.start', { id }),
        progress: (id, value) => void agentData.request('admin.jobs.progress', { id, value }),
        complete: (id) => agentData.request('admin.jobs.complete', { id }),
        fail: (id, error) => agentData.request('admin.jobs.fail', { id, error }),
        markCancelled: (id) => agentData.request('admin.jobs.markCancelled', { id }),
        cancelled: (id) => wikiCancelled.has(id),
      },
      scan: (workspace) => scanWorkspaceMarkdown(workspace),
      readSource: (workspace, path) => readWorkspaceSource(workspace, path),
      generate: (source, path, workspace, expectedModel) => agentData.runServiceTask({ id: `wiki-${randomUUID()}`, kind: 'wiki_page_generate', input: { workspace, sourcePath: path, source, ...(expectedModel ? { expectedModel } : {}) } }).then((value) => String(value)),
      readPage: (workspace, page) => agentData.requestAdmin('wiki.read', { workspace, page }),
      writePage: (input) => agentData.requestAdmin('wiki.replace', { ...input }),
      onSkip: (input) => agentData.recordWikiSyncSkip(input),
      onStage: (id, stage, processed, total) => agentData.recordJobStage(id, stage, processed, total),
    });
    agentData = new AgentDataService({
      dataPath,
      validateProject: (project) => validateProject(project, worksDir),
      resolveSession: (project, sessionId) => piRuntime?.ownsSession(project, sessionId) ?? false,
      wikiModelLabel: () => systemWorker.describeModel(),
      executeServiceTask: (task) => systemWorker.run({ id: task.id, kind: task.kind, input: task.input }),
      jobRunners: {
        'wiki.sync': {
          run: async (id, workspace, expectedModel) => { wikiCancelled.delete(id); await wikiSync.run(id, workspace, expectedModel); wikiCancelled.delete(id); },
          cancel: (id) => { wikiCancelled.add(id); },
        },
        'codegraph.sync': codeGraphJobs,
      },
      codeRetrieval: {
        projects: () => codeGraph.projects(),
        status: async (workspace) => ({ ...await codeGraph.status(workspace) }),
        search: async (workspace, query, limit) => ({ ...await codeGraph.search(workspace, query, limit) }),
        call: (workspace, tool, args) => codeGraph.call(workspace, tool, args),
      },
      methods: {
        'turn.start': (params) => piRuntime?.enqueueTurn(
          readRpcString(params, 'workspace'),
          readRpcString(params, 'input'),
          typeof params.permissionProfile === 'string' ? params.permissionProfile : 'workspace',
          {
            ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
            ...(typeof params.sessionPath === 'string' ? { sessionPath: params.sessionPath } : {}),
            ...(params.source === 'goal' ? { source: 'goal' as const } : { source: 'interactive' as const }),
          },
        ),
        'permission.authorize': (params) => {
          const operation = isRecord(params.operation) ? params.operation : {};
          return permissions.authorize(
            { ...operation, kind: typeof operation.kind === 'string' ? operation.kind : 'unknown' },
            typeof params.profile === 'string' ? params.profile : 'workspace',
          );
        },
        // pi 子进程会主动调这个 RPC 推送 MCP 连接状态。AppEvent 已移除，此处不再转发；
        // UI 的 MCP 状态由 pi://ui-request 的 setStatus 分支填充（见 ExtensionUiHost）。
        // 保留方法本身（返回 null）以免 pi 侧收到 "unknown method" 错误。
        'mcp.state.publish': () => null,
      },
    });
    await agentData.start();
    const pluginStorage = new AgentDataStorage(dataPath);
    pluginStorage.migrate();
    const plugins = new PluginManager({ storage: pluginStorage, apiVersion: '1' });
    plugins.discover(builtinPluginDefinitions());
    await plugins.startAll();
    const agentHost = new AgentHost({
      createHandle: async (workspace, cwd) => createWorkspaceHandle({
        workspace,
        cwd,
        modelRuntime: await modelRuntimeHost.ensure(),
        allowedExtensionsJson: JSON.stringify(plugins.allowedPluginIds()),
        resolveConfig: (origin) => piRuntime!.turnConfig(workspace, cwd, origin),
        emitUiRequest: (envelope) => {
          broadcastPiEvent('pi://ui-request', {
            workspace: envelope.workspace,
            request: envelope.request,
            ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
            source: envelope.source,
          });
        },
        onEvent: (event, meta) => {
          const envelope = piRuntime?.eventEnvelope(workspace, event, meta) ?? {
            workspace,
            event,
            source: meta.source,
            ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
            ...(meta.sessionPath ? { sessionPath: meta.sessionPath } : {}),
          };
          broadcastPiEvent('pi://event', envelope);
          void piRuntime?.handlePiEvent(workspace, event, meta).catch((error) => console.error('Pi event handling failed', error));
        },
        onFatal: (error) => {
          console.error('WorkspaceHandle fatal', error);
          void agentHost.close(workspace).catch(() => {});
          broadcastPiEvent('pi://exit', { workspace, code: 1 });
          void piRuntime?.handlePiExit(workspace, 1).catch(() => {});
        },
      }),
    });
    const enhancePrompt = createEnhancePrompt({
      host: modelRuntimeHost,
      agentHost,
      settings: () => settings.getAll(),
      agentData,
    });
    registerIpcHandlers({
      settings,
      mcpPolicy: new McpPolicyService(app.getPath('home'), {
        permissionManager: permissions,
      }),
      mcpConfig,
      subagent: new SubagentService(sandbox),
      files: new FileService(),
      skills: new SkillService(app.getPath('home')),
      usage: new UsageService(process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent')),
      pi: piRuntime = new PiRuntimeService({
        agentDir,
        runtimeConfigPath,
        agentHost,
        modelRuntimeHost,
        agentDataEndpoint: (cwd) => JSON.stringify(agentData.agentEndpoint(cwd)),
        resolveWorkspace: async (path) => {
          const resolved = await workspace.ensureWorkspace(path);
          knownWorkspaces.add(resolved);
          return resolved;
        },
        permissionManager: permissions,
        mcpConfig,
        allowedPluginIds: () => plugins.allowedPluginIds(),
        threadStore: agentData,
      }),
      provider: new ProviderService({
        agentDir: process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent'),
        probeModels: async () => {
          const runtime = await modelRuntimeHost.ensure();
          return JSON.stringify({ ok: true, models: collectModels(new ModelRegistry(runtime) as never) });
        },
        refresh: () => piRuntime!.refreshModelRegistry(),
        activeModel: async (workspace) => {
          const model = agentHost.get(workspace)?.session.model;
          if (!model) throw new Error(`workspace not open: ${workspace}`);
          return { provider: model.provider, modelId: model.id };
        },
        oneshot: (request, onLine, signal) => runHostOneshot(modelRuntimeHost, request, onLine, signal),
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
      enhancePrompt,
      permissions,
      plugins,
      // 开发者工作台的后端：打包产物里不注入 → dev_* 命令不注册，工作台读不到主进程信息。
      dev: app.isPackaged ? undefined : new DevService(),
    });
    workspace.setWorkspaceCloser(async (project) => {
      await piRuntime?.closeWorkspace(project);
      releaseSubagentControlPlane(project);
    });
    let shutdownStarted = false;
    let shutdownDone = false;
    app.on('before-quit', (event) => {
      if (shutdownDone) return;
      event.preventDefault();
      if (shutdownStarted) return;
      shutdownStarted = true;
      void (async () => {
        await Promise.allSettled([codeGraphJobs.close()]);
        systemWorker.close();
        await agentHost.closeAll();
        killAllSubagents();
        await agentData.stop();
        pluginStorage.close();
      })().catch((error) => console.error('Application shutdown failed', error)).finally(() => {
        shutdownDone = true;
        app.quit();
      });
    });
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}

function broadcastPiEvent(event: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(`${IPC_CHANNELS.eventPrefix}${event}`, payload);
  }
}

function readRpcString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
