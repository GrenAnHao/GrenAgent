import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { browserWindowOptions, resolveAppIcon, resolveRendererHtml } from "./mainConfig";
import { WindowBackgroundStore } from "./app/windowBackground";
import { SettingsService } from "./app/settingsService";
import { McpPolicyService } from "./app/mcpPolicyService";
import { McpConfigService } from "./app/mcpConfigService";
import { FileService } from "./app/fileService";
import { SkillService } from "./app/skillService";
import { PromptLibraryService } from "./app/promptLibraryService";
import { UsageService } from "./app/usageService";
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
import { CodeGraphHostClient } from "./app/codeGraph/codeGraphHostClient";
import { CodeGraphJobs } from "./app/codeGraph/codeGraphJobs";
import { validateProject } from "./app/validateProject";
import { bootstrapRuntimeConfig } from "./agent/runtimeConfigBootstrap";
import { resolveAgentHostEntry, resolveCodeGraphHostEntry, resolveCodeGraphWorkerEntry, resolveJobGuardExe, resolveWorkerEntry } from "./agent/workerEntry";
import { ModelRuntimeHost } from "./agent/modelRuntimeHost";
import { agentDataModelOverride, applyAgentDataModel } from "./agentData/agentDataSettings";
import { getConfig, refreshConfig } from "../../extensions/_shared/runtime-config.js";
import { getAgentDir, ModelRegistry, ModelRuntime, SettingsManager } from "../../cli/src/pi-sdk.js";
import { collectModels } from "../../cli/src/probe-models.js";
import { runHostOneshot } from "./agent/hostOneshotAdapter";
import { canSendTo, recordDiagEvent, recordDroppedSend, recordEventSend, startRuntimeDiag } from "./runtimeDiag";
import { installFastRealpath } from "./fastRealpath";
import { mergeRuntimeSettingsFile } from "./app/settingsService";
import { AgentProcessClient } from "./agentProcess/agentProcessClient";
import { BROADCAST_CHANNEL, DIAG_CHANNEL, type BroadcastPayload } from "./agentProcess/contract";
import { createAgentPorts, createHostMethods } from "./agentProcess/mainBindings";
import { startJobGuard } from "./agentProcess/jobGuard";

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
    startRuntimeDiag();
    // userData 随应用名变化（dev 用 package.json name，打包用 productName），
    // 早期版本的数据留在旧目录；读不到时回退到 com.rxstudio.grenagent。
    const settings = new SettingsService(app.getPath('userData'), [
      join(app.getPath('appData'), 'com.rxstudio.grenagent'),
    ].filter((dir) => dir !== app.getPath('userData')));
    const dataPath = join(app.getPath('userData'), 'agent-data.db');
    const windowBackground = new WindowBackgroundStore(app.getPath('userData'));
    let agentData: AgentDataService;
    // 交互运行时在 agent-host 子进程里。这里的调用都经 RPC 转发；子进程按需拉起。
    let agentProcess: AgentProcessClient | undefined;
    const agent = createAgentPorts({
      request: (method, params) => {
        if (!agentProcess) return Promise.reject(new Error('AGENT_HOST_NOT_READY'));
        return agentProcess.request(method, params);
      },
      isRunning: () => agentProcess?.isRunning ?? false,
    });
    const permissions = new PermissionManager({ dataDir: app.getPath('userData'), resolveProfile: async (operation, requested) => {
      const workspace = typeof operation.workspace === 'string' ? operation.workspace : undefined;
      const args = isRecord(operation.args) ? operation.args : undefined;
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
      if (!workspace) return requested;
      return (await agent.pi.permissionProfile(workspace, sessionId).catch(() => undefined)) ?? requested;
    } });
    const sandbox = new SandboxManager({});
    const mcpConfig = new McpConfigService(app.getPath('home'), settings, {
      // 配置已经落盘；子进程暂时不在时它下次启动会读到新配置，这里只记下，不让保存失败。
      hotReload: (workspace, runtimeJson) => agent.mcp.hotReload(workspace, runtimeJson)
        .catch((error) => console.error('MCP hot reload failed', error)),
      reload: (workspace, name) => agent.mcp.reload(workspace, name),
    });
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
      create: () => ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') }),
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
    const entryInput = { packaged: app.isPackaged, resourcesPath: process.resourcesPath, mainDir: __dirname };
    const jobGuardExe = resolveJobGuardExe(entryInput);
    // CodeGraph 的索引与查询在 codegraph-host 子进程里跑：SDK 的写库与引用解析是同步的，放在主进程会把窗口卡住几十秒。
    // 按需拉起（第一次查询或同步时），崩了下一条请求再拉起，连续崩溃时冷却；不带 V8 参数（字节码入口）。
    const codeGraph = new CodeGraphHostClient({
      listWorkspaces: () => [...knownWorkspaces],
      createProcess: (onEvent) => new AgentProcessClient({
        entry: resolveCodeGraphHostEntry(entryInput),
        guard: (pid) => startJobGuard(pid, { exePath: jobGuardExe }),
        execPath: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEGRAPH_WORKER_ENTRY: resolveCodeGraphWorkerEntry(entryInput) },
        hostMethods: {},
        onEvent,
        onExit: (exit) => recordDiagEvent({ kind: 'codegraph-host-exit', code: exit.code, signal: exit.signal, expected: exit.expected, stderrTail: exit.stderrTail.slice(-4_000) }),
        log: (stream, line) => (stream === 'stderr' ? console.error : console.log)(`[codegraph-host] ${line}`),
        readyTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000,
      }),
      onDiag: (sample) => recordDiagEvent({ kind: 'codegraph-host-sample', ...sample }),
    });
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
      resolveSession: (project, sessionId) => agent.pi.ownsSession(project, sessionId).catch(() => false),
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
        'turn.start': (params) => agent.pi.enqueueTurn(
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
        // agent-host 子进程里的 MCP 扩展推送连接状态。转成 setStatus('mcp')，面板才能看到 exposure、auth 和 loginUrl。
        // 扩展发的是 ctx.cwd；面板按 AgentStore workspace 读。对上活 handle 就改成 handle.workspace（向子进程查）。
        'mcp.state.publish': async (params) => {
          const published = typeof params.workspace === 'string' ? params.workspace : '';
          const workspace = published ? await agent.mcp.workspaceForCwd(published).catch(() => published) : published;
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
      extensions: () => agent.extensions.catalog(),
      requestReload: () => agent.resources.reload(),
    });
    agentProcess = new AgentProcessClient({
      entry: resolveAgentHostEntry(entryInput),
      // 子进程崩溃（或主进程崩溃）时，它拉起的 MCP 服务器、bash、子代理留下的子孙进程由守卫清掉。
      guard: (pid) => startJobGuard(pid, { exePath: jobGuardExe }),
      onSweep: (summary, exit) => recordDiagEvent({ kind: 'agent-host-sweep', summary, expected: exit.expected }),
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // 不带任何 V8 参数：字节码缓存里记着编译时的 V8 参数指纹，参数不同整份缓存被拒，子进程起不来。
      // RunAsNode 的默认老生代上限按物理内存算（16GB 以上的机器就是 4096MB），不需要再调。
      hostMethods: createHostMethods({
        resolveWorkspace: async (path) => {
          const resolved = await workspace.ensureWorkspace(path);
          knownWorkspaces.add(resolved);
          return resolved;
        },
        agentDataEndpoint: (cwd) => JSON.stringify(agentData.agentEndpoint(cwd)),
        mcpRuntime: (target) => mcpConfig.runtime(target),
        allowedPluginIds: () => plugins.allowedPluginIds(),
        authorize: (operation, profile) => permissions.authorize(operation, profile),
        // 主进程的 SettingsService 也写这份文件；同一把锁在这个进程里。
        mergeRuntimeSettings: (patch) => mergeRuntimeSettingsFile(runtimeConfigPath, patch),
        thread: {
          createThread: (input) => agentData.createThread(input),
          createTurn: (input) => agentData.createTurn(input),
          updateTurn: (id, patch) => agentData.updateTurn(id, patch),
          upsertItem: (item) => agentData.upsertItem(item),
        },
      }),
      onEvent: (channel, payload) => {
        if (channel === DIAG_CHANNEL) {
          recordDiagEvent({ kind: 'agent-host-sample', ...(payload as Record<string, unknown>) });
          return;
        }
        if (channel !== BROADCAST_CHANNEL) return;
        const message = payload as BroadcastPayload;
        if (typeof message?.channel === 'string') broadcastPiEvent(message.channel, message.payload);
      },
      onExit: (exit) => {
        recordDiagEvent({
          kind: 'agent-host-exit',
          code: exit.code,
          signal: exit.signal,
          expected: exit.expected,
          ...(exit.fatal ? { fatal: exit.fatal } : {}),
          stderrTail: exit.stderrTail.slice(-4096),
        });
        if (exit.expected) return;
        console.error('agent-host exited unexpectedly', exit.code, exit.signal, exit.fatal ?? exit.stderrTail.slice(-2000));
        // 运行时整个没了：每个打开过的工作区发一条不带会话的 pi://exit，渲染层把这个项目的运行态全部熄灭。
        for (const target of agent.tracker.drain()) {
          broadcastPiEvent('pi://exit', { workspace: target, code: exit.code ?? 1, source: 'interactive' });
        }
      },
    });
    const enhancePrompt = createEnhancePrompt({
      host: modelRuntimeHost,
      activeModel: (target) => agent.pi.activeModel(target),
      settings: () => settings.getAll(),
      agentData,
    });
    registerIpcHandlers({
      settings,
      // 后台 bash job 的实时输出由子进程经 pi://jobs 推送；这里只有快照和停止。
      jobs: agent.jobs,
      mcpPolicy: new McpPolicyService(app.getPath('home'), {
        permissionManager: permissions,
        probe: (configJson) => agent.mcp.probe(configJson),
      }),
      mcpConfig,
      subagent: agent.subagent,
      files: new FileService(),
      skills: new SkillService(app.getPath('home')),
      promptLibrary: new PromptLibraryService(agentDir),
      piPackages,
      usage: new UsageService(process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent')),
      pi: agent.pi,
      provider: new ProviderService({
        agentDir: process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent'),
        probeModels: async () => {
          const runtime = await modelRuntimeHost.ensure();
          const models = collectModels(new ModelRegistry(runtime) as never);
          return JSON.stringify({ ok: true, models });
        },
        // 主进程的短调用和子进程里的会话各持一份 ModelRuntime，两边都要重读。
        refresh: async () => {
          await modelRuntimeHost.refresh();
          return agent.pi.refreshModelRegistry();
        },
        activeModel: async (target) => {
          const model = await agent.pi.activeModel(target);
          if (!model) throw new Error(`workspace not open: ${target}`);
          return model;
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
      await agent.pi.closeWorkspace(project);
      await agent.controlPlane.release(project);
    });
    // 删会话前先停掉并摘下持有它的 handle，否则还在跑的会话会把文件写回来。
    workspace.setSessionReleaser((paths) => agent.pi.releaseSessions(paths));
    workspace.setSubagentControl(agent.controlPlane);
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
        // 子进程收尾时扩展还会经 AgentData 记账（记忆、回合状态），必须先于 agentData.stop。
        await agentProcess?.shutdown();
        await agentData.stop();
        pluginStorage.close();
      })().catch((error) => console.error('Application shutdown failed', error)).finally(() => {
        shutdownDone = true;
        app.quit();
      });
    });
    // 子进程加载 pi SDK 和全部扩展要一两秒，和窗口加载并行。
    void agentProcess.start().catch((error) => console.error('agent-host failed to start', error));
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
