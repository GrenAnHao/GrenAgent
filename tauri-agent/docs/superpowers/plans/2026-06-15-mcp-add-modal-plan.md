# MCP 添加改造 实现计划

> **面向 AI 代理的工作者：** 本仓库**禁止子代理**。用 `superpowers:executing-plans` 在当前会话内逐任务实现此计划。步骤用复选框（`- [ ]`）跟踪进度。
>
> 配套规格：`docs/superpowers/specs/2026-06-15-mcp-add-modal-design.md`。

**目标：** 把 `tauri-agent` 扩展页「插件(MCP)」区从「直接编辑 JSON textarea」改造为「添加 MCP 模态框（快速配置表单 / JSON 批量导入两 tab）+ server 卡片启停/编辑/删除」。

**架构：** 纯前端，不改后端、不新增 IPC。所有增删改启停最终落到两个 setting 字符串（`MCP_SERVERS` 启用集 / `MCP_SERVERS_DISABLED` 禁用集）的读写，复用 `useSettingsForm`（`persist` 静默存盘 + `save` 重启生效）。逻辑集中在纯函数模块 `mcpConfig.ts`，UI 拆成 `KeyValueEditor` / `McpTypeSelect` / `AddMcpModal` / `McpServerCard`，由 `ExtensionsPanel` 组装。

**技术栈：** React 19 + TypeScript + `@lobehub/ui`（Modal/Flexbox/Icon）+ antd（Switch/Input）+ antd-style（`createStaticStyles`/`cssVar`）+ lucide-react + vitest（jsdom）。

**约定：**
- 图标一律 lucide（直接组件或 `@lobehub/ui` 的 `Icon`），**禁止 emoji**（见 `.cursor/rules/no-emoji.mdc`）。
- 测试命令：`npx vitest run <file>`（在 `tauri-agent/` 下）。
- 类型检查：`npx tsc --noEmit`（在 `tauri-agent/` 下）。
- 样式数值与配色对齐已确认原型 `tauri-agent/.superpowers/brainstorm/mcp-mockup-v3.html`，但用 `cssVar` 适配亮/暗主题。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| 创建 `src/features/extensions/mcpConfig.ts` | 纯函数：解析/序列化两个集合、表单↔config 互转、JSON 导入解析、增删改启停 |
| 创建 `src/features/extensions/mcpConfig.test.ts` | mcpConfig 单测 |
| 创建 `src/features/extensions/KeyValueEditor.tsx` | env/headers 的键值对编辑器（受控） |
| 创建 `src/features/extensions/KeyValueEditor.test.tsx` | KeyValueEditor 单测 |
| 创建 `src/features/extensions/McpTypeSelect.tsx` | STDIO/REMOTE 类型选择卡片（受控） |
| 创建 `src/features/extensions/McpTypeSelect.test.tsx` | McpTypeSelect 单测 |
| 创建 `src/features/extensions/AddMcpModal.tsx` | 添加/编辑模态框（快速配置 + JSON 导入两 tab） |
| 创建 `src/features/extensions/AddMcpModal.test.tsx` | AddMcpModal 单测 |
| 创建 `src/features/extensions/McpServerCard.tsx` | 单个 server 卡片（状态点/pill/启停/编辑/删除） |
| 创建 `src/features/extensions/McpServerCard.test.tsx` | McpServerCard 单测 |
| 修改 `src/features/extensions/ExtensionsPanel.tsx` | 插件 tab 集成卡片列表 + 添加按钮 + 模态框；移除 MCP textarea；保留技能 tab 与「重启生效」机制 |
| 修改 `src/features/extensions/ExtensionsPanel.test.tsx` | 更新插件 tab 相关用例 |

类型集中定义在 `mcpConfig.ts` 并被各组件 import，保证一致。

---

## 任务 1：mcpConfig 纯函数模块

**文件：**
- 创建：`src/features/extensions/mcpConfig.ts`
- 测试：`src/features/extensions/mcpConfig.test.ts`

- [ ] **步骤 1：编写实现**

```ts
// src/features/extensions/mcpConfig.ts
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
```

- [ ] **步骤 2：编写测试**

```ts
// src/features/extensions/mcpConfig.test.ts
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
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npx vitest run src/features/extensions/mcpConfig.test.ts`
预期：PASS（全部用例）。若失败按报错修实现。

- [ ] **步骤 4：类型检查**

运行：`npx tsc --noEmit`
预期：0 错误。

- [ ] **步骤 5：Commit**

```bash
git add src/features/extensions/mcpConfig.ts src/features/extensions/mcpConfig.test.ts
git commit -m "feat(mcp): add mcpConfig pure helpers for parse/serialize/import"
```

