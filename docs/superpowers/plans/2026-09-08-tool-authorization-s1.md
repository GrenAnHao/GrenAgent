# S1 授权中枢与审计台账 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让每一次工具调用都经过主进程的规则决策，并在 SQLite 中留下审计记录。

**架构：** sidecar 的 `safety` 扩展在 `tool_call` 钩子里提取本次调用的事实特征（危险命令、受保护路径、越界写、联网、MCP、代码执行），经 AgentData TCP 交给主进程；主进程用「内置规则 + 用户规则」匹配出 `allow` / `deny` / `ask`，写入 `tool_audit` 后返回。`ask` 时 sidecar 用 `ctx.ui.select` 阻塞等用户，用户选「总是允许」则回调主进程写一条 `permission_rules`。

**技术栈：** TypeScript、`node:sqlite` 的 `DatabaseSync`、vitest、Electron 主进程 / Pi sidecar 扩展双包。

**上游规格：** `docs/superpowers/specs/2026-09-08-tool-authorization-audit-checkpoint-design.md`

---

## 关键约束（动工前必读）

**两个包不能互相引用。** `electron-agent/electron/**`（主进程）与 `extensions/**`（sidecar 扩展）是独立的包，生产代码不得跨包 import，理由见 `electron-agent/electron/app/wikiSyncService.ts:37` 的注释。因此 `isDangerousBash`、`matchProtectedPath` 这些判定函数留在 sidecar 侧，主进程只接收布尔特征。

跨包契约靠结构一致而非 import 保证，两侧各写一份 interface。**同名字段必须逐字相同，但两份不必字段数相同**：sidecar 的 `ToolCallFacts` 是主进程版本的子集（少 `threadId` 与 `turnId`，见下条），主进程的 `ToolRuleInput` 与 sidecar 的 `ToolRuleDraft` 字段完全相同、只是名字不同——前者是入库输入，后者是发送草稿。改动任一侧的字段名时，另一侧必须同步。

**内置规则必须与现状行为等价。** 现有 `extensions/safety/index.ts` 的判定顺序是：`full` 档在第 53-55 行直接 `return undefined`，因此危险命令与受保护路径在 `full` 下**也不拦**。内置规则集必须复刻这一点，`full` 档为空集。改变这个行为属于回归。

**失败方向分两种。** 规则查询失败（SQLite 繁忙）降级为 `ask`；TCP 通道不可用（`AGENT_DATA_ENDPOINT` 缺失或连接失败）直接拒绝。`extensions/_shared/desktop-control.ts:22` 现有的 catch 返回 `denied`，方向正确，不要改成放行。

**S1 不碰渲染层。** sidecar 用 `ctx.ui.select` 发三个选项，现有 `PromptRequestCard` 的 select 分支（`src/features/chat/input/PromptRequestCard.tsx:122-148`）已能渲染。`__approval` 哨兵富卡是 S2 的范围。

**类型检查必须用 `tsconfig.node.json`，且以「新增错误数为 0」为判据。** `electron-agent/tsconfig.json` 是 `"files": []` 加 `references` 的 solution 风格配置，非 `--build` 模式下检查 0 个文件——`npx tsc -p tsconfig.json --noEmit` 恒定退出码 0 且无输出，证明不了任何事。真正覆盖 `electron/**` 的是 `tsconfig.node.json`，但该配置下仓库有 53 处历史报错（`threadStore.ts` 的类型断言、若干测试文件的跨包引用等），与本计划无关，不要去修。

因此每处类型检查一律用这条命令，判据是输出为 0：

```powershell
cd electron-agent; npx tsc -p tsconfig.node.json --noEmit 2>&1 | Select-String "toolPermission" | Measure-Object | Select-Object -ExpandProperty Count
```

需要确认没有波及其他文件时，另跑一次总数，应仍为 53：

```powershell
cd electron-agent; npx tsc -p tsconfig.node.json --noEmit 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count
```

注意 `tsconfig.node.json` 的 `include` 只有 `electron/**/*.ts`，不含渲染层 `src/**`，也不含 `extensions/**`（另一个包）。任务 10 与 11 改的是 `extensions/`，那两个任务靠 vitest 与运行时验证，没有对应的 tsc 步骤。

**`thread_id` 与 `turn_id` 在 S1 恒为 NULL。** 这两列属于 Electron 主进程的会话模型，sidecar 不知道自己处在哪个 thread / turn，传不上来。S1 的关联靠 `session_id` 加 `tool_call_id`，足够回答「这次调用是谁、什么时候、批没批」。S3 需要按轮次给文件变更分组时才需要 `turn_id`，届时由主进程在 RPC 处理中按 workspace 查当前 turn 补齐。这是有意的空缺，不是遗漏，实现时不要为了填满列而编造值。

---

## 文件结构

新建，全部位于 `electron-agent/electron/app/toolPermission/`：

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 跨模块共享类型：`ToolCallFacts`、`ToolRule`、`ToolDecision`、`ToolOrigin` |
| `rules.ts` | 纯函数 `matchUserRules`，无 I/O，可完全单测 |
| `builtinRules.ts` | 三档预设的内置规则常量，基于特征谓词 |
| `argsDigest.ts` | 纯函数，按工具名裁剪参数为审计摘要 |
| `ruleStore.ts` | `permission_rules` 表读写 |
| `auditStore.ts` | `tool_audit` 表写入与查询 |
| `toolDecisionService.ts` | 编排：取规则 → 匹配 → 写审计 → 返回决策 |

修改：

| 文件 | 改动 |
| --- | --- |
| `electron-agent/electron/agentData/storage.ts` | 建两张表，`schema_version` 3 → 4 |
| `electron-agent/electron/main.ts` | 在 `methods` 中注册两个 RPC |
| `extensions/_shared/desktop-control.ts` | 新增两个客户端方法 |
| `extensions/safety/index.ts` | 钩子的 ②③④ 层替换为快问主进程 |

拆分理由：`rules.ts`、`builtinRules.ts`、`argsDigest.ts` 是纯函数，与数据库和网络隔离，测试不需要任何 fixture；`ruleStore` 与 `auditStore` 各管一张表；`toolDecisionService` 只做编排，不含判定逻辑。这样每个文件都能一次读完，决策逻辑的测试也不必搭数据库。

---

## 任务 1：建表与迁移

**文件：**
- 修改：`electron-agent/electron/agentData/storage.ts:11-86`
- 测试：`electron-agent/electron/agentData/storage.toolPermission.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/agentData/storage.toolPermission.test.ts`：

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataStorage } from './storage';

const directories: string[] = [];
const stores: AgentDataStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<AgentDataStorage> {
  const directory = await mkdtemp(join(tmpdir(), 'tool-permission-schema-'));
  directories.push(directory);
  const store = new AgentDataStorage(join(directory, 'agent-data.db'));
  stores.push(store);
  store.migrate();
  return store;
}

