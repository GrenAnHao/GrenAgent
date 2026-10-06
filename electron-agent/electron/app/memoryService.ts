import { randomUUID } from 'node:crypto';
import type { L1Record } from '../agent/memoryExtraction';
import { parseMemoryExtraction } from '../agent/memoryExtraction';
import { stripTrailingNewlines } from '../agent/memoryPrompts';
import type { MemoryRecord, MemoryScope, MemoryStore } from '../agentData/memoryStore';
import type { ManagedMemoryRecord, MemoryConversation, MemoryConversationDetail, MemoryCreateInput, MemoryDraft, MemoryListInput, MemoryPage, MemoryReadInput, MemoryUpdateInput } from '../agentData/memoryContracts';
import { RpcError } from '../agentData/protocol';

import { memoryDedupOutput } from './appServer/serviceTaskRegistry';
import type { ServiceTask } from './appServer/types';
import { applyDedupDecisions, recallCandidates } from './memoryDedup';
import { buildExtractionWindow } from './memoryExtractionWindow';
import {
  applyPersonaDecision,
  applySceneDecisions,
  DEFAULT_MAX_SCENES,
  listGlobalLevel,
  PERSONA_SOURCE,
  parseMemoryPersona,
  parseMemoryScene,
  sceneFilenameFromSource,
  sceneSummary,
  type ParsedMemoryScene,
} from './memoryLayers';
import { computeFireAt, L2_DELAY_MS, L2_MIN_INTERVAL_MS, LAYER_SCENE_KIND } from './memoryLayerSchedule';

export interface MemorySearchScope extends MemoryScope { projectId: string; query: string; limit?: number }
export interface MemoryCaptureInput extends MemoryScope { projectId: string; source: string; transcript: string; fingerprint: string; extract?: boolean }
/**
 * extraction：主进程怎么处理了这次捕获。queued = 已入队（taskId 有值）；skipped = 新增内容里没有可抽取的
 * 对话文本，游标已直接提交；deferred = 按抽取节奏延后。有值时扩展不再走本地兜底抽取。
 */
export interface MemoryCaptureResult { changed: boolean; delta: string; fingerprint: string; taskId?: string; extraction?: 'queued' | 'skipped' | 'deferred' }
export interface MemoryTaskQueue {
  enqueue(input: { id: string; kind: string; input: unknown; sourceProjectId?: string; sourceSessionId?: string; system?: boolean }): Promise<ServiceTask>;
  get?(id: string): ServiceTask | undefined;
  findPending?(kind: string, matches: (task: ServiceTask) => boolean): ServiceTask | undefined;
}
export interface LayerScheduleOptions {
  delayMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
}
/** 上游 pipeline-manager.ts 的 L1 节奏。默认值来自上游 config.ts:586-588。 */
export interface ExtractCadenceOptions {
  /** everyNConversations：累计多少轮抽一次。默认 5。 */
  everyN?: number;
  /** enableWarmup：新会话阈值 1→2→4→…→everyN。默认 true。 */
  warmup?: boolean;
  /** l1IdleTimeoutSeconds：没到阈值时，空闲多久补抽。默认 600_000 ms。 */
  idleMs?: number;
  /** 启动后多久补抽上次没抽完的来源（上游在关闭时冲掉，Pi 退出时等不了模型）。默认 60_000 ms。 */
  recoverDelayMs?: number;
  setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
}
type CaptureSource = Omit<MemoryCaptureInput, 'transcript' | 'fingerprint' | 'extract'>;
interface CadenceState { count: number; threshold: number; source: CaptureSource; timer?: { cancel: () => void } }
export interface MemoryServiceOptions {
  store: MemoryStore;
  queue: MemoryTaskQueue;
  validateProject?: (projectId: string) => Promise<string>;
  extractMode?: 'work' | 'chat';
  layerSchedule?: LayerScheduleOptions;
  extractCadence?: ExtractCadenceOptions;
}
interface PendingCapture { scope: MemoryScope; source: string; fingerprint: string; delta: string }
interface PendingDedup {
  capture: PendingCapture;
  records: Map<string, L1Record>;
  candidateIds: Set<string>;
}
interface PendingLayer {
  scope: MemoryScope;
  source: string;
}

