import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { browserWindowOptions, resolveAppIcon, resolveRendererHtml } from "./mainConfig";
import { WindowBackgroundStore } from "./app/windowBackground";
import { SettingsService } from "./app/settingsService";
import { McpPolicyService } from "./app/mcpPolicyService";
import { McpConfigService } from "./app/mcpConfigService";
import { SubagentService } from "./app/subagentService";
import { FileService } from "./app/fileService";
import { SkillService } from "./app/skillService";
import { PromptLibraryService } from "./app/promptLibraryService";
import { UsageService } from "./app/usageService";
import { PiRuntimeService } from "./app/piRuntimeService";
import { PiPackageService } from "./app/piPackageService";
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
import { attachEmbeddedWebview } from "./browser/attachEmbeddedWebview";
import { attachDevToolsShortcut } from "./devtoolsShortcut";
import { SandboxManager } from "./app/sandbox/sandboxManager";
import { AgentDataStorage } from "./agentData/storage";
import { PluginManager } from "./app/plugin/pluginManager";
import { builtinPluginDefinitions } from "./app/plugin/builtinPlugins";
import { SystemWorkerManager } from "./pi/systemWorkerManager";
import { CodeGraphService } from "./app/codeGraph/codeGraphService";
import { CodeGraphJobs } from "./app/codeGraph/codeGraphJobs";
import { validateProject } from "./app/validateProject";
import { bootstrapRuntimeConfig } from "./agent/runtimeConfigBootstrap";
import { resolveWorkerEntry } from "./agent/workerEntry";
import { subscribeSessionTitleWritten } from "../../extensions/auto-title/notify.js";
import { AgentHost } from "./agent/agentHost";
import { createWorkspaceHandle } from "./agent/createWorkspaceHandle";
import { ModelRuntimeHost } from "./agent/modelRuntimeHost";
import { agentDataModelOverride, applyAgentDataModel } from "./agentData/agentDataSettings";
import { getConfig, refreshConfig } from "../../extensions/_shared/runtime-config.js";
import { getAgentDir, ModelRegistry, ModelRuntime, SettingsManager } from "../../cli/src/pi-sdk.js";
import { installCursorProvider, registerCursorNativeProvider } from "../../cli/src/cursor/install.js";
import { collectModels } from "../../cli/src/probe-models.js";
import { runHostOneshot } from "./agent/hostOneshotAdapter";
import { killAllSubagents } from "../../extensions/multi-agent/subagentProcessRegistry.js";
import { releaseSubagentControlPlane } from "../../extensions/multi-agent/controlPlane.js";
import { startJobsBridge } from "./app/jobsBridge";
import { canSendTo, recordDroppedSend, recordEventSend, startRuntimeDiag } from "./runtimeDiag";
import { installFastRealpath } from "./fastRealpath";

/** backgroundColor：上次运行时按明暗记下的底色，没有就用 browserWindowOptions 的默认深色。 */
export function createWindow(backgroundColor?: string) {
  const window = new BrowserWindow({
    ...browserWindowOptions,
    ...(backgroundColor ? { backgroundColor } : {}),
    icon: resolveAppIcon(app.isPackaged, app.getAppPath(), __dirname),
  });
  attachEmbeddedWebview(window.webContents);
  attachDevToolsShortcut(window);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(resolveRendererHtml(app.getAppPath()));
  }
}

