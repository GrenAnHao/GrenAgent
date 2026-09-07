import { describe, expect, it } from 'vitest';
import { encodeRequestFrames, RequestFrameDecoder } from './requestFrames';
import type { RpcRequest } from './protocol';

const FRAME_BYTES = 1_048_576;
const CHUNK_BYTES = 65_536;
const REQUEST_BYTES = 32 * FRAME_BYTES;
const request: RpcRequest = { id: 'request-1', version: 1, token: 'secret', method: 'memory.capture', params: {} };

function chunk(chunk: string, last: boolean, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...request, method: 'system.request_chunk', params: { chunk, last }, ...patch });
}

function requestWithBytes(bytes: number): RpcRequest {
  const base = { ...request, params: { text: '' } };
  return { ...base, params: { text: 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(base))) } };
}

describe('request frames', () => {
  it('accepts project token validators without allowing cross-token fragments', () => {
    const valid = new Set(['secret', 'project']);
    const decoder = new RequestFrameDecoder((token) => valid.has(token));
    const line = JSON.stringify(request);
    expect(decoder.accept(chunk(line.slice(0, 10), false))).toBeUndefined();
    expect(() => decoder.accept(chunk(line.slice(10), true, { token: 'project' }))).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(decoder.accept(chunk(line, true))).toBe(line);
    expect(() => decoder.accept(chunk(JSON.stringify({ ...request, token: 'project' }), true))).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(decoder.accept(chunk(line.slice(0, 10), false))).toBeUndefined();
    valid.delete('secret');
    expect(() => decoder.accept(chunk(line.slice(10), true))).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('keeps ordinary requests unchanged', () => {
    const line = JSON.stringify(request);
    expect(encodeRequestFrames(request)).toEqual([line]);
    expect(new RequestFrameDecoder('secret').accept(line)).toBe(line);
  });

  it('reassembles a large escaped Unicode payload without changing its content', () => {
    const input = { ...request, params: { text: '漢🚀\n\\"'.repeat(120_000) } };
    const frames = encodeRequestFrames(input);
    expect(frames.length).toBeGreaterThan(1);
    const decoder = new RequestFrameDecoder('secret');
    const complete: string[] = [];
    frames.forEach((line, index) => {
      expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(FRAME_BYTES);
      const frame = JSON.parse(line);
      expect(frame).toMatchObject({ id: input.id, version: 1, token: 'secret', method: 'system.request_chunk' });
      expect(Buffer.byteLength(frame.params.chunk)).toBeLessThanOrEqual(CHUNK_BYTES);
      expect(frame.params.last).toBe(index === frames.length - 1);
      const result = decoder.accept(line);
      if (result !== undefined) complete.push(result);
    });
    expect(complete.map((line) => JSON.parse(line))).toEqual([input]);
  });

  it('includes the JSONL newline when deciding whether a physical frame fits', () => {
    expect(encodeRequestFrames(requestWithBytes(FRAME_BYTES - 1))).toHaveLength(1);
    expect(encodeRequestFrames(requestWithBytes(FRAME_BYTES)).length).toBeGreaterThan(1);
  });

  it('allows exactly 32 MiB of logical JSON and rejects an extra byte', () => {
    const input = requestWithBytes(REQUEST_BYTES);
    const decoder = new RequestFrameDecoder('secret');
    let result: string | undefined;
    for (const line of encodeRequestFrames(input)) result = decoder.accept(line);
    expect(result).toBe(JSON.stringify(input));
    expect(() => encodeRequestFrames(requestWithBytes(REQUEST_BYTES + 1))).toThrow(expect.objectContaining({ code: 'REQUEST_TOO_LARGE' }));
  });

  it.each([
    [{ token: 'forged' }, 'UNAUTHORIZED'],
    [{ version: 2 }, 'INVALID_REQUEST'],
    [{ params: { chunk: 'x', last: 'false' } }, 'INVALID_REQUEST'],
    [{ params: { chunk: 1, last: false } }, 'INVALID_REQUEST'],
  ])('validates chunk credentials and shape before buffering %j', (patch, code) => {
    const decoder = new RequestFrameDecoder('secret');
    expect(() => decoder.accept(chunk('{', false, patch))).toThrow(expect.objectContaining({ code }));
    expect(decoder.accept(chunk(JSON.stringify(request), true))).toBe(JSON.stringify(request));
  });

  it.each([
    { id: 'other-request' },
    { token: 'forged' },
    { version: 2 },
    { method: 'system.request_chunk' },
  ])('rejects mismatched or nested reassembled requests %j', (patch) => {
    const decoder = new RequestFrameDecoder('secret');
    expect(() => decoder.accept(chunk(JSON.stringify({ ...request, ...patch }), true))).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(decoder.accept(chunk(JSON.stringify(request), true))).toBe(JSON.stringify(request));
  });

  it('limits concurrent partial requests and clears them when a socket closes', () => {
    const decoder = new RequestFrameDecoder('secret');
    for (let i = 0; i < 8; i += 1) expect(decoder.accept(chunk('{', false, { id: String(i) }))).toBeUndefined();
    expect(() => decoder.accept(chunk('{', false, { id: 'ninth' }))).toThrow(expect.objectContaining({ code: 'REQUEST_TOO_LARGE' }));
    decoder.clear();
    expect(decoder.accept(chunk('{', false, { id: 'ninth' }))).toBeUndefined();
    decoder.clear();
    expect(decoder.accept(chunk(JSON.stringify(request), true))).toBe(JSON.stringify(request));
  });

  it('rejects oversized chunks and bounds accumulated logical bytes', () => {
    const decoder = new RequestFrameDecoder('secret');
    expect(() => decoder.accept(chunk('x'.repeat(CHUNK_BYTES + 1), false))).toThrow(expect.objectContaining({ code: 'REQUEST_TOO_LARGE' }));
    const line = chunk('x'.repeat(CHUNK_BYTES), false);
    for (let i = 0; i < REQUEST_BYTES / CHUNK_BYTES; i += 1) expect(decoder.accept(line)).toBeUndefined();
    expect(() => decoder.accept(chunk('x', false))).toThrow(expect.objectContaining({ code: 'REQUEST_TOO_LARGE' }));
    expect(decoder.accept(chunk(JSON.stringify(request), true))).toBe(JSON.stringify(request));
  });

  it('does not allow unauthenticated chunks to consume partial-request slots', () => {
    const decoder = new RequestFrameDecoder('secret');
    for (let i = 0; i < 9; i += 1) expect(() => decoder.accept(chunk('{', false, { id: String(i), token: 'forged' }))).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    expect(decoder.accept(chunk(JSON.stringify(request), true))).toBe(JSON.stringify(request));
  });

  it('bounds fragment bookkeeping even when authenticated clients send tiny chunks', () => {
    const decoder = new RequestFrameDecoder('secret');
    const line = chunk('x', false);
    for (let i = 0; i < 513; i += 1) expect(decoder.accept(line)).toBeUndefined();
    expect(() => decoder.accept(line)).toThrow(expect.objectContaining({ code: 'REQUEST_TOO_LARGE' }));
    expect(decoder.accept(chunk(JSON.stringify(request), true))).toBe(JSON.stringify(request));
  });
});
