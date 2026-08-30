import { describe, expect, it } from 'vitest';
import {
  configToForm,
  listEntries,
  mergeImport,
  parseMcpImport,
  removeServer,
  serializeForm,
  setEnabled,
  transportOf,
  upsertServer,
  validateForm,
  type Collections,
} from './mcpConfig';

const empty: Collections = { enabled: '', disabled: '' };

describe('mcpConfig', () => {
  it('listEntries merges enabled + disabled with flags', () => {
    const cols: Collections = {
      enabled: '{"mcpServers":{"a":{"command":"npx"}}}',
      disabled: '{"mcpServers":{"b":{"url":"https://x"}}}',
    };
    const list = listEntries(cols);
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.name === 'a')?.enabled).toBe(true);
    expect(list.find((e) => e.name === 'b')?.enabled).toBe(false);
  });

  it('transportOf detects stdio/sse', () => {
    expect(transportOf({ command: 'npx' })).toBe('stdio');
    expect(transportOf({ url: 'https://x' })).toBe('sse');
    expect(transportOf({} as never)).toBe('?');
  });

  it('serializeForm builds stdio config with args/env', () => {
    const { name, config } = serializeForm({
      type: 'stdio',
      name: 'gh',
      command: 'npx',
      args: '-y  @modelcontextprotocol/server-github',
      env: [['GITHUB_TOKEN', 'ghp']],
    });
    expect(name).toBe('gh');
    expect(config).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'ghp' },
    });
  });

  it('serializeForm puts bearer token into headers.Authorization', () => {
    const { config } = serializeForm({ type: 'remote', name: 'r', url: 'https://x', auth: 'bearer', token: 'abc' });
    expect(config).toEqual({ url: 'https://x', headers: { Authorization: 'Bearer abc' } });
  });

  it('configToForm round-trips bearer auth back from headers', () => {
    const f = configToForm('r', { url: 'https://x', headers: { Authorization: 'Bearer abc', 'X-Y': '1' } });
    expect(f.type).toBe('remote');
    expect(f.auth).toBe('bearer');
    expect(f.token).toBe('abc');
    expect(f.headers).toEqual([['X-Y', '1']]);
  });

  it('validateForm catches empty/duplicate/invalid', () => {
    expect(validateForm({ type: 'stdio', name: '', command: 'x' }, new Set())).toMatch(/不能为空/);
    expect(validateForm({ type: 'stdio', name: 'a', command: 'x' }, new Set(['a']))).toMatch(/已存在/);
    expect(validateForm({ type: 'stdio', name: 'a', command: '' }, new Set())).toMatch(/命令/);
    expect(validateForm({ type: 'remote', name: 'a', url: 'not-url' }, new Set())).toMatch(/URL/);
    expect(validateForm({ type: 'stdio', name: 'a', command: 'x' }, new Set())).toBeNull();
  });

  it('parseMcpImport parses multiple and rejects invalid', () => {
    const ok = parseMcpImport('{"mcpServers":{"a":{"command":"npx"},"b":{"url":"https://x"}}}');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.servers).toHaveLength(2);
    expect(parseMcpImport('nope').ok).toBe(false);
    expect(parseMcpImport('{}').ok).toBe(false);
  });

  it('upsert/remove/setEnabled move between collections', () => {
    let cols = upsertServer(empty, { name: 'a', config: { command: 'npx' } }, 'enabled');
    expect(listEntries(cols)).toHaveLength(1);
    cols = setEnabled(cols, 'a', false);
    expect(listEntries(cols).find((e) => e.name === 'a')?.enabled).toBe(false);
    cols = removeServer(cols, 'a');
    expect(listEntries(cols)).toHaveLength(0);
  });

  it('mergeImport skips conflicts', () => {
    const base = upsertServer(empty, { name: 'a', config: { command: 'npx' } });
    const r = mergeImport(base, [
      { name: 'a', config: { command: 'x' } },
      { name: 'b', config: { url: 'https://y' } },
    ]);
    expect(r.added).toBe(1);
    expect(r.skipped).toEqual(['a']);
    expect(listEntries(r.cols)).toHaveLength(2);
  });
});