---

## 任务 2：KeyValueEditor（env / headers 键值对编辑器）

**文件：**
- 创建：`src/features/extensions/KeyValueEditor.tsx`
- 测试：`src/features/extensions/KeyValueEditor.test.tsx`

- [ ] **步骤 1：编写实现**

```tsx
// src/features/extensions/KeyValueEditor.tsx
import { createStaticStyles, cssVar } from 'antd-style';
import { Minus, Plus } from 'lucide-react';

export type KvPairs = Array<[string, string]>;

interface KeyValueEditorProps {
  value: KvPairs;
  onChange: (next: KvPairs) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addText?: string;
  testId?: string;
}

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    gap: 8px;
    margin-block-end: 8px;
  `,
  input: css`
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;

    &:focus {
      border-color: ${cssVar.colorPrimary};
      outline: none;
    }
  `,
  rm: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    flex: 0 0 auto;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
  `,
  add: css`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: ${cssVar.colorPrimary};
    font-size: 12px;
    cursor: pointer;
  `,
}));

export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = 'KEY',
  valuePlaceholder = 'value',
  addText = '添加',
  testId = 'kv',
}: KeyValueEditorProps) {
  const setAt = (i: number, idx: 0 | 1, v: string) => {
    const next = value.map((p) => [...p] as [string, string]);
    next[i][idx] = v;
    onChange(next);
  };
  return (
    <div data-testid={testId}>
      {value.map((pair, i) => (
        <div key={i} className={styles.row}>
          <input
            className={styles.input}
            data-testid={`${testId}-key-${i}`}
            placeholder={keyPlaceholder}
            value={pair[0]}
            onChange={(e) => setAt(i, 0, e.target.value)}
          />
          <input
            className={styles.input}
            data-testid={`${testId}-val-${i}`}
            placeholder={valuePlaceholder}
            value={pair[1]}
            onChange={(e) => setAt(i, 1, e.target.value)}
          />
          <button
            type="button"
            className={styles.rm}
            data-testid={`${testId}-rm-${i}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <Minus size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.add}
        data-testid={`${testId}-add`}
        onClick={() => onChange([...value, ['', '']])}
      >
        <Plus size={13} />
        {addText}
      </button>
    </div>
  );
}
```

- [ ] **步骤 2：编写测试**

```tsx
// src/features/extensions/KeyValueEditor.test.tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyValueEditor, type KvPairs } from './KeyValueEditor';

afterEach(cleanup);

