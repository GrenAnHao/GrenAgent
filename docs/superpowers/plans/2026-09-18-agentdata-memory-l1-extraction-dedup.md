# Pi AgentData Memory 阶段一：L1 抽取与去重对齐 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 Pi 的记忆抽取从"三行指令 + 纯追加落库"改成 TencentDB 的"分类型抽取 + 冲突判定去重"，止住废话入库与重复累加。

**架构：** 抽取与冲突判定提示词从 TencentDB-Agent-Memory（MIT）移植，收敛到单一模块；L1 输出由"任意对象"改为受 zod schema 约束的记录数组；落库由整包字符串改为逐条记录；在 `memory_extract` 之后接入**已注册但空置**的 `memory_deduplicate` 任务，由系统 worker 判定 `store/update/merge/skip`，主进程应用决策；去重拿不到决策时**不提交 capture**，留待下轮重试（不照搬 TencentDB 的 `store-all` 兜底）。

**技术栈：** TypeScript、zod、node:sqlite、vitest

**范围说明：** 本计划只覆盖阶段一（L1 抽取 + 去重 + 数据契约）。调度层（L1 空闲/阈值触发、L2/L3 定时）、L2 场景层、L3 画像层、存储对账与生成溯源各自独立成计划，见文末「后续计划」。

**硬约束（先读再动手）：**
1. `extensions/` 与 `electron-agent/` **两个包不能互相 import**（既有事实，见 `docs/superpowers/specs/2026-09-04-agent-data-global-scope-design.md:73`）。提示词因此必须在两处各存一份，用测试锚点防漂移。
2. 系统 worker 带 `PI_SYSTEM_WORKER=1` → **零扩展、无任何工具可调**（`docs/superpowers/specs/2026-09-04-agent-data-global-scope-design.md:70`）。所有提示词只能是纯文本问答，禁止要求模型读写文件。
3. 生效中的抽取指令在 `electron-agent/electron/pi/systemWorkerManager.ts:11`；`extensions/memory/capture.ts:19-22` 只是无 Electron 时的本地兜底。**两处都要改。**

---

## 文件结构

**新建**

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron/agent/memoryPrompts.ts` | 权威提示词：抽取（work/chat）+ 冲突判定 |
| `electron-agent/electron/agent/memoryPrompts.test.ts` | 提示词锚点测试（防漂移） |
| `electron-agent/electron/agent/memoryExtraction.ts` | L1 记录 zod schema、规范化、解析 |
| `electron-agent/electron/agent/memoryExtraction.test.ts` | schema 边界测试 |
| `electron-agent/electron/app/memoryDedup.ts` | 候选召回、去重编排、决策应用 |
| `electron-agent/electron/app/memoryDedup.test.ts` | 决策应用测试 |
| `extensions/memory/prompts.ts` | 本地兜底镜像（与权威源同文） |
| `extensions/memory/prompts.test.ts` | 镜像锚点测试 |

**修改**

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `electron-agent/electron/pi/systemWorkerManager.ts` | `:10-15` | `memory_extract` / `memory_deduplicate` 指令改指向 `memoryPrompts.ts` |
| `electron-agent/electron/app/appServer/serviceTaskRegistry.ts` | `:16-17` | 换真实 schema；放宽 `memory_extract` 超时 |
| `electron-agent/electron/app/memoryService.ts` | `:111-127` | 逐条落库 + 去重编排 |
| `electron-agent/electron/app/memoryService.ts` | `:157-166` | 校验换 schema |
| `electron-agent/electron/agentData/runtime.ts` | `:130-134` | 增加 `memory_deduplicate` 完成回调 |
| `extensions/memory/capture.ts` | `:19-22` | 本地兜底改用镜像提示词 |

**不修改：** `electron-agent/electron/agentData/memoryStore.ts` 的表结构与 `upsert` / `search` / `remove` 已够用（`search` 返回带 `id` 的记录，`remove(scope, id)` 可删旧记录）。

---

## 任务 1：移植抽取提示词（权威源）

**文件：**
- 创建：`electron-agent/electron/agent/memoryPrompts.ts`
- 测试：`electron-agent/electron/agent/memoryPrompts.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT,
  MEMORY_EXTRACT_WORK_SYSTEM_PROMPT,
  memoryExtractPrompt,
} from './memoryPrompts';