export class MemoryService {
  private readonly pending = new Map<string, PendingCapture>();
  private readonly pendingDedup = new Map<string, PendingDedup>();
  private readonly pendingScene = new Map<string, PendingLayer>();
  private readonly pendingPersona = new Map<string, PendingLayer>();
  private readonly finishing = new Set<string>();
  private readonly timers = new Map<string, { cancel: () => void }>();
  private readonly cadence = new Map<string, CadenceState>();
  private recoverTimer?: { cancel: () => void };
  /**
   * 用户开关 MEMORY_EXTRACT 主进程读不到，只能从扩展每次 memory.capture 带的 extract 标志得知。
   * 取最近一次非 internal.force 的 capture 的取值；undefined = 本进程还没见过，这时不做任何补抽。
   */
  private extractObserved: boolean | undefined;
  /** recoverPendingCaptures 登记过、还没执行的补抽请求。开关关着时保留，重新打开后才挂计时器。 */
  private recoverRequested = false;
  private disposed = false;
  constructor(private readonly options: MemoryServiceOptions) {}

  private now(): number {
    return this.options.layerSchedule?.now?.() ?? Date.now();
  }

  private delayMs(): number {
    return this.options.layerSchedule?.delayMs ?? L2_DELAY_MS;
  }

  private minIntervalMs(): number {
    return this.options.layerSchedule?.minIntervalMs ?? L2_MIN_INTERVAL_MS;
  }

  private immediateLayers(): boolean {
    return this.delayMs() === 0 && this.minIntervalMs() === 0;
  }

  private everyN(): number { return Math.max(1, this.options.extractCadence?.everyN ?? 5); }
  private warmup(): boolean { return this.options.extractCadence?.warmup ?? true; }
  private idleMs(): number { return this.options.extractCadence?.idleMs ?? 600_000; }

  private setCadenceTimer(callback: () => void, ms: number): { cancel: () => void } {
    const setTimer = this.options.extractCadence?.setTimer ?? ((cb, wait) => {
      const handle = setTimeout(cb, wait);
      // 10 分钟的空闲补抽不该拖住进程退出。
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    });
    return setTimer(callback, ms);
  }

  private cadenceState(input: CaptureSource): CadenceState {
    const key = sourceKey(input);
    let state = this.cadence.get(key);
    if (!state) {
      state = { count: 0, threshold: this.warmup() ? 1 : this.everyN(), source: captureSource(input) };
      this.cadence.set(key, state);
    }
    state.source = captureSource(input);
    return state;
  }

  /** 真正入队抽取时调用：计数清零、取消空闲计时、预热阈值翻倍直到 everyN（上游每次 L1 成功后翻倍，这里在入队时翻倍）。 */
  private consumeCadence(state: CadenceState): void {
    this.resetCount(state);
    state.threshold = Math.min(state.threshold * 2, this.everyN());
  }

  /** 没入队就不推进预热：只清零计数、取消空闲计时。 */
  private resetCount(state: CadenceState): void {
    state.count = 0;
    state.timer?.cancel();
    state.timer = undefined;
  }

  private armIdle(state: CadenceState): void {
    if (this.disposed) return;
    state.timer?.cancel();
    state.timer = this.setCadenceTimer(() => {
      state.timer = undefined;
      void this.flushSource(state.source);
    }, this.idleMs());
  }

  /** 空闲计时和启动补抽共用：按存储里的 pending 强制入队一次。开关没被确认开着（或已关闭）时什么都不做。 */
  private async flushSource(source: CaptureSource): Promise<void> {
    if (this.disposed || this.extractObserved !== true) return;
    try {
      const next = this.options.store.pendingCapture(source, source.source);
      if (!next) return;
      await this.capture({ ...source, transcript: next.transcript, fingerprint: next.fingerprint }, { force: true });
    } catch (error) {
      // 不重试：pending 保留到下一轮对话或下次启动。
      warnRecoverFailed(error);
    }
  }

