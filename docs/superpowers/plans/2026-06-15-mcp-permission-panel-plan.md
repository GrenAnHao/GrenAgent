# MCP 权限控制 · 阶段 2（前端管理面板）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 给 `~/.pi/mcp-policy.json` / `mcp-audit.jsonl` 加可视化管理面板：`McpServerCard` 可展开看每个工具并用 `Segmented` 调三态、`ToolPermissionModal` 编辑参数规则、`AuditModal` 查看审计；权限变更即时生效不重启。

**架构：** sidecar 的 `mcp` 扩展 summary 增推 `toolNames`；新增 Rust `mcp_policy.rs` 读写 `~/.pi/` 下策略/审计文件；前端纯函数 `mcpPolicy.ts` 编辑 policy 原始对象（保字段）+ `mcpPolicyIo.ts` invoke 封装 + 三个组件改造/新增。

**技术栈：** TypeScript + React 19 + `@lobehub/ui` + antd（`Segmented`/`Switch`/`Select`）+ antd-style（`createStaticStyles`/`cssVar`）+ lucide + vitest；Rust（tauri 2 command + `dirs` crate）。

**参考设计：** `docs/superpowers/specs/2026-06-15-mcp-permission-panel-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `extensions/mcp/index.ts`（改） | summary 增推每 server `toolNames`（注册全名） |
| `tauri-agent/src/stores/mcpStatusStore.ts`（改） | `McpServerStatus` 加 `toolNames?` |
| `tauri-agent/src-tauri/src/commands/mcp_policy.rs`（新） | `read_mcp_policy/write_mcp_policy/read_mcp_audit`，路径限 `~/.pi/` |
| `tauri-agent/src-tauri/src/commands/mod.rs`（改） | `pub mod mcp_policy;` |
| `tauri-agent/src-tauri/src/lib.rs`（改） | 注册 3 个 command |
| `tauri-agent/src/features/extensions/mcpPolicy.ts`（新） | 纯函数：解析/读改 policy raw + 审计解析 + 短名 |
| `tauri-agent/src/lib/mcpPolicyIo.ts`（新） | invoke 封装 |
| `tauri-agent/src/features/extensions/McpServerCard.tsx`（改） | 可展开 + 工具行 Segmented 三态 + 规则按钮 |
| `tauri-agent/src/features/extensions/ToolPermissionModal.tsx`（新） | 三态 + 规则数组编辑 |
| `tauri-agent/src/features/extensions/AuditModal.tsx`（新） | 审计列表 + 筛选 |
| `tauri-agent/src/features/extensions/ExtensionsPanel.tsx`（改） | 持 policy state + 接线 + 审计入口 |

---

## 任务 1：sidecar 推工具名 + store 字段

**文件：** 改 `extensions/mcp/index.ts`、`tauri-agent/src/stores/mcpStatusStore.ts`、`tauri-agent/src/stores/mcpStatusStore.test.ts`

- [ ] **步骤 1：mcp registry 类型加 toolNames** — 把 `const registry = new Map<string, { status: McpStatus; tools: number; error?: string }>();` 改为：

```ts
  const registry = new Map<string, { status: McpStatus; tools: number; error?: string; toolNames?: string[] }>();
```

- [ ] **步骤 2：summary 增推 toolNames** — 在 summary 的 map 对象末尾加一行：

```ts
      tools: registry.get(s.name)?.tools ?? 0,
      toolNames: registry.get(s.name)?.toolNames ?? [],
    }));
```

- [ ] **步骤 3：connectServer 成功分支存 toolNames** — 把 `registry.set(s.name, { status: "connected", tools: tools.length });` 改为：

```ts
      registry.set(s.name, { status: "connected", tools: tools.length, toolNames: newNames });
```

- [ ] **步骤 4：store 失败测试** — 在 `mcpStatusStore.test.ts` 追加：

```ts
  it('carries toolNames when provided', () => {
    useMcpStatusStore.getState().setServers([
      { name: 'fs', transport: 'stdio', status: 'connected', tools: 2, toolNames: ['mcp__fs__read', 'mcp__fs__write'] },
    ]);
    expect(useMcpStatusStore.getState().servers[0].toolNames).toEqual(['mcp__fs__read', 'mcp__fs__write']);
  });
