import { describe, expect, it } from 'vitest';
import {
  getCacheEntry, getCachedTools, parseProbeResult, parseToolsCache, toProbeConfigJson,
} from './mcpToolsCache';

describe('parseToolsCache', () => {
  it('returns {} for empty / invalid', () => {
    expect(parseToolsCache('')).toEqual({});
    expect(parseToolsCache('nope')).toEqual({});
  });
  it('parses entries and reads tools', () => {
    const c = parseToolsCache(JSON.stringify({ s: { toolNames: ['mcp__s__t'], probedAt: 't1', ok: true } }));
    expect(getCachedTools(c, 's')).toEqual(['mcp__s__t']);
    expect(getCacheEntry(c, 's')?.ok).toBe(true);
  });
  it('tolerates malformed entries', () => {
    const c = parseToolsCache(JSON.stringify({ a: 5, b: { toolNames: 'x', ok: true } }));
    expect(getCachedTools(c, 'a')).toEqual([]);
    expect(getCachedTools(c, 'b')).toEqual([]);
    expect(getCachedTools(c, 'missing')).toEqual([]);
  });
});

describe('toProbeConfigJson', () => {
  it('stdio config', () => {
    expect(JSON.parse(toProbeConfigJson('s', { command: 'c', args: ['a'], env: { K: 'v' } }))).toEqual({
      name: 's', transport: 'stdio', command: 'c', args: ['a'], env: { K: 'v' },
    });
  });
  it('remote config → sse', () => {
    expect(JSON.parse(toProbeConfigJson('s', { url: 'http://x/sse' }))).toEqual({
      name: 's', transport: 'sse', url: 'http://x/sse',
    });
  });
  it('remote config keeps headers and uses streamable HTTP for /mcp', () => {
    expect(JSON.parse(toProbeConfigJson('s', { url: 'http://127.0.0.1:54382/mcp', headers: { 'x-api-key': 'k' } }))).toEqual({
      name: 's',
      transport: 'http',
      url: 'http://127.0.0.1:54382/mcp',
      headers: { 'x-api-key': 'k' },
    });
  });
});

describe('parseProbeResult', () => {
  it('parses ok result', () => {
    expect(parseProbeResult('{"ok":true,"toolNames":["mcp__s__t"]}')).toEqual({ ok: true, toolNames: ['mcp__s__t'] });
  });
  it('falls back on garbage', () => {
    expect(parseProbeResult('x')).toEqual({ ok: false, toolNames: [], error: 'invalid probe result' });
  });
});
