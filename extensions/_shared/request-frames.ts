export const MAX_FRAME_BYTES = 1_048_576;
export const MAX_REQUEST_BYTES = 32 * MAX_FRAME_BYTES;
export const REQUEST_CHUNK_BYTES = 65_536;
export const REQUEST_CHUNK_METHOD = 'system.request_chunk';

interface EncodableRequest { id: string; version: number; method: string; params: Record<string, unknown>; token: string }

export class RequestFrameError extends Error {
  readonly code = 'REQUEST_TOO_LARGE';
}

/** Return JSON lines without their trailing newline; preserve small requests verbatim. */
export function encodeRequestFrames(request: EncodableRequest): string[] {
  const line = JSON.stringify(request);
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length > MAX_REQUEST_BYTES) throw new RequestFrameError('RPC request exceeds 32 MiB');
  if (bytes.length + 1 <= MAX_FRAME_BYTES) return [line];
  const frames: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + REQUEST_CHUNK_BYTES, bytes.length);
    // Keep a UTF-8 code point together so encoding each JSON fragment is lossless.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const frame = JSON.stringify({ id: request.id, version: request.version, token: request.token, method: REQUEST_CHUNK_METHOD,
      params: { chunk: bytes.subarray(offset, end).toString('utf8'), last: end === bytes.length } });
    if (Buffer.byteLength(frame) + 1 > MAX_FRAME_BYTES) throw new RequestFrameError('RPC chunk frame exceeds 1 MiB');
    frames.push(frame);
    offset = end;
  }
  return frames;
}