```

- [ ] **步骤 5：运行验证失败** — `cd tauri-agent && bunx vitest run src/stores/mcpStatusStore.test.ts`，预期 FAIL（`toolNames` 不在类型上）。

- [ ] **步骤 6：store 加字段** — `McpServerStatus` 接口加 `toolNames?: string[];`（在 `tools: number;` 之后）。

- [ ] **步骤 7：运行验证通过** — 同命令，预期 PASS。

- [ ] **步骤 8：Commit**

```bash
git add extensions/mcp/index.ts tauri-agent/src/stores/mcpStatusStore.ts tauri-agent/src/stores/mcpStatusStore.test.ts
git commit -m "feat(mcp-policy-ui): sidecar pushes toolNames + store field (任务1/7)"
```

---

## 任务 2：Rust command（mcp_policy.rs）

**文件：** 新 `tauri-agent/src-tauri/src/commands/mcp_policy.rs`；改 `commands/mod.rs`、`lib.rs`

- [ ] **步骤 1：创建 `mcp_policy.rs`**

```rust
use std::fs;
use std::path::PathBuf;

fn pi_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home directory".to_string())?;
    Ok(home.join(".pi"))
}

#[tauri::command]
pub async fn read_mcp_policy() -> Result<String, String> {
    let path = pi_dir()?.join("mcp-policy.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn write_mcp_policy(content: String) -> Result<(), String> {
    let dir = pi_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("mcp-policy.json");
    let tmp = dir.join("mcp-policy.json.tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn read_mcp_audit() -> Result<String, String> {
    let path = pi_dir()?.join("mcp-audit.jsonl");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}
```

- [ ] **步骤 2：`commands/mod.rs` 声明** — 加一行 `pub mod mcp_policy;`（在 `pub mod knowledge;` 与 `pub mod memory;` 之间，保持字母序）。

- [ ] **步骤 3：`lib.rs` 注册** — 在 `commands::files::write_file,` 之后加：

```rust
            commands::mcp_policy::read_mcp_policy,
            commands::mcp_policy::write_mcp_policy,
            commands::mcp_policy::read_mcp_audit,
```

- [ ] **步骤 4：cargo check** — `cd tauri-agent/src-tauri && cargo check`，预期通过（`dirs` 已在依赖）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/mcp_policy.rs tauri-agent/src-tauri/src/commands/mod.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(mcp-policy-ui): rust commands for ~/.pi policy & audit (任务2/7)"
```

---

## 任务 3：前端纯函数 + invoke 封装

**文件：** 新 `features/extensions/mcpPolicy.ts`、`features/extensions/mcpPolicy.test.ts`、`lib/mcpPolicyIo.ts`

- [ ] **步骤 1：写失败测试 `mcpPolicy.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  getToolPerm, getToolRules, parseAuditLines, parsePolicyDoc,
  serializePolicyDoc, setToolPerm, setToolRules, shortToolName,
} from './mcpPolicy';

describe('parsePolicyDoc', () => {
  it('returns {} for empty / invalid', () => {
    expect(parsePolicyDoc('')).toEqual({});
    expect(parsePolicyDoc('nope')).toEqual({});
  });
});

describe('getToolPerm', () => {
  it('defaults to auto when missing', () => {
    expect(getToolPerm({}, 'mcp__s__t')).toBe('auto');
  });
  it('reads existing permission', () => {
    expect(getToolPerm({ tools: { mcp__s__t: { permission: 'disabled' } } }, 'mcp__s__t')).toBe('disabled');
  });
});

describe('setToolPerm', () => {
  it('is immutable and preserves other fields', () => {
    const raw = { defaultPermission: 'auto', tools: { mcp__a__x: { permission: 'disabled' } } };
    const next = setToolPerm(raw, 'mcp__s__t', 'needs_approval');
    expect(getToolPerm(next, 'mcp__s__t')).toBe('needs_approval');
    expect(getToolPerm(next, 'mcp__a__x')).toBe('disabled');
    expect(next.defaultPermission).toBe('auto');
    expect(raw.tools).not.toHaveProperty('mcp__s__t');
  });
});

describe('setToolRules', () => {
  it('sets and clears rules', () => {
    const withRules = setToolRules({}, 'mcp__s__t', [{ match: { p: 'x' }, policy: 'always' }]);
    expect(getToolRules(withRules, 'mcp__s__t')).toEqual([{ match: { p: 'x' }, policy: 'always' }]);
    expect(getToolRules(setToolRules(withRules, 'mcp__s__t', []), 'mcp__s__t')).toEqual([]);
  });
});

describe('parseAuditLines', () => {
  it('parses jsonl and skips malformed', () => {
    const out = parseAuditLines('{"ts":"t1","server":"s","tool":"x","decision":"approved","argsDigest":"{}"}\nbad\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ server: 's', tool: 'x', decision: 'approved' });
  });
});

describe('shortToolName', () => {
  it('strips mcp__server__ prefix', () => {
    expect(shortToolName('mcp__github__create_issue')).toBe('create_issue');
    expect(shortToolName('plain')).toBe('plain');
  });
});

describe('serializePolicyDoc', () => {
  it('round-trips', () => {
    const raw = parsePolicyDoc(serializePolicyDoc({ tools: { mcp__s__t: { permission: 'auto' } } }));
    expect(getToolPerm(raw, 'mcp__s__t')).toBe('auto');
  });
});
```

- [ ] **步骤 2：运行验证失败** — `cd tauri-agent && bunx vitest run src/features/extensions/mcpPolicy.test.ts`，预期 FAIL。

- [ ] **步骤 3：实现 `mcpPolicy.ts`**

```ts
export type Perm = 'auto' | 'needs_approval' | 'disabled';
export type RulePolicy = 'never' | 'required' | 'always';

export interface RuleItem {
  match?: Record<string, string>;
  policy: RulePolicy;
}

export interface AuditEntry {
  ts: string;
  server: string;
  tool: string;
  decision: string;
  argsDigest: string;
}

const PERMS: Perm[] = ['auto', 'needs_approval', 'disabled'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function parsePolicyDoc(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const v = JSON.parse(json);
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

function toolsOf(raw: Record<string, unknown>): Record<string, unknown> {
  return isRecord(raw.tools) ? raw.tools : {};
}

export function getToolPerm(raw: Record<string, unknown>, fullName: string): Perm {
  const entry = toolsOf(raw)[fullName];
  const p = isRecord(entry) ? entry.permission : undefined;
  return PERMS.includes(p as Perm) ? (p as Perm) : 'auto';
}

export function getToolRules(raw: Record<string, unknown>, fullName: string): RuleItem[] {
  const entry = toolsOf(raw)[fullName];
  const rules = isRecord(entry) && Array.isArray(entry.rules) ? entry.rules : [];
  return rules.filter(isRecord).map((r): RuleItem => {
    const policy = r.policy === 'never' || r.policy === 'required' || r.policy === 'always' ? r.policy : 'required';
    const item: RuleItem = { policy };
    if (isRecord(r.match)) {
      const m: Record<string, string> = {};
      for (const [k, val] of Object.entries(r.match)) if (typeof val === 'string') m[k] = val;
      item.match = m;
    }
    return item;
  });
}

function ensureEntry(raw: Record<string, unknown>, fullName: string): {
  next: Record<string, unknown>;
  entry: Record<string, unknown>;
} {
  const next = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const tools = isRecord(next.tools) ? next.tools : {};
  const entry = isRecord(tools[fullName]) ? (tools[fullName] as Record<string, unknown>) : {};
  tools[fullName] = entry;
  next.tools = tools;
  return { next, entry };
}

export function setToolPerm(raw: Record<string, unknown>, fullName: string, perm: Perm): Record<string, unknown> {
  const { next, entry } = ensureEntry(raw, fullName);
  entry.permission = perm;
  return next;
}

export function setToolRules(raw: Record<string, unknown>, fullName: string, rules: RuleItem[]): Record<string, unknown> {
  const { next, entry } = ensureEntry(raw, fullName);
  if (rules.length === 0) delete entry.rules;
  else entry.rules = rules;
  return next;
}

export function serializePolicyDoc(raw: Record<string, unknown>): string {
  return JSON.stringify(raw, null, 2);
}

export function parseAuditLines(text: string): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (isRecord(v)) {
        out.push({
          ts: String(v.ts ?? ''),
          server: String(v.server ?? ''),
          tool: String(v.tool ?? ''),
          decision: String(v.decision ?? ''),
          argsDigest: String(v.argsDigest ?? ''),
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export function shortToolName(fullName: string): string {
  const rest = fullName.startsWith('mcp__') ? fullName.slice(5) : fullName;
  const i = rest.indexOf('__');
  return i >= 0 ? rest.slice(i + 2) : rest;
}
```

- [ ] **步骤 4：运行验证通过** — 同命令，预期 PASS。

- [ ] **步骤 5：实现 `lib/mcpPolicyIo.ts`**

```ts
import { invoke } from '@tauri-apps/api/core';

export function readMcpPolicy(): Promise<string> {
  return invoke<string>('read_mcp_policy');
}

export function writeMcpPolicy(content: string): Promise<void> {
  return invoke<void>('write_mcp_policy', { content });
}

export function readMcpAudit(): Promise<string> {
  return invoke<string>('read_mcp_audit');
}
```

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/extensions/mcpPolicy.ts tauri-agent/src/features/extensions/mcpPolicy.test.ts tauri-agent/src/lib/mcpPolicyIo.ts
git commit -m "feat(mcp-policy-ui): policy doc helpers + invoke io (任务3/7)"
```

---

## 任务 4：McpServerCard 可展开 + Segmented 三态

**文件：** 改 `tauri-agent/src/features/extensions/McpServerCard.tsx`

- [ ] **步骤 1：整体替换为可展开版本**（保留原有卡片行外观，外层包一层 wrap，新增展开区）

```tsx
import { Segmented, Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronRight, PencilLine, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { transportOf, type McpConfig } from './mcpConfig';
import { getToolPerm, shortToolName, type Perm } from './mcpPolicy';

export interface McpLiveStatus {
  status: 'connecting' | 'connected' | 'failed';
  tools: number;
  toolNames?: string[];
}

interface McpServerCardProps {
  name: string;
  config: McpConfig;
  enabled: boolean;
  live?: McpLiveStatus;
  policyRaw?: Record<string, unknown>;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onPermChange?: (fullName: string, perm: Perm) => void;
  onOpenRules?: (fullName: string) => void;
}

const PERM_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '需审批', value: 'needs_approval' },
  { label: '禁用', value: 'disabled' },
];

function dotColor(enabled: boolean, live?: McpLiveStatus): string {
  if (!enabled || !live) return '#8a8f98';
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
  wrap: css`
    margin-block-end: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    overflow: hidden;
  `,
  card: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 14px;
  `,
  disabled: css`
    opacity: 0.55;
  `,
  expandBtn: css`
    display: inline-flex;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
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
  tools: css`
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    padding: 6px 14px 10px;
  `,
  toolRow: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding-block: 6px;
  `,
  toolName: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  hint: css`
    padding: 8px 0;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

export function McpServerCard({
  name, config, enabled, live, policyRaw = {},
  onToggle, onEdit, onDelete, onPermChange, onOpenRules,
}: McpServerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const color = dotColor(enabled, live);
  const toolNames = live?.toolNames ?? [];
  return (
    <div className={styles.wrap} data-testid={`mcp-server-${name}`}>
      <div className={`${styles.card} ${enabled ? '' : styles.disabled}`}>
        <button
          type="button"
          className={styles.expandBtn}
          data-testid={`mcp-expand-${name}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
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
      {expanded ? (
        <div className={styles.tools}>
          {!enabled || !live || live.status !== 'connected' ? (
            <div className={styles.hint}>连接后可查看并配置工具权限</div>
          ) : toolNames.length === 0 ? (
            <div className={styles.hint}>该 server 无工具</div>
          ) : (
            toolNames.map((full) => (
              <div key={full} className={styles.toolRow} data-testid={`mcp-tool-${full}`}>
                <span className={styles.toolName} title={full}>{shortToolName(full)}</span>
                <Segmented
                  size="small"
                  value={getToolPerm(policyRaw, full)}
                  options={PERM_OPTIONS}
                  onChange={(v) => onPermChange?.(full, v as Perm)}
                  data-testid={`mcp-perm-${full}`}
                />
                <button
                  type="button"
                  className={styles.iconbtn}
                  title="参数规则"
                  data-testid={`mcp-rules-${full}`}
                  onClick={() => onOpenRules?.(full)}
                >
                  <SlidersHorizontal size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **步骤 2：类型检查** — `cd tauri-agent && bunx tsc --noEmit`（新 props 为可选，`ExtensionsPanel` 现有调用不传也编译通过；任务 7 再传入真实值）。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/extensions/McpServerCard.tsx
git commit -m "feat(mcp-policy-ui): expandable card with per-tool Segmented (任务4/7)"
```

---

## 任务 5：ToolPermissionModal（三态 + 规则编辑）

**文件：** 新 `tauri-agent/src/features/extensions/ToolPermissionModal.tsx`

- [ ] **步骤 1：实现组件**

```tsx
import { Button, Modal } from '@lobehub/ui';
import { Segmented, Select } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { KeyValueEditor, type KvPairs } from './KeyValueEditor';
import { getToolPerm, getToolRules, shortToolName, type Perm, type RuleItem, type RulePolicy } from './mcpPolicy';

interface ToolPermissionModalProps {
  open: boolean;
  fullName: string;
  policyRaw: Record<string, unknown>;
  onSave: (fullName: string, perm: Perm, rules: RuleItem[]) => void;
  onClose: () => void;
}

interface EditRule {
  match: KvPairs;
  policy: RulePolicy;
}

const PERM_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '需审批', value: 'needs_approval' },
  { label: '禁用', value: 'disabled' },
];

const POLICY_OPTIONS = [
  { label: '免审 (never)', value: 'never' },
  { label: '需审 (required)', value: 'required' },
  { label: '必审 (always)', value: 'always' },
];

function toEdit(rules: RuleItem[]): EditRule[] {
  return rules.map((r) => ({ match: Object.entries(r.match ?? {}), policy: r.policy }));
}

function fromEdit(edits: EditRule[]): RuleItem[] {
  return edits.map((e) => {
    const match: Record<string, string> = {};
    for (const [k, v] of e.match) if (k.trim()) match[k] = v;
    const item: RuleItem = { policy: e.policy };
    if (Object.keys(match).length) item.match = match;
    return item;
  });
}

const styles = createStaticStyles(({ css }) => ({
  section: css`
    margin-block-end: 16px;
  `,
  label: css`
    display: block;
    margin-block-end: 8px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  rule: css`
    padding: 10px;
    margin-block-end: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
  `,
  ruleHead: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-block-end: 8px;
  `,
  rm: css`
    display: inline-flex;
    border: none;
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
  foot: css`
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-block-start: 16px;
  `,
  hint: css`
    margin-block-end: 12px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

export function ToolPermissionModal({ open, fullName, policyRaw, onSave, onClose }: ToolPermissionModalProps) {
  const [perm, setPerm] = useState<Perm>('auto');
  const [rules, setRules] = useState<EditRule[]>([]);

  useEffect(() => {
    if (!open) return;
    setPerm(getToolPerm(policyRaw, fullName));
    setRules(toEdit(getToolRules(policyRaw, fullName)));
  }, [open, fullName, policyRaw]);

  const setRuleMatch = (i: number, match: KvPairs) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, match } : r)));
  const setRulePolicy = (i: number, policy: RulePolicy) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, policy } : r)));
  const removeRule = (i: number) => setRules((rs) => rs.filter((_, j) => j !== i));
  const addRule = () => setRules((rs) => [...rs, { match: [], policy: 'required' }]);

  return (
    <Modal open={open} title={`工具权限 · ${shortToolName(fullName)}`} footer={null} onCancel={onClose} data-testid="tool-perm-modal">
      <div className={styles.hint}>{fullName}</div>

      <div className={styles.section}>
        <label className={styles.label}>权限</label>
        <Segmented
          value={perm}
          options={PERM_OPTIONS}
          onChange={(v) => setPerm(v as Perm)}
          data-testid="tool-perm-segmented"
        />
      </div>

      <div className={styles.section}>
        <label className={styles.label}>参数规则（按顺序匹配，第一个命中生效）</label>
        {rules.map((r, i) => (
          <div key={i} className={styles.rule} data-testid={`tool-rule-${i}`}>
            <div className={styles.ruleHead}>
              <Select
                size="small"
                value={r.policy}
                options={POLICY_OPTIONS}
                onChange={(v) => setRulePolicy(i, v as RulePolicy)}
                style={{ width: 160 }}
                data-testid={`tool-rule-policy-${i}`}
              />
              <button type="button" className={styles.rm} onClick={() => removeRule(i)} data-testid={`tool-rule-rm-${i}`}>
                <Trash2 size={14} />
              </button>
            </div>
            <KeyValueEditor
              value={r.match}
              onChange={(v) => setRuleMatch(i, v)}
              keyPlaceholder="参数名 (如 path)"
              valuePlaceholder="匹配 (支持 *)"
              addText="添加匹配条件"
              testId={`tool-rule-match-${i}`}
            />
          </div>
        ))}
        <button type="button" className={styles.add} onClick={addRule} data-testid="tool-rule-add">
          <Plus size={13} />
          添加规则
        </button>
      </div>

      <div className={styles.foot}>
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" data-testid="tool-perm-save" onClick={() => { onSave(fullName, perm, fromEdit(rules)); onClose(); }}>
          保存
        </Button>
      </div>
    </Modal>
  );
}
```

- [ ] **步骤 2：Commit**

```bash
git add tauri-agent/src/features/extensions/ToolPermissionModal.tsx
git commit -m "feat(mcp-policy-ui): ToolPermissionModal (三态 + 规则编辑) (任务5/7)"
```

---

## 任务 6：AuditModal（审计列表 + 筛选）

**文件：** 新 `tauri-agent/src/features/extensions/AuditModal.tsx`

- [ ] **步骤 1：实现组件**

```tsx
import { Modal } from '@lobehub/ui';
import { Select } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { useEffect, useMemo, useState } from 'react';
import { readMcpAudit } from '../../lib/mcpPolicyIo';
import { parseAuditLines, shortToolName, type AuditEntry } from './mcpPolicy';

interface AuditModalProps {
  open: boolean;
  onClose: () => void;
}

const MAX_ROWS = 500;

const styles = createStaticStyles(({ css }) => ({
  filters: css`
    display: flex;
    gap: 8px;
    margin-block-end: 12px;
  `,
  list: css`
    max-height: 60vh;
    overflow-y: auto;
  `,
  row: css`
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 8px 0;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 12px;
  `,
  ts: css`
    flex: 0 0 auto;
    color: ${cssVar.colorTextTertiary};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  `,
  tool: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  decision: css`
    flex: 0 0 auto;
    color: ${cssVar.colorTextSecondary};
  `,
  empty: css`
    padding: 32px 0;
    text-align: center;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
}));

export function AuditModal({ open, onClose }: AuditModalProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [server, setServer] = useState<string>('');
  const [decision, setDecision] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void readMcpAudit()
      .then((text) => {
        if (!cancelled) setEntries(parseAuditLines(text).reverse());
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const servers = useMemo(() => Array.from(new Set(entries.map((e) => e.server))).filter(Boolean), [entries]);
  const decisions = useMemo(() => Array.from(new Set(entries.map((e) => e.decision))).filter(Boolean), [entries]);
  const filtered = entries
    .filter((e) => (server ? e.server === server : true))
    .filter((e) => (decision ? e.decision === decision : true))
    .slice(0, MAX_ROWS);

  return (
    <Modal open={open} title="MCP 调用审计" footer={null} onCancel={onClose} data-testid="audit-modal">
      <div className={styles.filters}>
        <Select
          size="small"
          allowClear
          placeholder="全部 server"
          style={{ width: 180 }}
          value={server || undefined}
          onChange={(v) => setServer(v ?? '')}
          options={servers.map((s) => ({ label: s, value: s }))}
          data-testid="audit-filter-server"
        />
        <Select
          size="small"
          allowClear
          placeholder="全部 decision"
          style={{ width: 180 }}
          value={decision || undefined}
          onChange={(v) => setDecision(v ?? '')}
          options={decisions.map((d) => ({ label: d, value: d }))}
          data-testid="audit-filter-decision"
        />
      </div>
      {filtered.length === 0 ? (
        <div className={styles.empty}>暂无审计记录</div>
      ) : (
        <div className={styles.list}>
          {filtered.map((e, i) => (
            <div key={i} className={styles.row} data-testid="audit-row">
              <span className={styles.ts}>{e.ts.replace('T', ' ').replace('Z', '').slice(0, 19)}</span>
              <span className={styles.tool} title={`${e.tool}\n${e.argsDigest}`}>
                {e.server}: {shortToolName(e.tool)}
              </span>
              <span className={styles.decision}>{e.decision}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
```

- [ ] **步骤 2：Commit**

```bash
git add tauri-agent/src/features/extensions/AuditModal.tsx
git commit -m "feat(mcp-policy-ui): AuditModal with filters (任务6/7)"
```

---

## 任务 7：ExtensionsPanel 接线 + 全量验证

**文件：** 改 `tauri-agent/src/features/extensions/ExtensionsPanel.tsx`

- [ ] **步骤 1：加 import** — 顶部加：

```tsx
import { ScrollText } from 'lucide-react';
import { readMcpPolicy, writeMcpPolicy } from '../../lib/mcpPolicyIo';
import { parsePolicyDoc, serializePolicyDoc, setToolPerm, type Perm } from './mcpPolicy';
import { ToolPermissionModal } from './ToolPermissionModal';
import { AuditModal } from './AuditModal';
```

（`ScrollText` 合并进现有 `lucide-react` import 行；`Boxes, Plus, RotateCw, Sparkles` 已在。）

- [ ] **步骤 2：加 state 与加载** — 在组件内现有 useState 群后加：

```tsx
  const [policyRaw, setPolicyRaw] = useState<Record<string, unknown>>({});
  const [auditOpen, setAuditOpen] = useState(false);
  const [rulesTarget, setRulesTarget] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void readMcpPolicy()
      .then((t) => {
        if (!cancelled) setPolicyRaw(parsePolicyDoc(t));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const writePolicy = (next: Record<string, unknown>) => {
    setPolicyRaw(next);
    void writeMcpPolicy(serializePolicyDoc(next)).catch(() => {});
  };
  const onPermChange = (fullName: string, perm: Perm) => writePolicy(setToolPerm(policyRaw, fullName, perm));
```

（权限写入不调 `markChanged()`，因即时生效、无需重启。）

- [ ] **步骤 3：审计按钮** — 在 MCP hero 的「添加 MCP」按钮旁加一个审计入口（同一个 `heroBar` 右侧容器内，`Button` 之前）：

```tsx
                <Button
                  size="small"
                  icon={<ScrollText size={14} />}
                  data-testid="mcp-audit-open"
                  onClick={() => setAuditOpen(true)}
                >
                  审计
                </Button>
```

- [ ] **步骤 4：传 props 给 McpServerCard** — 给 `<McpServerCard .../>` 加：

```tsx
                    policyRaw={policyRaw}
                    onPermChange={onPermChange}
                    onOpenRules={(full) => setRulesTarget(full)}
```

- [ ] **步骤 5：挂载两个 Modal** — 在 `<AddMcpModal .../>` 之后加：

```tsx
              {rulesTarget ? (
                <ToolPermissionModal
                  open={!!rulesTarget}
                  fullName={rulesTarget}
                  policyRaw={policyRaw}
                  onSave={(full, perm, rules) =>
                    writePolicy(setToolRules(setToolPerm(policyRaw, full, perm), full, rules))
                  }
                  onClose={() => setRulesTarget(undefined)}
                />
              ) : null}
              <AuditModal open={auditOpen} onClose={() => setAuditOpen(false)} />
```

并把 import 补上 `setToolRules`：`import { parsePolicyDoc, serializePolicyDoc, setToolPerm, setToolRules, type Perm } from './mcpPolicy';`

- [ ] **步骤 6：前端类型检查 + 单测**

运行：`cd tauri-agent && bunx tsc --noEmit && bunx vitest run src/features/extensions/ src/stores/mcpStatusStore.test.ts`
预期：tsc 0 错；测试全绿。

- [ ] **步骤 7：sidecar 构建 + cargo check**

运行：`cd tauri-agent && node scripts/build-sidecar.mjs`（验证 mcp 改动打包）
运行：`cd tauri-agent/src-tauri && cargo check`（验证 Rust command）
预期：均通过。

- [ ] **步骤 8：端到端冒烟（手动，建议）**

1. 启动 app，配一个 MCP server（如 open-websearch），等连接成功。
2. 展开该 server 卡片 → 看到工具列表，每个有 Segmented 三态。
3. 把某工具设为「禁用」→ 让 agent 调用它 → 应被 block（无需重启）。
4. 点工具「规则」→ 加一条 `match: {query: "*secret*"}` / `always` → 保存；检查 `~/.pi/mcp-policy.json` 已更新且保留其他工具。
5. 点 hero「审计」→ 看到调用记录，可按 server/decision 筛选。

- [ ] **步骤 9：Commit**

```bash
git add tauri-agent/src/features/extensions/ExtensionsPanel.tsx
git commit -m "feat(mcp-policy-ui): wire panel state + audit entry + modals (任务7/7)"
```

---

## 自检（规格覆盖度对照）

| 设计章节/需求 | 对应任务 |
|----------------|----------|
| sidecar 推 toolNames | 任务 1 |
| store toolNames 字段 | 任务 1 |
| Rust read/write policy + read audit（限 ~/.pi/） | 任务 2 |
| 前端 policy 纯函数（读改保字段）+ 审计解析 + 短名 | 任务 3 |
| invoke 封装 | 任务 3 |
| McpServerCard 可展开 + Segmented 三态 | 任务 4 |
| 规则数组编辑（match + policy） | 任务 5（ToolPermissionModal） |
| 审计列表 + 筛选 | 任务 6（AuditModal） |
| ExtensionsPanel 持 policy state + 即时写 + 审计入口 | 任务 7 |
| 权限变更即时生效不重启（不调 markChanged） | 任务 7 步骤 2 |
| policy key 用注册全名、显示短名 | 任务 3（shortToolName）+ 任务 4 |

类型一致性：`Perm`/`RulePolicy`/`RuleItem`/`AuditEntry` 在 `mcpPolicy.ts` 定义，被 `McpServerCard`/`ToolPermissionModal`/`AuditModal`/`ExtensionsPanel` 一致引用；`getToolPerm/setToolPerm/setToolRules/getToolRules/parseAuditLines/shortToolName/serializePolicyDoc/parsePolicyDoc` 签名跨任务一致；`McpLiveStatus.toolNames` 与 store `McpServerStatus.toolNames` 对齐。无占位符。

依赖顺序检查：任务 3 的纯函数被任务 4/5/6/7 使用，排在前 ✓；任务 1/2（数据来源）在前 ✓；任务 7 收口 panel props（任务 4 引入的新 props）✓。

---

## 执行交接

两种执行方式：

1. **子代理驱动（推荐）**：每任务一个子代理 + 任务间审查。必需子技能 superpowers:subagent-driven-development。
2. **内联执行**：当前会话用 superpowers:executing-plans 批量执行 + 检查点。
</parameter>
</invoke>

