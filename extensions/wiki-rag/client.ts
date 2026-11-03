import { getConfig } from '../_shared/runtime-config.js';
import { AgentDataClient } from '../_shared/agent-data-client.js';

export class WikiClient {
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const endpoint = getConfig('AGENT_DATA_ENDPOINT');
    if (!endpoint) throw new Error('agent data runtime is not configured');
    return new AgentDataClient().request<T>(method, params);
  }
}
