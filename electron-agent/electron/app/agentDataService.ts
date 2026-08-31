import { AgentDataClient } from '../agentData/client';
import { AgentDataRuntime, type AgentDataRuntimeOptions } from '../agentData/runtime';
import type { AgentDataEndpoint } from '../agentData/protocol';

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
        this.client = new AgentDataClient(endpoint);
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
      await this.client?.close(); this.runtime?.close(); this.client = undefined; this.runtime = undefined;
    })().finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }
  endpoint(): AgentDataEndpoint | undefined { return this.runtime?.getEndpoint(); }
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> { return this.requireClient().request<T>(method, params); }
  private requireClient(): AgentDataClient { if (!this.client) throw new Error('agent data runtime is not started'); return this.client; }
}