if (!process.env.VITEST) {
  installFastRealpath();
  app.whenReady().then(async () => {
    installCursorProvider();
    startRuntimeDiag();
    // userData 随应用名变化（dev 用 package.json name，打包用 productName），
    // 早期版本的数据留在旧目录；读不到时回退到 com.rxstudio.grenagent。
    const settings = new SettingsService(app.getPath('userData'), [
      join(app.getPath('appData'), 'com.rxstudio.grenagent'),
    ].filter((dir) => dir !== app.getPath('userData')));
    const dataPath = join(app.getPath('userData'), 'agent-data.db');
    const windowBackground = new WindowBackgroundStore(app.getPath('userData'));
    let piRuntime: PiRuntimeService | undefined;
    let agentHost: AgentHost | undefined;
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
      create: async () => {
        const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') });
        registerCursorNativeProvider((provider) => runtime.registerNativeProvider(provider));
        return runtime;
      },
      resolveSettings: async () => {
        const defaults = SettingsManager.create(app.getPath('userData'), getAgentDir());
        return { provider: defaults.getDefaultProvider() ?? '', modelId: defaults.getDefaultModel() ?? '' };
      },
    });
    const agentDataModelRaw = () => {
      refreshConfig();
      return getConfig('agentDataModel');
    };
    const completeAgentData = (input: { user: string; systemPrompt?: string; maxTokens?: number; signal?: AbortSignal; onUsage?: (report: { model: string; usage: unknown }) => void }) =>
      modelRuntimeHost.completeSimple(applyAgentDataModel(input, agentDataModelRaw()));
    const systemWorker = new SystemWorkerManager({
      describeModel: async () => {
        const model = agentDataModelOverride(agentDataModelRaw());
        return model ? `${model.provider}/${model.modelId}` : modelRuntimeHost.describeModel();
      },
      complete: (input) => completeAgentData(input),
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
    agentData = new AgentDataService({
      dataPath,
      validateProject: (project) => validateProject(project, worksDir),
      resolveSession: (project, sessionId) => piRuntime?.ownsSession(project, sessionId) ?? false,
      completeSimple: (input) => completeAgentData(input),
      executeServiceTask: (task, hooks) => systemWorker.run({ id: task.id, kind: task.kind, input: task.input }, hooks),
      jobRunners: {
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
        // pi 子进程推送 MCP 连接状态。转成 setStatus('mcp')，面板才能看到 exposure、auth 和 loginUrl。
        // 扩展发的是 ctx.cwd；面板按 AgentStore workspace 读。对上活 handle 就改成 handle.workspace。
        'mcp.state.publish': (params) => {
          const published = typeof params.workspace === 'string' ? params.workspace : '';
          const workspace = agentHost?.workspaceForCwd(published) ?? published;
          const servers = Array.isArray(params.servers) ? params.servers : [];
          broadcastPiEvent('pi://ui-request', {
            workspace,
            source: 'interactive',
            request: {
              id: 'mcp-state',
              method: 'setStatus',
              statusKey: 'mcp',
              statusText: JSON.stringify(servers),
            },
          });
          return null;
        },
      },
    });
    await agentData.start();
    const pluginStorage = new AgentDataStorage(dataPath);
    pluginStorage.migrate();
    const plugins = new PluginManager({ storage: pluginStorage, apiVersion: '1' });
    plugins.discover(builtinPluginDefinitions());
    await plugins.startAll();
    const piPackages = new PiPackageService({
      agentDir,
      allowedPluginIds: () => plugins.allowedPluginIds(),
    });
    agentHost = new AgentHost({
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
            ...(envelope.sessionPath ? { sessionPath: envelope.sessionPath } : {}),
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
        onFatal: (error, handle) => {
          console.error('WorkspaceHandle fatal', error);
          let sessionId: string | undefined;
          let sessionPath: string | undefined;
          try {
            const id = handle?.session?.sessionId;
            if (typeof id === 'string' && id) sessionId = id;
            const file = handle?.session?.sessionFile;
            if (typeof file === 'string' && file) sessionPath = file;
          } catch { /* 会话已经拆掉 */ }
          const task = handle ? agentHost.evict(workspace, handle) : agentHost.close(workspace);
          void task.catch(() => {});
          broadcastPiEvent('pi://exit', {
            workspace,
            code: 1,
            ...(sessionId ? { sessionId } : {}),
            ...(sessionPath ? { sessionPath } : {}),
          });
          void piRuntime?.handlePiExit(workspace, 1, sessionId ? { sessionId, source: 'interactive' } : undefined).catch(() => {});
        },
      }),
    });
    const enhancePrompt = createEnhancePrompt({
      host: modelRuntimeHost,
      agentHost,
      settings: () => settings.getAll(),
      agentData,
    });
    // 后台 bash job（含前台超时转后台的）的实时输出推给界面。
    const jobsBridge = startJobsBridge((event, payload) => broadcastPiEvent(event, payload), {
      workspaceForCwd: (cwd) => agentHost.workspaceForCwd(cwd) ?? cwd,
    });
    registerIpcHandlers({
      settings,
      jobs: jobsBridge,
      mcpPolicy: new McpPolicyService(app.getPath('home'), {
        permissionManager: permissions,
      }),
      mcpConfig,
      subagent: new SubagentService(sandbox),
      files: new FileService(),
      skills: new SkillService(app.getPath('home')),
      promptLibrary: new PromptLibraryService(agentDir),
      piPackages,
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
      windowBackground,
      // 开发者工作台的后端：打包产物里不注入 → dev_* 命令不注册，工作台读不到主进程信息。
      dev: app.isPackaged ? undefined : new DevService(),
    });
    workspace.setWorkspaceCloser(async (project) => {
      await piRuntime?.closeWorkspace(project);
      releaseSubagentControlPlane(project);
    });
    let shutdownStarted = false;
    let shutdownDone = false;
    // 会话已被替换时，auto-title 把标题写进原 jsonl，不会再走当前 pi 的 session_info_changed。
    // 补一次同名事件，侧栏会重读会话列表。workspace 留空，避免被当成当前画面上的会话事件。
    const stopAutoTitleNotice = subscribeSessionTitleWritten(() => {
      broadcastPiEvent('pi://event', {
        workspace: '',
        event: { type: 'session_info_changed' },
        source: 'interactive',
      });
    });
    app.on('before-quit', (event) => {
      if (shutdownDone) return;
      event.preventDefault();
      if (shutdownStarted) return;
      shutdownStarted = true;
      stopAutoTitleNotice();
      jobsBridge.stop();
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
    createWindow(windowBackground.read());
  });
  app.on("window-all-closed", () => app.quit());
}

function broadcastPiEvent(event: string, payload: unknown): void {
  const source = (payload as { source?: unknown } | null)?.source;
  for (const window of BrowserWindow.getAllWindows()) {
    // 渲染进程崩了或正在重载时帧已销毁，send 会为每条事件打一整段堆栈。子代理流式事件一秒几百条，
    // 日志本身就会压垮主线程和控制台。跳过并计数，诊断日志里看 droppedSends。
    if (!canSendTo(window.webContents)) {
      recordDroppedSend();
      continue;
    }
    window.webContents.send(`${IPC_CHANNELS.eventPrefix}${event}`, payload);
    recordEventSend(typeof source === 'string' ? `${event}:${source}` : event);
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
