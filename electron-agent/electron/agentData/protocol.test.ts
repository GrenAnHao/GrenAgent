import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type RpcRequest, isRpcRequest } from './protocol';

describe('agent data protocol', () => {
  it('validates versioned authenticated requests', () => {
    const request: RpcRequest = { id: '1', version: PROTOCOL_VERSION, method: 'system.hello', params: {}, token: 't' };
    expect(isRpcRequest(request)).toBe(true);
    expect(isRpcRequest({ ...request, version: 2 })).toBe(false);
  });
});
