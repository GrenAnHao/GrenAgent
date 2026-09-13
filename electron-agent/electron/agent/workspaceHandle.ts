import { runInWorkspace, type WorkspaceContext } from '../../../extensions/_shared/workspace-context.js';
import { drainByParent } from '../../../extensions/multi-agent/activation.js';
import { registerEmbeddedSubagentEventSink } from '../../../extensions/multi-agent/embedded-events.js';
import { registerParentSessionHost } from '../../../extensions/multi-agent/parent-host.js';
import { toJsonEvent } from '../../../cli/src/json-event.js';
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime, PromptOptions } from '../../../cli/src/pi-sdk.js';
import { SessionUiAdapter } from './sessionUiAdapter.js';

type TurnOrigin = 'main' | 'goal';
export type ImageContent = NonNullable<PromptOptions['images']>[number];

export interface HandleEventMeta { sessionId?: string; sessionPath?: string; source: 'interactive' | 'goal' | 'subagent' }

export interface WorkspaceHandleOptions {
  workspace: string;
  cwd: string;
  runtime: AgentSessionRuntime;
  /** 解析该 origin 的 per-(workspace, source) 配置进 ALS（第 2 份消费）。 */
  resolveConfig: (origin: TurnOrigin) => Promise<Readonly<Record<string, string>>>;
  emitUiRequest: (envelope: { workspace: string; source: 'interactive' | 'goal'; sessionId?: string; request: Record<string, unknown> }) => void;
  onEvent: (event: Record<string, unknown>, meta: HandleEventMeta) => void;
  /** 构造失败使 handle 损坏时调用（AgentHost 负责 evict + 广播 pi://exit）。 */
  onFatal: (error: unknown) => void;
  /** 关项目：MCP / IM（第 4 份再接 killSubagentsFor）。 */
  onDispose?: (workspace: string, cwd: string) => void | Promise<void>;
}

/** 把 SDK Model（常带 getter / 方法）收成可走 IPC 的纯字段，避免空会话 getState / 模型列表丢 provider/id / 档位映射。 */
export function snapshotSessionModel(model: unknown): Record<string, unknown> | null {
  if (!model || typeof model !== 'object') return null;
  const item = model as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : '';
  const provider = typeof item.provider === 'string' ? item.provider : '';
  if (!id || !provider) return null;
  const snap: Record<string, unknown> = { id, provider };
  if (typeof item.name === 'string') snap.name = item.name;
  if (typeof item.api === 'string') snap.api = item.api;
  if (typeof item.baseUrl === 'string') snap.baseUrl = item.baseUrl;
  if (typeof item.reasoning === 'boolean') snap.reasoning = item.reasoning;
  if (item.thinkingLevelMap && typeof item.thinkingLevelMap === 'object') {
    snap.thinkingLevelMap = { ...(item.thinkingLevelMap as Record<string, unknown>) };
  }
  return snap;
}

/**
 * 一个项目的交互 runtime。
 * runtime.session 可替换：new/switch/fork/reload 内部经 finishSessionReplacement 自动调
 * setRebindSession 注册的回调，宿主绝不自行二次 rebind（bindExtensions 无幂等保护）。
 * new/switch/fork/reload/prompt 全部包进 runInWorkspace，ALS 才能穿透构造期与回合。
 */
export class WorkspaceHandle {
  readonly ui: SessionUiAdapter;
  private unsubscribe: (() => void) | undefined;
  private unsubChildEvents: (() => void) | undefined;
  private disposed = false;
  private sessionInvalidated = false;
  private turnOrigin: TurnOrigin = 'main';
  private parentSessionPath: string | undefined;
  private unregisterParentHost: (() => void) | undefined;
  private switching = false;

  constructor(private readonly options: WorkspaceHandleOptions) {
    this.ui = new SessionUiAdapter({
      workspace: options.workspace,
      sessionId: () => this.session.sessionId,
      isGoalTurn: () => this.turnOrigin === 'goal',
      emit: options.emitUiRequest,
    });
  }

  get session(): AgentSession {
    return this.options.runtime.session;
  }

  get currentTurnOrigin(): TurnOrigin {
    return this.turnOrigin;
  }

