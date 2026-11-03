import { app, BrowserWindow, nativeImage, Notification } from "electron";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { APP_NAV_EVENT, BROWSER_OPEN_URL_EVENT, forwardAppCommands, guardMainWindowNavigation } from "./mainWindowNavigation";
import { browserWindowOptions, resolveAppIcon, resolveRendererHtml } from "./mainConfig";
import { WindowBackgroundStore } from "./app/windowBackground";
import { SettingsService } from "./app/settingsService";
import { McpPolicyService } from "./app/mcpPolicyService";
import { McpConfigService } from "./app/mcpConfigService";
import { FileService } from "./app/fileService";
import { SkillService } from "./app/skillService";
import { PromptLibraryService } from "./app/promptLibraryService";
import { PiPackageService } from "./app/piPackageService";
import { ProviderService } from "./app/providerService";
import { WorkspaceService } from "./app/workspaceService";
import { RepoWikiService, isTrustedRepoWikiSender } from "./app/repoWikiService";
import { createRepoWikiKnowledgeModelResolver } from "./app/repoWikiKnowledgeModel";
import { createNativeWikiModelBridge, type NativeWikiBridge } from "./app/nativeWikiModel";
import { generateSessionTitle } from "./app/sessionTitle";
import { UiHistoryService } from "./app/uiHistoryService";
import { WorkspaceApprovalService } from "./app/workspaceApprovalService";
import { GitService } from "./app/gitService";
import { DEFAULT_ISOLATED_LIMIT, DEFAULT_ISOLATED_RECLAIM_DAYS, IsolatedWorkspaceService } from "./app/isolatedWorkspaceService";
import { isolatedPathParts } from "../../extensions/_shared/isolated-workspace.js";
import { TerminalService } from "./app/terminalService";
import { CreateService } from "./app/createService";
import { TempHtmlService } from "./app/tempHtmlService";
import { ShellService } from "./app/shellService";
import { AgentDataService } from "./app/agentDataService";
import { PermissionManager } from "./app/permissionManager";
import { DevService } from "./app/devService";
import { createEnhancePrompt } from "./app/enhancePrompt";
import { AttentionService } from "./app/attentionService";
import { registerCommand, registerIpcHandlers } from "./ipc/register";
import { IPC_CHANNELS } from "./ipc/contracts";
import { attachEmbeddedWebview } from "./browser/attachEmbeddedWebview";
import { attachDevToolsShortcut } from "./devtoolsShortcut";
import { SandboxManager } from "./app/sandbox/sandboxManager";
import { PluginManager } from "./app/plugin/pluginManager";
import { builtinPluginDefinitions } from "./app/plugin/builtinPlugins";
import { assembleAgentData, type AgentDataMainMethods } from "./agentDataProcess/assemble";
import { createCodeGraphClient } from "./agentDataProcess/codeGraphClient";
import type { CodeGraphSyncEvent } from "./app/codeGraph/hostContract";
import { AGENTDATA_DIAG_CHANNEL, AGENTDATA_MODEL_USAGE_CHANNEL, type AgentDataHostConfig, type AgentDataHostMethod } from "./agentDataProcess/contract";
import type { MethodHandler } from "./agentProcess/rpcPeer";
import { bootstrapRuntimeConfig } from "./agent/runtimeConfigBootstrap";
import { resolveAgentDataHostEntry, resolveAgentHostEntry, resolveCodeGraphHostEntry, resolveCodeGraphWorkerEntry, resolveJobGuardExe, resolveRepoWikiHostEntry, resolveWorkerEntry } from "./agent/workerEntry";
import { agentDataPipePath } from "./agentDataProcess/pipePath";
import { ModelRuntimeHost } from "./agent/modelRuntimeHost";
import { createAgentDataModelPort } from "./agentData/createAgentDataModelPort";
import { KnowledgeMessageBroker } from "./agent/knowledgeModelTurn";
import type { KnowledgeMessageInput, RepoWikiKnowledgeSnapshot } from "../shared/knowledgeKernelContracts";
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
export function createWindow(backgroundColor?: string): BrowserWindow {
  const window = new BrowserWindow({
    ...browserWindowOptions,
    ...(backgroundColor ? { backgroundColor } : {}),
    icon: resolveAppIcon(app.isPackaged, app.getAppPath(), __dirname),
  });
  attachEmbeddedWebview(window.webContents);
  attachDevToolsShortcut(window);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  // 主窗口不能被链接导航走、不自己弹新窗：网页链接转给渲染进程在内置浏览器里开。
  forwardAppCommands(window, (direction) => window.webContents.send(`${IPC_CHANNELS.eventPrefix}${APP_NAV_EVENT}`, { direction }));
  guardMainWindowNavigation(window.webContents, {
    appUrl: rendererUrl ?? pathToFileURL(resolveRendererHtml(app.getAppPath())).href,
    openInApp: (url) =>
      window.webContents.send(`${IPC_CHANNELS.eventPrefix}${BROWSER_OPEN_URL_EVENT}`, { url, disposition: 'foreground-tab' }),
  });

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(resolveRendererHtml(app.getAppPath()));
  }
  return window;
}