describe('memoryPrompts', () => {
  it('work 版保留四类枚举与排除清单', () => {
    for (const type of ['work_fact', 'work_task', 'work_method', 'work_artifact']) {
      expect(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT).toContain(type);
    }
    expect(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT).toContain('不应该提取的内容');
    expect(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT).toContain('不提取与工作无关的个人偏好');
    expect(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT).toContain('返回且仅返回一个合法的 JSON 数组');
  });

  it('chat 版保留三类枚举与宁缺毋滥', () => {
    for (const type of ['persona', 'episodic', 'instruction']) {
      expect(MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT).toContain(type);
    }
    expect(MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT).toContain('宁缺毋滥');
    expect(MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT).toContain('不应该提取的内容');
  });

  it('默认走 work 版', () => {
    expect(memoryExtractPrompt()).toBe(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT);
    expect(memoryExtractPrompt('chat')).toBe(MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm --prefix electron-agent test -- --run electron/agent/memoryPrompts.test.ts`
预期：FAIL，报错 `Failed to resolve import "./memoryPrompts"`

- [ ] **步骤 3：编写实现**

从 `D:\System Dir\Downloads\TencentDB-Agent-Memory\MemoryCore\src\core\prompts\l1-extraction.ts` **逐字复制**，不改一字：

- `EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT`（源文件 `:105-372`）→ 导出为 `MEMORY_EXTRACT_WORK_SYSTEM_PROMPT`
- `EXTRACT_MEMORIES_SYSTEM_PROMPT`（源文件 `:15-101`）→ 导出为 `MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT`

> 正文不在本计划中复述，以免与源文件产生二次漂移；复制后必须逐字一致。

```ts
/**
 * 移植自 TencentDB-Agent-Memory（MIT）
 *   上游：MemoryCore/src/core/prompts/l1-extraction.ts
 *   上游 HEAD：0468a2a5b50eaafc54758ed1e2e6609472e5b6ce
 *   该文件最后一次变更：41444344ce11467a5b5ad6aa032f5e261da1f4d2（2026-07-22，v2.0.0-beta.1）
 *
 * 两个常量与上游正文逐字一致，勿在此处"顺手优化"。校验值按模板字面量的运行时取值计，
 * 不含定界反引号：
 *   MEMORY_EXTRACT_WORK_SYSTEM_PROMPT  ← 上游 105-372 行，5269 字符，sha256=392b4585…
 *   MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT  ← 上游 15-101 行，2369 字符，sha256=fae33004…
 */

export const MEMORY_EXTRACT_WORK_SYSTEM_PROMPT = `…`; // 逐字复制 l1-extraction.ts:105-372
export const MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT = `…`; // 逐字复制 l1-extraction.ts:15-101

export type MemoryPromptMode = 'work' | 'chat';

/** 默认 work：Pi 是编码 / Agent 桌面场景。 */
export function memoryExtractPrompt(mode: MemoryPromptMode = 'work'): string {
  return mode === 'chat' ? MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT : MEMORY_EXTRACT_WORK_SYSTEM_PROMPT;
}
```

> **本文件不放任何本地原创的提示词片段。** 移植后的提示词只输出 L1 JSON 数组（TencentDB 的原生协议），因此阶段一起 `l2` / `l3` 不再由这次调用产出，写入路径对二者保持兼容但暂时为空。这与上游一致——它的 L2 场景与 L3 画像是各自独立的调用，在后续计划中恢复。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm --prefix electron-agent test -- --run electron/agent/memoryPrompts.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agent/memoryPrompts.ts electron-agent/electron/agent/memoryPrompts.test.ts
git commit -m "feat(memory): port TencentDB L1 extraction prompts"
```

---

## 任务 2：把生效中的抽取指令接到新提示词

**文件：**
- 修改：`electron-agent/electron/pi/systemWorkerManager.ts:10-15`
- 修改：`electron-agent/electron/pi/systemWorkerManager.test.ts`（已有测试文件）

- [ ] **步骤 1：编写失败的测试**

在 `systemWorkerManager.test.ts` 中追加：

```ts
it('memory_extract 使用移植后的抽取提示词', () => {
  const task = { id: 't1', kind: 'memory_extract', input: { delta: 'user: hi' } };
  const prompt = serviceTaskPromptForTest(task);
  expect(prompt).toContain('不提取与工作无关的个人偏好');
  expect(prompt).toContain('Task kind: memory_extract');
});
```

> 若 `serviceTaskPrompt` 未导出，在实现文件中加 `export function serviceTaskPromptForTest(task: SystemWorkerTask): string { return serviceTaskPrompt(task); }`，或直接把 `serviceTaskPrompt` 改为导出。
>
> ⚠️ 锚点必须取自 **work** 版：接线用的是 `MEMORY_EXTRACT_WORK_SYSTEM_PROMPT`，而 `宁缺毋滥` 只存在于 chat 版（见「执行期订正记录」）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm --prefix electron-agent test -- --run electron/pi/systemWorkerManager.test.ts`
预期：FAIL，断言 `不提取与工作无关的个人偏好` 不成立（当前指令只有一行）

- [ ] **步骤 3：编写实现**

```ts
import { MEMORY_EXTRACT_WORK_SYSTEM_PROMPT } from '../agent/memoryPrompts';

const KIND_INSTRUCTIONS: Record<string, string> = {
  memory_extract: `${MEMORY_EXTRACT_WORK_SYSTEM_PROMPT}`,
  goal_judge: 'Act as an independent Goal completion judge. …', // 保持不变
  wiki_page_generate: 'Write a concise Markdown knowledge page …', // 保持不变
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm --prefix electron-agent test -- --run electron/pi/systemWorkerManager.test.ts`
预期：PASS，且既有 `memory_extract` 分支测试仍通过

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/pi/systemWorkerManager.ts electron-agent/electron/pi/systemWorkerManager.test.ts
git commit -m "feat(memory): wire system worker to ported extraction prompt"
```

---

## 任务 3：L1 记录 schema 与解析器

**文件：**
- 创建：`electron-agent/electron/agent/memoryExtraction.ts`
- 测试：`electron-agent/electron/agent/memoryExtraction.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { L1_TYPES_WORK, L1_TYPES_CHAT, parseMemoryExtraction } from './memoryExtraction';

const record = {
  content: '团队决定 L1 只保留少量高层类型',
  type: 'work_method',
  priority: 85,
  source_message_ids: ['m1'],
  metadata: {},
};

describe('parseMemoryExtraction', () => {
  it('接受 work 类型的记录数组', () => {
    const parsed = parseMemoryExtraction({ l1: [record] }, 'work');
    expect(parsed.l1).toHaveLength(1);
    expect(parsed.l1![0].scene_name).toBe('未分类');
  });

  it('丢弃越界类型而不抛错（对齐上游已知坑的收敛版）', () => {
    const parsed = parseMemoryExtraction({ l1: [record, { ...record, type: 'work_method' }] }, 'chat');
    expect(parsed.l1).toHaveLength(1);
  });

  it('priority 缺失时补 50，越界时钳到 0..100', () => {
    const parsed = parseMemoryExtraction({ l1: [{ ...record, priority: 999 }, { ...record, priority: undefined }] }, 'work');
    expect(parsed.l1!.map((r) => r.priority)).toEqual([100, 50]);
  });

  it('拒绝未知顶层键', () => {
    expect(() => parseMemoryExtraction({ l1: [], nope: 1 }, 'work')).toThrow();
  });

  it('l2/l3 必须是字符串', () => {
    expect(parseMemoryExtraction({ l2: 'x', l3: 'y' }, 'work').l2).toBe('x');
    expect(() => parseMemoryExtraction({ l2: 1 }, 'work')).toThrow();
  });

  it('类型白名单按模式收敛', () => {
    expect(L1_TYPES_WORK).toHaveLength(4);
    expect(L1_TYPES_CHAT).toHaveLength(3);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm --prefix electron-agent test -- --run electron/agent/memoryExtraction.test.ts`
预期：FAIL，`Failed to resolve import "./memoryExtraction"`

- [ ] **步骤 3：编写实现**

```ts
import { z } from 'zod';

export const L1_TYPES_WORK = ['work_fact', 'work_task', 'work_method', 'work_artifact'] as const;
export const L1_TYPES_CHAT = ['persona', 'episodic', 'instruction'] as const;
export type L1Type = (typeof L1_TYPES_WORK)[number] | (typeof L1_TYPES_CHAT)[number];

const l1RecordSchema = z.object({
  content: z.string().min(1),
  type: z.string(),
  priority: z.number().optional(),
  scene_name: z.string().optional(),
  source_message_ids: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface L1Record {
  content: string;
  type: L1Type;
  priority: number;
  scene_name: string;
  source_message_ids: string[];
  metadata: Record<string, unknown>;
}

export interface MemoryExtraction { l1?: L1Record[]; l2?: string; l3?: string }

/** 上游 scene-extraction 的默认情境名；L1 抽取未给场景时使用。 */
const DEFAULT_SCENE = '未分类';

export function parseMemoryExtraction(value: unknown, mode: 'work' | 'chat' = 'work'): MemoryExtraction {
  const allowed = new Set<string>(mode === 'chat' ? L1_TYPES_CHAT : L1_TYPES_WORK);
  const root = z.object({
    l1: z.array(l1RecordSchema).optional(),
    l2: z.string().optional(),
    l3: z.string().optional(),
  }).strict().safeParse(value);
  if (!root.success) throw new Error('memory extraction output is invalid');

  const l1 = root.data.l1
    ?.filter((raw) => allowed.has(raw.type))
    .map<L1Record>((raw) => ({
      content: raw.content.trim(),
      type: raw.type as L1Type,
      priority: Math.max(0, Math.min(100, Math.trunc(raw.priority ?? 50))),
      scene_name: raw.scene_name?.trim() || DEFAULT_SCENE,
      source_message_ids: raw.source_message_ids ?? [],
      metadata: raw.metadata ?? {},
    }))
    .filter((record) => record.content.length > 0);

  return {
    l1: l1 && l1.length > 0 ? l1 : undefined,
    l2: root.data.l2?.trim() || undefined,
    l3: root.data.l3?.trim() || undefined,
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm --prefix electron-agent test -- --run electron/agent/memoryExtraction.test.ts`
预期：PASS（6 个用例）

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agent/memoryExtraction.ts electron-agent/electron/agent/memoryExtraction.test.ts
git commit -m "feat(memory): typed L1 record schema with per-mode type whitelist"
```

---

## 任务 4：收紧任务注册表（schema + 超时）

**文件：**
- 修改：`electron-agent/electron/app/appServer/serviceTaskRegistry.ts:16-17`
- 测试：`electron-agent/electron/app/appServer/serviceTaskRegistry.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
it('memory_extract 的输出 schema 拒绝非记录数组', () => {
  const registry = new ServiceTaskRegistry();
  expect(() => registry.validateOutput('memory_extract', { l1: [{ content: '', type: 'work_fact' }] })).toThrow();
  expect(registry.validateOutput('memory_extract', { l1: [{ content: 'x', type: 'work_fact' }] })).toMatchObject({ l1: [expect.any(Object)] });
});

it('memory_extract 超时放宽到 60s', () => {
  expect(new ServiceTaskRegistry().get('memory_extract')!.timeoutMs).toBe(60_000);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm --prefix electron-agent test -- --run electron/app/appServer/serviceTaskRegistry.test.ts`
预期：FAIL（当前 `anyObject` 接受任意对象，且超时为 30_000）

- [ ] **步骤 3：编写实现**

```ts
import { z } from 'zod';

const l1RecordForRegistry = z.object({
  content: z.string().min(1),
  type: z.string().min(1),
  priority: z.number().optional(),
  scene_name: z.string().optional(),
  source_message_ids: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const memoryExtractionOutput = z.object({
  l1: z.array(l1RecordForRegistry).optional(),
  l2: z.string().optional(),
  l3: z.string().optional(),
}).strict();
export const memoryDedupOutput = z.array(z.object({
  record_id: z.string().min(1),
  action: z.enum(['store', 'update', 'merge', 'skip']),
  target_ids: z.array(z.string()),
  merged_content: z.string().optional(),
  merged_type: z.string().optional(),
  merged_priority: z.number().optional(),
})).max(200);

// BUILTIN_SERVICE_TASKS 中：
{ kind: 'memory_extract', inputSchema: anyObject, outputSchema: memoryExtractionOutput, timeoutMs: 60_000, maxAttempts: 2, capabilities: ['llm_completion'] },
{ kind: 'memory_deduplicate', inputSchema: anyObject, outputSchema: memoryDedupOutput, timeoutMs: 60_000, maxAttempts: 2, capabilities: ['llm_completion'] },
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm --prefix electron-agent test -- --run electron/app/appServer/serviceTaskRegistry.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/appServer/serviceTaskRegistry.ts electron-agent/electron/app/appServer/serviceTaskRegistry.test.ts
git commit -m "feat(memory): real schemas and 60s timeout for memory extraction tasks"
```

---

## 任务 5：L1 逐条落库

**文件：**
- 修改：`electron-agent/electron/app/memoryService.ts:111-127`、`:157-166`
- 测试：`electron-agent/electron/app/memoryService.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
it('把 L1 记录数组逐条落库，而不是整包字符串', async () => {
  const { db, store, service } = setup();
  const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
  await service.completeExtraction(captured.taskId!, {
    l1: [
      { content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 90 },
      { content: '后端需在周五前完成表结构设计', type: 'work_task', priority: 85 },
    ],
  });
  const rows = store.search(scope, '团队决定');
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0].content)).toMatchObject({ type: 'work_method', priority: 90 });
  expect(store.search(scope, '表结构')).toHaveLength(1);
  db.close();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts`
预期：FAIL，`store.search(scope, '表结构')` 返回 0（当前整包序列化为一行）

- [ ] **步骤 3：编写实现**

```ts
import { parseMemoryExtraction } from '../agent/memoryExtraction';

completeExtraction(taskId: string, output: unknown): MemoryRecord[] {
  const capture = this.pending.get(taskId) ?? this.captureFromTask(taskId);
  if (!capture) throw new Error('memory capture task not found');
  const extraction = parseMemoryExtraction(output, this.options.extractMode ?? 'work');
  const writes: MemoryRecord[] = [];
  const globalScope = { ...capture.scope, scope: 'global' as const };

  for (const record of extraction.l1 ?? []) {
    writes.push(this.options.store.upsert(capture.scope, {
      level: 1,
      content: JSON.stringify(record),
      source: capture.source,
    }));
  }
  if (extraction.l2) writes.push(this.options.store.upsert(globalScope, { level: 2, content: extraction.l2, source: capture.source }));
  if (extraction.l3) writes.push(this.options.store.upsert(globalScope, { level: 3, content: extraction.l3, source: capture.source }));

  this.options.store.commitCapture(capture.scope, capture.source, capture.fingerprint, capture.delta);
  this.finishCapture(taskId);
  return writes;
}
```

删除文件内旧的 `validateExtraction`（`:157-166`），改由 `parseMemoryExtraction` 承担。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts`
预期：PASS，且既有用例仍通过

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/memoryService.ts electron-agent/electron/app/memoryService.test.ts
git commit -m "feat(memory): persist each L1 record as its own row"
```

---

## 任务 6：去重编排（候选召回 + 决策应用）

**文件：**
- 创建：`electron-agent/electron/app/memoryDedup.ts`
- 测试：`electron-agent/electron/app/memoryDedup.test.ts`
- 修改：`electron-agent/electron/app/memoryService.ts`（`completeExtraction` 之后分流）

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { applyDedupDecisions } from './memoryDedup';

describe('applyDedupDecisions', () => {
  it('skip 不写入', () => {
    const calls: string[] = [];
    applyDedupDecisions({ upsert: (_s, i) => { calls.push(`upsert:${i.level}`); return {} as never }, remove: () => { calls.push('remove'); } }, 'u',
      [{ record_id: 'r1', action: 'skip', target_ids: [] }], new Map(), 'src');
    expect(calls).toEqual([]);
  });

  it('update/merge 先删 target_ids 再写合并结果', () => {
    const calls: string[] = [];
    const records = new Map([['r1', { content: '新', type: 'work_fact', priority: 80 }]]);
    applyDedupDecisions({ upsert: (_s, i) => { calls.push(`upsert:${i.content}`); return {} as never }, remove: (_s, id) => { calls.push(`remove:${id}`); } }, 'u',
      [{ record_id: 'r1', action: 'merge', target_ids: ['old1', 'old2'], merged_content: '合并后', merged_type: 'work_fact', merged_priority: 88 }], records, 'src');
    expect(calls).toEqual(['remove:old1', 'remove:old2', 'upsert:{"content":"合并后","type":"work_fact","priority":88,"scene_name":"未分类","source_message_ids":[],"metadata":{}}']);
  });

  it('决策缺失的记录按 store 处理，不静默丢弃', () => {
    const calls: string[] = [];
    applyDedupDecisions({ upsert: (_s, i) => { calls.push(`upsert:${i.content}`); return {} as never }, remove: () => {} }, 'u',
      [], new Map([['r9', { content: '孤儿', type: 'work_task', priority: 60 }]]), 'src');
    expect(calls).toEqual(['upsert:{"content":"孤儿","type":"work_task","priority":60,"scene_name":"未分类","source_message_ids":[],"metadata":{}}']);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryDedup.test.ts`
预期：FAIL，`Failed to resolve import "./memoryDedup"`

- [ ] **步骤 3：编写实现**

```ts
import type { L1Record } from '../agent/memoryExtraction';
import type { MemoryRecord, MemoryScope } from '../agentData/memoryStore';

export interface DedupDecision {
  record_id: string;
  action: 'store' | 'update' | 'merge' | 'skip';
  target_ids: string[];
  merged_content?: string;
  merged_type?: string;
  merged_priority?: number;
}

export interface DedupTarget {
  upsert: (scope: MemoryScope, input: { level: 1; content: string; source?: string }) => MemoryRecord;
  remove: (scope: MemoryScope, id: string) => void;
}

/** 候选召回：按 content 走 store.search，取 topK。上游用向量+RRF；此处为阶段一的可用足量实现。 */
export function recallCandidates(store: { search: (scope: MemoryScope, query: string, limit?: number) => MemoryRecord[] }, scope: MemoryScope, content: string, topK = 5): MemoryRecord[] {
  return store.search(scope, content, topK);
}

export function applyDedupDecisions(
  target: DedupTarget,
  userId: string,
  decisions: DedupDecision[],
  records: Map<string, Pick<L1Record, 'content' | 'type' | 'priority'>>,
  source: string,
  scope: MemoryScope = { userId, workspace: '' },
): MemoryRecord[] {
  const byId = new Map(decisions.map((decision) => [decision.record_id, decision]));
  const writes: MemoryRecord[] = [];

  for (const [recordId, record] of records) {
    const decision = byId.get(recordId) ?? { record_id: recordId, action: 'store' as const, target_ids: [] };
    if (decision.action === 'skip') continue;

    if (decision.action === 'update' || decision.action === 'merge') {
      for (const id of decision.target_ids) target.remove(scope, id);
      const merged = {
        content: decision.merged_content ?? record.content,
        type: decision.merged_type ?? record.type,
        priority: decision.merged_priority ?? record.priority,
        scene_name: '未分类',
        source_message_ids: [] as string[],
        metadata: {} as Record<string, unknown>,
      };
      writes.push(target.upsert(scope, { level: 1, content: JSON.stringify(merged), source }));
      continue;
    }

    const stored = {
      content: record.content,
      type: record.type,
      priority: record.priority,
      scene_name: '未分类',
      source_message_ids: [] as string[],
      metadata: {} as Record<string, unknown>,
    };
    writes.push(target.upsert(scope, { level: 1, content: JSON.stringify(stored), source }));
  }

  return writes;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryDedup.test.ts`
预期：PASS（3 个用例）

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/memoryDedup.ts electron-agent/electron/app/memoryDedup.test.ts
git commit -m "feat(memory): dedup decision application"
```

---

## 任务 7：接上 `memory_deduplicate` 任务与失败关闭

**文件：**
- 修改：`electron-agent/electron/app/memoryService.ts`
- 修改：`electron-agent/electron/agentData/runtime.ts:130-134`
- 修改：`electron-agent/electron/pi/systemWorkerManager.ts:10-15`（`memory_deduplicate` 指令）
- 测试：`electron-agent/electron/app/memoryService.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
it('有候选项时先入队 memory_deduplicate，且不立即提交 capture', async () => {
  const { db, store, tasks, service } = setup();
  store.upsert({ userId: 'u', workspace: '/repo', projectId: '/repo' }, { level: 1, content: JSON.stringify({ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 80 }) });
  const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
  await service.completeExtraction(captured.taskId!, { l1: [{ content: '团队决定 L1 只保留高层类型', type: 'work_method', priority: 90 }] });

  expect(tasks.map((task) => task.kind)).toEqual(['memory_extract', 'memory_deduplicate']);
  expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: 'user: a' });
  db.close();
});

it('去重决策解析失败时不提交 capture，留待重试', async () => {
  const { db, service } = setup();
  const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
  await service.completeExtraction(captured.taskId!, { l1: [{ content: 'x', type: 'work_fact' }] });
  expect(() => service.completeDedup('missing', [])).toThrow('memory capture task not found');
  db.close();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts`
预期：FAIL，`completeDedup is not a function`

- [ ] **步骤 3：编写实现**

`memoryService.ts`：

```ts
interface PendingDedup { capture: PendingCapture; records: Map<string, L1Record> }
private readonly pendingDedup = new Map<string, PendingDedup>();

// completeExtraction 改为：先算候选，有候选则入队去重；无候选走原直写路径
const l1 = extraction.l1 ?? [];
const withCandidates = l1.filter((record) => recallCandidates(this.options.store, capture.scope, record.content, 5)
  .some((hit) => hit.level === 1));
if (withCandidates.length > 0) {
  const taskId = randomUUID();
  const records = new Map(l1.map((record, index) => [`r${index}`, record]));
  this.pendingDedup.set(taskId, { capture, records });
  void this.options.queue.enqueue({
    id: taskId,
    kind: 'memory_deduplicate',
    input: {
      newMemories: [...records].map(([record_id, record]) => ({ record_id, ...record })),
      candidates: [...records.values()].flatMap((record) =>
        recallCandidates(this.options.store, capture.scope, record.content, 5).map((hit) => ({
          record_id: hit.id, content: hit.content, level: hit.level,
        }))),
    },
    sourceProjectId: capture.scope.projectId ?? capture.scope.workspace,
    sourceSessionId: capture.scope.sessionId,
    system: true,
  }).catch(() => { this.pendingDedup.delete(taskId); });
  this.finishCapture(taskId);       // 释放 extract 任务，但**不** commitCapture
  return [];
}

// 无候选 → 直写（沿用任务 5 的实现），并在末尾 commitCapture
```

```ts
completeDedup(taskId: string, output: unknown): MemoryRecord[] {
  const pending = this.pendingDedup.get(taskId);
  if (!pending) throw new Error('memory capture task not found');
  const decisions = output as DedupDecision[];
  const writes = applyDedupDecisions(
    { upsert: (scope, input) => this.options.store.upsert(scope, input), remove: (scope, id) => this.options.store.remove(scope, id) },
    pending.capture.scope.userId,
    decisions,
    pending.records,
    pending.capture.source,
    pending.capture.scope,
  );
  this.options.store.commitCapture(pending.capture.scope, pending.capture.source, pending.capture.fingerprint, pending.capture.delta);
  this.pendingDedup.delete(taskId);
  return writes;
}
```

失败关闭：`taskSettled`（`:129-131`）在 `memory_deduplicate` 失败/取消时**只删除 `pendingDedup` 条目、不 commit**，让 `finishCapture` 的既有重试链（`pendingCapture` → 下轮 `agent_end`）接住。

```ts
taskSettled(task: ServiceTask): void {
  if (task.status !== 'failed' && task.status !== 'cancelled') return;
  if (task.kind === 'memory_extract') this.finishCapture(task.id, task);
  if (task.kind === 'memory_deduplicate') this.pendingDedup.delete(task.id); // 不 commit → 留待重试
}
```

`runtime.ts:130-134`：

```ts
execute: async (task) => {
  const output = await this.options.executeServiceTask!(task);
  if (task.kind === 'memory_extract') this.memoryService!.completeExtraction(task.id, output);
  if (task.kind === 'memory_deduplicate') this.memoryService!.completeDedup(task.id, output);
  return output;
},
```

`systemWorkerManager.ts` 新增指令（移植 TencentDB `prompts/l1-dedup.ts` 的 `CONFLICT_DETECTION_SYSTEM_PROMPT`，源文件 `:72-134` 为 work 版）：

```ts
memory_deduplicate: MEMORY_DEDUP_WORK_SYSTEM_PROMPT,
```

前置在任务 1 的 `memoryPrompts.ts` 中增加 `export const MEMORY_DEDUP_WORK_SYSTEM_PROMPT = `…`;`（逐字复制 `l1-dedup.ts:72-134`），并补同一文件里的锚点测试：`expect(MEMORY_DEDUP_WORK_SYSTEM_PROMPT).toContain('store|update|skip|merge')`。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm --prefix electron-agent test -- --run electron/app/memoryService.test.ts electron/agent/memoryPrompts.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/memoryService.ts electron-agent/electron/agentData/runtime.ts electron-agent/electron/pi/systemWorkerManager.ts electron-agent/electron/agent/memoryPrompts.ts
git commit -m "feat(memory): wire memory_deduplicate with fail-closed commit"
```

---

## 任务 8：本地兜底路径对齐

**文件：**
- 创建：`extensions/memory/prompts.ts`
- 测试：`extensions/memory/prompts.test.ts`
- 修改：`extensions/memory/capture.ts:19-22`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { LOCAL_MEMORY_EXTRACT_SYSTEM } from './prompts';

describe('local extraction prompt', () => {
  it('与 electron 侧权威提示词同源锚点', () => {
    expect(LOCAL_MEMORY_EXTRACT_SYSTEM).toContain('不提取与工作无关的个人偏好');
    expect(LOCAL_MEMORY_EXTRACT_SYSTEM).toContain('work_fact');
    expect(LOCAL_MEMORY_EXTRACT_SYSTEM).toContain('不应该提取的内容');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm --prefix extensions exec vitest run memory/prompts.test.ts`
预期：FAIL，`Failed to resolve import "./prompts"`

- [ ] **步骤 3：编写实现**

`extensions/memory/prompts.ts`：**逐字复制** `electron-agent/electron/agent/memoryPrompts.ts` 的 `MEMORY_EXTRACT_WORK_SYSTEM_PROMPT`，改名导出为 `LOCAL_MEMORY_EXTRACT_SYSTEM`，文件头注明：

```ts
/**
 * 与 electron-agent/electron/agent/memoryPrompts.ts 的 MEMORY_EXTRACT_WORK_SYSTEM_PROMPT 同文。
 * 两个包不能互相 import，改动必须两处同步；锚点测试负责发现漂移。
 */
```

`extensions/memory/capture.ts` 顶部：

```ts
import { LOCAL_MEMORY_EXTRACT_SYSTEM } from './prompts';
const SYSTEM = LOCAL_MEMORY_EXTRACT_SYSTEM;
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npm --prefix extensions exec vitest run memory/prompts.test.ts memory/capture.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add extensions/memory/prompts.ts extensions/memory/prompts.test.ts extensions/memory/capture.ts
git commit -m "feat(memory): align extension-side fallback prompt with ported source"
```

---

## 任务 9：全量回归

**文件：** 无新增

- [ ] **步骤 1：跑记忆相关全量测试**

运行：
```bash
npm --prefix electron-agent test -- --run electron/agent/memoryPrompts.test.ts electron/agent/memoryExtraction.test.ts electron/app/memoryDedup.test.ts electron/app/memoryService.test.ts electron/agentData/memoryStore.test.ts electron/pi/systemWorkerManager.test.ts electron/app/appServer/serviceTaskRegistry.test.ts
npm --prefix extensions exec vitest run memory
```
预期：全部 PASS

- [ ] **步骤 2：确认无占位与类型漂移**

运行：`grep -rn "TODO\|待定\|后续实现" electron-agent/electron/agent/memoryPrompts.ts electron-agent/electron/agent/memoryExtraction.ts electron-agent/electron/app/memoryDedup.ts extensions/memory/prompts.ts`
预期：无输出

- [ ] **步骤 3：Commit**

```bash
git commit --allow-empty -m "test(memory): phase-1 regression green"
```

---

## 自检

**1. 规格覆盖度**

| 阶段一目标 | 对应任务 |
| --- | --- |
| 移植权威抽取提示词 | 任务 1、2、8 |
| L1 由任意对象改为受约束记录数组 | 任务 3、4 |
| 逐条落库 | 任务 5 |
| 去重（候选召回 + store/update/merge/skip） | 任务 6、7 |
| 失败关闭（不 store-all） | 任务 7 |

**2. 占位符扫描：** 提示词正文以"逐字复制源文件 `路径:行号`"给出，非占位；所有代码步骤含可执行代码；无 "TODO / 待定 / 类似任务 N"。

**3. 类型一致性：** `L1Record`（`memoryExtraction.ts`）→ `memoryDedup.ts` 的 `Map<string, Pick<L1Record, 'content'|'type'|'priority'>>` → `memoryService.ts` 的 `Map<string, L1Record>`；`DedupDecision` 只在 `memoryDedup.ts` 定义并被 `memoryService.ts` 引用；`computeExtraction` / `completeDedup` / `applyDedupDecisions` / `recallCandidates` 命名在任务 6、7 一致。

**4. 执行期订正记录**

- 任务 1：计划原测试断言 work 版包含 `宁缺毋滥`，实测该短语只存在于 chat 版（work 版的对应原则是"面向工作协作 / 面向团队共享"）。已把 work 版锚点改为 `不应该提取的内容` + `不提取与工作无关的个人偏好`，chat 版锚点补上 `不应该提取的内容`。提示词正文未做任何改动（已用脚本校验与上游逐字一致）。
- 任务 1：删除了计划原稿中的 `MEMORY_EXTRACT_OUTPUT_TAIL`。它与移植后的提示词输出协议直接冲突（移植版只允许输出 JSON 数组），且是无消费者的死代码。`l2` / `l3` 的恢复交由后续 L2/L3 计划。
- 任务 1：上游文件为 CRLF 行尾，而 JS 模板字面量在解析时把 CRLF 归一为 LF，因此运行时长度是 5269 / 2369 而非源文字符数 5545 / 2464。差额构成：work 版 267 处 CRLF + 9 处转义反引号，chat 版 86 处 CRLF + 9 处转义反引号。头注释中的字符数与 sha256 一律按**运行时取值**记录，以免行尾规范化被误判为漂移。
- 任务 8：镜像只覆盖 work 版常量（接线用的就是它）；chat 版暂不镜像，若将来需要接线再补。

**5. 已知遗留（不在本计划内，已在后续计划中登记）**

- 候选召回用 `store.search`（`LIKE` 子串匹配），是阶段一的可用足量实现，非向量召回；向量召回需接入 `embedding/` 服务，另立计划。
- `l2` / `l3` 在阶段一**不再产出**：移植后的抽取提示词只输出 L1 数组。写入路径对二者保持兼容（字段可选，读到即写），但后续计划落地前 L2/L3 不会有新记录；历史记录仍可读可编辑。
- `memoryDeduplicate` 的 `inputSchema` 仍为 `anyObject`，本阶段只收紧 `outputSchema`。

---

## 后续计划（各自独立成文，不并入本计划）

1. **调度层**：移植 `pipeline-manager.ts` 的 L1 阈值/warmup/空闲 debounce/backlog drain，L2 延迟触发与 min/max 间隔，L3 全局互斥。
2. **L2 场景层**：移植 `scene-extraction.ts`（META / heat / maxScenes / UPDATE 优先 / MERGE 删旧），执行形态改为"worker 出内容、主进程落库"。
3. **L3 画像层**：移植 `persona-generation.ts`（增量更新、字符上限、Team Doctrine 变体）。
4. **存储与溯源**：事实源/检索源对账与 `memory-generation-log` 式生成溯源。