  /** 记录最近一次 capture 带来的开关状态。开关是全局的：关了就取消所有来源的空闲计时和补抽计时。 */
  private observeExtract(enabled: boolean): void {
    this.extractObserved = enabled;
    if (enabled) {
      this.armRecover();
      return;
    }
    for (const state of this.cadence.values()) {
      state.timer?.cancel();
      state.timer = undefined;
    }
    // 只取消计时器，recoverRequested 保留：开关重新打开后还要补抽。
    this.recoverTimer?.cancel();
    this.recoverTimer = undefined;
  }

  /** 登记启动补抽。主进程不知道开关状态，等第一次开着开关的 capture 出现后才真正挂计时器。 */
  recoverPendingCaptures(): void {
    if (this.disposed) return;
    this.recoverRequested = true;
    this.armRecover();
  }

  private armRecover(): void {
    if (this.disposed || !this.recoverRequested || this.recoverTimer || this.extractObserved !== true) return;
    this.recoverTimer = this.setCadenceTimer(() => {
      this.recoverTimer = undefined;
      this.recoverRequested = false;
      void (async () => {
        try {
          for (const row of this.options.store.listPendingCaptures()) {
            await this.flushSource({ ...row, projectId: row.projectId ?? row.workspace });
          }
        } catch (error) {
          // 库已关闭等：下次启动再补。
          warnRecoverFailed(error);
        }
      })();
    }, this.options.extractCadence?.recoverDelayMs ?? 60_000);
  }

  search(scope: MemorySearchScope): Promise<MemoryRecord[]> {
    return Promise.resolve(this.options.store.search(scope, scope.query, scope.limit));
  }

  async list(input: MemoryListInput): Promise<MemoryPage<ManagedMemoryRecord>> {
    return this.options.store.list(input);
  }

  async read(input: MemoryReadInput): Promise<ManagedMemoryRecord> {
    return this.options.store.read(input);
  }

  async listConversations(input: MemoryListInput): Promise<MemoryPage<MemoryConversation>> {
    return this.options.store.listConversations(input);
  }

  async readConversation(input: MemoryReadInput): Promise<MemoryConversationDetail> {
    return this.options.store.readConversation(input);
  }

  async create(input: MemoryCreateInput): Promise<ManagedMemoryRecord> {
    return this.options.store.create({ ...input, draft: await this.validateOwner(input.draft) });
  }

  async update(input: MemoryUpdateInput): Promise<ManagedMemoryRecord> {
    const current = this.options.store.read(input);
    const owner = input.draft?.owner;
    // Historical owners may no longer exist. Only a new project binding needs
    // filesystem validation; the store checks revision again after this await.
    const draft = owner?.scope === 'project' && (current.scope !== 'project' || current.sourceProjectId !== owner.projectId)
      ? await this.validateOwner(input.draft) : input.draft;
    return this.options.store.update({ ...input, draft });
  }

  private async validateOwner(draft: MemoryDraft): Promise<MemoryDraft> {
    if (draft?.owner?.scope !== 'project') return draft;
    if (!this.options.validateProject || typeof draft.owner.projectId !== 'string' || !draft.owner.projectId.trim()) throw new RpcError('INVALID_PARAMS', 'invalid memory project');
    try {
      const projectId = await this.options.validateProject(draft.owner.projectId);
      if (typeof projectId !== 'string' || !projectId.trim()) throw new Error();
      return { ...draft, owner: { scope: 'project', projectId } };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const safeMessages = ['PROJECT_REQUIRED', 'PROJECT_NOT_DIRECTORY', 'TEMPORARY_PROJECT_NOT_ALLOWED', 'project directory not available'];
      throw new RpcError('INVALID_PARAMS', safeMessages.includes(message) ? message : 'invalid memory project');
    }
  }