describe('KeyValueEditor', () => {
  it('adds, edits and removes rows', () => {
    let value: KvPairs = [['A', '1']];
    const onChange = vi.fn((next: KvPairs) => {
      value = next;
    });
    const { rerender } = render(<KeyValueEditor value={value} onChange={onChange} />);

    fireEvent.change(screen.getByTestId('kv-val-0'), { target: { value: '2' } });
    expect(onChange).toHaveBeenLastCalledWith([['A', '2']]);

    fireEvent.click(screen.getByTestId('kv-add'));
    expect(onChange).toHaveBeenLastCalledWith([['A', '1'], ['', '']]);

    rerender(<KeyValueEditor value={[['A', '1'], ['B', '2']]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('kv-rm-0'));
    expect(onChange).toHaveBeenLastCalledWith([['B', '2']]);
  });
});
```

- [ ] **步骤 3：运行测试**

运行：`npx vitest run src/features/extensions/KeyValueEditor.test.tsx`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add src/features/extensions/KeyValueEditor.tsx src/features/extensions/KeyValueEditor.test.tsx
git commit -m "feat(mcp): add KeyValueEditor for env/headers"
```

---

## 任务 3：McpTypeSelect（STDIO / REMOTE 类型卡片）

**文件：**
- 创建：`src/features/extensions/McpTypeSelect.tsx`
- 测试：`src/features/extensions/McpTypeSelect.test.tsx`

- [ ] **步骤 1：编写实现**

```tsx
// src/features/extensions/McpTypeSelect.tsx
import { createStaticStyles, cssVar } from 'antd-style';
import { Check, Router, Terminal } from 'lucide-react';

type McpType = 'stdio' | 'remote';

interface McpTypeSelectProps {
  value: McpType;
  onChange: (v: McpType) => void;
}

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    gap: 12px;
    margin-block-end: 16px;
  `,
  card: css`
    position: relative;
    flex: 1;
    padding: 12px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    cursor: pointer;
    transition: border-color 0.16s ease;

    &:hover {
      border-color: ${cssVar.colorPrimaryHover};
    }
  `,
  active: css`
    border-color: ${cssVar.colorPrimary};
  `,
  tick: css`
    position: absolute;
    inset-block-start: 10px;
    inset-inline-end: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: ${cssVar.colorPrimary};
    color: #fff;
  `,
  title: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  desc: css`
    margin-block-start: 5px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

const OPTIONS: Array<{ value: McpType; label: string; desc: string; Icon: typeof Terminal }> = [
  { value: 'stdio', label: 'STDIO', desc: '本地命令启动（npx / uvx…）', Icon: Terminal },
  { value: 'remote', label: 'REMOTE', desc: '远程 URL（HTTP / SSE）', Icon: Router },
];

export function McpTypeSelect({ value, onChange }: McpTypeSelectProps) {
  return (
    <div className={styles.row}>
      {OPTIONS.map(({ value: v, label, desc, Icon }) => (
        <div
          key={v}
          data-testid={`mcp-type-${v}`}
          className={`${styles.card} ${value === v ? styles.active : ''}`}
          onClick={() => onChange(v)}
        >
          {value === v ? (
            <span className={styles.tick}>
              <Check size={12} />
            </span>
          ) : null}
          <div className={styles.title}>
            <Icon size={16} />
            {label}
          </div>
          <div className={styles.desc}>{desc}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **步骤 2：编写测试**

```tsx
// src/features/extensions/McpTypeSelect.test.tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpTypeSelect } from './McpTypeSelect';

afterEach(cleanup);

describe('McpTypeSelect', () => {
  it('renders both options and fires onChange', () => {
    const onChange = vi.fn();
    render(<McpTypeSelect value="stdio" onChange={onChange} />);
    expect(screen.getByTestId('mcp-type-stdio')).toBeTruthy();
    expect(screen.getByTestId('mcp-type-remote')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mcp-type-remote'));
    expect(onChange).toHaveBeenCalledWith('remote');
  });
});
```

- [ ] **步骤 3：运行测试**

运行：`npx vitest run src/features/extensions/McpTypeSelect.test.tsx`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add src/features/extensions/McpTypeSelect.tsx src/features/extensions/McpTypeSelect.test.tsx
git commit -m "feat(mcp): add McpTypeSelect type cards"
```

---

## 任务 4：AddMcpModal（快速配置 + JSON 导入）

**文件：**
- 创建：`src/features/extensions/AddMcpModal.tsx`
- 测试：`src/features/extensions/AddMcpModal.test.tsx`

**接口约定（被 ExtensionsPanel 调用）：**
- props：`open: boolean`、`editing?: { name: string; config: McpConfig; enabled: boolean }`、`existingNames: string[]`、`onSubmitForm(entry, targetEnabled)`、`onSubmitImport(servers)`、`onClose()`。
- 内部维护 tab（`config` | `json`）、表单 state、JSON 文本 state、错误 state。
- 编辑模式：`editing` 存在时只显示快速配置 tab，标题「编辑 MCP」，回填 `configToForm`，提交走 `onSubmitForm`（保持原 enabled 集合）。

- [ ] **步骤 1：编写实现**

```tsx
// src/features/extensions/AddMcpModal.tsx
import { Modal } from '@lobehub/ui';
import { Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { useEffect, useState } from 'react';
import { KeyValueEditor } from './KeyValueEditor';
import { McpTypeSelect } from './McpTypeSelect';
import {
  configToForm,
  parseMcpImport,
  serializeForm,
  validateForm,
  type AuthKind,
  type McpConfig,
  type McpFormValues,
} from './mcpConfig';

interface AddMcpModalProps {
  open: boolean;
  editing?: { name: string; config: McpConfig; enabled: boolean };
  existingNames: string[];
  onSubmitForm: (entry: { name: string; config: McpConfig }, targetEnabled: boolean) => void;
  onSubmitImport: (servers: Array<{ name: string; config: McpConfig }>) => void;
  onClose: () => void;
}

type Tab = 'config' | 'json';

const EMPTY_FORM: McpFormValues = { type: 'stdio', name: '', command: '', args: '', env: [], url: '', auth: 'none', token: '', headers: [] };

const styles = createStaticStyles(({ css }) => ({
  seg: css`
    display: flex;
    gap: 4px;
    margin-block-end: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  tab: css`
    padding: 7px 14px;
    border: none;
    border-block-end: 2px solid transparent;
    margin-block-end: -1px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    cursor: pointer;
  `,
  tabActive: css`
    color: ${cssVar.colorText};
    font-weight: 600;
    border-block-end-color: ${cssVar.colorPrimary};
  `,
  field: css`
    margin-block-end: 14px;
  `,
  label: css`
    display: block;
    margin-block-end: 6px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  input: css`
    width: 100%;
    padding: 9px 11px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;

    &:focus {
      border-color: ${cssVar.colorPrimary};
      outline: none;
    }
  `,
  ta: css`
    width: 100%;
    min-height: 220px;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;

    &:focus {
      border-color: ${cssVar.colorPrimary};
      outline: none;
    }
  `,
  authRow: css`
    display: flex;
    gap: 8px;
    margin-block-end: 10px;
  `,
  authOpt: css`
    padding: 6px 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
  `,
  authActive: css`
    border-color: ${cssVar.colorPrimary};
    color: ${cssVar.colorText};
  `,
  error: css`
    margin-block-end: 10px;
    color: ${cssVar.colorError};
    font-size: 12px;
  `,
  foot: css`
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-block-start: 16px;
  `,
  btn: css`
    padding: 6px 16px;
    border: none;
    border-radius: 9px;
    background: ${cssVar.colorPrimary};
    color: #fff;
    font-size: 13px;
    cursor: pointer;
  `,
  ghost: css`
    background: transparent;
    border: 1px solid ${cssVar.colorBorder};
    color: ${cssVar.colorText};
  `,
}));

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "<your-token>" }
    }
  }
}`;

export function AddMcpModal({ open, editing, existingNames, onSubmitForm, onSubmitImport, onClose }: AddMcpModalProps) {
  const [tab, setTab] = useState<Tab>('config');
  const [form, setForm] = useState<McpFormValues>(EMPTY_FORM);
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setJson('');
    setTab('config');
    setForm(editing ? configToForm(editing.name, editing.config) : EMPTY_FORM);
  }, [open, editing]);

  const set = <K extends keyof McpFormValues>(k: K, v: McpFormValues[K]) => setForm((p) => ({ ...p, [k]: v }));

  const submitConfig = () => {
    const names = new Set(existingNames.filter((n) => n !== editing?.name));
    const err = validateForm(form, names);
    if (err) {
      setError(err);
      return;
    }
    onSubmitForm(serializeForm(form), editing ? editing.enabled : true);
    onClose();
  };

  const submitJson = () => {
    const r = parseMcpImport(json);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onSubmitImport(r.servers);
    onClose();
  };

  return (
    <Modal
      open={open}
      title={editing ? '编辑 MCP' : '添加 MCP'}
      footer={null}
      onCancel={onClose}
      data-testid="add-mcp-modal"
    >
      {!editing ? (
        <div className={styles.seg}>
          <button
            type="button"
            data-testid="mcp-tab-config"
            className={`${styles.tab} ${tab === 'config' ? styles.tabActive : ''}`}
            onClick={() => setTab('config')}
          >
            快速配置
          </button>
          <button
            type="button"
            data-testid="mcp-tab-json"
            className={`${styles.tab} ${tab === 'json' ? styles.tabActive : ''}`}
            onClick={() => setTab('json')}
          >
            JSON 导入
          </button>
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}

      {tab === 'config' || editing ? (
        <>
          <McpTypeSelect value={form.type} onChange={(t) => set('type', t)} />
          <div className={styles.field}>
            <label className={styles.label}>MCP 名称 *</label>
            <input
              className={styles.input}
              data-testid="mcp-name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="my-server"
            />
          </div>

          {form.type === 'stdio' ? (
            <>
              <div className={styles.field}>
                <label className={styles.label}>命令 *</label>
                <input className={styles.input} data-testid="mcp-command" value={form.command ?? ''} onChange={(e) => set('command', e.target.value)} placeholder="npx" />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>参数 args</label>
                <input className={styles.input} data-testid="mcp-args" value={form.args ?? ''} onChange={(e) => set('args', e.target.value)} placeholder="-y @scope/server" />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>环境变量 env</label>
                <KeyValueEditor value={form.env ?? []} onChange={(v) => set('env', v)} keyPlaceholder="VAR_NAME" addText="添加变量" testId="mcp-env" />
              </div>
            </>
          ) : (
            <>
              <div className={styles.field}>
                <label className={styles.label}>URL *</label>
                <input className={styles.input} data-testid="mcp-url" value={form.url ?? ''} onChange={(e) => set('url', e.target.value)} placeholder="https://mcp.example.com/sse" />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>鉴权</label>
                <div className={styles.authRow}>
                  {(['none', 'bearer'] as AuthKind[]).map((a) => (
                    <span
                      key={a}
                      data-testid={`mcp-auth-${a}`}
                      className={`${styles.authOpt} ${form.auth === a ? styles.authActive : ''}`}
                      onClick={() => set('auth', a)}
                    >
                      {a === 'none' ? '无' : 'Bearer Token'}
                    </span>
                  ))}
                </div>
                {form.auth === 'bearer' ? (
                  <input className={styles.input} data-testid="mcp-token" value={form.token ?? ''} onChange={(e) => set('token', e.target.value)} placeholder="Bearer 令牌" />
                ) : null}
              </div>
              <div className={styles.field}>
                <label className={styles.label}>请求头 Headers</label>
                <KeyValueEditor value={form.headers ?? []} onChange={(v) => set('headers', v)} keyPlaceholder="Header" addText="添加请求头" testId="mcp-headers" />
              </div>
            </>
          )}

          <div className={styles.foot}>
            <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={onClose}>取消</button>
            <button type="button" className={styles.btn} data-testid="mcp-submit" onClick={submitConfig}>{editing ? '保存' : '添加'}</button>
          </div>
        </>
      ) : (
        <>
          <textarea className={styles.ta} data-testid="mcp-json" value={json} onChange={(e) => setJson(e.target.value)} placeholder={JSON_PLACEHOLDER} />
          <div className={styles.foot}>
            <button type="button" className={`${styles.btn} ${styles.ghost}`} onClick={onClose}>取消</button>
            <button type="button" className={styles.btn} data-testid="mcp-import" onClick={submitJson}>导入</button>
          </div>
        </>
      )}
    </Modal>
  );
}
```

- [ ] **步骤 2：编写测试**

```tsx
// src/features/extensions/AddMcpModal.test.tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import { AddMcpModal } from './AddMcpModal';

afterEach(cleanup);

const renderModal = (props: Partial<Parameters<typeof AddMcpModal>[0]> = {}) =>
  render(
    <ThemeProvider>
      <AddMcpModal
        open
        existingNames={[]}
        onSubmitForm={props.onSubmitForm ?? vi.fn()}
        onSubmitImport={props.onSubmitImport ?? vi.fn()}
        onClose={props.onClose ?? vi.fn()}
        editing={props.editing}
      />
    </ThemeProvider>,
  );

describe('AddMcpModal', () => {
  it('submits a STDIO form config', () => {
    const onSubmitForm = vi.fn();
    renderModal({ onSubmitForm });
    fireEvent.change(screen.getByTestId('mcp-name'), { target: { value: 'gh' } });
    fireEvent.change(screen.getByTestId('mcp-command'), { target: { value: 'npx' } });
    fireEvent.click(screen.getByTestId('mcp-submit'));
    expect(onSubmitForm).toHaveBeenCalledWith({ name: 'gh', config: { command: 'npx' } }, true);
  });

  it('shows validation error for empty name', () => {
    const onSubmitForm = vi.fn();
    renderModal({ onSubmitForm });
    fireEvent.click(screen.getByTestId('mcp-submit'));
    expect(onSubmitForm).not.toHaveBeenCalled();
    expect(screen.getByText(/名称不能为空/)).toBeTruthy();
  });

  it('switches to REMOTE and submits url + bearer', () => {
    const onSubmitForm = vi.fn();
    renderModal({ onSubmitForm });
    fireEvent.click(screen.getByTestId('mcp-type-remote'));
    fireEvent.change(screen.getByTestId('mcp-name'), { target: { value: 'r' } });
    fireEvent.change(screen.getByTestId('mcp-url'), { target: { value: 'https://x.com' } });
    fireEvent.click(screen.getByTestId('mcp-auth-bearer'));
    fireEvent.change(screen.getByTestId('mcp-token'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('mcp-submit'));
    expect(onSubmitForm).toHaveBeenCalledWith(
      { name: 'r', config: { url: 'https://x.com', headers: { Authorization: 'Bearer abc' } } },
      true,
    );
  });

  it('imports JSON with multiple servers', () => {
    const onSubmitImport = vi.fn();
    renderModal({ onSubmitImport });
    fireEvent.click(screen.getByTestId('mcp-tab-json'));
    fireEvent.change(screen.getByTestId('mcp-json'), {
      target: { value: '{"mcpServers":{"a":{"command":"npx"},"b":{"url":"https://y"}}}' },
    });
    fireEvent.click(screen.getByTestId('mcp-import'));
    expect(onSubmitImport).toHaveBeenCalledWith([
      { name: 'a', config: { command: 'npx' } },
      { name: 'b', config: { url: 'https://y' } },
    ]);
  });
});
```

- [ ] **步骤 3：运行测试**

运行：`npx vitest run src/features/extensions/AddMcpModal.test.tsx`
预期：PASS。若 `Modal` 在 jsdom 下需要 portal 容器，确认 `ThemeProvider` 包裹即可（其余 panel 测试已用此模式）。

- [ ] **步骤 4：类型检查 + Commit**

运行：`npx tsc --noEmit` → 0 错误。

```bash
git add src/features/extensions/AddMcpModal.tsx src/features/extensions/AddMcpModal.test.tsx
git commit -m "feat(mcp): add AddMcpModal with quick-config and JSON import tabs"
```

---

## 任务 5：McpServerCard（卡片 + 启停/编辑/删除）

**文件：**
- 创建：`src/features/extensions/McpServerCard.tsx`
- 测试：`src/features/extensions/McpServerCard.test.tsx`

- [ ] **步骤 1：编写实现**

```tsx
// src/features/extensions/McpServerCard.tsx
import { Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { PencilLine, Trash2 } from 'lucide-react';
import { transportOf, type McpConfig } from './mcpConfig';

export interface McpLiveStatus {
  status: 'connecting' | 'connected' | 'failed';
  tools: number;
}

interface McpServerCardProps {
  name: string;
  config: McpConfig;
  enabled: boolean;
  live?: McpLiveStatus;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}

function dotColor(enabled: boolean, live?: McpLiveStatus): string {
  if (!enabled) return '#8a8f98';
  if (!live) return '#8a8f98';
  if (live.status === 'connected') return '#3ddc84';
  if (live.status === 'connecting') return '#f5a623';
  return '#f5635b';
}

function statusLabel(enabled: boolean, live?: McpLiveStatus): string {
  if (!enabled) return '已禁用';
  if (!live) return '待连接';
  if (live.status === 'connected') return `${live.tools} 工具`;
  if (live.status === 'connecting') return '连接中…';
  return '连接失败';
}

const styles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 14px;
    margin-block-end: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    transition: border-color 0.16s ease, background 0.16s ease;

    &:hover {
      border-color: ${cssVar.colorBorder};
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  disabled: css`
    opacity: 0.55;
  `,
  dot: css`
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
  `,
  name: css`
    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  pill: css`
    padding: 1px 8px;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextSecondary};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    text-transform: uppercase;
  `,
  grow: css`
    flex: 1;
    min-width: 0;
  `,
  status: css`
    font-size: 11px;
  `,
  ops: css`
    display: flex;
    align-items: center;
    gap: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  iconbtn: css`
    display: inline-flex;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
  `,
}));

