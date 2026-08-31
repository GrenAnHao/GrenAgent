import { describe, expect, it, vi } from 'vitest';
import { agentDataApi } from './agentData';
import * as runtime from '../platform/runtime';

describe('agentDataApi', () => {
  it('uses typed IPC commands', async () => { const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({ state: 'ready', version: 1 }); await agentDataApi.status(); expect(spy).toHaveBeenCalledWith('agentData_status'); spy.mockRestore(); });
});