  /** internal.force 只给空闲计时、启动补抽、finishCapture 内部使用，RPC 不会传第二个参数。 */
  async capture(input: MemoryCaptureInput, internal: { force?: boolean } = {}): Promise<MemoryCaptureResult> {
    if (!internal.force) this.observeExtract(input.extract !== false);
    const captured = this.options.store.capture(input, input.source, input.transcript, input.fingerprint);
    if (!captured.changed || !captured.delta) return captured;
    if (input.extract === false) {
      this.options.store.commitCapture(input, input.source, input.fingerprint);
      return captured;
    }
    const state = this.cadenceState(input);
    // 一次 agent_end 算一轮（上游 conversation_count）。任务进行中到来的轮数也计入，finishCapture 时据此决定接着抽还是等空闲。
    if (!internal.force) state.count += 1;
    const active = [...this.pending].find(([, value]) => sameSource(value.scope, value.source, input));
    if (active) return { ...captured, taskId: active[0], extraction: 'queued' };
    const queued = this.options.queue.findPending?.('memory_extract', (task) => {
      const value = this.captureFromTask(task.id, task);
      return !this.finishing.has(task.id) && value !== undefined && sameSource(value.scope, value.source, input);
    });
    if (queued) {
      this.pending.set(queued.id, this.captureFromTask(queued.id, queued)!);
      return { ...captured, taskId: queued.id, extraction: 'queued' };
    }
    if (!internal.force && state.count < state.threshold) {
      this.armIdle(state);
      return { ...captured, extraction: 'deferred' };
    }
    const scope = { ...input, scope: 'project' as const };
    const extractionWindow = buildExtractionWindow(captured.delta, () => captureBackground(this.options.store, scope, input.source, captured.delta));
    if (extractionWindow.newMessages.length === 0) {
      this.options.store.commitCapture(scope, input.source, input.fingerprint, captured.delta);
      // 没入队就不翻倍预热阈值，只把这一批清掉。
      this.resetCount(state);
      return { ...captured, extraction: 'skipped' };
    }
    this.consumeCadence(state);
    const taskId = randomUUID();
    this.pending.set(taskId, { scope, source: input.source, fingerprint: input.fingerprint, delta: captured.delta });
    try {
      void this.options.queue.enqueue({
        id: taskId,
        kind: 'memory_extract',
        input: {
          // delta 只是游标：captureFromTask / commitCapture 用它做前缀比对。它含工具输出，Input 行不会带上它。
          delta: captured.delta,
          newMessages: extractionWindow.newMessages,
          backgroundMessages: extractionWindow.backgroundMessages,
          previousSceneName: latestSceneName(this.options.store, scope),
          mode: this.options.extractMode ?? 'work',
          source: input.source,
          fingerprint: input.fingerprint,
          userId: input.userId,
          projectId: input.projectId,
          workspace: input.workspace,
          sessionId: input.sessionId,
        },
        sourceProjectId: input.projectId,
        sourceSessionId: input.sessionId,
        system: true,
      }).then((task) => {
        // Queues with a terminal callback may already have settled this task.
        if (this.pending.has(taskId)) this.taskSettled(task);
      }).catch(() => { if (this.pending.has(taskId)) this.finishCapture(taskId); });
    } catch (error) {
      this.pending.delete(taskId);
      throw error;
    }
    return { ...captured, taskId, extraction: 'queued' };
  }