export function McpServerCard({ name, config, enabled, live, onToggle, onEdit, onDelete }: McpServerCardProps) {
  const color = dotColor(enabled, live);
  return (
    <div className={`${styles.card} ${enabled ? '' : styles.disabled}`} data-testid={`mcp-server-${name}`}>
      <span className={styles.dot} style={{ background: color }} />
      <span className={styles.name}>{name}</span>
      <span className={styles.pill}>{transportOf(config)}</span>
      <span className={styles.grow} />
      <span className={styles.status} style={{ color }}>{statusLabel(enabled, live)}</span>
      <span className={styles.ops}>
        <Switch size="small" checked={enabled} onChange={onToggle} data-testid={`mcp-toggle-${name}`} />
        <button type="button" className={styles.iconbtn} data-testid={`mcp-edit-${name}`} onClick={onEdit}>
          <PencilLine size={15} />
        </button>
        <button type="button" className={styles.iconbtn} data-testid={`mcp-delete-${name}`} onClick={onDelete}>
          <Trash2 size={15} />
        </button>
      </span>
    </div>
  );
}
```

- [ ] **步骤 2：编写测试**

```tsx
// src/features/extensions/McpServerCard.test.tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServerCard } from './McpServerCard';

afterEach(cleanup);

describe('McpServerCard', () => {
  it('shows transport, status and wires actions', () => {
    const onToggle = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <McpServerCard
        name="gh"
        config={{ command: 'npx' }}
        enabled
        live={{ status: 'connected', tools: 12 }}
        onToggle={onToggle}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('stdio');
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('12 工具');
    expect(screen.getByTestId('mcp-toggle-gh').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('mcp-edit-gh'));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mcp-delete-gh'));
    expect(onDelete).toHaveBeenCalled();
  });
});
```

- [ ] **步骤 3：运行测试 + Commit**

运行：`npx vitest run src/features/extensions/McpServerCard.test.tsx` → PASS。

```bash
git add src/features/extensions/McpServerCard.tsx src/features/extensions/McpServerCard.test.tsx
git commit -m "feat(mcp): add McpServerCard with toggle/edit/delete"
```

---

## 任务 6：ExtensionsPanel 集成改造

**文件：**
- 修改：`src/features/extensions/ExtensionsPanel.tsx`
- 修改：`src/features/extensions/ExtensionsPanel.test.tsx`

**改造点（在现有 v 已有的 tab + 重启机制基础上）：**
1. 删除 MCP 区的 `<textarea>`（`ext-field-MCP_SERVERS`）与「配置（JSON）」label。
2. MCP 区改为：hero 标题右侧放「添加 MCP」按钮（`Plus` 图标，testid `mcp-add`）；下方用 `listEntries` 渲染 `McpServerCard` 列表（启用在前、禁用在后）。
3. 新增状态：`modalOpen`、`editing`。点击「添加 MCP」→ `modalOpen=true, editing=undefined`；卡片 `onEdit` → `editing=该项`。
4. 集合读写：`cols = { enabled: values.MCP_SERVERS ?? '', disabled: values.MCP_SERVERS_DISABLED ?? '' }`；任何变更后 `setValue('MCP_SERVERS', next.enabled); setValue('MCP_SERVERS_DISABLED', next.disabled); markChanged()`。
5. `live` 状态：`liveByName.get(name)`。
6. 删除走 `window.confirm`（jsdom 可 mock）二次确认。

- [ ] **步骤 1：改实现（关键片段）**

在 import 增加：

```tsx
import { Plus } from 'lucide-react';
import { AddMcpModal } from './AddMcpModal';
import { McpServerCard } from './McpServerCard';
import {
  listEntries,
  mergeImport,
  removeServer,
  setEnabled,
  upsertServer,
  type Collections,
  type McpConfig,
} from './mcpConfig';
```

组件内（替换原 mcpServers 解析与 MCP 区渲染）：

```tsx
const cols: Collections = {
  enabled: values.MCP_SERVERS ?? '',
  disabled: values.MCP_SERVERS_DISABLED ?? '',
};
const entries = listEntries(cols).sort((a, b) => Number(b.enabled) - Number(a.enabled));
const existingNames = entries.map((e) => e.name);