  async start(): Promise<void> {
    // finishSessionReplacement 会 await 这个回调；直接 bindAndSubscribe，不要再包一层同步 rebind。
    this.options.runtime.setRebindSession(async () => { await this.bindAndSubscribe(); });
    this.options.runtime.setBeforeSessionInvalidate(() => { this.sessionInvalidated = true; });
    this.unsubChildEvents = registerEmbeddedSubagentEventSink((event, meta) => {
      if (this.disposed) return;
      if (meta.workspace !== this.options.workspace && meta.workspace !== this.options.cwd) return;
      let downgraded = event;
      try {
        downgraded = toJsonEvent(event as unknown as AgentSessionEvent) as unknown as Record<string, unknown>;
      } catch {
        /* already JSON-shaped */
      }
      this.options.onEvent(downgraded, {
        ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
        sessionPath: meta.sessionPath,
        source: 'subagent',
      });
    });
    await this.runMain(async () => { await this.bindAndSubscribe(); });
    this.registerCurrentParentHost();
  }

  async prompt(text: string, options: { images?: ImageContent[]; streamingBehavior?: 'steer' | 'followUp' }, origin: TurnOrigin): Promise<void> {
    const config = await this.options.resolveConfig(origin);
    this.turnOrigin = origin;
    return runInWorkspace(this.ctx(origin, config), () => new Promise<void>((resolve, reject) => {
      let settled = false;
      void this.session.prompt(text, {
        images: options.images,
        streamingBehavior: options.streamingBehavior,
        source: 'rpc',
        preflightResult: (ok: boolean) => { if (ok) { settled = true; resolve(); } },
      } as PromptOptions).catch((error: unknown) => {
        // preflight 前失败 → reject；preflight 成功后的回合内错误由事件流上报，吞掉。
        if (!settled) {
          this.turnOrigin = 'main';
          reject(error);
        }
      });
    }));
  }

  async newSession(options?: Parameters<AgentSessionRuntime['newSession']>[0]): Promise<{ cancelled: boolean }> {
    return this.replace(() => this.options.runtime.newSession(options));
  }

  async switchSession(sessionPath: string, options?: Parameters<AgentSessionRuntime['switchSession']>[1]): Promise<{ cancelled: boolean }> {
    return this.replace(() => this.options.runtime.switchSession(sessionPath, options));
  }

  async fork(entryId: string, options?: Parameters<AgentSessionRuntime['fork']>[1]): Promise<{ cancelled: boolean; selectedText?: string }> {
    return this.replace(() => this.options.runtime.fork(entryId, options));
  }

  async reload(): Promise<void> {
    await this.runMain(async () => {
      await this.session.waitForIdle();
      await this.session.reload();
    });
  }

  getState(): Record<string, unknown> {
    const s = this.session;
    return {
      model: snapshotSessionModel(s.model),
      thinkingLevel: s.thinkingLevel,
      isStreaming: s.isStreaming,
      isCompacting: s.isCompacting,
      steeringMode: s.steeringMode,
      followUpMode: s.followUpMode,
      sessionFile: s.sessionFile,
      sessionId: s.sessionId,
      sessionName: s.sessionName,
      autoCompactionEnabled: s.autoCompactionEnabled,
      messageCount: s.messages.length,
      pendingMessageCount: s.pendingMessageCount,
    };
  }

  getCommands(): { commands: Array<Record<string, unknown>> } {
    const commands: Array<Record<string, unknown>> = [];
    for (const c of this.session.extensionRunner.getRegisteredCommands()) {
      commands.push({ name: c.invocationName, description: c.description, source: 'extension', sourceInfo: c.sourceInfo });
    }
    for (const t of this.session.promptTemplates) {
      commands.push({ name: t.name, description: t.description, source: 'prompt', sourceInfo: t.sourceInfo });
    }
    for (const skill of this.session.resourceLoader.getSkills().skills) {
      commands.push({ name: `skill:${skill.name}`, description: skill.description, source: 'skill', sourceInfo: skill.sourceInfo });
    }
    return { commands };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.detachParentHost(this.parentSessionPath);
    this.ui.cancelAll();
    try { await this.session.abort(); } catch { /* 清理阶段 abort 失败不阻断 */ }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubChildEvents?.();
    this.unsubChildEvents = undefined;
    try { await this.options.runtime.dispose(); } catch { /* 同上 */ }
    try { await this.options.onDispose?.(this.options.workspace, this.options.cwd); } catch { /* 同上 */ }
  }