  completeExtraction(taskId: string, output: unknown): MemoryRecord[] {
    const extractTaskId = taskId;
    const capture = this.pending.get(extractTaskId) ?? this.captureFromTask(extractTaskId);
    if (!capture) throw new Error('memory capture task not found');
    const extraction = parseMemoryExtraction(output, this.options.extractMode ?? 'work');
    const l1 = extraction.l1 ?? [];
    const withCandidates = l1.filter((record) => recallCandidates(this.options.store, capture.scope, record.content, 5)
      .some((hit) => hit.level === 1));
    if (withCandidates.length > 0) {
      const dedupTaskId = randomUUID();
      const records = new Map(l1.map((record, index) => [`r${index}`, record]));
      const matches = [...records].map(([record_id, record]) => ({
        newMemory: { record_id, ...record },
        candidates: recallCandidates(this.options.store, capture.scope, record.content, 5)
          .filter((hit) => hit.level === 1)
          .map((hit) => storedL1Candidate(hit)),
      }));
      this.pendingDedup.set(dedupTaskId, {
        capture, records,
        candidateIds: new Set(matches.flatMap((match) => match.candidates.map((candidate) => candidate.id))),
      });
      void this.options.queue.enqueue({
        id: dedupTaskId,
        kind: 'memory_deduplicate',
        input: { matches, mode: this.options.extractMode ?? 'work' },
        sourceProjectId: capture.scope.projectId ?? capture.scope.workspace,
        sourceSessionId: capture.scope.sessionId,
        system: true,
      }).catch(() => { this.pendingDedup.delete(dedupTaskId); });
      this.finishCapture(extractTaskId);
      return [];
    }
    const writes: MemoryRecord[] = [];
    for (const record of l1) {
      writes.push(this.options.store.upsert(capture.scope, { level: 1, content: JSON.stringify(record), source: capture.source }));
    }
    this.options.store.commitCapture(capture.scope, capture.source, capture.fingerprint, capture.delta);
    this.finishCapture(extractTaskId);
    this.scheduleScene(capture.scope, capture.source, l1);
    return writes;
  }

  completeDedup(taskId: string, output: unknown): MemoryRecord[] {
    const pending = this.pendingDedup.get(taskId);
    if (!pending) throw new Error('memory capture task not found');
    const parsed = memoryDedupOutput.safeParse(output);
    if (!parsed.success) throw new Error('memory dedup output is invalid');
    const decisions = parsed.data.map((decision) => ({
      ...decision,
      target_ids: decision.target_ids.filter((id) => pending.candidateIds.has(id)),
    }));
    const writes = applyDedupDecisions(
      { upsert: (s, i) => this.options.store.upsert(s, i), remove: (s, id) => this.options.store.remove(s, id) },
      pending.capture.scope.userId,
      decisions,
      pending.records,
      pending.capture.source,
      pending.capture.scope,
    );
    this.options.store.commitCapture(pending.capture.scope, pending.capture.source, pending.capture.fingerprint, pending.capture.delta);
    this.pendingDedup.delete(taskId);
    this.scheduleScene(pending.capture.scope, pending.capture.source, l1FromWrites(writes));
    return writes;
  }

  completeScene(taskId: string, output: unknown): MemoryRecord[] {
    const pending = this.pendingScene.get(taskId) ?? this.layerFromTask(taskId, 'memory_scene');
    if (!pending) throw new Error('memory scene task not found');
    const parsed = parseMemoryScene(output);
    const writes = applySceneDecisions(this.options.store, pending.scope, parsed.scenes);
    this.pendingScene.delete(taskId);
    const pendingSchedule = this.options.store.schedules.get(pending.scope.userId, LAYER_SCENE_KIND);
    this.options.store.schedules.markFired(pending.scope.userId, LAYER_SCENE_KIND, this.now());
    if (pendingSchedule?.payload && pendingSchedule.fireAt != null) {
      const fireAt = computeFireAt(this.now(), this.now(), this.delayMs(), this.minIntervalMs());
      this.options.store.schedules.upsertPending({
        userId: pending.scope.userId,
        kind: LAYER_SCENE_KIND,
        fireAt,
        payload: pendingSchedule.payload,
        now: this.now(),
      });
      this.armSceneTimer(pending.scope.userId, fireAt);
    }
    const persona = listGlobalLevel(this.options.store, pending.scope.userId, 3).find((row) => row.source === PERSONA_SOURCE);
    if (parsed.persona_update_request || !persona) this.schedulePersona(pending, parsed, writes, persona?.content);
    return writes;
  }

  completePersona(taskId: string, output: unknown): MemoryRecord {
    const pending = this.pendingPersona.get(taskId) ?? this.layerFromTask(taskId, 'memory_persona');
    if (!pending) throw new Error('memory persona task not found');
    const parsed = parseMemoryPersona(output);
    const write = applyPersonaDecision(this.options.store, pending.scope, parsed.content);
    this.pendingPersona.delete(taskId);
    return write;
  }

