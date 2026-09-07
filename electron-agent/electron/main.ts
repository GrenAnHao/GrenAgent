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
import { DevService } from "./app/devService";
import { registerIpcHandlers } from "./ipc/register";
import { IPC_CHANNELS } from "./ipc/contracts";
import { PiManager } from "./pi/manager";
import { resolvePiPackageDir, resolvePiProcess } from "./runtimePaths";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
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
import { GoalCoordinator } from "./app/goalCoordinator";
import { judgeGoal } from "./app/goalJudge";

export function createWindow() {
  const window = new BrowserWindow(browserWindowOptions);
  attachWebviewSecurity(window.webContents);
  attachDevToolsShortcut(window);
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, "../dist/index.html"));
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
    let goalCoordinator: GoalCoordinator | undefined;
    let agentData: AgentDataService;
    const permissions = new PermissionManager({ dataDir: app.getPath('userData'), resolveProfile: (operation, requested) => {
      const workspace = typeof operation.workspace === 'string' ? operation.workspace : undefined;
      const args = isRecord(operation.args) ? operation.args : undefined;
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
      const source = args?.source === 'goal' ? 'goal' : 'interactive';
      return workspace && source !== 'goal' ? (piRuntime?.permissionProfile(workspace, sessionId) ?? requested) : requested;
    } });
    const sandbox = new SandboxManager({});
    const mcpConfig = new McpConfigService(app.getPath('home'), settings);
    const workspace = new WorkspaceService(process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent'));
    const worksDir = await workspace.getWorksDir();
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
        'permission.authorize': (params) => permissions.authorize(
          isRecord(params.operation) ? params.operation : {},
          typeof params.profile === 'string' ? params.profile : 'workspace',
        ),
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
    const pi = new PiManager(
      piProcess,
      {
        onEvent: (workspace, event, metadata) => {
          // 先转发渲染层、后落盘：流式 UI 的实时性优先于持久化。
          // handlePiEvent 内部会走 node:sqlite 的同步写，若放在前面会阻塞主进程事件循环，
          // 把本帧的 webContents.send 延后，表现为思考/正文「卡住直到整段返回才突然出现」。
          const envelope = piRuntime?.eventEnvelope(workspace, event, metadata) ?? {
            workspace,
            event,
            ...(metadata?.sessionId ? { sessionId: metadata.sessionId } : {}),
            source: metadata?.source ?? 'interactive',
          };
          broadcastPiEvent('pi://event', envelope);
          void piRuntime?.handlePiEvent(workspace, event, metadata).catch((error) => console.error('Pi event handling failed', error));
        },
        onUiRequest: (workspace, request, metadata) => {
          // Automatic Goal workers must never surface interactive prompts in
          // the visible session; their turn will fail closed if they cannot
          // proceed without user input.
          if (metadata?.source === 'goal') {
            const requestId = typeof request.id === 'string' ? request.id : '';
            void piRuntime?.rejectUiRequest(workspace, metadata, requestId).catch((error) => console.error('Goal UI rejection failed', error));
            return;
          }
          broadcastPiEvent('pi://ui-request', {
          workspace,
          request,
          ...(metadata?.sessionId ? { sessionId: metadata.sessionId } : {}),
          ...(metadata?.source ? { source: metadata.source } : {}),
          });
        },
        onExit: (workspace, code, metadata) => {
          broadcastPiEvent('pi://exit', {
            workspace,
            code,
            ...(metadata?.sessionId ? { sessionId: metadata.sessionId } : {}),
            ...(metadata?.source ? { source: metadata.source } : {}),
          });
          void piRuntime?.handlePiExit(workspace, code, metadata).catch((error) => console.error('Pi exit handling failed', error));
        },
        onLog: (message) => console.error(message),
      },
      { sandbox },
    );
    registerIpcHandlers({
      settings,
      mcpPolicy: new McpPolicyService(app.getPath('home'), {
        piCommand: piProcess,
        piPackageDir: resolvePiPackageDir({ appPath: app.getAppPath(), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }),
        permissionManager: permissions,
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
        agentDataEndpoint: (cwd) => JSON.stringify(agentData.agentEndpoint(cwd)),
        migrateLegacyGoal: ({ workspace, sessionId, condition, react, paused, legacyEntryTimestamp }) => agentData.requestAdmin('admin.goal.recoverLegacy', {
          workspace,
          sessionId,
          condition,
          react,
          paused,
          ...(legacyEntryTimestamp === undefined ? {} : { legacyEntryTimestamp }),
        }).then(() => undefined),
        resolveWorkspace: async (path) => {
          const resolved = await workspace.ensureWorkspace(path);
          knownWorkspaces.add(resolved);
          return resolved;
        },
        permissionManager: permissions,
        mcpConfig,
        allowedPluginIds: () => plugins.allowedPluginIds(),
        threadStore: agentData,
        onTurnSettled: (result) => {
          if (!result.goal || !result.sessionId) return;
          return goalCoordinator?.onTurnCompleted({
            workspace: result.workspace,
            sessionId: result.sessionId,
            ...(result.sessionPath ? { sessionPath: result.sessionPath } : {}),
            turnId: result.turnId,
            status: result.status,
            summary: result.summary,
            goal: result.goal,
          });
        },
        bindGoalSession: (project, sessionId, source) => agentData.bindGoalSession(project, sessionId, source).then(() => undefined),
        unbindGoalSession: (project, sessionId) => agentData.unbindGoalSession(project, sessionId).then(() => undefined),
        onSessionForked: async ({ workspace, sourceSessionId, targetSessionId }) => {
          const source = await agentData.goalGet(sourceSessionId, workspace);
          if (!source) return;
          // A cleared source is forked as a tombstone rather than skipped: the
          // copied JSONL still carries the old legacy Goal entry, and without a
          // tombstone the later legacy migration would resurrect it.
          await agentData.requestAdmin('admin.goal.fork', {
            sourceSessionId,
            sourceGoalId: source.goalId,
            targetSessionId,
          });
        },
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
      // 开发者工作台的后端：打包产物里不注入 → dev_* 命令不注册，工作台读不到主进程信息。
      dev: app.isPackaged ? undefined : new DevService(),
    });
    goalCoordinator = new GoalCoordinator({
      data: {
        get: (sessionId) => agentData.goalGet(sessionId, ''),
        update: (input) => agentData.requestAdmin('admin.goal.update', input),
        claimRound: (input) => agentData.goalClaimRound(input),
        settleRound: (input) => agentData.goalSettleRound(input),
        cancelRound: (input) => agentData.goalCancelRound(input),
        judgeResult: (input) => agentData.requestAdmin('admin.goal.judgeResult', { ...input, origin: 'system' }),
        runtimeError: (input) => agentData.goalRuntimeError(input),
      },
      worker: {
        enqueueGoalTurn: (input) => piRuntime!.enqueueGoalTurn(input),
        closeGoalWorker: (sessionId, workspace) => piRuntime!.closeGoalWorker(sessionId, workspace),
      },
      judge: {
        judge: (input) => judgeGoal({
          run: (task) => agentData.runServiceTask({ id: task.id, kind: task.kind, input: task.input, capabilities: ['llm_completion'] }),
        }, input),
      },
      onGoalChanged: (snapshot) => broadcastPiEvent('goal://status', {
        schemaVersion: 1,
        workspace: snapshot.workspace,
        sessionId: snapshot.sessionId,
        snapshot,
      }),
    });
    agentData.onGoalEvent((event, snapshot) => {
      if (snapshot) return goalCoordinator?.onGoalChanged(snapshot, event);
    });
    workspace.setWorkspaceCloser(async (project) => {
      await goalCoordinator?.onWorkspaceDeleted(project);
      await piRuntime?.closeWorkspace(project);
    });
    let shutdownStarted = false;
    let shutdownDone = false;
    app.on('before-quit', (event) => {
      if (shutdownDone) return;
      event.preventDefault();
      if (shutdownStarted) return;
      shutdownStarted = true;
      void (async () => {
        await goalCoordinator?.stop();
        await Promise.allSettled([pi.closeAll(), codeGraphJobs.close()]);
        systemWorker.close();
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

function readRpcString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