if (!process.env.VITEST) {
  installFastRealpath();
  app.whenReady().then(async () => {
    startRuntimeDiag();
    // Windows 上系统通知按 AppUserModelId 归属。打包后和 electron-builder.yml 的 appId 一致；开发态没有快捷方式，用 exe 路径。
    if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.rxstudio.grenagent' : process.execPath);
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
      publish: (workspace, servers) => publishMcpState(workspace, servers),
    });
    const workspace = new WorkspaceService(process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent'));
    // 独立工作区上限由设置页决定，每次创建现读。
    const isolatedWorkspace = new IsolatedWorkspaceService({
      limit: async () => Number((await settings.getAll()).isolatedWorkspaceLimit ?? DEFAULT_ISOLATED_LIMIT),
    });
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
    const knowledgeModel = createAgentDataModelPort(modelRuntimeHost, agentDataModelRaw, async () => {
      try { return await readFile(join(agentDir, 'models.json'), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    });
    const completeAgentData = knowledgeModel.complete;
    const describeAgentDataModel = knowledgeModel.describe;
    const entryInput = { packaged: app.isPackaged, resourcesPath: process.resourcesPath, mainDir: __dirname };
    const jobGuardExe = resolveJobGuardExe(entryInput);
    const codeGraphEntries = {
      hostEntry: resolveCodeGraphHostEntry(entryInput),
      workerEntry: resolveCodeGraphWorkerEntry(entryInput),
      jobGuardExe,
      execPath: process.execPath,
    };
    // 必须留在主进程的 socket 方法（审批 UI、渲染层广播、问 agent-host）。child 模式下由 agentdata-host 经反向 RPC 调回来。
    let bindRepoWiki!: (service: RepoWikiService) => void;
    const repoWikiReady = new Promise<RepoWikiService>((resolve) => { bindRepoWiki = resolve; });
    let repoWikiInstance: RepoWikiService | undefined;
    let nativeWikiInstance: NativeWikiBridge | undefined;
    let nativeWikiDrain: Promise<void> = Promise.resolve();
    let knowledgeEpoch: string | undefined, knowledgeEpochActive = false;
    let releaseKnowledgeEpoch!: () => void;
    let knowledgeEpochReady = new Promise<void>((resolve) => { releaseKnowledgeEpoch = resolve; });
    const legacyKnowledgeProviders = new Map<string, { epoch?: string; abort: AbortController; settled: Promise<void> }>();
    const knowledgeBroker = new KnowledgeMessageBroker({
      bind: (taskId) => knowledgeModel.bindKnowledgeModel(taskId),
      request: (binding, transcript, options) => knowledgeModel.requestKnowledgeMessage(binding, transcript, options),
      drainWorkers: async (oldEpoch) => {
        const old = [...legacyKnowledgeProviders.values()].filter(entry => entry.epoch !== knowledgeEpoch);
        for (const entry of old) entry.abort.abort();
        await Promise.allSettled(old.map(entry => entry.settled));
        await (await repoWikiReady).drainKnowledgeWorker(oldEpoch);
      },
    });
    const waitKnowledgeEpoch = async (epoch: string, signal: AbortSignal) => {
      while (!knowledgeEpochActive) {
        if (signal.aborted) throw new Error('aborted');
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new Error('aborted'));
          signal.addEventListener('abort', abort, { once: true });
          void knowledgeEpochReady.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
        if (knowledgeEpoch && knowledgeEpoch !== epoch) throw new Error('STALE_EPOCH');
      }
      if (knowledgeEpoch !== epoch) throw new Error('STALE_EPOCH');
    };
    const mainMethods: AgentDataMainMethods = {
      'knowledge.bindEpoch': async (params) => {
        knowledgeEpochActive = false; knowledgeEpoch = readRpcString(params, 'epoch');
        repoWikiInstance?.setKnowledgeEpoch(knowledgeEpoch);
        releaseKnowledgeEpoch(); knowledgeEpochReady = new Promise<void>(resolve => { releaseKnowledgeEpoch = resolve; });
        await nativeWikiDrain;
        return knowledgeBroker.bindEpoch(knowledgeEpoch);
      },
      'knowledge.activateEpoch': (params) => { const epoch = readRpcString(params, 'epoch'); knowledgeBroker.activateEpoch(epoch); nativeWikiInstance?.activateModelDispatch(); knowledgeEpochActive = true; releaseKnowledgeEpoch(); return null; },
      'knowledge.bindModel': (params) => knowledgeBroker.bind(readRpcString(params, 'taskId')),
      'knowledge.message': (params) => knowledgeBroker.request(params.input as KnowledgeMessageInput),
      'knowledge.abort': (params) => knowledgeBroker.abortRequest(readRpcString(params, 'requestId')),
      'knowledge.ackUsage': (params) => knowledgeBroker.ackUsage(readRpcString(params, 'requestId')),
      'knowledge.worker': async (params) => (await repoWikiReady).invokeKnowledgeWorker(readRpcString(params, 'method'), isRecord(params.input) ? params.input : {}),
      'knowledge.changed': async (params) => (await repoWikiReady).publishKnowledgeSnapshot(params.snapshot as RepoWikiKnowledgeSnapshot),
      'repoWiki.run': async (params) => (await repoWikiReady).runTask(params as unknown as Parameters<RepoWikiService['runTask']>[0]),
      'repoWiki.cancel': async (params) => (await repoWikiReady).cancelTask({ id: readRpcString(params, 'id'), ...(params.pause === true ? { pause: true } : {}) }),
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
        publishMcpState(workspace, Array.isArray(params.servers) ? params.servers : []);
        return null;
      },
    };
    // AgentData 运行在哪里：child（默认）= agentdata-host 子进程，agent-data.db 、记忆 / Wiki 任务、CodeGraph 都在那里；
    // inproc = 原来的主进程内，只作退路（GREN_AGENTDATA_PROCESS=inproc）。
    let inprocAgentData: ReturnType<typeof assembleAgentData> | undefined;
    if (process.env.GREN_AGENTDATA_PROCESS === 'inproc') {
      const knownWorkspaces = new Set<string>();
      let reportBreaker: (event: CodeGraphSyncEvent) => void = () => {};
      inprocAgentData = assembleAgentData({
        knowledgeKernelVersion: 1,
        dataPath,
        model: { describe: describeAgentDataModel, complete: (input) => completeAgentData(input) },
        codeGraph: createCodeGraphClient({
          ...codeGraphEntries,
          listWorkspaces: () => [...knownWorkspaces],
          diag: recordDiagEvent,
          statePath: join(dirname(dataPath), 'codegraph-state.json'),
          onBreaker: (event) => reportBreaker(event),
        }),
        resolveSession: (project, sessionId) => agent.pi.ownsSession(project, sessionId),
        methods: mainMethods,
      });
      const assembled = inprocAgentData;
      reportBreaker = (event) => assembled.runtime.recordCodegraphBreaker(event);
      agentData = new AgentDataService({ runtime: assembled.runtime, onKnownWorkspace: (path) => knownWorkspaces.add(path) });
    } else {
      // 模型短调用留在主进程（auth.json / OAuth 在这里）。子进程的 abort 按 requestId 找到对应的 AbortController。
      const modelCalls = new Map<string, AbortController>();
      let agentDataProcess: AgentProcessClient | undefined;
      const hostMethods: Record<AgentDataHostMethod, MethodHandler> = {
        'main.model.describe': () => describeAgentDataModel(),
        'main.model.complete': async (p) => {
          const requestId = readRpcString(p, 'requestId');
          const controller = new AbortController();
          modelCalls.set(requestId, controller);
          let settled!: () => void;
          try {
            if (typeof p.controllerEpoch === 'string') await waitKnowledgeEpoch(p.controllerEpoch, controller.signal);
            legacyKnowledgeProviders.set(requestId, { epoch: typeof p.controllerEpoch === 'string' ? p.controllerEpoch : undefined,
              abort: controller, settled: new Promise<void>(resolve => { settled = resolve; }) });
            const input = isRecord(p.input) ? p.input as { user: string; systemPrompt?: string; maxTokens?: number } : { user: '' };
            return await completeAgentData({
              ...input,
              signal: controller.signal,
              ...(p.withUsage === true ? { onUsage: (report: { model: string; usage: unknown }) => agentDataProcess?.emit(AGENTDATA_MODEL_USAGE_CHANNEL, { requestId, report }) } : {}),
            });
          } finally {
            settled?.(); legacyKnowledgeProviders.delete(requestId);
            modelCalls.delete(requestId);
          }
        },
        'main.model.abort': (p) => { modelCalls.get(readRpcString(p, 'requestId'))?.abort(); return null; },
        'main.resolveSession': (p) => agent.pi.ownsSession(readRpcString(p, 'workspace'), readRpcString(p, 'sessionId')),
        'main.method': (p) => {
          const name = readRpcString(p, 'name') as keyof AgentDataMainMethods;
          const method = mainMethods[name];
          if (!method) throw new Error(`unknown main method: ${name}`);
          return method(isRecord(p.params) ? p.params : {});
        },
      };
      agentData = new AgentDataService({
        mode: 'child',
        listenPath: agentDataPipePath(),
        createProcess: (launchState, hooks) => (agentDataProcess = new AgentProcessClient({
          entry: resolveAgentDataHostEntry(entryInput),
          guard: (pid) => startJobGuard(pid, { exePath: jobGuardExe }),
          onSweep: (summary, exit) => recordDiagEvent({ kind: 'agentdata-host-sweep', summary, expected: exit.expected }),
          execPath: process.execPath,
          env: () => ({
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            AGENTDATA_HOST_CONFIG: JSON.stringify({ ...launchState(), dataPath, codeGraph: codeGraphEntries, knowledgeKernelVersion: 1 } satisfies AgentDataHostConfig),
          }),
          hostMethods,
          onEvent: (channel, payload) => {
            if (channel === AGENTDATA_DIAG_CHANNEL && isRecord(payload) && typeof payload.kind === 'string') recordDiagEvent(payload as { kind: string });
          },
          onExit: (exit) => {
            recordDiagEvent({ kind: 'agentdata-host-exit', code: exit.code, signal: exit.signal, expected: exit.expected, ...(exit.fatal ? { fatal: exit.fatal } : {}), stderrTail: exit.stderrTail.slice(-4_000) });
            nativeWikiDrain = nativeWikiInstance?.abortAndDrain() ?? Promise.resolve();
            for (const controller of modelCalls.values()) controller.abort();
            modelCalls.clear();
            hooks.onExit(exit);
          },
          log: (stream, line) => (stream === 'stderr' ? console.error : console.log)(`[agentdata-host] ${line}`),
          readyTimeoutMs: 60_000,
          shutdownTimeoutMs: 15_000,
        })),
      });
    }
    await agentData.start();
    const plugins = new PluginManager({
      state: { initial: await agentData.loadPluginStates(), save: (record) => agentData.savePluginState(record) },
      apiVersion: '1',
    });
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
          agentData.registerKnownWorkspace(resolved);
          return resolved;
        },
        agentDataEndpoint: async (cwd) => JSON.stringify(await agentData.agentEndpoint(cwd)),
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
    const nativeWiki = createNativeWikiModelBridge({
      model: knowledgeModel,
      gate: {
        admit: async (operation, signal) => {
          if (signal.aborted) throw signal.reason ?? new Error('aborted');
          const project = await (await repoWikiReady).invokeKnowledgeWorker('project.read', { projectId: operation.projectId, domain: 'wiki' }) as { root: string; scope: string; key: { branch: string; language: string } };
          const pathKey = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
          if (pathKey(project.root) !== pathKey(operation.repositoryRoot) || project.key.branch !== operation.branch || project.key.language !== operation.locale) throw new Error('NATIVE_SCOPE_MISMATCH');
          if (signal.aborted) throw signal.reason ?? new Error('aborted');
          const result = await agentData.requestAdmin<{ leaseId: string }>('admin.native.admit', { operation, scope: project.scope });
          if (signal.aborted) { await agentData.requestAdmin('admin.native.release', { operation, leaseId: result.leaseId }); throw signal.reason ?? new Error('aborted'); }
          return result.leaseId;
        },
        release: async (operation, leaseId) => { await agentData.requestAdmin('admin.native.release', { operation, leaseId }); },
        project: async operation => { await agentData.requestAdmin('admin.native.project', { operation }); },
        dispatched: async (operation, requestId) => { await (await repoWikiReady).recordNativeDispatch(operation, requestId); },
        stage: async (eventId, operationId, stage, detail) => { await agentData.requestAdmin('admin.native.stage', { eventId, operationId, stage, detail }); },
        recover: async operation => { await agentData.requestAdmin('admin.native.recover', { operation }); },
        withSlot: async (requestId, work, signal) => {
          if (signal.aborted) throw signal.reason ?? new Error('aborted');
          const cancel = () => { void agentData.requestAdmin('admin.native.slotCancel', { requestId }).catch(() => undefined); };
          signal.addEventListener('abort', cancel, { once: true });
          let acquired = false;
          try {
            await agentData.requestAdmin('admin.native.slotAcquire', { requestId }); acquired = true;
            if (signal.aborted) throw signal.reason ?? new Error('aborted');
            return await work();
          } finally {
            signal.removeEventListener('abort', cancel);
            if (acquired) await agentData.requestAdmin('admin.native.slotRelease', { requestId });
          }
        },
      },
    });
    nativeWikiInstance = nativeWiki;
    let mainWindow: BrowserWindow | undefined;
    const repoWiki = new RepoWikiService({
      entry: resolveRepoWikiHostEntry(entryInput),
      dataDir: join(app.getPath('userData'), 'repo-wiki'),
      registerCommand: (name, handler) => registerCommand(name, (event, args) => handler({
        sender: event.sender, senderFrame: event.senderFrame ?? undefined,
      }, args)),
      isTrustedSender: (event) => isTrustedRepoWikiSender(event, {
        window: mainWindow,
        appUrl: process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(resolveRendererHtml(app.getAppPath())).href,
        windowForSender: (sender) => BrowserWindow.fromWebContents(sender),
      }),
      // Host-maintained project records grant access; renderer arguments do not.
      allowedWorkspaces: () => workspace.readProjectSnapshot(),
      projectSnapshot: () => workspace.getProjectSnapshot(),
      isConversationWorkspaceSnapshot: (cwd) => workspace.isConversationWorkspaceSnapshot(cwd),
      isConversationWorkspace: (cwd) => workspace.isConversationWorkspace(cwd),
      resolveModel: createRepoWikiKnowledgeModelResolver(agentData, knowledgeModel.configurationIdentity),
      native: nativeWiki,
      tasks: agentData,
      knowledge: agentData,
      onError: (error) => console.error('RepoWiki configuration refresh failed', error),
    });
    repoWikiInstance = repoWiki;
    if (knowledgeEpoch) repoWiki.setKnowledgeEpoch(knowledgeEpoch);
    bindRepoWiki(repoWiki);
    const stopRepoWikiProjectSubscription = workspace.subscribeProjectsChanged(() => {
      void repoWiki.onHostProjectsChanged().catch((error) => console.error('RepoWiki project refresh failed', error));
    });
    // Metadata-only background prime. The renderer can display its existing host
    // project snapshot before this completes; no project directories are visited.
    void repoWiki.onHostProjectsChanged().catch((error) => console.error('RepoWiki project snapshot failed', error));
    const attention = new AttentionService({
      window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined),
      readSettings: () => settings.getAll(),
      createNotification: (options) => (Notification.isSupported() ? new Notification(options) : undefined),
      createImage: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
      setBadgeCount: (count) => {
        app.setBadgeCount(count);
      },
      send: (event, payload) => broadcastPiEvent(event, payload),
      platform: process.platform,
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
      usage: agent.usage,
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
          await repoWiki.refreshConfiguration();
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
      workspaceProjectsChanged: () => repoWiki.refreshConfiguration(),
      // 短调用走主进程那份 ModelRuntime；标题模型每次现读设置。
      sessionTitle: {
        generate: (sessionPath) => generateSessionTitle(sessionPath, {
          complete: (input) => modelRuntimeHost.completeSimple(input),
          titleModel: () => {
            refreshConfig();
            return getConfig('titleModel');
          },
        }),
      },
      uiHistory: new UiHistoryService((path) => workspace.ensureWorkspace(path)),
      workspaceApproval: new WorkspaceApprovalService(app.getPath('userData')),
      git: new GitService(),
      isolatedWorkspace,
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
      attention,
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
        stopRepoWikiProjectSubscription();
        // agent-host 收尾时扩展还会经 AgentData 记账（记忆、回合状态），必须先于 agentData.stop。
        await agentProcess?.shutdown();
        await repoWiki.drainNative();
        // child 模式：agentdata-host 自己先停 CodeGraph 同步与模型任务、再关库；inproc 模式在这里做同样的事。
        await inprocAgentData?.close();
        await agentData.stop();
        await repoWiki.stop();
      })().catch((error) => console.error('Application shutdown failed', error)).finally(() => {
        shutdownDone = true;
        app.quit();
      });
    });
    // 启动时回收久未使用、已回传且干净的独立工作区。此刻还没有任何会话打开，所以在开窗口之前跑完；
    // 未到期的只看文件时间、不跑 git，通常是毫秒级。
    await reclaimIsolatedWorkspaces(settings, workspace, isolatedWorkspace)
      .catch((error) => console.error('Isolated workspace reclaim failed', error));
    // 子进程加载 pi SDK 和全部扩展要一两秒，和窗口加载并行。
    void agentProcess.start().catch((error) => console.error('agent-host failed to start', error));
    mainWindow = createWindow(windowBackground.read());
    attention.attachWindow(mainWindow);
  });
  app.on("window-all-closed", () => app.quit());
}

async function reclaimIsolatedWorkspaces(
  settings: SettingsService,
  workspace: WorkspaceService,
  isolated: IsolatedWorkspaceService,
): Promise<void> {
  const raw = (await settings.getAll()).isolatedWorkspaceReclaimDays;
  const days = raw === undefined || raw === '' ? DEFAULT_ISOLATED_RECLAIM_DAYS : Number(raw);
  if (!(days > 0)) return;
  const projects = (await workspace.listProjects()).filter((project) => !isolatedPathParts(project));
  const removed = await isolated.reclaim(projects, { maxAgeDays: days });
  if (removed.length) console.info('Reclaimed isolated workspaces', removed);
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

/** 把一个工作区的 MCP 状态推给设置页。会话扩展的订阅推送和「重载」的回报都走这里。 */
function publishMcpState(workspace: string, servers: unknown[]): void {
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
}

function readRpcString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