  taskSettled(task: ServiceTask): void {
    if (task.kind === 'memory_extract' && (task.status === 'failed' || task.status === 'cancelled')) this.finishCapture(task.id, task);
    if (task.kind === 'memory_deduplicate' && (task.status === 'failed' || task.status === 'cancelled')) this.pendingDedup.delete(task.id);
    if (task.kind === 'memory_scene' && (task.status === 'failed' || task.status === 'cancelled')) this.pendingScene.delete(task.id);
    if (task.kind === 'memory_persona' && (task.status === 'failed' || task.status === 'cancelled')) this.pendingPersona.delete(task.id);
  }

  private finishCapture(taskId: string, task?: ServiceTask): void {
    const capture = this.pending.get(taskId) ?? this.captureFromTask(taskId, task);
    this.pending.delete(taskId);
    // 关闭后不再入队；开关被确认关着时也不接着抽，pending 留到下一次开着开关的对话。
    if (!capture || this.disposed || this.extractObserved === false) return;
    const next = this.options.store.pendingCapture(capture.scope, capture.source);
    // Only newer input earns another task. Repeated failures with no new turn
    // remain pending for an explicit retry instead of creating an infinite loop.
    if (next && next.fingerprint !== capture.fingerprint) {
      const source = { ...capture.scope, projectId: capture.scope.projectId ?? capture.scope.workspace, source: capture.source };
      // 任务进行中累计的轮数够了就接着抽，不够就等空闲补抽。这个进程里没见过该来源（重启后恢复的任务）
      // 时不知道积了多少轮，照旧立刻接着抽。
      const known = this.cadence.get(sourceKey(source));
      if (known && known.count < known.threshold) {
        this.armIdle(known);
        return;
      }
      // completeExtraction runs before TaskQueue persists "completed". Exclude
      // that still-running task while finding/creating the successor.
      this.finishing.add(taskId);
      void this.capture({ ...source, ...next }, { force: true })
        .catch(() => {}).finally(() => { this.finishing.delete(taskId); });
    }
  }

  private captureFromTask(taskId: string, task = this.options.queue.get?.(taskId)): PendingCapture | undefined {
    const input = task?.input as Record<string, unknown> | undefined;
    if (!task || task.kind !== 'memory_extract' || !input || typeof input.delta !== 'string') return undefined;
    if (typeof task.sourceProjectId !== 'string' || typeof input.source !== 'string') return undefined;
    return { scope: { userId: typeof input.userId === 'string' ? input.userId : 'local', projectId: task.sourceProjectId, workspace: typeof input.workspace === 'string' ? input.workspace : task.sourceProjectId, sessionId: typeof task.sourceSessionId === 'string' ? task.sourceSessionId : undefined }, source: input.source, fingerprint: typeof input.fingerprint === 'string' ? input.fingerprint : '', delta: input.delta };
  }