const [modalOpen, setModalOpen] = useState(false);
const [editing, setEditing] = useState<{ name: string; config: McpConfig; enabled: boolean } | undefined>(undefined);

const writeCols = (next: Collections) => {
  setValue('MCP_SERVERS', next.enabled);
  setValue('MCP_SERVERS_DISABLED', next.disabled);
  markChanged();
};
const handleSubmitForm = (entry: { name: string; config: McpConfig }, targetEnabled: boolean) =>
  writeCols(upsertServer(cols, entry, targetEnabled ? 'enabled' : 'disabled'));
const handleSubmitImport = (servers: Array<{ name: string; config: McpConfig }>) =>
  writeCols(mergeImport(cols, servers).cols);
const handleToggle = (name: string, enabled: boolean) => writeCols(setEnabled(cols, name, enabled));
const handleDelete = (name: string) => {
  if (window.confirm(`确认删除 MCP "${name}"？`)) writeCols(removeServer(cols, name));
};
```

MCP 区 hero + 列表（替换原 MCP 列表与 textarea）：

```tsx
<div className={styles.hero}>
  <span className={styles.heroTitle}>
    MCP 服务器
    {entries.length > 0 ? <span className={styles.count}>{entries.length}</span> : null}
  </span>
  <button type="button" className={styles.addBtn} data-testid="mcp-add" onClick={() => { setEditing(undefined); setModalOpen(true); }}>
    <Plus size={14} /> 添加 MCP
  </button>
