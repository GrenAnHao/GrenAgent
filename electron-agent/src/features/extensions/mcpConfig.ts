export type McpTransport = 'stdio' | 'sse' | '?';
export type AuthKind = 'none' | 'bearer';

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface McpRemoteConfig {
  url: string;
  headers?: Record<string, string>;
}
export type McpConfig = McpStdioConfig | McpRemoteConfig;

export interface McpEntry {
  name: string;
  config: McpConfig;
  enabled: boolean;
}

export interface Collections {
  /** MCP_SERVERS（启用集）原始 JSON 字符串 */
  enabled: string;
  /** MCP_SERVERS_DISABLED（禁用集）原始 JSON 字符串 */
  disabled: string;
}

export interface McpFormValues {
  type: 'stdio' | 'remote';
  name: string;
  command?: string;
  args?: string;
  env?: Array<[string, string]>;
  url?: string;
  auth?: AuthKind;
  token?: string;
  headers?: Array<[string, string]>;
}

export type ImportResult =
  | { ok: true; servers: Array<{ name: string; config: McpConfig }> }
  | { ok: false; error: string };

export function transportOf(c: McpConfig): McpTransport {
  if (c && typeof (c as McpRemoteConfig).url === 'string') return 'sse';
  if (c && typeof (c as McpStdioConfig).command === 'string') return 'stdio';
  return '?';
}

/** 解析单个集合 JSON（标准 {mcpServers:{...}} 或裸 map）。无效时返回 []。 */
function parseCollection(json: string): Array<{ name: string; config: McpConfig }> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const root = parsed as Record<string, unknown>;
    const wrapped = root.mcpServers;
    const src = (wrapped && typeof wrapped === 'object' ? wrapped : root) as Record<string, unknown>;
    return Object.entries(src).flatMap(([name, raw]) =>
      raw && typeof raw === 'object' ? [{ name, config: raw as McpConfig }] : [],
    );
  } catch {
    return [];
  }
}

function stringify(entries: Array<{ name: string; config: McpConfig }>): string {
  if (entries.length === 0) return '';
  const map: Record<string, McpConfig> = {};
  for (const e of entries) map[e.name] = e.config;
  return JSON.stringify({ mcpServers: map }, null, 2);
}

/** 合并启用集 + 禁用集为统一列表（带 enabled 标记）。 */
export function listEntries(cols: Collections): McpEntry[] {
  return [
    ...parseCollection(cols.enabled).map((e) => ({ ...e, enabled: true })),
    ...parseCollection(cols.disabled).map((e) => ({ ...e, enabled: false })),
  ];
}

function kvToObj(kv?: Array<[string, string]>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of kv ?? []) {
    const key = k.trim();
    if (key) o[key] = v;
  }
  return o;
}
function objToKv(o?: Record<string, string>): Array<[string, string]> {
  return Object.entries(o ?? {});
}

/** 表单值 → {name, config}。Bearer 落到 headers.Authorization。 */
export function serializeForm(v: McpFormValues): { name: string; config: McpConfig } {
  const name = v.name.trim();
  if (v.type === 'stdio') {
    const config: McpStdioConfig = { command: (v.command ?? '').trim() };
    const args = (v.args ?? '').trim();
    if (args) config.args = args.split(/\s+/);
    const env = kvToObj(v.env);
    if (Object.keys(env).length) config.env = env;
    return { name, config };
  }
  const headers = kvToObj(v.headers);
  if (v.auth === 'bearer' && (v.token ?? '').trim()) {
    headers.Authorization = `Bearer ${(v.token ?? '').trim()}`;
  }
  const config: McpRemoteConfig = { url: (v.url ?? '').trim() };
  if (Object.keys(headers).length) config.headers = headers;
  return { name, config };
}

