import { AgentDataClient } from '../agentData/client';
import { AgentDataRuntime, type AgentDataRuntimeOptions } from '../agentData/runtime';
import type { AgentDataEndpoint } from '../agentData/protocol';
import type { Item, Thread, Turn } from './appServer/types';
import type { CreateThreadInput, CreateTurnInput, ThreadSnapshot } from '../agentData/threadStore';
import type { QueueTaskInput } from './appServer/taskQueue';
import type { WikiSyncSkipInput } from './wikiSyncService';
import type { CreateGoalInput, GoalUpdateInput, GoalEvent, GoalSnapshot, GoalDispatch, RoundClaimInput, RoundSettlementInput, RoundCancelInput, GoalRuntimeErrorInput } from '../agentData/goalContracts';

// CodeGraph calls may cold-load the embedded SDK and its index. Keep this aligned with
// extensions/code-retrieval's 65s client timeout instead of AgentDataClient's
// short default used by lightweight callers.
const AGENT_DATA_SERVICE_TIMEOUT_MS = 65_000;

export class AgentDataService {
  private runtime?: AgentDataRuntime;
  private client?: AgentDataClient;
  private startPromise?: Promise<{ version: number }>;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: AgentDataRuntimeOptions) {}

  async start(): Promise<{ version: number }> {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      if (!this.client) {
        this.runtime = new AgentDataRuntime(this.options);
        const endpoint = await this.runtime.start();
        this.client = new AgentDataClient(endpoint, { timeoutMs: AGENT_DATA_SERVICE_TIMEOUT_MS, closeOnTimeout: false });
      }
      return this.client!.request<{ version: number }>('system.hello');
    })().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  status(): Promise<{ state: string; version: number }> { return this.requireClient().request('system.status'); }
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.startPromise) await this.startPromise.catch(() => {});
      if (this.client) await this.client.request('system.shutdown').catch(() => {});
      await this.client?.close(); this.runtime?.close();
      await this.runtime?.waitClosed();
      this.client = undefined; this.runtime = undefined;
    })().finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }
  endpoint(): AgentDataEndpoint | undefined { return this.runtime?.getEndpoint(); }
  agentEndpoint(workspace: string): AgentDataEndpoint {
    if (!this.runtime) throw new Error('agent data runtime is not started');
    return this.runtime.agentEndpoint(workspace);
  }
  requestAdmin<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.runtime) return Promise.reject(new Error('agent data runtime is not started'));
    return this.runtime.requestAdmin<T>(method, params);
  }
  goalGet(sessionId: string, _workspace: string): Promise<GoalSnapshot | undefined> {
    return this.requestAdmin<GoalSnapshot | undefined>('admin.goal.get', { sessionId });
  }
  goalCreate(input: Omit<CreateGoalInput, 'origin'> | CreateGoalInput): Promise<GoalSnapshot> {
    const { origin: _origin, ...params } = input as CreateGoalInput;
    return this.requestAdmin<GoalSnapshot>('admin.goal.create', { ...params, origin: 'human-ui' });
  }
  goalUpdate(input: Omit<GoalUpdateInput, 'origin'> | GoalUpdateInput): Promise<GoalSnapshot> {
    const { origin: _origin, ...params } = input as GoalUpdateInput;
    return this.requestAdmin<GoalSnapshot>('admin.goal.update', { ...params, origin: 'human-ui' });
  }
  goalRecordProgress(input: Omit<GoalUpdateInput, 'origin'> | GoalUpdateInput): Promise<GoalSnapshot> {
    return this.goalUpdate({ ...input, action: 'block' });
  }
  goalRequestCompletion(input: Omit<GoalUpdateInput, 'origin'> | GoalUpdateInput): Promise<GoalSnapshot> {
    return this.goalUpdate({ ...input, action: 'begin_judging' });
  }
  goalHistory(sessionId: string, limit?: number): Promise<GoalEvent[]> {
    return this.requestAdmin<GoalEvent[]>('admin.goal.history', { sessionId, ...(limit === undefined ? {} : { limit }) });
  }
  goalClaimRound(input: RoundClaimInput): Promise<GoalDispatch> {
    return this.requestAdmin<GoalDispatch>('admin.goal.claimRound', input as unknown as Record<string, unknown>);
  }
  goalSettleRound(input: RoundSettlementInput): Promise<{ snapshot: GoalSnapshot; dispatch: GoalDispatch }> {
    return this.requestAdmin<{ snapshot: GoalSnapshot; dispatch: GoalDispatch }>('admin.goal.settleRound', input as unknown as Record<string, unknown>);
  }
  goalCancelRound(input: RoundCancelInput): Promise<GoalDispatch | null> {
    return this.requestAdmin<GoalDispatch | null>('admin.goal.cancelRound', input as unknown as Record<string, unknown>);
  }
  goalRuntimeError(input: GoalRuntimeErrorInput): Promise<GoalSnapshot> {
    return this.requestAdmin<GoalSnapshot>('admin.goal.runtimeError', input as unknown as Record<string, unknown>);
  }
  onGoalEvent(listener: (event: GoalEvent, snapshot: GoalSnapshot | undefined) => void | boolean | Promise<void | boolean>): () => void {
    if (!this.runtime) throw new Error('agent data runtime is not started');
    return this.runtime.onGoalEvent(listener);
  }
  bindGoalSession(workspace: string, sessionId: string, source: 'interactive' | 'goal' = 'interactive'): Promise<{ bound: boolean; workspace: string; sessionId: string; source: 'interactive' | 'goal' }> {
    return this.requestAdmin('admin.goal.session.bind', { workspace, sessionId, source });
  }
  unbindGoalSession(workspace: string, sessionId: string): Promise<{ bound: boolean; workspace: string; sessionId: string }> {
    return this.requestAdmin('admin.goal.session.unbind', { workspace, sessionId });
  }
  resolveDiagnosticPath(id: string): Promise<string> {
    if (!this.runtime) return Promise.reject(new Error('agent data runtime is not started'));
    return this.runtime.resolveDiagnosticPath(id);
  }
  recordJobStage(id: string, stage: string, processed?: number, total?: number): void {
    if (!this.runtime) throw new Error('agent data runtime is not started');
    this.runtime.recordJobStage(id, stage, processed, total);
  }
  recordWikiSyncSkip(input: WikiSyncSkipInput): void {
    if (!this.runtime) throw new Error('agent data runtime is not started');
    this.runtime.recordWikiSyncSkip(input);
  }
  async runServiceTask(input: Omit<QueueTaskInput, 'system'>): Promise<unknown> {
    if (!this.runtime) throw new Error('agent data runtime is not started');
    return this.runtime.runServiceTask(input);
  }
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> { return this.requireClient().request<T>(method, params); }
  createThread(input: CreateThreadInput): Promise<Thread> { return this.request('thread.create', input); }
  listThreads(): Promise<Thread[]> { return this.request('thread.list'); }
  readThread(id: string): Promise<ThreadSnapshot | undefined> { return this.request('thread.read', { id }); }
  createTurn(input: CreateTurnInput): Promise<Turn> { return this.request('turn.create', input); }
  updateTurn(id: string, patch: Partial<Pick<Turn, 'status' | 'startedAt' | 'completedAt' | 'error'>>): Promise<Turn> { return this.request('turn.update', { id, ...patch }); }
  upsertItem(item: Omit<Item, 'createdAt'> & Partial<Pick<Item, 'createdAt' | 'updatedAt'>>): Promise<Item> { return this.request('item.upsert', item); }
  listItems(threadId: string, turnId?: string): Promise<Item[]> { return this.request('item.list', { threadId, ...(turnId === undefined ? {} : { turnId }) }); }

  private requireClient(): AgentDataClient { if (!this.client) throw new Error('agent data runtime is not started'); return this.client; }
}