  private async replace<T>(action: () => Promise<T>): Promise<T> {
    this.ui.cancelAll();
    const previous = this.options.runtime.session;
    const oldPath = this.parentSessionPath;
    try {
      const result = await this.runMain(action);
      this.sessionInvalidated = false;
      if (this.options.runtime.session !== previous) {
        await this.detachParentHost(oldPath);
        this.registerCurrentParentHost();
      }
      return result;
    } catch (error) {
      const current = this.options.runtime.session;
      // 旧 session 已 teardown（原地 invalidate、引用已变或已空）才致命；fork 无效 id / 非法 jsonl / resolveConfig 失败时 session 仍在。
      if (this.sessionInvalidated || current !== previous || current == null) {
        this.options.onFatal(error);
        await this.detachParentHost(oldPath);
        this.registerCurrentParentHost();
      }
      throw error;
    }
  }

  private async detachParentHost(path: string | undefined): Promise<void> {
    this.switching = true;
    if (path) {
      try { await drainByParent(path); } catch { /* 换会话 / 拆除 drain 失败不阻断 */ }
    }
    this.unregisterParentHost?.();
    this.unregisterParentHost = undefined;
    this.parentSessionPath = undefined;
    this.switching = false;
  }

  private registerCurrentParentHost(): void {
    const session = this.session;
    if (!session) return;
    const sessionPath = session.sessionFile;
    const sessionId = session.sessionId;
    if (!sessionPath || !sessionId) return;
    this.parentSessionPath = sessionPath;
    this.unregisterParentHost = registerParentSessionHost({
      sessionId,
      sessionPath,
      workspace: this.options.workspace,
      isBusy: () => session.isStreaming,
      isDraining: () => this.disposed || this.switching,
      sendMessage: (msg, opts) => { void session.sendCustomMessage(msg, opts); },
      prompt: (text, delivery) => {
        void this.prompt(text, session.isStreaming ? { streamingBehavior: delivery } : {}, 'main');
      },
    });
  }

  private runMain<T>(fn: () => Promise<T>): Promise<T> {
    return this.resolveMainCtx().then((ctx) => runInWorkspace(ctx, fn));
  }

  private async resolveMainCtx(): Promise<WorkspaceContext> {
    return this.ctx('main', await this.options.resolveConfig('main'));
  }

  private ctx(origin: TurnOrigin, config: Readonly<Record<string, string>>): WorkspaceContext {
    return { origin, workspace: this.options.workspace, cwd: this.options.cwd, config };
  }

  private async bindAndSubscribe(): Promise<void> {
    await this.session.bindExtensions({
      uiContext: this.ui.context,
      mode: 'rpc',
      commandContextActions: {
        waitForIdle: () => this.session.waitForIdle(),
        newSession: (options) => this.newSession(options),
        fork: async (entryId, forkOptions) => ({ cancelled: (await this.fork(entryId, forkOptions)).cancelled }),
        navigateTree: (targetId, options) => this.session.navigateTree(targetId, options),
        switchSession: (sessionPath, options) => this.switchSession(sessionPath, options),
        reload: () => this.reload(),
      },
      shutdownHandler: () => {},
      onError: (err) => {
        this.forward({ type: 'extension_error', extensionPath: err.extensionPath, event: err.event, error: err.error });
      },
    });
    this.unsubscribe?.();
    this.unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
      if (this.disposed) return;
      let downgraded: Record<string, unknown>;
      try {
        downgraded = toJsonEvent(event) as unknown as Record<string, unknown>;
      } catch {
        return; // 畸形事件丢单条，不断流
      }
      this.forward(downgraded);
      if (downgraded.type === 'agent_end' && downgraded.willRetry !== true) this.turnOrigin = 'main';
    });
  }

  private forward(event: Record<string, unknown>): void {
    this.options.onEvent(event, {
      ...(this.session.sessionId ? { sessionId: this.session.sessionId } : {}),
      source: this.turnOrigin === 'goal' ? 'goal' : 'interactive',
    });
  }
}