/** {name, config} → 表单值。headers.Authorization=Bearer xxx 反解为 Bearer 选项。 */
export function configToForm(name: string, c: McpConfig): McpFormValues {
  if (transportOf(c) === 'stdio') {
    const s = c as McpStdioConfig;
    return {
      type: 'stdio',
      name,
      command: s.command,
      args: (s.args ?? []).join(' '),
      env: objToKv(s.env),
    };
  }
  const r = c as McpRemoteConfig;
  const headers = { ...(r.headers ?? {}) };
  let auth: AuthKind = 'none';
  let token = '';
  if (typeof headers.Authorization === 'string' && headers.Authorization.startsWith('Bearer ')) {
    auth = 'bearer';
    token = headers.Authorization.slice('Bearer '.length);
    delete headers.Authorization;
  }
  return { type: 'remote', name, url: r.url, auth, token, headers: objToKv(headers) };
}

/** 校验表单，返回错误信息（null 表示通过）。existingNames 用于唯一性（编辑时排除自身）。 */
export function validateForm(v: McpFormValues, existingNames: Set<string>): string | null {
  const name = v.name.trim();
  if (!name) return 'MCP 名称不能为空';
  if (!/^[\w-]+$/.test(name)) return 'MCP 名称只能含字母、数字、- 和 _';
  if (existingNames.has(name)) return `名称 "${name}" 已存在`;
  if (v.type === 'stdio') {
    if (!(v.command ?? '').trim()) return '命令不能为空';
    return null;
  }
  const url = (v.url ?? '').trim();
  if (!url) return 'URL 不能为空';
  try {
    new URL(url);
  } catch {
    return 'URL 格式不合法';
  }
  return null;
}

/** 解析粘贴的 JSON（支持一次多个 server）。 */
export function parseMcpImport(text: string): ImportResult {
  const t = text.trim();
  if (!t) return { ok: false, error: '内容为空' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { ok: false, error: 'JSON 解析失败' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: '不是有效的 JSON 对象' };
  const root = parsed as Record<string, unknown>;
  const wrapped = root.mcpServers;
  const src = (wrapped && typeof wrapped === 'object' ? wrapped : root) as Record<string, unknown>;
  const servers = Object.entries(src).flatMap(([name, raw]) => {
    if (!raw || typeof raw !== 'object') return [];
    const c = raw as McpConfig;
    return transportOf(c) === '?' ? [] : [{ name, config: c }];
  });
  if (servers.length === 0) return { ok: false, error: '未发现有效的 mcpServers 配置' };
  return { ok: true, servers };
}

/** 新增/覆盖一个 server（先从两个集合删同名，再加入目标集合）。 */
export function upsertServer(
  cols: Collections,
  entry: { name: string; config: McpConfig },
  target: 'enabled' | 'disabled' = 'enabled',
): Collections {
  const en = parseCollection(cols.enabled).filter((e) => e.name !== entry.name);
  const dis = parseCollection(cols.disabled).filter((e) => e.name !== entry.name);
  if (target === 'enabled') en.push(entry);
  else dis.push(entry);
  return { enabled: stringify(en), disabled: stringify(dis) };
}

/** 删除一个 server（两个集合都删）。 */
export function removeServer(cols: Collections, name: string): Collections {
  return {
    enabled: stringify(parseCollection(cols.enabled).filter((e) => e.name !== name)),
    disabled: stringify(parseCollection(cols.disabled).filter((e) => e.name !== name)),
  };
}

/** 启停：在启用/禁用集合间迁移。 */
export function setEnabled(cols: Collections, name: string, enabled: boolean): Collections {
  const found = [...parseCollection(cols.enabled), ...parseCollection(cols.disabled)].find(
    (e) => e.name === name,
  );
  if (!found) return cols;
  return upsertServer(cols, found, enabled ? 'enabled' : 'disabled');
}

/** 批量导入合并，冲突默认跳过并记录。 */
export function mergeImport(
  cols: Collections,
  servers: Array<{ name: string; config: McpConfig }>,
): { cols: Collections; added: number; skipped: string[] } {
  const existing = new Set(
    [...parseCollection(cols.enabled), ...parseCollection(cols.disabled)].map((e) => e.name),
  );
  let result = cols;
  let added = 0;
  const skipped: string[] = [];
  for (const s of servers) {
    if (existing.has(s.name)) {
      skipped.push(s.name);
      continue;
    }
    result = upsertServer(result, s, 'enabled');
    existing.add(s.name);
    added += 1;
  }
  return { cols: result, added, skipped };
}