  recoverLayerSchedules(): void {
    for (const row of this.options.store.schedules.listPending()) {
      if (row.kind !== LAYER_SCENE_KIND || row.fireAt == null) continue;
      this.armSceneTimer(row.userId, row.fireAt);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
    for (const state of this.cadence.values()) state.timer?.cancel();
    this.cadence.clear();
    this.recoverTimer?.cancel();
    this.recoverTimer = undefined;
  }

  private scheduleScene(scope: MemoryScope, source: string, l1: L1Record[]): void {
    if (l1.length === 0) return;
    if (this.immediateLayers()) {
      if (this.hasActiveScene(scope.userId)) return;
      this.enqueueScene(scope, source, l1);
      return;
    }
    const row = this.options.store.schedules.get(scope.userId, LAYER_SCENE_KIND);
    const fireAt = computeFireAt(this.now(), row?.lastFiredAt ?? 0, this.delayMs(), this.minIntervalMs());
    try {
      this.options.store.schedules.upsertPending({
        userId: scope.userId,
        kind: LAYER_SCENE_KIND,
        fireAt,
        payload: { scope, source, memories: l1 },
        now: this.now(),
      });
    } catch {
      return;
    }
    this.armSceneTimer(scope.userId, fireAt);
  }

  private hasActiveScene(userId: string): boolean {
    return Boolean(this.options.queue.findPending?.('memory_scene', (task) => {
      const input = task.input as Record<string, unknown> | undefined;
      return input?.userId === userId;
    }));
  }

  private armSceneTimer(userId: string, fireAt: number): void {
    this.timers.get(userId)?.cancel();
    const wait = Math.max(0, fireAt - this.now());
    const setTimer = this.options.layerSchedule?.setTimer ?? ((callback, ms) => {
      const handle = setTimeout(callback, ms);
      return { cancel: () => clearTimeout(handle) };
    });
    this.timers.set(userId, setTimer(() => { this.fireScene(userId); }, wait));
  }

  private fireScene(userId: string): void {
    this.timers.delete(userId);
    const row = this.options.store.schedules.get(userId, LAYER_SCENE_KIND);
    if (!row?.payload || row.fireAt == null) return;
    if (this.hasActiveScene(userId)) return;
    try {
      this.enqueueScene(row.payload.scope, row.payload.source, row.payload.memories);
      this.options.store.schedules.clearPending(userId, LAYER_SCENE_KIND, this.now());
    } catch {
      this.armSceneTimer(userId, this.now() + this.delayMs());
    }
  }

  private enqueueScene(scope: MemoryScope, source: string, l1: L1Record[]): void {
    const scenes = listGlobalLevel(this.options.store, scope.userId, 2).flatMap((row) => {
      const filename = sceneFilenameFromSource(row.source);
      return filename ? [{ filename, content: row.content, summary: sceneSummary(row.content) }] : [];
    });
    const taskId = randomUUID();
    this.pendingScene.set(taskId, { scope, source });
    try {
      void this.options.queue.enqueue({
        id: taskId,
        kind: 'memory_scene',
        input: {
          memories: l1,
          scenes,
          sceneSummaries: `当前场景总数: ${scenes.length}\n${scenes.map((scene) => `- ${scene.filename}: ${scene.summary}`).join('\n')}`,
          currentTimestamp: new Date().toISOString(),
          maxScenes: DEFAULT_MAX_SCENES,
          mode: this.options.extractMode ?? 'work',
          userId: scope.userId,
          projectId: scope.projectId,
          workspace: scope.workspace,
          sessionId: scope.sessionId,
          source,
        },
        sourceProjectId: scope.projectId ?? scope.workspace,
        sourceSessionId: scope.sessionId,
        system: true,
      }).catch(() => { this.pendingScene.delete(taskId); });
      if (this.options.queue.get && !this.options.queue.get(taskId)) {
        throw new Error('memory scene enqueue failed');
      }
    } catch (error) {
      this.pendingScene.delete(taskId);
      throw error;
    }
  }

  private schedulePersona(pending: PendingLayer, parsed: ParsedMemoryScene, writes: MemoryRecord[], existingPersona?: string): void {
    const scenes = listGlobalLevel(this.options.store, pending.scope.userId, 2)
      .flatMap((row) => {
        const filename = sceneFilenameFromSource(row.source);
        return filename ? [{ filename, content: row.content }] : [];
      });
    const changed = writes.flatMap((row) => {
      const filename = sceneFilenameFromSource(row.source);
      return filename ? [`#### ${filename}\n${row.content}`] : [];
    });
    const taskId = randomUUID();
    this.pendingPersona.set(taskId, pending);
    void this.options.queue.enqueue({
      id: taskId,
      kind: 'memory_persona',
      input: {
        generation: existingPersona ? 'incremental' : 'first',
        currentTime: new Date().toISOString(),
        totalProcessed: this.options.store.overview(pending.scope).byLevel.L1,
        sceneCount: scenes.length,
        changedSceneCount: writes.length,
        changedScenesContent: changed.join('\n\n') || scenes.map((scene) => `#### ${scene.filename}\n${scene.content}`).join('\n\n'),
        existingPersona,
        triggerInfo: parsed.persona_update_request,
        mode: this.options.extractMode ?? 'work',
        userId: pending.scope.userId,
        projectId: pending.scope.projectId,
        workspace: pending.scope.workspace,
        sessionId: pending.scope.sessionId,
        source: pending.source,
      },
      sourceProjectId: pending.scope.projectId ?? pending.scope.workspace,
      sourceSessionId: pending.scope.sessionId,
      system: true,
    }).catch(() => { this.pendingPersona.delete(taskId); });
  }

  private layerFromTask(taskId: string, kind: 'memory_scene' | 'memory_persona'): PendingLayer | undefined {
    const task = this.options.queue.get?.(taskId);
    const input = task?.input as Record<string, unknown> | undefined;
    if (!task || task.kind !== kind || !input || typeof input.source !== 'string' || typeof task.sourceProjectId !== 'string') return undefined;
    return {
      scope: {
        userId: typeof input.userId === 'string' ? input.userId : 'local',
        projectId: task.sourceProjectId,
        workspace: typeof input.workspace === 'string' ? input.workspace : task.sourceProjectId,
        sessionId: typeof task.sourceSessionId === 'string' ? task.sourceSessionId : undefined,
      },
      source: input.source,
    };
  }
}

function warnRecoverFailed(error: unknown): void {
  console.warn('[memory] 补抽失败', error instanceof Error ? error.message : String(error));
}

function sameSource(scope: MemoryScope, source: string, input: MemoryCaptureInput): boolean {
  return scope.userId === input.userId && scope.workspace === input.workspace && scope.sessionId === input.sessionId &&
    (scope.projectId ?? scope.workspace) === input.projectId && source === input.source;
}

function sourceKey(input: { userId: string; workspace: string; sessionId?: string; source: string }): string {
  return `${input.userId}\0${input.workspace}\0${input.sessionId ?? ''}\0${input.source}`;
}

/** 节奏状态长期驻留内存，只留来源标识，不带 transcript。 */
function captureSource(input: CaptureSource): CaptureSource {
  return { userId: input.userId, workspace: input.workspace, projectId: input.projectId, sessionId: input.sessionId, source: input.source };
}

function captureBackground(store: MemoryStore, scope: MemoryScope, source: string, delta: string): string {
  const cursor = store.pendingCapture(scope, source);
  const transcript = cursor?.transcript ?? delta;
  if (!delta || !transcript.endsWith(delta)) return '';
  return stripTrailingNewlines(transcript.slice(0, transcript.length - delta.length));
}

function latestSceneName(store: MemoryStore, scope: MemoryScope): string {
  for (const hit of store.search(scope, '{', 20)) {
    if (hit.level !== 1) continue;
    try {
      const parsed = JSON.parse(hit.content) as { scene_name?: unknown };
      if (typeof parsed.scene_name === 'string' && parsed.scene_name.trim()) return parsed.scene_name;
    } catch {
      /* 非 JSON L1 跳过 */
    }
  }
  return '无';
}

function storedL1Candidate(hit: MemoryRecord): { id: string; content: string; type?: string; priority?: number; scene_name?: string; timestamps: string[] } {
  let parsed: { content?: unknown; type?: unknown; priority?: unknown; scene_name?: unknown } | undefined;
  try { parsed = JSON.parse(hit.content) as typeof parsed; } catch { parsed = undefined; }
  return {
    id: hit.id,
    content: typeof parsed?.content === 'string' ? parsed.content : hit.content,
    type: typeof parsed?.type === 'string' ? parsed.type : undefined,
    priority: typeof parsed?.priority === 'number' ? parsed.priority : undefined,
    scene_name: typeof parsed?.scene_name === 'string' ? parsed.scene_name : undefined,
    timestamps: [new Date(hit.createdAt).toISOString()],
  };
}

function l1FromWrites(writes: MemoryRecord[]): L1Record[] {
  return writes.flatMap((row) => {
    if (row.level !== 1) return [];
    try {
      const parsed = JSON.parse(row.content) as L1Record;
      return parsed && typeof parsed.content === 'string' ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
