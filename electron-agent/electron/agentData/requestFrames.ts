import { isRpcRequest, RpcError, type RpcRequest } from './protocol';

// Keep wire limits aligned with extensions/_shared/request-frames.ts; the two
// packages build independently, and the client socket tests verify compatibility.
const MAX_FRAME_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 32 * MAX_FRAME_BYTES;
const REQUEST_CHUNK_BYTES = 65_536;
const REQUEST_CHUNK_METHOD = 'system.request_chunk';

export function encodeRequestFrames(request: RpcRequest): string[] {
  const line = JSON.stringify(request);
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length > MAX_REQUEST_BYTES) throw new RpcError('REQUEST_TOO_LARGE', 'RPC request exceeds 32 MiB');
  if (bytes.length + 1 <= MAX_FRAME_BYTES) return [line];
  const frames: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + REQUEST_CHUNK_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const frame = JSON.stringify({ id: request.id, version: request.version, token: request.token, method: REQUEST_CHUNK_METHOD,
      params: { chunk: bytes.subarray(offset, end).toString('utf8'), last: end === bytes.length } });
    if (Buffer.byteLength(frame) + 1 > MAX_FRAME_BYTES) throw new RpcError('REQUEST_TOO_LARGE', 'RPC chunk frame exceeds 1 MiB');
    frames.push(frame);
    offset = end;
  }
  return frames;
}

interface PartialRequest { chunks: string[]; bytes: number; token: string }
const MAX_PARTIAL_REQUESTS = 8;
const MAX_REQUEST_CHUNKS = Math.ceil(MAX_REQUEST_BYTES / (REQUEST_CHUNK_BYTES - 3));

/** One decoder belongs to one socket. Only the final fragment dispatches a request. */
export class RequestFrameDecoder {
  private readonly partial = new Map<string, PartialRequest>();

  constructor(private readonly token: string | ((token: string) => boolean)) {}

  private authorized(token: string): boolean { return typeof this.token === 'string' ? token === this.token : this.token(token); }

  accept(line: string): string | undefined {
    if (Buffer.byteLength(line) + 1 > MAX_FRAME_BYTES) throw new RpcError('REQUEST_TOO_LARGE', 'RPC frame exceeds 1 MiB');
    let value: unknown;
    try { value = JSON.parse(line); } catch { return line; }
    if (!value || typeof value !== 'object' || (value as { method?: unknown }).method !== REQUEST_CHUNK_METHOD) return line;
    if (!isRpcRequest(value)) throw new RpcError('INVALID_REQUEST', 'invalid RPC chunk request');
    if (!this.authorized(value.token)) { this.partial.delete(value.id); throw new RpcError('UNAUTHORIZED', 'invalid token'); }
    const { chunk, last } = value.params;
    if (typeof chunk !== 'string' || typeof last !== 'boolean') throw new RpcError('INVALID_REQUEST', 'invalid RPC chunk parameters');
    const current = this.partial.get(value.id);
    if (current && current.token !== value.token) {
      this.partial.delete(value.id);
      throw new RpcError('INVALID_REQUEST', 'RPC fragments use different credentials');
    }
    const chunkBytes = Buffer.byteLength(chunk);
    const bytes = (current?.bytes ?? 0) + chunkBytes;
    if (chunkBytes > REQUEST_CHUNK_BYTES || bytes > MAX_REQUEST_BYTES || (current?.chunks.length ?? 0) >= MAX_REQUEST_CHUNKS) {
      this.partial.delete(value.id);
      throw new RpcError('REQUEST_TOO_LARGE', 'RPC request exceeds fragment or 32 MiB limits');
    }
    if (!current && !last && this.partial.size >= MAX_PARTIAL_REQUESTS) throw new RpcError('REQUEST_TOO_LARGE', 'too many partial RPC requests');
    const chunks = current?.chunks ?? [];
    chunks.push(chunk);
    if (!last) {
      this.partial.set(value.id, { chunks, bytes, token: value.token });
      return undefined;
    }
    this.partial.delete(value.id);
    const combined = chunks.join('');
    let request: unknown;
    try { request = JSON.parse(combined); } catch { throw new RpcError('INVALID_REQUEST', 'invalid assembled RPC request'); }
    if (!isRpcRequest(request) || request.id !== value.id || request.token !== value.token || !this.authorized(request.token) || request.method === REQUEST_CHUNK_METHOD) {
      throw new RpcError('INVALID_REQUEST', 'assembled RPC request does not match its chunk envelope');
    }
    return combined;
  }

  clear(): void { this.partial.clear(); }
}