</div>

{entries.length === 0 ? (
  <div className={styles.empty} data-testid="mcp-empty">未配置 MCP server</div>
) : (
  entries.map((e) => (
    <McpServerCard
      key={e.name}
      name={e.name}
      config={e.config}
      enabled={e.enabled}
      live={liveMcpByName.get(e.name)}
      onToggle={(v) => handleToggle(e.name, v)}
      onEdit={() => { setEditing(e); setModalOpen(true); }}
      onDelete={() => handleDelete(e.name)}
    />
  ))
)}

<AddMcpModal
  open={modalOpen}
  editing={editing}
  existingNames={existingNames}
  onSubmitForm={handleSubmitForm}
  onSubmitImport={handleSubmitImport}
  onClose={() => setModalOpen(false)}
/>
```

> 新增样式类 `addBtn`（primary 小按钮，含 `Plus`）；`hero` 改为 `justify-content: space-between`。其余样式沿用现有文件。删除原 `tag`/`statusText`/textarea(`field`/`fieldLabel`) 中仅 MCP 用到、现已无引用的类（用 `tsc`/lint 的 unused 提示确认后再删，避免误删技能区共用类）。

- [ ] **步骤 2：更新测试**

把原 `ExtensionsPanel.test.tsx` 的 MCP 用例改为面向卡片 + 默认 tab=mcp：

```tsx
it('lists MCP servers as cards from MCP_SERVERS', async () => {
  getSettings.mockResolvedValueOnce({
    MCP_SERVERS: '{"mcpServers":{"fs":{"command":"npx","args":[]},"api":{"url":"https://m"}}}',
  });
  render(<ExtensionsPanel />);
  await waitFor(() => expect(screen.getByTestId('mcp-server-fs')).toBeTruthy());
  expect(screen.getByTestId('mcp-server-fs').textContent).toContain('stdio');
  expect(screen.getByTestId('mcp-server-api').textContent).toContain('sse');
});

