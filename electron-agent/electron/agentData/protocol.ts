export const PROTOCOL_VERSION = 1 as const;

export type RpcRequest = {
  id: string;
  version: typeof PROTOCOL_VERSION;
  method: string;
  params: Record<string, unknown>;
  token: string;
};

export type RpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

export interface AgentDataEndpoint {
  host: string;
  port: number;
  token: string;
}

export class RpcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && v.version === PROTOCOL_VERSION && typeof v.method === 'string'
    && Boolean(v.params && typeof v.params === 'object' && !Array.isArray(v.params)) && typeof v.token === 'string';
}