function columns(store: AgentDataStorage, table: string): string[] {
  return (store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

describe('tool permission schema', () => {
  it('creates permission_rules with the documented columns', async () => {
    const store = await fixture();
    expect(columns(store, 'permission_rules')).toEqual([
      'id', 'scope', 'scope_key', 'tool', 'matcher_kind', 'matcher', 'effect', 'created_at', 'expires_at',
    ]);
  });

  it('creates tool_audit with the documented columns', async () => {
    const store = await fixture();
    expect(columns(store, 'tool_audit')).toEqual([
      'id', 'workspace', 'session_id', 'thread_id', 'turn_id', 'tool_call_id', 'origin', 'tool',
      'args', 'decision', 'resolution', 'rule_id', 'queue_payload', 'created_at', 'resolved_at',
    ]);
  });

  it('bumps the schema version to 4', async () => {
    const store = await fixture();
    expect(store.schemaVersion()).toBe(4);
  });

  it('is idempotent across repeated migrations', async () => {
    const store = await fixture();
    store.migrate();
    expect(store.schemaVersion()).toBe(4);
    expect(columns(store, 'permission_rules')).toContain('effect');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/agentData/storage.toolPermission.test.ts`
预期：FAIL，报错 `no such table: permission_rules`

- [ ] **步骤 3：建表**

在 `electron-agent/electron/agentData/storage.ts` 中，把 `this.ensureColumn('goal_snapshots', 'source', 'TEXT');` 那一行之后、`if (this.schemaVersion() < 3)` 之前，插入：

```typescript
    this.db.exec(`CREATE TABLE IF NOT EXISTS permission_rules (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL,
      matcher_kind TEXT NOT NULL,
      matcher TEXT NOT NULL DEFAULT '',
      effect TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS permission_rules_lookup ON permission_rules(scope, scope_key, tool);
    CREATE TABLE IF NOT EXISTS tool_audit (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      session_id TEXT, thread_id TEXT, turn_id TEXT, tool_call_id TEXT,
      origin TEXT NOT NULL,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      decision TEXT NOT NULL,
      resolution TEXT NOT NULL,
      rule_id TEXT,
      queue_payload TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS tool_audit_session ON tool_audit(session_id, created_at);
    CREATE INDEX IF NOT EXISTS tool_audit_pending ON tool_audit(resolution, created_at) WHERE resolution = 'queued';`);
```

然后把最后一行的版本判断从 `if (this.schemaVersion() < 3) this.db.prepare('UPDATE schema_version SET version = ?').run(3);` 改为：

```typescript
    if (this.schemaVersion() < 4) this.db.prepare('UPDATE schema_version SET version = ?').run(4);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/agentData/storage.toolPermission.test.ts`
预期：4 个测试全部 PASS

- [ ] **步骤 5：确认未破坏既有迁移测试**

运行：`cd electron-agent && npx vitest run electron/agentData/`
预期：全部 PASS。若有测试断言 `schemaVersion() === 3`，改为 4——这是本次变更的预期后果。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agentData/storage.ts electron-agent/electron/agentData/storage.toolPermission.test.ts
git commit -m "feat(permission): 新增 permission_rules 与 tool_audit 表"
```

---

## 任务 2：共享类型

**文件：**
- 创建：`electron-agent/electron/app/toolPermission/types.ts`

本任务只定义类型，没有运行时行为，因此没有测试。后续任务的测试会覆盖这些类型的使用。

- [ ] **步骤 1：写类型定义**

创建 `electron-agent/electron/app/toolPermission/types.ts`：

```typescript
/**
 * 工具授权的跨进程契约。
 *
 * sidecar 侧在 extensions/_shared/desktop-control.ts 中重复声明结构相同的类型：
 * 两个包不能互相 import（见 app/wikiSyncService.ts 的注释），字段名必须逐字一致。
 */

export type ToolOrigin = 'main' | 'subagent' | 'goal';
export type ToolEffect = 'allow' | 'deny' | 'ask';
export type RuleScope = 'session' | 'workspace' | 'global';
export type MatcherKind = 'any' | 'command_prefix' | 'path_glob' | 'mcp_server';
export type ApprovalPreset = 'ask' | 'auto' | 'full';

/** sidecar 提取的调用特征。主进程不重新解析命令或路径，只消费这些布尔量。 */
export interface ToolCallFlags {
  /** isDangerousBash：rm -rf 之类 */
  dangerousCommand: boolean;
  /** isMutatingBash：会改动文件系统的命令 */
  mutatingCommand: boolean;
  /** matchProtectedPath：写入目标命中受保护路径 */
  protectedPath: boolean;
  /** 写入目标在工作区之外 */
  outsideWorkspace: boolean;
  /** NET_TOOLS 成员 */
  network: boolean;
  /** 工具名以 mcp__ 开头 */
  mcp: boolean;
  /** CODE_EXEC_TOOLS 成员：py_run / js_run / dap_* */
  codeExec: boolean;
  /** write / edit / WRITE_TOOLS 成员 */
  write: boolean;
}

export interface ToolCallFacts {
  tool: string;
  workspace: string;
  origin: ToolOrigin;
  preset: ApprovalPreset;
  flags: ToolCallFlags;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  toolCallId?: string;
  /** bash 命令原文，用于 command_prefix 匹配与审计 */
  command?: string;
  /** write / edit 的绝对目标路径，用于 path_glob 匹配与审计 */
  path?: string;
  /** 未经裁剪的原始参数，由 argsDigest 处理后才落库 */
  rawArgs?: Record<string, unknown>;
}

export interface ToolRule {
  id: string;
  scope: RuleScope;
  scopeKey: string;
  tool: string;
  matcherKind: MatcherKind;
  matcher: string;
  effect: ToolEffect;
  createdAt: number;
  expiresAt?: number;
}

/** 新增规则时的输入，id 与 createdAt 由 store 生成。 */
export interface ToolRuleInput {
  scope: RuleScope;
  scopeKey: string;
  tool: string;
  matcherKind: MatcherKind;
  matcher: string;
  effect: ToolEffect;
  expiresAt?: number;
}

export interface ToolDecision {
  decision: ToolEffect;
  /** 命中的规则 id；内置规则形如 builtin.dangerous-command */
  ruleId?: string;
  /** 审计行 id，sidecar 在用户应答后回传它以更新 resolution */
  auditId: string;
}
```

- [ ] **步骤 2：确认类型编译通过**

运行：`cd electron-agent; npx tsc -p tsconfig.node.json --noEmit 2>&1 | Select-String "toolPermission" | Measure-Object | Select-Object -ExpandProperty Count`
预期：输出 `0`

- [ ] **步骤 3：Commit**

```bash
git add electron-agent/electron/app/toolPermission/types.ts
git commit -m "feat(permission): 定义工具授权契约类型"
```

---

## 任务 3：用户规则匹配纯函数

**文件：**
- 创建：`electron-agent/electron/app/toolPermission/rules.ts`
- 测试：`electron-agent/electron/app/toolPermission/rules.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/app/toolPermission/rules.test.ts`：

```typescript
import { describe, expect, it } from 'vitest';
import { matchUserRules } from './rules';
import type { ToolCallFacts, ToolRule } from './types';

const NOW = 1_000_000;

function facts(over: Partial<ToolCallFacts> = {}): ToolCallFacts {
  return {
    tool: 'bash',
    workspace: 'D:/repo',
    origin: 'main',
    preset: 'auto',
    sessionId: 's1',
    command: 'npm run build',
    flags: {
      dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false,
      network: false, mcp: false, codeExec: false, write: false,
    },
    ...over,
  };
}

function rule(over: Partial<ToolRule> = {}): ToolRule {
  return {
    id: 'r1', scope: 'global', scopeKey: '', tool: 'bash',
    matcherKind: 'any', matcher: '', effect: 'allow', createdAt: 0,
    ...over,
  };
}

describe('matchUserRules', () => {
  it('returns undefined when nothing matches', () => {
    expect(matchUserRules([rule({ tool: 'write' })], facts(), NOW)).toBeUndefined();
  });

  it('deny outranks ask and allow regardless of scope width', () => {
    const matched = matchUserRules(
      [
        rule({ id: 'narrow-allow', scope: 'session', scopeKey: 's1', effect: 'allow' }),
        rule({ id: 'wide-deny', scope: 'global', effect: 'deny' }),
      ],
      facts(),
      NOW,
    );
    expect(matched?.id).toBe('wide-deny');
  });

  it('ask outranks allow', () => {
    const matched = matchUserRules(
      [rule({ id: 'a', effect: 'allow' }), rule({ id: 'b', effect: 'ask' })],
      facts(),
      NOW,
    );
    expect(matched?.id).toBe('b');
  });

  it('narrower scope wins among rules with the same effect', () => {
    const matched = matchUserRules(
      [
        rule({ id: 'global', scope: 'global', effect: 'allow' }),
        rule({ id: 'session', scope: 'session', scopeKey: 's1', effect: 'allow' }),
        rule({ id: 'workspace', scope: 'workspace', scopeKey: 'D:/repo', effect: 'allow' }),
      ],
      facts(),
      NOW,
    );
    expect(matched?.id).toBe('session');
  });

  it('ignores rules whose scope key belongs to another session or workspace', () => {
    expect(matchUserRules([rule({ scope: 'session', scopeKey: 'other' })], facts(), NOW)).toBeUndefined();
    expect(matchUserRules([rule({ scope: 'workspace', scopeKey: 'D:/other' })], facts(), NOW)).toBeUndefined();
  });

  it('ignores expired rules', () => {
    expect(matchUserRules([rule({ expiresAt: NOW - 1 })], facts(), NOW)).toBeUndefined();
    expect(matchUserRules([rule({ expiresAt: NOW + 1 })], facts(), NOW)?.id).toBe('r1');
  });

  it('matches tool names with a trailing wildcard', () => {
    const call = facts({ tool: 'mcp__github__create_issue' });
    expect(matchUserRules([rule({ tool: 'mcp__github__*' })], call, NOW)?.id).toBe('r1');
    expect(matchUserRules([rule({ tool: 'mcp__gitlab__*' })], call, NOW)).toBeUndefined();
  });

  it('command_prefix matches the leading substring of the command', () => {
    const r = [rule({ matcherKind: 'command_prefix', matcher: 'npm run' })];
    expect(matchUserRules(r, facts({ command: 'npm run build' }), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, facts({ command: 'npm install' }), NOW)).toBeUndefined();
  });

  it('command_prefix ignores leading whitespace in the command', () => {
    const r = [rule({ matcherKind: 'command_prefix', matcher: 'npm run' })];
    expect(matchUserRules(r, facts({ command: '  npm run build' }), NOW)?.id).toBe('r1');
  });

  it('path_glob matches with ** and * segments', () => {
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher: 'D:/repo/src/**' })];
    const call = (path: string) => facts({ tool: 'write', command: undefined, path });
    expect(matchUserRules(r, call('D:/repo/src/a/b.ts'), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, call('D:/repo/docs/a.md'), NOW)).toBeUndefined();
  });

  it('path_glob is case-insensitive and separator-insensitive', () => {
    const r = [rule({ tool: 'write', matcherKind: 'path_glob', matcher: 'D:/repo/src/**' })];
    const call = facts({ tool: 'write', command: undefined, path: 'd:\\repo\\SRC\\a.ts' });
    expect(matchUserRules(r, call, NOW)?.id).toBe('r1');
  });

  it('mcp_server matches every tool of one server', () => {
    const r = [rule({ tool: '*', matcherKind: 'mcp_server', matcher: 'github' })];
    expect(matchUserRules(r, facts({ tool: 'mcp__github__x' }), NOW)?.id).toBe('r1');
    expect(matchUserRules(r, facts({ tool: 'mcp__other__x' }), NOW)).toBeUndefined();
  });

  it('a matcher requiring a field that the call lacks does not match', () => {
    const r = [rule({ matcherKind: 'command_prefix', matcher: 'npm' })];
    expect(matchUserRules(r, facts({ command: undefined }), NOW)).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/rules.test.ts`
预期：FAIL，报错 `Failed to resolve import "./rules"`

- [ ] **步骤 3：实现规则匹配**

创建 `electron-agent/electron/app/toolPermission/rules.ts`：

```typescript
import type { ToolCallFacts, ToolEffect, ToolRule } from './types';

const EFFECT_RANK: Record<ToolEffect, number> = { deny: 3, ask: 2, allow: 1 };
const SCOPE_RANK = { session: 3, workspace: 2, global: 1 } as const;

/** 路径比较统一为小写正斜杠，Windows 上 D:\repo 与 d:/repo 视作同一路径。 */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/** 把 glob 转成正则：** 跨目录，* 不跨目录，其余字符转义。 */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
      continue;
    }
    if (glob[i] === '*') {
      source += '[^/]*';
      continue;
    }
    source += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function toolMatches(pattern: string, tool: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

function scopeApplies(rule: ToolRule, call: ToolCallFacts): boolean {
  if (rule.scope === 'global') return true;
  if (rule.scope === 'session') return rule.scopeKey !== '' && rule.scopeKey === call.sessionId;
  return rule.scopeKey !== '' && normalizePath(rule.scopeKey) === normalizePath(call.workspace);
}

function matcherApplies(rule: ToolRule, call: ToolCallFacts): boolean {
  if (rule.matcherKind === 'any') return true;
  if (rule.matcherKind === 'command_prefix') {
    return call.command !== undefined && call.command.trimStart().startsWith(rule.matcher);
  }
  if (rule.matcherKind === 'path_glob') {
    if (call.path === undefined) return false;
    return globToRegExp(normalizePath(rule.matcher)).test(normalizePath(call.path));
  }
  return call.tool.startsWith(`mcp__${rule.matcher}__`);
}

/**
 * 在用户规则中选出优先级最高的一条。
 *
 * 优先级：effect 强度（deny > ask > allow）优先于 scope 宽窄（session > workspace > global）。
 * 无匹配返回 undefined，由调用方决定兜底——本函数不假设默认值。
 */
export function matchUserRules(
  rules: readonly ToolRule[],
  call: ToolCallFacts,
  now: number,
): ToolRule | undefined {
  let best: ToolRule | undefined;
  let bestRank = -1;
  for (const rule of rules) {
    if (rule.expiresAt !== undefined && rule.expiresAt <= now) continue;
    if (!toolMatches(rule.tool, call.tool)) continue;
    if (!scopeApplies(rule, call)) continue;
    if (!matcherApplies(rule, call)) continue;
    const rank = EFFECT_RANK[rule.effect] * 10 + SCOPE_RANK[rule.scope];
    if (rank > bestRank) {
      best = rule;
      bestRank = rank;
    }
  }
  return best;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/rules.test.ts`
预期：13 个测试全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/toolPermission/rules.ts electron-agent/electron/app/toolPermission/rules.test.ts
git commit -m "feat(permission): 实现用户规则匹配"
```

---

## 任务 4：内置规则

**文件：**
- 创建：`electron-agent/electron/app/toolPermission/builtinRules.ts`
- 测试：`electron-agent/electron/app/toolPermission/builtinRules.test.ts`

内置规则用谓词函数而非数据 matcher，因为「危险命令」这类判定由 sidecar 完成后以布尔量传来，不需要再解析。

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/app/toolPermission/builtinRules.test.ts`：

```typescript
import { describe, expect, it } from 'vitest';
import { matchBuiltinRules } from './builtinRules';
import type { ApprovalPreset, ToolCallFacts, ToolCallFlags } from './types';

const NO_FLAGS: ToolCallFlags = {
  dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false,
  network: false, mcp: false, codeExec: false, write: false,
};

function facts(preset: ApprovalPreset, flags: Partial<ToolCallFlags> = {}): ToolCallFacts {
  return {
    tool: 'bash', workspace: 'D:/repo', origin: 'main', preset,
    flags: { ...NO_FLAGS, ...flags },
  };
}

describe('matchBuiltinRules', () => {
  it('full preset has no builtin rules, preserving current behaviour', () => {
    // 现状：extensions/safety/index.ts 第 53-55 行在 full 档直接 return undefined，
    // 危险命令与受保护路径在 full 下同样不拦。改变这个行为属于回归。
    expect(matchBuiltinRules(facts('full', { dangerousCommand: true }))).toBeUndefined();
    expect(matchBuiltinRules(facts('full', { protectedPath: true }))).toBeUndefined();
  });

  it('auto denies protected paths', () => {
    expect(matchBuiltinRules(facts('auto', { protectedPath: true, write: true }))).toMatchObject({
      effect: 'deny', id: 'builtin.protected-path',
    });
  });

  it('auto asks for dangerous commands', () => {
    expect(matchBuiltinRules(facts('auto', { dangerousCommand: true }))).toMatchObject({
      effect: 'ask', id: 'builtin.dangerous-command',
    });
  });

  it('auto allows a plain mutating command', () => {
    expect(matchBuiltinRules(facts('auto', { mutatingCommand: true }))).toBeUndefined();
  });

  it('ask asks for mcp, network, code exec, mutating commands and out-of-workspace writes', () => {
    expect(matchBuiltinRules(facts('ask', { mcp: true }))?.id).toBe('builtin.mcp');
    expect(matchBuiltinRules(facts('ask', { network: true }))?.id).toBe('builtin.network');
    expect(matchBuiltinRules(facts('ask', { codeExec: true }))?.id).toBe('builtin.code-exec');
    expect(matchBuiltinRules(facts('ask', { mutatingCommand: true }))?.id).toBe('builtin.mutating-command');
    expect(matchBuiltinRules(facts('ask', { write: true, outsideWorkspace: true }))?.id)
      .toBe('builtin.outside-workspace-write');
  });

  it('ask allows an in-workspace write', () => {
    expect(matchBuiltinRules(facts('ask', { write: true }))).toBeUndefined();
  });

  it('deny outranks ask when both match', () => {
    expect(matchBuiltinRules(facts('ask', { protectedPath: true, write: true, outsideWorkspace: true })))
      .toMatchObject({ effect: 'deny' });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/builtinRules.test.ts`
预期：FAIL，报错 `Failed to resolve import "./builtinRules"`

- [ ] **步骤 3：实现内置规则**

创建 `electron-agent/electron/app/toolPermission/builtinRules.ts`：

```typescript
import type { ApprovalPreset, ToolCallFacts, ToolEffect } from './types';

export interface BuiltinRule {
  id: string;
  effect: ToolEffect;
  match(call: ToolCallFacts): boolean;
}

/**
 * 受保护路径写入：任何档位都不许做（full 除外，见下）。
 * 危险命令：必须逐次确认，用户规则无法降级为静默放行。
 */
const GUARDS: BuiltinRule[] = [
  { id: 'builtin.protected-path', effect: 'deny', match: (c) => c.flags.write && c.flags.protectedPath },
  { id: 'builtin.dangerous-command', effect: 'ask', match: (c) => c.flags.dangerousCommand },
];

/** ask 档额外逐次确认的动作，对应现有 safety 钩子的第 ③ 层。 */
const ASK_EXTRA: BuiltinRule[] = [
  { id: 'builtin.mcp', effect: 'ask', match: (c) => c.flags.mcp },
  { id: 'builtin.network', effect: 'ask', match: (c) => c.flags.network },
  { id: 'builtin.outside-workspace-write', effect: 'ask', match: (c) => c.flags.write && c.flags.outsideWorkspace },
  { id: 'builtin.mutating-command', effect: 'ask', match: (c) => c.flags.mutatingCommand },
  { id: 'builtin.code-exec', effect: 'ask', match: (c) => c.flags.codeExec },
];

/**
 * full 档为空集是刻意的：现有 extensions/safety/index.ts 在 full 时于第 53-55 行
 * 直接返回，第 ④ 层的危险命令与受保护路径同样不执行。这里保持行为等价。
 */
export const BUILTIN_RULES: Record<ApprovalPreset, readonly BuiltinRule[]> = {
  full: [],
  auto: GUARDS,
  ask: [...GUARDS, ...ASK_EXTRA],
};

const EFFECT_RANK: Record<ToolEffect, number> = { deny: 3, ask: 2, allow: 1 };

/** 选出当前档位下命中的最强内置规则；无命中返回 undefined。 */
export function matchBuiltinRules(call: ToolCallFacts): BuiltinRule | undefined {
  let best: BuiltinRule | undefined;
  for (const rule of BUILTIN_RULES[call.preset]) {
    if (!rule.match(call)) continue;
    if (!best || EFFECT_RANK[rule.effect] > EFFECT_RANK[best.effect]) best = rule;
  }
  return best;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/builtinRules.test.ts`
预期：7 个测试全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/toolPermission/builtinRules.ts electron-agent/electron/app/toolPermission/builtinRules.test.ts
git commit -m "feat(permission): 定义三档预设的内置规则"
```

---

## 任务 5：参数摘要

**文件：**
- 创建：`electron-agent/electron/app/toolPermission/argsDigest.ts`
- 测试：`electron-agent/electron/app/toolPermission/argsDigest.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/app/toolPermission/argsDigest.test.ts`：

```typescript
import { describe, expect, it } from 'vitest';
import { digestArgs, MAX_DIGEST_LENGTH } from './argsDigest';

describe('digestArgs', () => {
  it('keeps the full command for bash', () => {
    expect(digestArgs('bash', { command: 'npm run build' })).toBe('{"command":"npm run build"}');
  });

  it('keeps only the path for write and drops the content', () => {
    const digest = digestArgs('write', { path: 'D:/repo/a.ts', content: 'x'.repeat(50_000) });
    expect(digest).toBe('{"path":"D:/repo/a.ts"}');
  });

  it('keeps only the path for edit and drops old and new text', () => {
    const digest = digestArgs('edit', { path: 'D:/repo/a.ts', oldText: 'a', newText: 'b' });
    expect(digest).toBe('{"path":"D:/repo/a.ts"}');
  });

  it('serialises unknown tools whole but truncates oversized payloads', () => {
    const digest = digestArgs('some_tool', { blob: 'y'.repeat(MAX_DIGEST_LENGTH * 2) });
    expect(digest.length).toBeLessThanOrEqual(MAX_DIGEST_LENGTH);
    expect(digest.endsWith('…')).toBe(true);
  });

  it('returns an empty object for missing args', () => {
    expect(digestArgs('bash', undefined)).toBe('{}');
  });

  it('survives values that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(digestArgs('some_tool', cyclic)).toBe('{"_unserializable":true}');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/argsDigest.test.ts`
预期：FAIL，报错 `Failed to resolve import "./argsDigest"`

- [ ] **步骤 3：实现摘要**

创建 `electron-agent/electron/app/toolPermission/argsDigest.ts`：

```typescript
/** 单条审计参数的字符上限，超出截断。 */
export const MAX_DIGEST_LENGTH = 4_000;

/** 只保留路径、丢弃正文的工具：内容已在 file_checkpoints 的 blob 中（S3），审计里再存一份是浪费。 */
const PATH_ONLY_TOOLS = new Set(['write', 'edit', 'ast_edit', 'hl_edit', 'search_replace', 'str_replace']);

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{"_unserializable":true}';
  }
}

/**
 * 把工具参数裁剪为审计摘要。
 *
 * bash 保留完整命令——审计的主要价值就在于此。写类工具只留路径。
 * 其余工具整体序列化后按长度截断，避免个别工具的大参数撑爆表。
 */
export function digestArgs(tool: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '{}';
  if (tool === 'bash' || tool === 'shell') {
    return stringify({ command: typeof args.command === 'string' ? args.command : '' });
  }
  if (PATH_ONLY_TOOLS.has(tool)) {
    const path = args.path ?? args.file_path ?? args.filePath ?? args.target_file;
    return stringify({ path: typeof path === 'string' ? path : '' });
  }
  const serialised = stringify(args);
  return serialised.length > MAX_DIGEST_LENGTH ? `${serialised.slice(0, MAX_DIGEST_LENGTH - 1)}…` : serialised;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/argsDigest.test.ts`
预期：6 个测试全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/toolPermission/argsDigest.ts electron-agent/electron/app/toolPermission/argsDigest.test.ts
git commit -m "feat(permission): 实现审计参数摘要"
```

---

## 任务 6：规则存储

**文件：**
- 创建：`electron-agent/electron/app/toolPermission/ruleStore.ts`
- 测试：`electron-agent/electron/app/toolPermission/ruleStore.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/app/toolPermission/ruleStore.test.ts`：

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataStorage } from '../../agentData/storage';
import { ToolRuleStore } from './ruleStore';

const directories: string[] = [];
const stores: AgentDataStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<ToolRuleStore> {
  const directory = await mkdtemp(join(tmpdir(), 'tool-rule-store-'));
  directories.push(directory);
  const storage = new AgentDataStorage(join(directory, 'agent-data.db'));
  stores.push(storage);
  storage.migrate();
  return new ToolRuleStore(storage.db, () => 42);
}

describe('ToolRuleStore', () => {
  it('inserts a rule and reads it back', async () => {
    const store = await fixture();
    const created = store.add({
      scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash',
      matcherKind: 'command_prefix', matcher: 'npm run', effect: 'allow',
    });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBe(42);
    expect(store.list()).toEqual([created]);
  });

  it('lists rules applicable to a workspace and session plus all global rules', async () => {
    const store = await fixture();
    const mine = store.add({ scope: 'session', scopeKey: 's1', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    const ws = store.add({ scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    const global = store.add({ scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    store.add({ scope: 'session', scopeKey: 'other', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    store.add({ scope: 'workspace', scopeKey: 'D:/elsewhere', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });

    const ids = store.applicable('D:/repo', 's1').map((r) => r.id).sort();
    expect(ids).toEqual([global.id, mine.id, ws.id].sort());
  });

  it('matches workspace scope regardless of separator and case', async () => {
    const store = await fixture();
    const rule = store.add({ scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    expect(store.applicable('d:\\repo', undefined).map((r) => r.id)).toEqual([rule.id]);
  });

  it('omits session rules when the call has no session id', async () => {
    const store = await fixture();
    store.add({ scope: 'session', scopeKey: 's1', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    expect(store.applicable('D:/repo', undefined)).toEqual([]);
  });

  it('removes a rule by id', async () => {
    const store = await fixture();
    const rule = store.add({ scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    expect(store.remove(rule.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove(rule.id)).toBe(false);
  });

  it('round-trips an optional expiry', async () => {
    const store = await fixture();
    const rule = store.add({ scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'ask', expiresAt: 99 });
    expect(store.list()[0]).toEqual({ ...rule, expiresAt: 99 });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/ruleStore.test.ts`
预期：FAIL，报错 `Failed to resolve import "./ruleStore"`

- [ ] **步骤 3：实现规则存储**

创建 `electron-agent/electron/app/toolPermission/ruleStore.ts`：

```typescript
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MatcherKind, RuleScope, ToolEffect, ToolRule, ToolRuleInput } from './types';

function normalizeWorkspace(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function mapRow(row: Record<string, unknown>): ToolRule {
  return {
    id: String(row.id),
    scope: String(row.scope) as RuleScope,
    scopeKey: String(row.scope_key ?? ''),
    tool: String(row.tool),
    matcherKind: String(row.matcher_kind) as MatcherKind,
    matcher: String(row.matcher ?? ''),
    effect: String(row.effect) as ToolEffect,
    createdAt: Number(row.created_at),
    ...(row.expires_at === null || row.expires_at === undefined ? {} : { expiresAt: Number(row.expires_at) }),
  };
}

export class ToolRuleStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  add(input: ToolRuleInput): ToolRule {
    const rule: ToolRule = { ...input, id: randomUUID(), createdAt: this.now() };
    this.db
      .prepare(
        `INSERT INTO permission_rules (id, scope, scope_key, tool, matcher_kind, matcher, effect, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.id, rule.scope, rule.scopeKey, rule.tool, rule.matcherKind,
        rule.matcher, rule.effect, rule.createdAt, rule.expiresAt ?? null,
      );
    return rule;
  }

  list(): ToolRule[] {
    return (this.db.prepare('SELECT * FROM permission_rules ORDER BY created_at, rowid').all() as Array<Record<string, unknown>>)
      .map(mapRow);
  }

  /**
   * 取出对这次调用可能适用的规则：全部 global，加上匹配当前工作区与会话的那些。
   * 工作区比较在 SQL 之外做，因为 scope_key 里可能存着不同分隔符或大小写的同一路径。
   */
  applicable(workspace: string, sessionId: string | undefined): ToolRule[] {
    const target = normalizeWorkspace(workspace);
    return this.list().filter((rule) => {
      if (rule.scope === 'global') return true;
      if (rule.scope === 'workspace') return normalizeWorkspace(rule.scopeKey) === target;
      return sessionId !== undefined && rule.scopeKey === sessionId;
    });
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id).changes > 0;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/ruleStore.test.ts`
预期：6 个测试全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/toolPermission/ruleStore.ts electron-agent/electron/app/toolPermission/ruleStore.test.ts
git commit -m "feat(permission): 实现授权规则存储"
```

---

## 任务 7：审计存储

**文件：**
- 创建：`electron-agent/electron/app/toolPermission/auditStore.ts`
- 测试：`electron-agent/electron/app/toolPermission/auditStore.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/app/toolPermission/auditStore.test.ts`：

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataStorage } from '../../agentData/storage';
import { ToolAuditStore } from './auditStore';

const directories: string[] = [];
const stores: AgentDataStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<ToolAuditStore> {
  const directory = await mkdtemp(join(tmpdir(), 'tool-audit-store-'));
  directories.push(directory);
  const storage = new AgentDataStorage(join(directory, 'agent-data.db'));
  stores.push(storage);
  storage.migrate();
  return new ToolAuditStore(storage.db, () => 42);
}

const BASE = {
  workspace: 'D:/repo', origin: 'main' as const, tool: 'bash',
  args: '{"command":"npm run build"}', decision: 'allow' as const, resolution: 'auto' as const,
};

describe('ToolAuditStore', () => {
  it('records a decision and returns its id', async () => {
    const store = await fixture();
    const id = store.record(BASE);
    const row = store.get(id);
    expect(row).toMatchObject({ ...BASE, id, createdAt: 42, resolvedAt: undefined });
  });

  it('persists optional correlation ids', async () => {
    const store = await fixture();
    const id = store.record({ ...BASE, sessionId: 's1', threadId: 't1', turnId: 'u1', toolCallId: 'c1', ruleId: 'r1' });
    expect(store.get(id)).toMatchObject({ sessionId: 's1', threadId: 't1', turnId: 'u1', toolCallId: 'c1', ruleId: 'r1' });
  });

  it('resolves a pending row and stamps resolvedAt', async () => {
    const store = await fixture();
    const id = store.record({ ...BASE, decision: 'ask', resolution: 'queued', queuePayload: '{"tool":"bash"}' });
    expect(store.resolve(id, 'user_allow')).toBe(true);
    expect(store.get(id)).toMatchObject({ resolution: 'user_allow', resolvedAt: 42 });
  });

  it('reports false when resolving an unknown id', async () => {
    const store = await fixture();
    expect(store.resolve('missing', 'user_deny')).toBe(false);
  });

  it('lists only queued rows, oldest first', async () => {
    const store = await fixture();
    store.record(BASE);
    const first = store.record({ ...BASE, decision: 'ask', resolution: 'queued' });
    const second = store.record({ ...BASE, decision: 'ask', resolution: 'queued' });
    expect(store.pending().map((r) => r.id)).toEqual([first, second]);
  });

  it('excludes rows that were resolved after being queued', async () => {
    const store = await fixture();
    const id = store.record({ ...BASE, decision: 'ask', resolution: 'queued' });
    store.resolve(id, 'user_deny');
    expect(store.pending()).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/auditStore.test.ts`
预期：FAIL，报错 `Failed to resolve import "./auditStore"`

- [ ] **步骤 3：实现审计存储**

创建 `electron-agent/electron/app/toolPermission/auditStore.ts`：

```typescript
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolEffect, ToolOrigin } from './types';

export type AuditResolution = 'auto' | 'rule' | 'user_allow' | 'user_deny' | 'queued' | 'aborted';

export interface ToolAuditInput {
  workspace: string;
  origin: ToolOrigin;
  tool: string;
  args: string;
  decision: ToolEffect;
  resolution: AuditResolution;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  toolCallId?: string;
  ruleId?: string;
  queuePayload?: string;
}

export interface ToolAuditRow extends ToolAuditInput {
  id: string;
  createdAt: number;
  resolvedAt?: number;
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function mapRow(row: Record<string, unknown>): ToolAuditRow {
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    origin: String(row.origin) as ToolOrigin,
    tool: String(row.tool),
    args: String(row.args),
    decision: String(row.decision) as ToolEffect,
    resolution: String(row.resolution) as AuditResolution,
    createdAt: Number(row.created_at),
    ...(row.session_id === null || row.session_id === undefined ? {} : { sessionId: String(row.session_id) }),
    ...(row.thread_id === null || row.thread_id === undefined ? {} : { threadId: String(row.thread_id) }),
    ...(row.turn_id === null || row.turn_id === undefined ? {} : { turnId: String(row.turn_id) }),
    ...(row.tool_call_id === null || row.tool_call_id === undefined ? {} : { toolCallId: String(row.tool_call_id) }),
    ...(row.rule_id === null || row.rule_id === undefined ? {} : { ruleId: String(row.rule_id) }),
    ...(optional(row.queue_payload) === undefined ? {} : { queuePayload: String(row.queue_payload) }),
    ...(row.resolved_at === null || row.resolved_at === undefined ? {} : { resolvedAt: Number(row.resolved_at) }),
  };
}

export class ToolAuditStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** 写一条决策记录，返回其 id。每次工具调用都要写，无论放行还是拦截。 */
  record(input: ToolAuditInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tool_audit (id, workspace, session_id, thread_id, turn_id, tool_call_id, origin, tool,
           args, decision, resolution, rule_id, queue_payload, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id, input.workspace, input.sessionId ?? null, input.threadId ?? null, input.turnId ?? null,
        input.toolCallId ?? null, input.origin, input.tool, input.args, input.decision,
        input.resolution, input.ruleId ?? null, input.queuePayload ?? null, this.now(),
      );
    return id;
  }

  get(id: string): ToolAuditRow | undefined {
    const row = this.db.prepare('SELECT * FROM tool_audit WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** 用户或中断给出结果后更新该行。返回是否命中了一行。 */
  resolve(id: string, resolution: AuditResolution): boolean {
    return this.db
      .prepare('UPDATE tool_audit SET resolution = ?, resolved_at = ? WHERE id = ?')
      .run(resolution, this.now(), id).changes > 0;
  }

  /** 无 UI 时攒下的待授权请求，按发生顺序返回。 */
  pending(): ToolAuditRow[] {
    return (this.db
      .prepare("SELECT * FROM tool_audit WHERE resolution = 'queued' ORDER BY created_at, rowid")
      .all() as Array<Record<string, unknown>>).map(mapRow);
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/auditStore.test.ts`
预期：6 个测试全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/toolPermission/auditStore.ts electron-agent/electron/app/toolPermission/auditStore.test.ts
git commit -m "feat(permission): 实现工具审计存储"
```

---

## 任务 8：决策服务

**文件：**
- 创建：`electron-agent/electron/app/toolPermission/toolDecisionService.ts`
- 测试：`electron-agent/electron/app/toolPermission/toolDecisionService.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/app/toolPermission/toolDecisionService.test.ts`：

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataStorage } from '../../agentData/storage';
import { ToolAuditStore } from './auditStore';
import { ToolRuleStore } from './ruleStore';
import { ToolDecisionService } from './toolDecisionService';
import type { ApprovalPreset, ToolCallFacts, ToolCallFlags } from './types';

const directories: string[] = [];
const stores: AgentDataStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const NO_FLAGS: ToolCallFlags = {
  dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false,
  network: false, mcp: false, codeExec: false, write: false,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tool-decision-'));
  directories.push(directory);
  const storage = new AgentDataStorage(join(directory, 'agent-data.db'));
  stores.push(storage);
  storage.migrate();
  const rules = new ToolRuleStore(storage.db, () => 42);
  const audit = new ToolAuditStore(storage.db, () => 42);
  return { rules, audit, service: new ToolDecisionService(rules, audit) };
}

function facts(over: Partial<ToolCallFacts> = {}): ToolCallFacts {
  return {
    tool: 'bash', workspace: 'D:/repo', origin: 'main', preset: 'auto', sessionId: 's1',
    command: 'npm run build', flags: { ...NO_FLAGS }, ...over,
  };
}

describe('ToolDecisionService.evaluate', () => {
  it('allows an unmatched call and audits it as auto', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts());
    expect(decision.decision).toBe('allow');
    expect(decision.ruleId).toBeUndefined();
    expect(audit.get(decision.auditId)).toMatchObject({ decision: 'allow', resolution: 'auto', tool: 'bash' });
  });

  it('applies a builtin rule and records its id', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({ flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(decision).toMatchObject({ decision: 'ask', ruleId: 'builtin.dangerous-command' });
    expect(audit.get(decision.auditId)).toMatchObject({ decision: 'ask', resolution: 'queued' });
  });

  it('applies a user rule and audits resolution as rule', async () => {
    const { rules, audit, service } = await fixture();
    const rule = rules.add({
      scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash',
      matcherKind: 'command_prefix', matcher: 'npm run', effect: 'deny',
    });
    const decision = service.evaluate(facts());
    expect(decision).toMatchObject({ decision: 'deny', ruleId: rule.id });
    expect(audit.get(decision.auditId)).toMatchObject({ resolution: 'rule' });
  });

  it('lets a builtin deny outrank a user allow', async () => {
    const { rules, service } = await fixture();
    rules.add({ scope: 'global', scopeKey: '', tool: 'write', matcherKind: 'any', matcher: '', effect: 'allow' });
    const decision = service.evaluate(facts({
      tool: 'write', command: undefined, path: 'C:/Windows/x.dll',
      flags: { ...NO_FLAGS, write: true, protectedPath: true },
    }));
    expect(decision).toMatchObject({ decision: 'deny', ruleId: 'builtin.protected-path' });
  });

  it('lets a builtin ask outrank a user allow', async () => {
    const { rules, service } = await fixture();
    rules.add({ scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' });
    const decision = service.evaluate(facts({ flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(decision).toMatchObject({ decision: 'ask', ruleId: 'builtin.dangerous-command' });
  });

  it('stores a queue payload only for headless ask decisions', async () => {
    const { audit, service } = await fixture();
    const withUi = service.evaluate(facts({ flags: { ...NO_FLAGS, dangerousCommand: true } }));
    const headless = service.evaluate(facts({ origin: 'goal', flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(audit.get(withUi.auditId)?.queuePayload).toBeUndefined();
    expect(JSON.parse(audit.get(headless.auditId)?.queuePayload ?? '{}')).toMatchObject({ tool: 'bash' });
  });

  it('degrades to ask and still returns an audit id when the rule store throws', async () => {
    const { audit } = await fixture();
    const broken = new ToolDecisionService(
      {
        applicable: () => { throw new Error('database is locked'); },
        add: () => { throw new Error('not exercised by this test'); },
      } as never,
      audit,
    );
    const decision = broken.evaluate(facts());
    expect(decision.decision).toBe('ask');
    expect(audit.get(decision.auditId)).toMatchObject({ decision: 'ask', ruleId: 'builtin.rule-lookup-failed' });
  });

  it('writes the digested args rather than the raw payload', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({
      tool: 'write', command: undefined, path: 'D:/repo/a.ts',
      rawArgs: { path: 'D:/repo/a.ts', content: 'x'.repeat(50_000) },
      flags: { ...NO_FLAGS, write: true },
    }));
    expect(audit.get(decision.auditId)?.args).toBe('{"path":"D:/repo/a.ts"}');
  });
});

describe('ToolDecisionService.remember', () => {
  it('persists a rule from a user approval', async () => {
    const { rules, service } = await fixture();
    const rule = service.remember({
      scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash',
      matcherKind: 'command_prefix', matcher: 'npm run', effect: 'allow',
    });
    expect(rules.list().map((r) => r.id)).toEqual([rule.id]);
  });
});

describe('ToolDecisionService.settle', () => {
  it('updates the audit row with the user answer', async () => {
    const { audit, service } = await fixture();
    const decision = service.evaluate(facts({ flags: { ...NO_FLAGS, dangerousCommand: true } }));
    expect(service.settle(decision.auditId, 'user_deny')).toBe(true);
    expect(audit.get(decision.auditId)).toMatchObject({ resolution: 'user_deny', resolvedAt: 42 });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/toolDecisionService.test.ts`
预期：FAIL，报错 `Failed to resolve import "./toolDecisionService"`

- [ ] **步骤 3：实现决策服务**

创建 `electron-agent/electron/app/toolPermission/toolDecisionService.ts`：

```typescript
import { digestArgs } from './argsDigest';
import { matchBuiltinRules } from './builtinRules';
import { matchUserRules } from './rules';
import type { AuditResolution, ToolAuditStore } from './auditStore';
import type { ToolRuleStore } from './ruleStore';
import type { ToolCallFacts, ToolDecision, ToolEffect, ToolRule, ToolRuleInput } from './types';

const EFFECT_RANK: Record<ToolEffect, number> = { deny: 3, ask: 2, allow: 1 };

/** goal / subagent 没有交互 UI，ask 只能攒进队列等人处理。 */
function isHeadless(call: ToolCallFacts): boolean {
  return call.origin !== 'main';
}

export class ToolDecisionService {
  constructor(
    private readonly rules: Pick<ToolRuleStore, 'applicable' | 'add'>,
    private readonly audit: ToolAuditStore,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 决定这次工具调用能不能执行，并留下审计记录。
   *
   * 内置规则与用户规则各选出最强的一条后再比一次，因此用户的 allow 既解除不了
   * 内置 deny，也降不掉内置 ask。规则查询失败时降级为 ask 而非放行。
   */
  evaluate(call: ToolCallFacts): ToolDecision {
    const builtin = matchBuiltinRules(call);
    let user: ToolRule | undefined;
    let lookupFailed = false;
    try {
      user = matchUserRules(this.rules.applicable(call.workspace, call.sessionId), call, this.now());
    } catch {
      lookupFailed = true;
    }

    let decision: ToolEffect = 'allow';
    let ruleId: string | undefined;
    let resolution: AuditResolution = 'auto';

    if (lookupFailed) {
      decision = 'ask';
      ruleId = 'builtin.rule-lookup-failed';
    } else if (builtin && (!user || EFFECT_RANK[builtin.effect] >= EFFECT_RANK[user.effect])) {
      decision = builtin.effect;
      ruleId = builtin.id;
    } else if (user) {
      decision = user.effect;
      ruleId = user.id;
      resolution = 'rule';
    }

    if (decision === 'ask') resolution = 'queued';

    const auditId = this.audit.record({
      workspace: call.workspace,
      origin: call.origin,
      tool: call.tool,
      args: digestArgs(call.tool, call.rawArgs),
      decision,
      resolution,
      ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
      ...(call.threadId === undefined ? {} : { threadId: call.threadId }),
      ...(call.turnId === undefined ? {} : { turnId: call.turnId }),
      ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
      ...(ruleId === undefined ? {} : { ruleId }),
      ...(decision === 'ask' && isHeadless(call)
        ? { queuePayload: JSON.stringify({ tool: call.tool, command: call.command, path: call.path, ruleId }) }
        : {}),
    });

    return { decision, auditId, ...(ruleId === undefined ? {} : { ruleId }) };
  }

  /** 用户选「总是允许」后落一条规则。 */
  remember(input: ToolRuleInput): ToolRule {
    return this.rules.add(input);
  }

  /** 用户应答或中断后更新审计行。 */
  settle(auditId: string, resolution: AuditResolution): boolean {
    return this.audit.resolve(auditId, resolution);
  }
}
```

- [ ] **步骤 4：运行测试与类型检查**

运行：`cd electron-agent; npx vitest run electron/app/toolPermission/; npx tsc -p tsconfig.node.json --noEmit 2>&1 | Select-String "toolPermission" | Measure-Object | Select-Object -ExpandProperty Count`
预期：10 个测试全部 PASS，类型错误计数为 `0`

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/toolPermission/toolDecisionService.ts electron-agent/electron/app/toolPermission/toolDecisionService.test.ts
git commit -m "feat(permission): 实现工具授权决策服务"
```

---

## 任务 9：注册 RPC

**文件：**
- 创建：`electron-agent/electron/app/toolPermission/rpc.ts`
- 修改：`electron-agent/electron/agentData/runtime.ts:64-101`（字段与 `start()`）、`runtime.ts:440`（分发链）
- 测试：`electron-agent/electron/app/toolPermission/rpc.test.ts`

**不要走 `main.ts` 的 `methods` 选项。** 那个选项在构造 `AgentDataService` 时就要求提供处理函数，但 `AgentDataStorage` 要到 `runtime.start()`（`runtime.ts:99`）才创建，那时拿不到 `db`。正确做法是照 `GoalStore`、`MemoryStore`、`JobStore` 的既有模式在 `start()` 内部构造，再挂进 `runtime.ts:440` 的分发链。

**workspace 必须由 token 决定。** sidecar 用 project token 调用，`this.projectTokens.get(token)` 能查出它属于哪个工作区。RPC 层要用这个值覆盖 sidecar 自报的 `workspace`，否则一个工作区的 sidecar 可以给另一个工作区写规则。`wikiMethod` 用 `wikiContext(value.token, value.params)` 做同样的事，照抄那个形状。

- [ ] **步骤 1：编写失败的测试**

创建 `electron-agent/electron/app/toolPermission/rpc.test.ts`：

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataStorage } from '../../agentData/storage';
import { ToolAuditStore } from './auditStore';
import { ToolRuleStore } from './ruleStore';
import { ToolDecisionService } from './toolDecisionService';
import { toolPermissionMethods } from './rpc';

const directories: string[] = [];
const stores: AgentDataStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(owner: string | undefined = 'D:/repo') {
  const directory = await mkdtemp(join(tmpdir(), 'tool-permission-rpc-'));
  directories.push(directory);
  const storage = new AgentDataStorage(join(directory, 'agent-data.db'));
  stores.push(storage);
  storage.migrate();
  const audit = new ToolAuditStore(storage.db, () => 42);
  const service = new ToolDecisionService(new ToolRuleStore(storage.db, () => 42), audit);
  return { service, audit, methods: toolPermissionMethods(service, owner) };
}

const CALL = {
  tool: 'bash', workspace: 'D:/repo', origin: 'main', preset: 'auto', sessionId: 's1',
  command: 'npm run build',
  flags: {
    dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false,
    network: false, mcp: false, codeExec: false, write: false,
  },
};

describe('toolPermissionMethods', () => {
  it('exposes exactly the three tool permission methods', async () => {
    const { methods } = await fixture();
    expect(Object.keys(methods).sort()).toEqual(['permission.tool.evaluate', 'permission.tool.remember', 'permission.tool.settle']);
  });

  it('evaluates a call passed as params.call', async () => {
    const { methods } = await fixture();
    const result = await methods['permission.tool.evaluate']({ call: CALL });
    expect(result).toMatchObject({ decision: 'allow' });
  });

  it('rejects a params payload without a call object', async () => {
    const { methods } = await fixture();
    await expect(methods['permission.tool.evaluate']({})).rejects.toThrow('invalid tool call');
  });

  it('rejects a call whose required fields have the wrong type', async () => {
    const { methods } = await fixture();
    await expect(methods['permission.tool.evaluate']({ call: { ...CALL, tool: 42 } })).rejects.toThrow('invalid tool call');
    await expect(methods['permission.tool.evaluate']({ call: { ...CALL, flags: null } })).rejects.toThrow('invalid tool call');
    await expect(methods['permission.tool.evaluate']({ call: { ...CALL, preset: 'nope' } })).rejects.toThrow('invalid tool call');
    await expect(methods['permission.tool.evaluate']({ call: { ...CALL, origin: 'nope' } })).rejects.toThrow('invalid tool call');
  });

  it('coerces missing flags to false rather than failing', async () => {
    const { methods } = await fixture();
    const result = await methods['permission.tool.evaluate']({
      call: { ...CALL, preset: 'auto', flags: { dangerousCommand: true } },
    });
    expect(result).toMatchObject({ decision: 'ask', ruleId: 'builtin.dangerous-command' });
  });

  it('overrides the caller-supplied workspace with the token owner', async () => {
    const { audit, methods } = await fixture('D:/repo');
    const result = await methods['permission.tool.evaluate']({
      call: { ...CALL, workspace: 'D:/someone-elses-project' },
    }) as { auditId: string };
    expect(audit.get(result.auditId)?.workspace).toBe('D:/repo');
  });

  it('rejects every call when the token owns no workspace', async () => {
    const { methods } = await fixture(undefined);
    await expect(methods['permission.tool.evaluate']({ call: CALL })).rejects.toThrow('workspace is not bound');
    await expect(methods['permission.tool.remember']({
      rule: { scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' },
    })).rejects.toThrow('workspace is not bound');
  });

  it('forces a remembered workspace rule onto the token owner', async () => {
    const { methods } = await fixture('D:/repo');
    const rule = await methods['permission.tool.remember']({
      rule: { scope: 'workspace', scopeKey: 'D:/elsewhere', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' },
    }) as { scopeKey: string };
    expect(rule.scopeKey).toBe('D:/repo');
  });

  it('remembers a rule', async () => {
    const { methods } = await fixture();
    const rule = await methods['permission.tool.remember']({
      rule: { scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow' },
    });
    expect(rule).toMatchObject({ effect: 'allow', tool: 'bash' });
  });

  it('rejects a remembered rule with an unknown effect', async () => {
    const { methods } = await fixture();
    await expect(methods['permission.tool.remember']({
      rule: { scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'maybe' },
    })).rejects.toThrow('invalid permission rule');
  });

  it('settles an audit row', async () => {
    const { methods } = await fixture();
    const decision = await methods['permission.tool.evaluate']({
      call: { ...CALL, flags: { ...CALL.flags, dangerousCommand: true } },
    }) as { auditId: string };
    await expect(methods['permission.tool.settle']({ auditId: decision.auditId, resolution: 'user_allow' }))
      .resolves.toEqual({ updated: true });
  });

  it('rejects an unknown resolution', async () => {
    const { methods } = await fixture();
    await expect(methods['permission.tool.settle']({ auditId: 'x', resolution: 'whatever' }))
      .rejects.toThrow('invalid resolution');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/rpc.test.ts`
预期：FAIL，报错 `Failed to resolve import "./rpc"`

- [ ] **步骤 3：实现 RPC 工厂**

创建 `electron-agent/electron/app/toolPermission/rpc.ts`：

```typescript
import type { AuditResolution } from './auditStore';
import type { ToolDecisionService } from './toolDecisionService';
import type {
  ApprovalPreset, MatcherKind, RuleScope, ToolCallFacts, ToolCallFlags, ToolEffect, ToolOrigin, ToolRuleInput,
} from './types';

type Params = Record<string, unknown>;
type Method = (params: Params) => unknown | Promise<unknown>;

const ORIGINS: readonly ToolOrigin[] = ['main', 'subagent', 'goal'];
const PRESETS: readonly ApprovalPreset[] = ['ask', 'auto', 'full'];
const EFFECTS: readonly ToolEffect[] = ['allow', 'deny', 'ask'];
const SCOPES: readonly RuleScope[] = ['session', 'workspace', 'global'];
const MATCHERS: readonly MatcherKind[] = ['any', 'command_prefix', 'path_glob', 'mcp_server'];
const RESOLUTIONS: readonly AuditResolution[] = ['auto', 'rule', 'user_allow', 'user_deny', 'queued', 'aborted'];

const FLAG_KEYS: readonly (keyof ToolCallFlags)[] = [
  'dangerousCommand', 'mutatingCommand', 'protectedPath', 'outsideWorkspace', 'network', 'mcp', 'codeExec', 'write',
];

function isRecord(value: unknown): value is Params {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`invalid tool call: ${field}`);
  return value;
}

/** 缺失的 flag 视为 false：sidecar 只发它判定为真的项，少发不算错。 */
function readFlags(value: unknown): ToolCallFlags {
  if (!isRecord(value)) throw new Error('invalid tool call: flags');
  const flags = {} as ToolCallFlags;
  for (const key of FLAG_KEYS) flags[key] = value[key] === true;
  return flags;
}

function readCall(value: unknown): ToolCallFacts {
  if (!isRecord(value)) throw new Error('invalid tool call');
  if (typeof value.tool !== 'string' || value.tool === '') throw new Error('invalid tool call: tool');
  if (typeof value.workspace !== 'string' || value.workspace === '') throw new Error('invalid tool call: workspace');
  if (!ORIGINS.includes(value.origin as ToolOrigin)) throw new Error('invalid tool call: origin');
  if (!PRESETS.includes(value.preset as ApprovalPreset)) throw new Error('invalid tool call: preset');
  return {
    tool: value.tool,
    workspace: value.workspace,
    origin: value.origin as ToolOrigin,
    preset: value.preset as ApprovalPreset,
    flags: readFlags(value.flags),
    ...(optionalString(value.sessionId, 'sessionId') === undefined ? {} : { sessionId: value.sessionId as string }),
    ...(optionalString(value.threadId, 'threadId') === undefined ? {} : { threadId: value.threadId as string }),
    ...(optionalString(value.turnId, 'turnId') === undefined ? {} : { turnId: value.turnId as string }),
    ...(optionalString(value.toolCallId, 'toolCallId') === undefined ? {} : { toolCallId: value.toolCallId as string }),
    ...(optionalString(value.command, 'command') === undefined ? {} : { command: value.command as string }),
    ...(optionalString(value.path, 'path') === undefined ? {} : { path: value.path as string }),
    ...(isRecord(value.rawArgs) ? { rawArgs: value.rawArgs } : {}),
  };
}

function readRule(value: unknown): ToolRuleInput {
  if (!isRecord(value)) throw new Error('invalid permission rule');
  if (!SCOPES.includes(value.scope as RuleScope)) throw new Error('invalid permission rule: scope');
  if (!MATCHERS.includes(value.matcherKind as MatcherKind)) throw new Error('invalid permission rule: matcherKind');
  if (!EFFECTS.includes(value.effect as ToolEffect)) throw new Error('invalid permission rule: effect');
  if (typeof value.tool !== 'string' || value.tool === '') throw new Error('invalid permission rule: tool');
  return {
    scope: value.scope as RuleScope,
    scopeKey: typeof value.scopeKey === 'string' ? value.scopeKey : '',
    tool: value.tool,
    matcherKind: value.matcherKind as MatcherKind,
    matcher: typeof value.matcher === 'string' ? value.matcher : '',
    effect: value.effect as ToolEffect,
    ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}),
  };
}

/**
 * 构造一组绑定到某个工作区的 RPC 处理函数。
 *
 * `owner` 来自调用方 token 所属的工作区，不是 sidecar 自报的值：调用方无法
 * 借伪造 workspace 去读写别的工作区的规则与审计。token 没有绑定工作区时全部拒绝。
 */
export function toolPermissionMethods(
  service: ToolDecisionService,
  owner: string | undefined,
): Record<string, Method> {
  const requireOwner = (): string => {
    if (!owner) throw new Error('workspace is not bound to this caller');
    return owner;
  };
  return {
    'permission.tool.evaluate': (params) => service.evaluate({ ...readCall(params.call), workspace: requireOwner() }),
    'permission.tool.remember': (params) => {
      const rule = readRule(params.rule);
      const scopeKey = rule.scope === 'workspace' ? requireOwner() : rule.scopeKey;
      requireOwner();
      return service.remember({ ...rule, scopeKey });
    },
    'permission.tool.settle': (params) => {
      requireOwner();
      if (typeof params.auditId !== 'string') throw new Error('invalid auditId');
      if (!RESOLUTIONS.includes(params.resolution as AuditResolution)) throw new Error('invalid resolution');
      return { updated: service.settle(params.auditId, params.resolution as AuditResolution) };
    },
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/app/toolPermission/rpc.test.ts`
预期：13 个测试全部 PASS

- [ ] **步骤 5：在 runtime 中构造服务**

在 `electron-agent/electron/agentData/runtime.ts` 顶部 import 区加入：

```typescript
import { ToolAuditStore } from '../app/toolPermission/auditStore';
import { ToolRuleStore } from '../app/toolPermission/ruleStore';
import { ToolDecisionService } from '../app/toolPermission/toolDecisionService';
import { toolPermissionMethods } from '../app/toolPermission/rpc';
```

在类字段区（`private storage?: AgentDataStorage;` 附近，约第 66 行）加一个字段：

```typescript
  private toolPermission?: ToolDecisionService;
```

在 `start()` 中紧跟 `this.goals = new GoalStore(this.storage.db);`（约第 101 行）之后加：

```typescript
    this.toolPermission = new ToolDecisionService(
      new ToolRuleStore(this.storage.db),
      new ToolAuditStore(this.storage.db),
    );
```

复用 `this.storage.db` 而不是新开连接：两个 `DatabaseSync` 指向同一文件会互相加锁。

在 `finishClose()` 中与 `this.storage?.close()` 同处清空引用：

```typescript
    this.toolPermission = undefined;
```

- [ ] **步骤 6：挂进分发链**

在 `runtime.ts` 中添加一个私有方法，与既有的 `wikiMethod` / `memoryMethod` 并列：

```typescript
  /** 工具授权 RPC。workspace 由 token 决定，调用方自报的值一律被覆盖。 */
  private toolPermissionMethod(name: string, workspace: string | undefined): AgentDataMethod | undefined {
    if (!this.toolPermission) return undefined;
    return toolPermissionMethods(this.toolPermission, workspace)[name];
  }
```

然后修改第 440 行的分发链，在 `this.threadMethod(value.method)` 之前插入一项。改动前：

```typescript
              : projectJobs ?? this.options.methods?.[value.method] ?? this.memoryMethod(value.method) ?? this.adminMethod(value.method) ?? this.threadMethod(value.method);
```

改动后：

```typescript
              : projectJobs ?? this.options.methods?.[value.method] ?? this.memoryMethod(value.method) ?? this.adminMethod(value.method) ?? this.toolPermissionMethod(value.method, workspace) ?? this.threadMethod(value.method);
```

`workspace` 是该分支上方第 433 行已有的 `this.projectTokens.get(value.token)`，直接复用，不要另外解析 token。

- [ ] **步骤 7：编写跨进程集成测试**

在 `electron-agent/electron/agentData/runtime.toolPermission.test.ts` 中验证真实的 socket 往返，参考 `extensionIntegration.test.ts` 的搭法：

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';

const directories: string[] = [];
const runtimes: AgentDataRuntime[] = [];
const clients: AgentDataClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const runtime of runtimes.splice(0)) { runtime.close(); await runtime.waitClosed(); }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-tool-permission-'));
  directories.push(directory);
  const workspace = join(directory, 'project');
  const runtime = new AgentDataRuntime({ dataPath: join(directory, 'agent-data.db') });
  runtimes.push(runtime);
  await runtime.start();
  const client = new AgentDataClient(runtime.agentEndpoint(workspace));
  clients.push(client);
  return { client, workspace };
}

describe('permission.tool.* over the socket', () => {
  it('evaluates a call and stamps the token workspace', async () => {
    const { client, workspace } = await fixture();
    const result = await client.request<{ decision: string; auditId: string }>('permission.tool.evaluate', {
      call: {
        tool: 'bash', workspace: 'D:/not-mine', origin: 'main', preset: 'auto', command: 'ls',
        flags: { dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false, network: false, mcp: false, codeExec: false, write: false },
      },
    });
    expect(result.decision).toBe('allow');
    expect(result.auditId).toBeTruthy();
    void workspace;
  });

  it('asks for a dangerous command under the auto preset', async () => {
    const { client } = await fixture();
    const result = await client.request<{ decision: string; ruleId: string }>('permission.tool.evaluate', {
      call: {
        tool: 'bash', workspace: 'x', origin: 'main', preset: 'auto', command: 'rm -rf /',
        flags: { dangerousCommand: true, mutatingCommand: true, protectedPath: false, outsideWorkspace: false, network: false, mcp: false, codeExec: false, write: false },
      },
    });
    expect(result).toMatchObject({ decision: 'ask', ruleId: 'builtin.dangerous-command' });
  });
});
```

- [ ] **步骤 8：运行测试与类型检查**

运行：`cd electron-agent; npx vitest run electron/agentData/runtime.toolPermission.test.ts electron/app/toolPermission/; npx tsc -p tsconfig.node.json --noEmit 2>&1 | Select-String "toolPermission" | Measure-Object | Select-Object -ExpandProperty Count`
预期：全部 PASS，类型错误计数为 `0`

- [ ] **步骤 9：Commit**

```bash
git add electron-agent/electron/app/toolPermission/rpc.ts electron-agent/electron/app/toolPermission/rpc.test.ts electron-agent/electron/agentData/runtime.ts electron-agent/electron/agentData/runtime.toolPermission.test.ts
git commit -m "feat(permission): 暴露工具授权 RPC"
```

---

## 任务 10：sidecar 客户端

**文件：**
- 修改：`extensions/_shared/desktop-control.ts`
- 测试：`extensions/_shared/desktop-control.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/_shared/desktop-control.test.ts`：

```typescript
import { describe, expect, it, vi } from 'vitest';
import { evaluateToolCall, rememberToolRule, settleToolCall } from './desktop-control.js';
import type { ToolCallFacts } from './desktop-control.js';

const CALL: ToolCallFacts = {
  tool: 'bash', workspace: 'D:/repo', origin: 'main', preset: 'auto', command: 'npm run build',
  flags: {
    dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false,
    network: false, mcp: false, codeExec: false, write: false,
  },
};

/** DesktopControlPort 的最小替身；request 的泛型返回值用 cast 满足接口。 */
function port(result: unknown) {
  return { request: vi.fn(async () => result) } as unknown as { request: ReturnType<typeof vi.fn> } & import('./desktop-control.js').DesktopControlPort;
}

describe('evaluateToolCall', () => {
  it('forwards the call and returns the decision', async () => {
    const client = port({ decision: 'allow', auditId: 'a1' });
    await expect(evaluateToolCall(client, CALL)).resolves.toEqual({ decision: 'allow', auditId: 'a1' });
    expect(client.request).toHaveBeenCalledWith('permission.tool.evaluate', { call: CALL });
  });

  it('denies when the channel fails, never falls through to allow', async () => {
    const client = { request: vi.fn(async () => { throw new Error('connection refused'); }) };
    await expect(evaluateToolCall(client, CALL)).resolves.toEqual({ decision: 'deny', auditId: undefined });
  });

  it('denies when the host returns a malformed decision', async () => {
    await expect(evaluateToolCall(port({ decision: 'maybe' }), CALL)).resolves.toMatchObject({ decision: 'deny' });
    await expect(evaluateToolCall(port(null), CALL)).resolves.toMatchObject({ decision: 'deny' });
  });
});

describe('rememberToolRule', () => {
  it('reports false instead of throwing when the host rejects the rule', async () => {
    const client = { request: vi.fn(async () => { throw new Error('invalid permission rule'); }) };
    await expect(rememberToolRule(client, {
      scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow',
    })).resolves.toBe(false);
  });

  it('reports true on success', async () => {
    await expect(rememberToolRule(port({ id: 'r1' }), {
      scope: 'global', scopeKey: '', tool: 'bash', matcherKind: 'any', matcher: '', effect: 'allow',
    })).resolves.toBe(true);
  });
});

describe('settleToolCall', () => {
  it('swallows transport errors: the decision already stands', async () => {
    const client = { request: vi.fn(async () => { throw new Error('closed'); }) };
    await expect(settleToolCall(client, 'a1', 'user_allow')).resolves.toBeUndefined();
  });

  it('skips the round trip when there is no audit id', async () => {
    const client = port({ updated: true });
    await settleToolCall(client, undefined, 'user_allow');
    expect(client.request).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run _shared/desktop-control.test.ts`
预期：FAIL，报错 `evaluateToolCall is not exported`

若 `extensions` 目录没有独立的 vitest 配置，从仓库根运行：`npx vitest run extensions/_shared/desktop-control.test.ts`。以此为准，后续步骤同理。

- [ ] **步骤 3：实现客户端方法**

在 `extensions/_shared/desktop-control.ts` 末尾追加。类型是主进程 `app/toolPermission/types.ts` 的镜像，字段名必须逐字一致——两个包不能互相 import：

```typescript
export type ToolOrigin = 'main' | 'subagent' | 'goal';
export type ToolEffect = 'allow' | 'deny' | 'ask';
export type ApprovalPreset = 'ask' | 'auto' | 'full';
export type RuleScope = 'session' | 'workspace' | 'global';
export type MatcherKind = 'any' | 'command_prefix' | 'path_glob' | 'mcp_server';
export type AuditResolution = 'auto' | 'rule' | 'user_allow' | 'user_deny' | 'queued' | 'aborted';

export interface ToolCallFlags {
  dangerousCommand: boolean;
  mutatingCommand: boolean;
  protectedPath: boolean;
  outsideWorkspace: boolean;
  network: boolean;
  mcp: boolean;
  codeExec: boolean;
  write: boolean;
}

export interface ToolCallFacts {
  tool: string;
  workspace: string;
  origin: ToolOrigin;
  preset: ApprovalPreset;
  flags: ToolCallFlags;
  sessionId?: string;
  toolCallId?: string;
  command?: string;
  path?: string;
  rawArgs?: Record<string, unknown>;
}

export interface ToolRuleDraft {
  scope: RuleScope;
  scopeKey: string;
  tool: string;
  matcherKind: MatcherKind;
  matcher: string;
  effect: ToolEffect;
  expiresAt?: number;
}

export interface ToolDecisionResult {
  decision: ToolEffect;
  auditId?: string;
  ruleId?: string;
}

/** 判定本进程身份，与 extensions/goal/tools.ts 的 automaticTurn 同源。 */
export function resolveToolOrigin(): ToolOrigin {
  if (process.env.PI_IS_SUBAGENT === '1') return 'subagent';
  if (process.env.PI_GOAL_WORKER === '1' || process.env.PI_SYSTEM_WORKER === '1') return 'goal';
  return 'main';
}

/**
 * 问主进程这次工具调用能不能执行。
 *
 * 通道不可用或回包不合法时返回 deny：此时既无法确认规则也无法写审计，
 * 放行等于无记录地执行。不要改成 allow。
 */
export async function evaluateToolCall(
  client: DesktopControlPort,
  call: ToolCallFacts,
): Promise<ToolDecisionResult> {
  try {
    const result = await client.request<unknown>('permission.tool.evaluate', { call });
    if (typeof result !== 'object' || result === null) return { decision: 'deny', auditId: undefined };
    const value = result as { decision?: unknown; auditId?: unknown; ruleId?: unknown };
    if (value.decision !== 'allow' && value.decision !== 'deny' && value.decision !== 'ask') {
      return { decision: 'deny', auditId: undefined };
    }
    return {
      decision: value.decision,
      auditId: typeof value.auditId === 'string' ? value.auditId : undefined,
      ...(typeof value.ruleId === 'string' ? { ruleId: value.ruleId } : {}),
    };
  } catch {
    return { decision: 'deny', auditId: undefined };
  }
}

/** 用户选「总是允许」后落规则。失败只影响下次还会再问一遍，不阻断本次执行。 */
export async function rememberToolRule(client: DesktopControlPort, rule: ToolRuleDraft): Promise<boolean> {
  try {
    await client.request('permission.tool.remember', { rule });
    return true;
  } catch {
    return false;
  }
}

/** 回填用户应答。审计写失败不改变已经作出的放行/拦截决定，故吞掉异常。 */
export async function settleToolCall(
  client: DesktopControlPort,
  auditId: string | undefined,
  resolution: AuditResolution,
): Promise<void> {
  if (!auditId) return;
  try {
    await client.request('permission.tool.settle', { auditId, resolution });
  } catch {
    /* 审计回填失败不影响本次执行结果 */
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run extensions/_shared/desktop-control.test.ts`
预期：7 个测试全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add extensions/_shared/desktop-control.ts extensions/_shared/desktop-control.test.ts
git commit -m "feat(permission): 新增 sidecar 侧授权客户端"
```

---

## 任务 11：safety 钩子接入

**文件：**
- 修改：`extensions/safety/index.ts:19-109`
- 测试：`extensions/safety/toolAuthorization.test.ts`

这是唯一改动既有行为的任务。第 ① 层（子代理能力硬限）原样保留，②③④ 层替换为快问主进程。

- [ ] **步骤 1：编写失败的测试**

创建 `extensions/safety/toolAuthorization.test.ts`：

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  evaluateToolCall: vi.fn(async () => ({ decision: 'allow' as const, auditId: 'a1' })),
  rememberToolRule: vi.fn(async () => true),
  settleToolCall: vi.fn(async () => undefined),
  getApprovalPolicy: vi.fn(() => 'auto' as const),
  getConfig: vi.fn(() => undefined as string | undefined),
}));

// resolveToolOrigin 保留真实实现：origin 的测试靠设置 PI_IS_SUBAGENT 等环境变量驱动。
vi.mock('../_shared/desktop-control.js', async () => {
  const actual = await vi.importActual<typeof import('../_shared/desktop-control.js')>('../_shared/desktop-control.js');
  return {
    ...actual,
    desktopControl: () => ({ request: vi.fn() }),
    evaluateToolCall: mocks.evaluateToolCall,
    rememberToolRule: mocks.rememberToolRule,
    settleToolCall: mocks.settleToolCall,
  };
});
vi.mock('../_shared/approval.js', () => ({ getApprovalPolicy: mocks.getApprovalPolicy }));
vi.mock('../_shared/runtime-config.js', () => ({ getConfig: mocks.getConfig }));

import safety from './index.js';

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ block?: boolean; reason?: string } | undefined>;

function loadToolCall(): Handler {
  let handler: Handler | undefined;
  safety({
    on: (name: string, fn: Handler) => { if (name === 'tool_call') handler = fn; },
  } as never);
  if (!handler) throw new Error('tool_call handler was not registered');
  return handler;
}

function ctx(over: Record<string, unknown> = {}) {
  return {
    cwd: 'D:/repo',
    hasUI: true,
    ui: { select: vi.fn(async () => '允许本次') },
    sessionManager: { getSessionId: () => 's1' },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SAFETY_DENY_TOOLS;
  delete process.env.SAFETY_READONLY;
  delete process.env.PI_IS_SUBAGENT;
  delete process.env.PI_GOAL_WORKER;
  mocks.getApprovalPolicy.mockReturnValue('auto');
  mocks.getConfig.mockReturnValue(undefined);
  mocks.evaluateToolCall.mockResolvedValue({ decision: 'allow', auditId: 'a1' });
});

describe('safety tool_call · capability hard limits still come first', () => {
  it('blocks a denied tool without asking the host', async () => {
    process.env.SAFETY_DENY_TOOLS = 'bash';
    const result = await loadToolCall()({ toolName: 'bash', input: { command: 'ls' } }, ctx());
    expect(result).toMatchObject({ block: true });
    expect(mocks.evaluateToolCall).not.toHaveBeenCalled();
  });

  it('blocks a write tool in readonly mode without asking the host', async () => {
    process.env.SAFETY_READONLY = '1';
    const result = await loadToolCall()({ toolName: 'ast_edit', input: { path: 'a.ts' } }, ctx());
    expect(result).toMatchObject({ block: true });
    expect(mocks.evaluateToolCall).not.toHaveBeenCalled();
  });
});

describe('safety tool_call · host decision', () => {
  it('passes the extracted facts to the host', async () => {
    await loadToolCall()({ toolName: 'bash', toolCallId: 'c1', input: { command: 'rm -rf /' } }, ctx());
    const call = mocks.evaluateToolCall.mock.calls[0][1];
    expect(call).toMatchObject({
      tool: 'bash', workspace: 'D:/repo', origin: 'main', preset: 'auto', toolCallId: 'c1', sessionId: 's1',
    });
    expect(call.flags.dangerousCommand).toBe(true);
  });

  it('marks mcp, network and code exec flags', async () => {
    await loadToolCall()({ toolName: 'mcp__github__x', input: {} }, ctx());
    expect(mocks.evaluateToolCall.mock.calls[0][1].flags.mcp).toBe(true);
    await loadToolCall()({ toolName: 'py_run', input: {} }, ctx());
    expect(mocks.evaluateToolCall.mock.calls[1][1].flags.codeExec).toBe(true);
  });

  it('reports the process origin for a sub-agent', async () => {
    process.env.PI_IS_SUBAGENT = '1';
    await loadToolCall()({ toolName: 'bash', input: { command: 'ls' } }, ctx({ hasUI: false }));
    expect(mocks.evaluateToolCall.mock.calls[0][1].origin).toBe('subagent');
  });

  it('honours SAFETY_BASH_CONFIRM=0 by withholding the dangerous flag', async () => {
    mocks.getConfig.mockImplementation((k: string) => (k === 'SAFETY_BASH_CONFIRM' ? '0' : undefined));
    await loadToolCall()({ toolName: 'bash', input: { command: 'rm -rf /' } }, ctx());
    expect(mocks.evaluateToolCall.mock.calls[0][1].flags.dangerousCommand).toBe(false);
  });

  it('honours SAFETY_PROTECT_PATHS=0 by withholding the protected-path flag', async () => {
    mocks.getConfig.mockImplementation((k: string) => (k === 'SAFETY_PROTECT_PATHS' ? '0' : undefined));
    await loadToolCall()({ toolName: 'write', input: { path: 'C:/Windows/System32/x.dll' } }, ctx());
    expect(mocks.evaluateToolCall.mock.calls[0][1].flags.protectedPath).toBe(false);
  });

  it('allows the call through when the host says allow', async () => {
    await expect(loadToolCall()({ toolName: 'bash', input: { command: 'ls' } }, ctx())).resolves.toBeUndefined();
  });

  it('blocks when the host says deny', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'deny', auditId: 'a1' });
    const result = await loadToolCall()({ toolName: 'bash', input: { command: 'ls' } }, ctx());
    expect(result).toMatchObject({ block: true });
  });
});

describe('safety tool_call · ask flow', () => {
  it('prompts the user and allows once when they pick 允许本次', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx();
    await expect(loadToolCall()({ toolName: 'bash', input: { command: 'rm -rf x' } }, c)).resolves.toBeUndefined();
    expect(c.ui.select).toHaveBeenCalled();
    expect(mocks.settleToolCall).toHaveBeenCalledWith(expect.anything(), 'a1', 'user_allow');
    expect(mocks.rememberToolRule).not.toHaveBeenCalled();
  });

  it('writes a command_prefix rule when the user picks 总是允许 for bash', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx({ ui: { select: vi.fn(async () => '总是允许') } });
    await loadToolCall()({ toolName: 'bash', input: { command: 'npm run build' } }, c);
    expect(mocks.rememberToolRule).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: 'workspace', scopeKey: 'D:/repo', tool: 'bash', matcherKind: 'command_prefix', effect: 'allow',
    }));
  });

  it('writes a plain tool rule when the tool has no command or path', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx({ ui: { select: vi.fn(async () => '总是允许') } });
    await loadToolCall()({ toolName: 'web_search', input: { query: 'x' } }, c);
    expect(mocks.rememberToolRule).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tool: 'web_search', matcherKind: 'any', effect: 'allow',
    }));
  });

  it('blocks and settles as user_deny when the user refuses', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx({ ui: { select: vi.fn(async () => '拒绝') } });
    const result = await loadToolCall()({ toolName: 'bash', input: { command: 'rm -rf x' } }, c);
    expect(result).toMatchObject({ block: true });
    expect(mocks.settleToolCall).toHaveBeenCalledWith(expect.anything(), 'a1', 'user_deny');
  });

  it('blocks without prompting when there is no UI, leaving the row queued', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx({ hasUI: false });
    const result = await loadToolCall()({ toolName: 'bash', input: { command: 'rm -rf x' } }, c);
    expect(result).toMatchObject({ block: true });
    expect(c.ui.select).not.toHaveBeenCalled();
    expect(mocks.settleToolCall).not.toHaveBeenCalled();
  });

  it('settles as aborted when the prompt throws', async () => {
    mocks.evaluateToolCall.mockResolvedValue({ decision: 'ask', auditId: 'a1' });
    const c = ctx({ ui: { select: vi.fn(async () => { throw new Error('aborted'); }) } });
    const result = await loadToolCall()({ toolName: 'bash', input: { command: 'rm -rf x' } }, c);
    expect(result).toMatchObject({ block: true });
    expect(mocks.settleToolCall).toHaveBeenCalledWith(expect.anything(), 'a1', 'aborted');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run extensions/safety/toolAuthorization.test.ts`
预期：FAIL。现有实现走的是硬编码分支，`evaluateToolCall` 不会被调用。

- [ ] **步骤 3：替换 ②③④ 层**

在 `extensions/safety/index.ts` 顶部补充 import：

```typescript
import {
  desktopControl, evaluateToolCall, rememberToolRule, resolveToolOrigin, settleToolCall,
  type ToolCallFacts, type ToolRuleDraft,
} from "../_shared/desktop-control.js";
```

在 `export default function` 之前加入两个辅助函数：

```typescript
/**
 * 把一次调用压成主进程需要的事实特征。判定逻辑留在 sidecar，主进程只消费布尔量。
 *
 * 参数类型刻意声明得比 SDK 的 ToolCallEvent / Context 宽松：结构化类型让实参
 * 兼容，同时这个函数在单测里可以用普通对象调用，不必构造完整的 SDK 上下文。
 */
function collectFacts(
  event: { toolName: string; toolCallId?: string; input?: unknown },
  ctx: { cwd: string; sessionManager?: { getSessionId?: () => string | undefined } },
  preset: "ask" | "auto" | "full",
): ToolCallFacts {
  const input = (event.input ?? {}) as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : undefined;
  const isWrite = event.toolName === "write" || event.toolName === "edit" || WRITE_BYPASS_TOOLS.has(event.toolName);
  const path = isWrite ? extractPath(input) : undefined;
  // SAFETY_BASH_CONFIRM / SAFETY_PROTECT_PATHS 是既有的用户开关（原第 92-93 行）。
  // 内置规则不可编辑，所以关闭护栏的能力必须留在这里：开关关掉时干脆不上报该特征，
  // 主进程也就无从匹配对应的内置规则。去掉这两个判断会让现有配置静默失效。
  const guardBash = !off(getConfig("SAFETY_BASH_CONFIRM"));
  const guardPaths = !off(getConfig("SAFETY_PROTECT_PATHS"));
  return {
    tool: event.toolName,
    workspace: ctx.cwd,
    origin: resolveToolOrigin(),
    preset,
    flags: {
      dangerousCommand: guardBash && command !== undefined && isDangerousBash(command),
      mutatingCommand: command !== undefined && isMutatingBash(command),
      protectedPath: guardPaths && path !== undefined && matchProtectedPath(path),
      outsideWorkspace: path !== undefined && !isUnderCwd(path, ctx.cwd),
      network: NET_TOOLS.has(event.toolName),
      mcp: event.toolName.startsWith("mcp__"),
      codeExec: CODE_EXEC.has(event.toolName),
      write: isWrite,
    },
    ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
    ...(ctx.sessionManager?.getSessionId?.() === undefined
      ? {}
      : { sessionId: ctx.sessionManager.getSessionId() as string }),
    ...(command === undefined ? {} : { command }),
    ...(path === undefined ? {} : { path }),
    rawArgs: input,
  };
}

/** 「总是允许」写成尽可能窄的规则：bash 按命令前缀，写类工具按目录，其余按工具名。 */
function draftRule(facts: ToolCallFacts): ToolRuleDraft {
  const base = { scope: "workspace" as const, scopeKey: facts.workspace, tool: facts.tool, effect: "allow" as const };
  if (facts.command !== undefined) {
    const head = facts.command.trimStart().split(/\s+/).slice(0, 2).join(" ");
    return { ...base, matcherKind: "command_prefix", matcher: head };
  }
  if (facts.path !== undefined) {
    const dir = facts.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
    return { ...base, matcherKind: "path_glob", matcher: `${dir}/**` };
  }
  return { ...base, matcherKind: "any", matcher: "" };
}
```

然后把钩子中从 `// ② owner 审批策略` 注释开始、直到 `return undefined;` 之前的全部内容（原第 52 至 107 行）替换为：

```typescript
    // ②③④ 授权决策统一交给主进程：规则匹配、内置护栏与审计都在那边，
    // 这里只负责提取事实与执行结果。第 ① 层的能力硬限已在上方强制，不受此影响。
    const policy = getApprovalPolicy();
    const preset = policy === "full" ? "full" : policy === "ask" ? "ask" : "auto";
    const control = desktopControl();
    const facts = collectFacts(event, ctx, preset);
    const verdict = await evaluateToolCall(control, facts);

    if (verdict.decision === "allow") return undefined;
    if (verdict.decision === "deny") {
      return { block: true, reason: `已被授权规则拒绝：${event.toolName}` };
    }

    // ask：无 UI 时不能就地询问，审计行保持 queued 等人处理。
    if (!ctx.hasUI) {
      return { block: true, reason: `已攒起等待授权：${event.toolName}` };
    }

    const detail = facts.command ?? facts.path ?? event.toolName;
    let choice: string;
    try {
      choice = await ctx.ui.select(`请求批准：\n\n  ${detail}`, ["允许本次", "总是允许", "拒绝"]);
    } catch {
      await settleToolCall(control, verdict.auditId, "aborted");
      return { block: true, reason: "授权请求已取消" };
    }

    if (choice === "拒绝") {
      await settleToolCall(control, verdict.auditId, "user_deny");
      return { block: true, reason: `用户拒绝：${event.toolName}` };
    }
    if (choice === "总是允许") await rememberToolRule(control, draftRule(facts));
    await settleToolCall(control, verdict.auditId, "user_allow");
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run extensions/safety/`
预期：新增的 15 个测试 PASS。既有 safety 测试若断言了被替换掉的硬编码文案，按新行为更新断言——这是本次变更的预期后果，但**不要**放宽以下两类断言：`SAFETY_DENY_TOOLS` 与 `SAFETY_READONLY` 属于第 ① 层，`SAFETY_BASH_CONFIRM` 与 `SAFETY_PROTECT_PATHS` 是用户可见的既有开关，两者都必须保持原有语义。

- [ ] **步骤 4b：确认没有留下死代码**

替换掉 ②③④ 层后，检查 `extensions/safety/index.ts` 顶部的 import 与模块级辅助函数是否还都有人用：

运行：`npx eslint extensions/safety/index.ts`

`off`（第 11 行）仍被 `collectFacts` 使用，`on`（钩子内）仍被 readonly 分支使用，`matchWriteAllowed` 仍被第 ① 层使用，其余判定函数与工具分组常量都被 `collectFacts` 使用——正常情况下不应有未使用告警。若出现，删掉本次改动造成的未使用项；不要顺手清理与本次改动无关的既有代码。

- [ ] **步骤 5：全量回归**

运行：`cd electron-agent && npx vitest run` 与 `npx vitest run extensions/`
预期：全部 PASS

- [ ] **步骤 6：类型检查**

本任务改的是 `extensions/`，不在 `tsconfig.node.json` 的 `include`（只含 `electron/**/*.ts`）范围内，没有对应的 tsc 步骤。改用 vitest 覆盖，并确认主进程侧未被波及：

运行：`cd electron-agent; npx tsc -p tsconfig.node.json --noEmit 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
预期：仍为 `53`，即历史基线未变

- [ ] **步骤 7：Commit**

```bash
git add extensions/safety/index.ts extensions/safety/toolAuthorization.test.ts
git commit -m "feat(permission): safety 钩子改由主进程决策"
```

---

## 任务 12：手工验收

自动化测试覆盖不到跨进程链路，这一步必须手动跑一遍真实应用。

**文件：** 无代码改动。

- [ ] **步骤 1：启动应用**

运行：`cd electron-agent && npm run dev`
预期：应用正常启动，无主进程报错

- [ ] **步骤 2：验证 auto 档放行普通命令**

在任意工作区发一条让 agent 执行 `ls` 的消息。
预期：直接执行，不弹确认卡。

- [ ] **步骤 3：验证审计落库**

先确定数据库位置。`main.ts:65` 用的是 `join(app.getPath('userData'), 'agent-data.db')`，Windows 上 `userData` 是 `%APPDATA%\<应用名>`，应用名取自 `package.json` 的 `name` 或 `electron-builder.yml` 的 `productName`。用 PowerShell 找出来：

```powershell
Get-ChildItem "$env:APPDATA" -Recurse -Depth 1 -Filter "agent-data.db" | Select-Object -ExpandProperty FullName
```

然后查最近的审计行（把 `<DB>` 换成上一条命令的输出）：

```powershell
sqlite3 "<DB>" "SELECT tool, decision, resolution, args FROM tool_audit ORDER BY created_at DESC LIMIT 5;"
```

若机器上没有 `sqlite3` 可执行文件，改用 Node：

```powershell
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);console.table(db.prepare('SELECT tool,decision,resolution,args FROM tool_audit ORDER BY created_at DESC LIMIT 5').all())" "<DB>"
```

预期：能看到刚才的调用，`decision` 为 `allow`，`resolution` 为 `auto`。

- [ ] **步骤 4：验证危险命令触发确认**

让 agent 执行一条危险命令（例如 `rm -rf ./tmp-nonexistent`）。
预期：输入框上方出现三选项卡片；选「允许本次」后执行；`tool_audit` 中该行 `decision` 为 `ask`、`resolution` 为 `user_allow`。

- [ ] **步骤 5：验证「总是允许」写入规则**

重复上一步但选「总是允许」，然后再执行一次同样的命令。
预期：第二次不再询问；`permission_rules` 中有一条 `command_prefix` 规则；第二次调用的 `resolution` 为 `rule`。

```powershell
sqlite3 "<DB>" "SELECT scope, scope_key, tool, matcher_kind, matcher, effect FROM permission_rules;"
```

同时确认 `scope_key` 是当前工作区的真实路径——这验证了任务 9 的 token 覆盖逻辑生效。

- [ ] **步骤 6：验证通道故障时拒绝而非放行**

停掉 AgentData 运行时（或在 `main.ts` 中临时把 `AGENT_DATA_ENDPOINT` 注入改为空字符串后重启），再让 agent 执行任意工具。
预期：工具被拒绝，理由文案可见；**不是**静默执行。验证完恢复改动。

- [ ] **步骤 7：验证 full 档行为未变**

把输入框的审批下拉切到「完全访问」，执行一条危险命令。
预期：不弹确认，直接执行——与改动前一致。`tool_audit` 仍有记录，`decision` 为 `allow`。

- [ ] **步骤 8：清理并提交验收结论**

删除步骤中产生的临时文件。若全部符合预期，在 PR 或提交信息中记录已完成手工验收。

---

## 完成判据

对照规格第 9 节的 S1 判据逐条确认：

- [ ] 规则匹配单测覆盖四种情形：`deny` 压 `ask` 压 `allow`、同强度下窄 scope 压宽 scope、过期规则不命中、用户 `allow` 无法覆盖内置 `deny` 与内置 `ask`（任务 3 与任务 8）
- [ ] 每一次工具调用在 `tool_audit` 中都有对应行，`decision` 与 `resolution` 组合正确（任务 8 与任务 12 步骤 3）
- [ ] 在 `ask` 档下执行一条 bash，确认卡片出现、批准后执行、审计留痕（任务 12 步骤 4）
- [ ] 两条失败路径方向正确：通道不可用时拒绝（任务 10 与任务 12 步骤 6）；规则查询失败时降级为询问（任务 8）
- [ ] `full` 档下子代理能力硬限仍然生效（任务 11 步骤 1 的前两个测试）

## 本计划不做的事

以下属于 S2 与 S3，不要在本计划中提前实现：

- `__approval` 哨兵富卡、审批队列 store、渐进累积卡
- 设置页的规则管理界面
- 无 UI 时攒下的 `queued` 行的展示与人工处理入口（本计划只负责把行写对）
- `permission_rules` 的作用域选择 UI（本计划固定写 workspace 作用域）
- 文件快照、变更汇总卡、撤销