it('opens add modal from the add button', async () => {
  getSettings.mockResolvedValueOnce({});
  render(<ExtensionsPanel />);
  fireEvent.click(screen.getByTestId('mcp-add'));
  await waitFor(() => expect(screen.getByTestId('add-mcp-modal')).toBeTruthy());
});
```

技能 tab 的用例（任务历史中的 `ext-tab-skills` + Switch + 重启按钮）保持不变。

- [ ] **步骤 3：运行测试 + 类型检查 + lint**

```bash
npx vitest run src/features/extensions/ExtensionsPanel.test.tsx
npx tsc --noEmit
```
预期：测试 PASS、tsc 0 错误。用 ReadLints 检查改动文件无新增 lint。

- [ ] **步骤 4：Commit**

```bash
git add src/features/extensions/ExtensionsPanel.tsx src/features/extensions/ExtensionsPanel.test.tsx
git commit -m "feat(mcp): integrate add modal + server cards into ExtensionsPanel"
```

---

## 任务 7：settingsSchema 注册 MCP_SERVERS_DISABLED（如需）+ 全量验证

**文件：**
- 修改（按需）：`src/features/settings/settingsSchema.ts`

- [ ] **步骤 1：确认存储键**

`MCP_SERVERS_DISABLED` 由 `useSettingsForm` 的 `values`/`setValue`/`persist` 透明读写（map 任意 key），**无需** schema 注册即可存盘。仅当存在「设置面板需展示该字段」需求时才加到 `settingsSchema`。本计划默认不在 GUI 暴露它（纯内部状态），跳过此步。

- [ ] **步骤 2：全量验证**

```bash
npx vitest run src/features/extensions
npx tsc --noEmit
```
预期：extensions 目录所有测试 PASS；tsc 0 错误。

- [ ] **步骤 3：手动冒烟（可选，开发者本地）**

`npm run tauri dev` → 扩展页插件 tab：添加（STDIO/REMOTE/JSON 导入）、启停、编辑、删除均生效；改动后出现「重启生效」；重启后状态点正确。

- [ ] **步骤 4：Commit（若步骤 1 改了 schema）**

```bash
git add src/features/settings/settingsSchema.ts
git commit -m "chore(mcp): document MCP_SERVERS_DISABLED internal setting"
```

---

## 自检

**1. 规格覆盖度：**
- 结构（模态框 + 两 tab）→ 任务 4。
- STDIO/REMOTE 字段 → 任务 3、4（含 env/headers 任务 2）。
- JSON 批量导入 + 冲突跳过 → 任务 1（`mergeImport`）+ 任务 4。
- 卡片启停/编辑/删除 → 任务 5 + 任务 6。
- 双 setting 存储（启用/禁用迁移）→ 任务 1（`setEnabled`/`upsert`/`remove`）+ 任务 6。
- 移除 JSON textarea → 任务 6 步骤 1。
- 自动存盘 + 重启生效 → 复用现有 `markChanged`/`persist`/`save`（任务 6 接入 `writeCols`）。
- 无测试连接、状态点 → 任务 5（`dotColor`/`statusLabel`）。
- lucide 图标、无 emoji → 全任务遵守。

**2. 占位符扫描：** 无 TODO/待定；每个代码步骤含可运行代码。样式数值参照原型 v3，已用 `cssVar` 写出具体类。

**3. 类型一致性：** `McpConfig`/`McpFormValues`/`Collections`/`McpEntry` 全部定义于 `mcpConfig.ts` 并被各组件 import；函数名 `serializeForm`/`configToForm`/`validateForm`/`parseMcpImport`/`upsertServer`/`removeServer`/`setEnabled`/`mergeImport`/`listEntries`/`transportOf` 在任务 4、5、6 调用处一致。

---

## 执行交接

本仓库禁止子代理 → 用 `superpowers:executing-plans` 在当前会话内逐任务、按复选框推进，每个任务结束后做检查点（测试 + tsc 通过再 commit）。
