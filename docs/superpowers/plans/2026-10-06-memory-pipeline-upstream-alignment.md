# 记忆管线对齐 TencentDB-Agent-Memory 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 Pi 记忆管线里偏离上游、导致成本高和失败率高的五处（抽取输入、输出解析、调用参数、抽取节奏、去重召回）加上 L2 场景正文，按上游 TencentDB-Agent-Memory 的做法补齐。

**架构：** 改动都在 Electron 主进程的 AgentData 记忆链路：`MemoryService` 组织任务，`SystemWorkerManager` 拼 prompt、解析输出，`ModelRuntimeHost` 调模型。每个任务独立可测、独立提交，按顺序执行，后面的任务依赖前面的数据形状。

**技术栈：** TypeScript、vitest、`node:sqlite`、zod、pi-ai `completeSimple`。

**执行环境：** 主工作树里有大量和本计划无关的未提交改动，建议用 superpowers:using-git-worktrees 在独立 worktree 里执行。所有测试命令都在 `electron-agent/` 或 `extensions/` 下运行。

---

## 背景：为什么是这五件事

以下都是 2026-10-06 在本机库（`%APPDATA%\electron-agent\agent-data.db`）上实测的数据，对照的上游源码在 `D:\System Dir\Downloads\TencentDB-Agent-Memory\MemoryCore\src`。

| # | 现状 | 上游 | 实测影响 |
|---|---|---|---|
| A | 抽取载荷是整段 transcript，含工具输出 | 只送 user/assistant 文本，去掉代码块（`core/conversation/l0-recorder.ts:551-590`、`utils/sanitize.ts:90-92`） | 历史 311 个抽取任务的载荷里，**工具输出占 94.7%（42.3 MB）**，用户发言 0.6%，assistant 文本 4.5% |
| B | delta 不设上限，老会话第一次捕获就整段发出 | 新消息最多 10 条，背景最多 5 条（`core/record/l1-extractor.ts:149-182`） | 单次最大 286 KB，碰上超时和上下文超长 |
| C | 输出必须严格符合 schema，否则抛错并重试 | 剥 `<think>`、去掉代码围栏、只取数组、修复控制字符和非法 priority（`l1-extractor.ts:571-681`、`utils/sanitize.ts:316-405`） | 新会话里 5 个抽取任务有 3 个因格式失败，花掉了抽取 token 的 68% |
| D | 所有记忆任务 60 秒超时，不设输出上限 | L1 / 去重 180 秒（`l1-extractor.ts:518`、`l1-dedup.ts:167`），L2 300 秒（`scene/scene-extractor.ts:118`），L1 输出上限 4096（`config.ts:652`） | 历史上有 36 个任务因超时失败、72 次 attempt |
| E | 每轮对话都抽取 | 每 5 轮一批，冷启动预热 1→2→4→5，空闲 600 秒补抽（`utils/pipeline-manager.ts:11-64`、`config.ts:586-588`） | 和 B 叠加：调用频繁，而且每次都没有上限 |
| F | 去重候选用整条新记忆做 `LIKE '%…%'` | 向量召回 top-5 | `memory_deduplicate` 在库里一次都没执行过（0 条） |
| G | L2 把全部场景正文内联进 prompt | 只给文件清单和摘要，正文由模型用 `read` 按需读（`core/prompts/scene-extraction.ts:551-565`） | 2026-10-06 当天 74% 的 token 花在一次 L2 调用上（66,593） |

用户已选定 G 的做法：主进程预筛，只内联和新记忆相关的场景正文。

**核实后不改的一处：** 子代理报告说「我们没关 thinking」。实际上 pi-ai 不传 `reasoning` 就等于关闭思考（`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:633`：`enable_thinking = !!options?.reasoningEffort`）。传 `'minimal'` 反而会把思考打开，所以本计划**不传 reasoning**。

## 不在本计划内

以下和上游也有差距，但要么依赖本计划先落地、拿到新数据，要么需要另做设计，各自单独立计划：

- 检索与注入（FTS5 / 向量 / RRF、persona 和场景导航放进 system、召回预算）：需要新表、新索引和 embedding 配置。
- heat 解析与排序、L3 的 `triggerEveryN`、L2 的 `maxInterval` 与冷会话停止：依赖本计划完成后 L2 的新行为。
- L0/L1 保留期与清理、生成溯源、L1 `timestamps` 时间线：属于数据生命周期，跟成本和失败率无关。
- `memory_captures` 里仍存着含工具输出的完整 transcript，`conversation_search` 依赖它，这次不动。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `electron-agent/electron/app/memoryExtractionWindow.ts` | 创建 | 把 transcript 切成消息，只留 user/assistant 文本，清洗、过滤，截成 10+5 窗口 |
| `electron-agent/electron/agent/memoryOutputParse.ts` | 创建 | 移植上游的 `<think>` 剥离、`sanitizeJsonForParse`、`repairExtractionJson`，宽松解析抽取输出 |
| `electron-agent/electron/app/memoryTerms.ts` | 创建 | 中英文关键词切分与重叠打分，供去重召回和 L2 预筛共用 |
| `electron-agent/electron/app/memoryService.ts` | 修改 | 接入窗口、抽取节奏（everyN / 预热 / 空闲 / 启动补抽）、L2 预筛与写入保护 |
| `electron-agent/electron/pi/systemWorkerManager.ts` | 修改 | Input 行规则、抽取输出解析、按 kind 传 `maxTokens` |
| `electron-agent/electron/agent/memoryExtraction.ts` | 修改 | 摊平场景时补默认值（priority、source_message_ids、metadata） |
| `electron-agent/electron/agent/modelRuntimeHost.ts` | 修改 | `completeSimple` 透传 `maxTokens` |
| `electron-agent/electron/agent/shortCall.ts` | 修改 | 记忆任务超时对齐上游 |
| `electron-agent/electron/app/appServer/serviceTaskRegistry.ts` | 修改 | 同上（TaskQueue 侧的超时） |
| `electron-agent/electron/main.ts` | 修改 | `completeAgentData` 入参类型加 `maxTokens` |
| `electron-agent/electron/agentData/memoryStore.ts` | 修改 | `searchL1ByTerms`、`listPendingCaptures` |
| `electron-agent/electron/agentData/runtime.ts` | 修改 | 启动时调用 `recoverPendingCaptures` |
| `electron-agent/electron/app/memoryDedup.ts` | 修改 | 候选召回改为关键词重叠 |
| `electron-agent/electron/app/memoryLayers.ts` | 修改 | `selectScenesToInline` |
| `electron-agent/electron/agent/memoryLayerPrompts.ts` | 修改 | L2 提示词说明只内联相关正文、只能改这些文件 |
| `extensions/memory/capture.ts` | 修改 | 主进程已处理（延后或跳过）时不走本地兜底抽取 |
| `docs/decisions/electron-agent/agentdata/*.md` | 创建 | 每个任务一篇决策记录 |

---

### 任务 1：抽取窗口

**文件：**
- 创建：`electron-agent/electron/app/memoryExtractionWindow.ts`
- 测试：`electron-agent/electron/app/memoryExtractionWindow.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// electron-agent/electron/app/memoryExtractionWindow.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildExtractionWindow, conversationTurns, MAX_BACKGROUND_MESSAGES, MAX_MESSAGE_CHARS, MAX_NEW_MESSAGES, splitTranscript,
} from './memoryExtractionWindow';

describe('splitTranscript', () => {
  it('按 pi 的角色行切分，正文里的冒号不算新消息', () => {
    expect(splitTranscript('user: 看看 a: b\nassistant: 好\ntoolResult: out\ncustom: memo')).toEqual([
      { role: 'user', content: '看看 a: b' },
      { role: 'assistant', content: '好' },
      { role: 'toolResult', content: 'out' },
      { role: 'custom', content: 'memo' },
    ]);
  });
});

describe('conversationTurns', () => {
  it('丢掉工具输出和自定义消息，同一轮里被工具调用隔开的 assistant 文本合成一条', () => {
    const text = 'user: 帮我查日志\nassistant: 我先看看\ntoolResult: HUGE_TOOL_OUTPUT\nassistant: 结论是磁盘满了\ncustom: ## Relevant memory';
    expect(conversationTurns(text)).toEqual([
      { role: 'user', content: '帮我查日志' },
      { role: 'assistant', content: '我先看看\n\n结论是磁盘满了' },
    ]);
  });

  it('assistant 去掉代码块和内联图片，user 保留代码块', () => {
    const text = 'user: 改成这样\n```ts\nconst a = 1;\n```\nassistant: 已改好\n```ts\nconst a = 2;\n```\n说明在上面 data:image/png;base64,AAAA';
    expect(conversationTurns(text)).toEqual([
      { role: 'user', content: '改成这样\n```ts\nconst a = 1;\n```' },
      { role: 'assistant', content: '已改好\n\n说明在上面' },
    ]);
  });

  it('按上游 shouldExtractL1 过滤空消息、斜杠命令、纯符号和纯问号', () => {
    expect(conversationTurns('user: /new\nuser: ？？\nuser: !!\nuser: ok\nassistant:   ')).toEqual([{ role: 'user', content: 'ok' }]);
  });

  it(`单条超过 ${MAX_MESSAGE_CHARS} 字时截断并标注`, () => {
    const [turn] = conversationTurns(`user: ${'字'.repeat(MAX_MESSAGE_CHARS + 10)}`);
    expect(turn.content).toHaveLength(MAX_MESSAGE_CHARS + '…（已截断）'.length);
    expect(turn.content.endsWith('…（已截断）')).toBe(true);
  });
});

describe('buildExtractionWindow', () => {
  const turns = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${i % 2 === 0 ? 'user' : 'assistant'}: ${prefix}${i}`).join('\n');

  it(`新消息最多 ${MAX_NEW_MESSAGES} 条，背景最多 ${MAX_BACKGROUND_MESSAGES} 条，窗口外的 delta 消息并入背景候选`, () => {
    const window = buildExtractionWindow(turns('d', 14), turns('b', 6), 1_000);
    expect(window.newMessages.map((m) => m.content)).toEqual(['d4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11', 'd12', 'd13']);
    expect(window.backgroundMessages.map((m) => m.content)).toEqual(['b5', 'd0', 'd1', 'd2', 'd3']);
  });

  it('背景用 b 前缀、新消息用 m 前缀编号，时间戳先背景后新消息递增', () => {
    const window = buildExtractionWindow('user: new', 'user: old', 1_000);
    expect(window.backgroundMessages).toEqual([{ id: 'b0', role: 'user', content: 'old', timestamp: 1_000 }]);
    expect(window.newMessages).toEqual([{ id: 'm0', role: 'user', content: 'new', timestamp: 2_000 }]);
  });

  it('delta 只有工具输出时新消息为空', () => {
    expect(buildExtractionWindow('toolResult: x', 'user: old').newMessages).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run --project main electron/app/memoryExtractionWindow.test.ts`
预期：FAIL，报错 `Failed to resolve import "./memoryExtractionWindow"`

- [ ] **步骤 3：编写实现**

```ts
// electron-agent/electron/app/memoryExtractionWindow.ts
import type { ConversationMessage } from '../agent/memoryPrompts';

/** 上游 core/record/l1-extractor.ts:149-150 的默认值。 */
export const MAX_NEW_MESSAGES = 10;
export const MAX_BACKGROUND_MESSAGES = 5;
/**
 * Pi 偏离：上游不截单条。Pi 的 assistant 回复经常是长报告，合并同一轮的多段文本后一条就可能上万字，
 * 不截的话批量上限就形同虚设。
 */
export const MAX_MESSAGE_CHARS = 4000;
const TRUNCATED = '…（已截断）';

type Role = 'user' | 'assistant';
export interface TranscriptSegment { role: string; content: string }
export interface ConversationTurn { role: Role; content: string }
export interface ExtractionWindow { newMessages: ConversationMessage[]; backgroundMessages: ConversationMessage[] }

/** extensions/_shared/transcript.ts 的 messageToText 写成 `role: text`，role 来自 pi 的 AgentMessage。 */
const ROLE_LINE = /^(user|assistant|toolResult|custom|bashExecution|branchSummary|compactionSummary): /gm;

export function splitTranscript(text: string): TranscriptSegment[] {
  const matches = [...text.matchAll(ROLE_LINE)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    return { role: match[1], content: text.slice(start, end).replace(/\n+$/, '') };
  });
}

/** 上游 sanitizeText 里与 Pi 相关的部分（去内联图片、压空行）加 stripCodeBlocks（只对 assistant）。 */
function cleanContent(role: Role, content: string): string {
  let text = content.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, '');
  if (role === 'assistant') text = text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  return text.replace(/\0/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 移植自上游 shouldExtractL1（utils/sanitize.ts:135-156）；OpenClaw 专有的框架噪声过滤不适用于 Pi，未移植。 */
export function shouldExtract(text: string): boolean {
  if (!text.trim()) return false;
  if (text.startsWith('/')) return false;
  if (/^[^\w\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{1,5}$/.test(text)) return false;
  if (/^[?？]+$/.test(text)) return false;
  return true;
}

function cap(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}${TRUNCATED}` : text;
}

/**
 * 只留 user / assistant 文本（上游 extractUserAssistantMessages）。工具输出被丢掉以后，同一轮里被工具调用
 * 隔开的 assistant 文本是连续的，合成一条，相当于「一轮一条回复」，和上游的消息粒度一致。
 */
export function conversationTurns(text: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const segment of splitTranscript(text)) {
    if (segment.role !== 'user' && segment.role !== 'assistant') continue;
    const content = cleanContent(segment.role, segment.content);
    if (!shouldExtract(content)) continue;
    const last = turns.at(-1);
    if (last && last.role === 'assistant' && segment.role === 'assistant') {
      last.content = `${last.content}\n\n${content}`;
      continue;
    }
    turns.push({ role: segment.role, content });
  }
  return turns.map((turn) => ({ ...turn, content: cap(turn.content) }));
}

/**
 * 上游把一批里最后 10 条当新消息、再往前 5 条当背景（l1-extractor.ts:177-182）。Pi 的 background 是同一
 * 会话里更早、已经抽过的文本，所以背景候选是「background 的消息 + delta 里没进窗口的消息」。
 * 窗口外更早的 delta 消息不再单独抽取，提交游标时一并视为已处理，和上游一致。
 */
export function buildExtractionWindow(delta: string, background: string, now = Date.now()): ExtractionWindow {
  const fresh = conversationTurns(delta);
  const newTurns = fresh.slice(-MAX_NEW_MESSAGES);
  const before = [...conversationTurns(background), ...fresh.slice(0, fresh.length - newTurns.length)];
  const backgroundTurns = before.slice(-MAX_BACKGROUND_MESSAGES);
  const stamp = (prefix: string, list: ConversationTurn[], offset: number): ConversationMessage[] =>
    list.map((turn, index) => ({ id: `${prefix}${index}`, role: turn.role, content: turn.content, timestamp: now + (offset + index) * 1000 }));
  return {
    backgroundMessages: stamp('b', backgroundTurns, 0),
    newMessages: stamp('m', newTurns, backgroundTurns.length),
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run --project main electron/app/memoryExtractionWindow.test.ts`
预期：PASS（9 个测试）

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/memoryExtractionWindow.ts electron-agent/electron/app/memoryExtractionWindow.test.ts
git commit -m "feat(agentdata): 新增记忆抽取窗口，只取对话文本并按上游 10+5 截断"
```

---

### 任务 2：抽取任务改用窗口

**文件：**
- 修改：`electron-agent/electron/app/memoryService.ts`（`MemoryCaptureResult`、`capture()`，删掉 `captureBackground` 的调用点）
- 修改：`electron-agent/electron/pi/systemWorkerManager.ts`（`inputNotRendered`）
- 修改：`extensions/memory/capture.ts:34-39`
- 测试：`electron-agent/electron/app/memoryService.test.ts`、`electron-agent/electron/pi/systemWorkerManager.test.ts`、`extensions/memory/capture.test.ts`
- 创建：`docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-window.md`
- 修改：`docs/decisions/electron-agent/agentdata/2026-10-06-memory-task-usage-and-payload-dedupe.md`（顶部加墓碑，正文不动）

任务输入里保留 `delta`：`captureFromTask` 和 `commitCapture` 要拿它做游标前缀比对。但 `delta` 含工具输出，不再发给模型。模型只看到 `newMessages` / `backgroundMessages`。

- [ ] **步骤 1：编写失败的测试**

在 `memoryService.test.ts` 里，把 `'抽取任务带上背景对话、上一情境和 mode'` 整个替换成下面两个测试，并在它后面再加两个：

```ts
  it('抽取任务带上背景消息、上一情境和 mode，delta 原样留作游标', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert(scope, { level: 1, content: JSON.stringify({ content: '旧事实', type: 'work_fact', scene_name: '团队在围绕旧议题推进' }) });
    store.capture(scope, 'session:s1', 'user: first', 'fp0');
    store.commitCapture(scope, 'session:s1', 'fp0');
    await service.capture({ ...scope, source: 'session:s1', transcript: 'user: first\nuser: second', fingerprint: 'fp1' });
    expect(tasks[0].input).toMatchObject({
      delta: 'user: second',
      newMessages: [expect.objectContaining({ id: 'm0', role: 'user', content: 'second' })],
      backgroundMessages: [expect.objectContaining({ id: 'b0', role: 'user', content: 'first' })],
      previousSceneName: '团队在围绕旧议题推进',
      mode: 'work',
    });
    expect(tasks[0].input).not.toHaveProperty('background');
    db.close();
  });

  it('工具输出不进抽取消息', async () => {
    const { db, tasks, service } = setup();
    await service.capture({ ...scope, source: 'session:s1', transcript: 'user: 查日志\nassistant: 我看看\ntoolResult: HUGE_TOOL_OUTPUT\nassistant: 磁盘满了', fingerprint: 'fp1' });
    const input = tasks[0].input as { newMessages: Array<{ role: string; content: string }> };
    expect(input.newMessages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: '查日志' },
      { role: 'assistant', content: '我看看\n\n磁盘满了' },
    ]);
    expect(JSON.stringify(input.newMessages)).not.toContain('HUGE_TOOL_OUTPUT');
    db.close();
  });

  it('新增内容只有工具输出时不入队，直接提交游标', async () => {
    const { db, tasks, service } = setup();
    const first = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: hi', fingerprint: 'fp1' });
    service.completeExtraction(first.taskId!, {});
    const second = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: hi\ntoolResult: x', fingerprint: 'fp2' });
    expect(second).toMatchObject({ changed: true, extraction: 'skipped' });
    expect(second.taskId).toBeUndefined();
    expect(tasks).toHaveLength(1);
    expect(db.prepare('SELECT pending FROM memory_captures').get()).toMatchObject({ pending: null });
    db.close();
  });

  it('入队时回执带 extraction: queued', async () => {
    const { db, service } = setup();
    expect(await service.capture({ ...scope, source: 'session:s1', transcript: 'user: hi', fingerprint: 'fp1' })).toMatchObject({ extraction: 'queued' });
    db.close();
  });
```

在 `systemWorkerManager.test.ts` 里，把 `'memory_extract 给了 newMessages 数组时渲染的是它，没渲染的 delta 留在 Input 段'` 整个替换为：

```ts
  it('memory_extract 给了 newMessages 数组时，delta 只是游标，不进 Input 段', () => {
    const input = {
      newMessages: [{ id: 'm0', role: 'user', content: 'ARRAY_MARKER', timestamp: 1 }],
      backgroundMessages: [{ id: 'b0', role: 'user', content: 'BG_MARKER', timestamp: 0 }],
      delta: 'user: ARRAY_MARKER\ntoolResult: TOOL_OUTPUT',
      source: 'session:s',
    };
    const { user } = serviceTaskRequestForTest({ id: 't1', kind: 'memory_extract', input });
    expect(user.split('ARRAY_MARKER').length - 1).toBe(1);
    expect(user.split('BG_MARKER').length - 1).toBe(1);
    expect(user).not.toContain('TOOL_OUTPUT');
    const inputLine = user.slice(user.lastIndexOf('\nInput: ') + '\nInput: '.length);
    expect(JSON.parse(inputLine)).toEqual({ source: 'session:s' });
  });
```

在 `extensions/memory/capture.test.ts` 的 `describe` 末尾加：

```ts
  it.each(['deferred', 'skipped', 'queued'])('主进程回执 extraction=%s 时不走本地兜底抽取', async (extraction) => {
    const c = client();
    const request = c.request.bind(c);
    c.request = async <T,>(method: string, params: Record<string, unknown>) => {
      const result = await request<T>(method, params);
      return (method === 'memory.capture' ? { ...(result as object), extraction } : result) as T;
    };
    const ask = vi.fn(async () => sceneJson('unused'));
    await new LayeredMemoryCapture(c, () => ask).enqueue(ctx, [{ role: 'user', content: 'remember me' }]);
    expect(ask).not.toHaveBeenCalled();
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run --project main electron/app/memoryService.test.ts electron/pi/systemWorkerManager.test.ts`
预期：FAIL，`newMessages` 不存在、`extraction` 不存在、Input 行仍含 `delta`

运行：`cd extensions; npx vitest run memory/capture.test.ts`
预期：FAIL，`ask` 被调用

- [ ] **步骤 3：实现**

`memoryService.ts` 顶部 import 加：

```ts
import { buildExtractionWindow } from './memoryExtractionWindow';
```

`MemoryCaptureResult` 改为：

```ts
/**
 * extraction：主进程怎么处理了这次捕获。queued = 已入队（taskId 有值）；skipped = 新增内容里没有可抽取的
 * 对话文本，游标已直接提交；deferred = 按抽取节奏延后（任务 5）。有值时扩展不再走本地兜底抽取。
 */
export interface MemoryCaptureResult { changed: boolean; delta: string; fingerprint: string; taskId?: string; extraction?: 'queued' | 'skipped' | 'deferred' }
```

`capture()` 里，从 `const taskId = randomUUID();` 到 `return { ...captured, taskId };` 替换为：

```ts
    const scope = { ...input, scope: 'project' as const };
    const window = buildExtractionWindow(captured.delta, captureBackground(this.options.store, scope, input.source, captured.delta));
    if (window.newMessages.length === 0) {
      this.options.store.commitCapture(scope, input.source, input.fingerprint, captured.delta);
      return { ...captured, extraction: 'skipped' };
    }
    const taskId = randomUUID();
    this.pending.set(taskId, { scope, source: input.source, fingerprint: input.fingerprint, delta: captured.delta });
    try {
      void this.options.queue.enqueue({
        id: taskId,
        kind: 'memory_extract',
        input: {
          // delta 只是游标：captureFromTask / commitCapture 用它做前缀比对。它含工具输出，Input 行不会带上它。
          delta: captured.delta,
          newMessages: window.newMessages,
          backgroundMessages: window.backgroundMessages,
          previousSceneName: latestSceneName(this.options.store, scope),
          mode: this.options.extractMode ?? 'work',
          source: input.source,
          fingerprint: input.fingerprint,
          userId: input.userId,
          projectId: input.projectId,
          workspace: input.workspace,
          sessionId: input.sessionId,
        },
        sourceProjectId: input.projectId,
        sourceSessionId: input.sessionId,
        system: true,
      }).then((task) => {
        // Queues with a terminal callback may already have settled this task.
        if (this.pending.has(taskId)) this.taskSettled(task);
      }).catch(() => { if (this.pending.has(taskId)) this.finishCapture(taskId); });
    } catch (error) {
      this.pending.delete(taskId);
      throw error;
    }
    return { ...captured, taskId, extraction: 'queued' };
```

（原来写在 `const taskId` 之后的那行 `const scope = …` 删掉，因为它已经挪到前面。）

`systemWorkerManager.ts` 的 `inputNotRendered` 里 memory_extract 分支整段替换为：

```ts
  const rest = { ...task.input };
  // newMessages / backgroundMessages 数组时渲染的是它们；否则渲染 delta / background。两种情况下这五个字段
  // 都不该再进 Input 行：被渲染的已经在正文里，没被渲染的 delta 只是游标，而且含工具输出。
  for (const key of ['newMessages', 'backgroundMessages', 'delta', 'background']) delete rest[key];
  if (typeof rest.previousSceneName === 'string') delete rest.previousSceneName;
  return rest;
```

同一个文件里，`inputNotRendered` 上方的注释改为：

```ts
/**
 * Input 段只放正文模板没渲染过的字段。memory_extract 的对话已经由 formatExtractionPrompt 写成可读文本，
 * delta 只是游标（见 MemoryService.capture），所以 newMessages / backgroundMessages / delta / background /
 * previousSceneName 都不进 Input 段。memory_scene 同样去重，见 sceneInputNotRendered。其余 kind 原样保留。
 */
```

`extensions/memory/capture.ts` 第 34 行的类型和第 39 行改为：

```ts
    const captured = await this.client.request<{ changed: boolean; delta: string; taskId?: string; extraction?: string }>("memory.capture", { ...scope(ctx), source, transcript, fingerprint, ...(ctx.extract === false ? { extract: false } : {}) });
```

```ts
    // Electron-owned MemoryService queues, defers or skips extraction itself. The
    // local fallback below remains for older sidecars that return neither.
    if (captured.taskId || captured.extraction) return;
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run --project main electron/app/memoryService.test.ts electron/pi/systemWorkerManager.test.ts electron/agentData/runtime.test.ts electron/agentData/runtime.extensions.test.ts electron/agentData/extensionIntegration.test.ts`
预期：PASS。`runtime.test.ts` 里有 4 个已知失败（wiki RPC 相关，和本计划无关，2026-10-06 已在基线确认），数量不应增加。

运行：`cd extensions; npx vitest run memory/capture.test.ts`
预期：PASS

- [ ] **步骤 5：写决策记录**

`docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-window.md`：

```markdown
---
title: memory_extract 只送最近 10 条对话加 5 条背景，工具输出不进抽取；delta 只当游标
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/app/memoryExtractionWindow.ts
  - electron-agent/electron/app/memoryService.ts
  - electron-agent/electron/pi/systemWorkerManager.ts
  - extensions/memory/capture.ts
supersedes: 2026-10-06-memory-task-usage-and-payload-dedupe.md
superseded_by:
---

## 背景
历史 311 个 memory_extract 任务的载荷里，工具输出占 94.7%（42.3 MB），用户发言 0.6%，assistant 文本 4.5%。delta 不设上限，老会话第一次捕获会把整段历史一次发出（实测 286 KB）。上游 TencentDB-Agent-Memory 只送 user/assistant 文本（l0-recorder.ts:551-590），assistant 去掉代码块，每批最多 10 条新消息加 5 条背景（l1-extractor.ts:149-182）。

## 决定
新增 buildExtractionWindow：按 pi 的角色行切分 transcript，只留 user/assistant；assistant 去代码块、去内联图片；按上游 shouldExtractL1 过滤；同一轮里被工具调用隔开的 assistant 文本合成一条；单条截到 4000 字；最后取 10 条新消息，背景从「更早的会话文本 + delta 里没进窗口的消息」里取最后 5 条。

任务输入新增 newMessages / backgroundMessages，去掉 background 字符串。delta 保留，只给 captureFromTask / commitCapture 做游标；systemWorkerManager 的 Input 行一律不带 newMessages、backgroundMessages、delta、background、previousSceneName。窗口为空（新增内容只有工具输出）时不入队，直接提交游标。memory.capture 的回执新增 extraction 字段，扩展看到它就不走本地兜底抽取。

被推翻的旧笔记里，以下结论仍然有效：service_tasks 的 token 用量埋点（input / output / cache_read / cache_write_tokens、model 按 attempt 累加）；formatNonStream 先看 stopReason、provider 报错透出原文；empty content 开头的错误不重试。被推翻的只有「newMessages 是数组时，没渲染的 delta 保留在 Input 段」这一条。

## 放弃的方案
- 在扩展里改 flattenTranscript，捕获时就不存工具输出：conversation_search 依赖完整的 transcript，L0 归档会因此变样。
- 不合并同一轮的 assistant 段：一轮常被工具调用切成好几段，10 条新消息只能覆盖两三轮，和抽取节奏的 5 轮对不上。
- 不截单条：一条长报告就能把批量上限抵掉。
- 窗口外更早的 delta 消息另开任务补抽：和上游的批次语义不一致，而且会把节省的成本又花回去。

## 后果
一批里超过 10 条之前的对话不会被单独抽取，提交游标时视为已处理，这和上游一致。工具输出里的事实（比如某个命令的报错）只有在 assistant 文本里转述过才会被记住。截断以「…（已截断）」结尾，模型能看出来。
```

在 `2026-10-06-memory-task-usage-and-payload-dedupe.md` 第一行（frontmatter 的 `---` 之前）加一行墓碑，正文不动：

```markdown
> 已过时 → 见 2026-10-07-memory-extract-window.md
```

并把它 frontmatter 里的 `status: active` 改为 `status: superseded`，`superseded_by:` 填 `2026-10-07-memory-extract-window.md`。

运行：`node scripts/check-notes.mjs`
预期：`notes OK`

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/app/memoryService.ts electron-agent/electron/app/memoryService.test.ts electron-agent/electron/pi/systemWorkerManager.ts electron-agent/electron/pi/systemWorkerManager.test.ts extensions/memory/capture.ts extensions/memory/capture.test.ts docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-window.md docs/decisions/electron-agent/agentdata/2026-10-06-memory-task-usage-and-payload-dedupe.md
git commit -m "fix(agentdata): memory_extract 改用 10+5 对话窗口，工具输出不再送给模型"
```

---

### 任务 3：抽取输出宽松解析

**文件：**
- 创建：`electron-agent/electron/agent/memoryOutputParse.ts`
- 测试：`electron-agent/electron/agent/memoryOutputParse.test.ts`
- 修改：`electron-agent/electron/pi/systemWorkerManager.ts`（`parseCompleteOutput`）
- 修改：`electron-agent/electron/agent/memoryExtraction.ts`（`flattenSceneExtraction`）
- 测试：`electron-agent/electron/pi/systemWorkerManager.test.ts`、`electron-agent/electron/agent/memoryExtraction.test.ts`
- 创建：`docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-output-parse.md`

和上游有一处有意的不同：上游找不到数组时把这一批当作「没有记忆」，直接提交；我们仍然抛错，交给 TaskQueue 重试一次。2026-10-06 的数据显示，同样的输入重试是会成功的（`dd38bb31` 失败、紧接着的 `76997ac5` 成功）。

- [ ] **步骤 1：编写失败的测试**

```ts
// electron-agent/electron/agent/memoryOutputParse.test.ts
import { describe, expect, it } from 'vitest';
import { parseExtractionText, parseLooseJson, repairExtractionJson, sanitizeJsonForParse, stripModelWrappers } from './memoryOutputParse';

const scene = { scene_name: 's', message_ids: ['m0'], memories: [{ content: 'c', type: 'work_fact', priority: 80 }] };

describe('stripModelWrappers', () => {
  it('剥掉完整的 <think> 块和代码围栏，不完整的 think 原样保留', () => {
    expect(stripModelWrappers('<think>想 [1]</think>\n```json\n[1]\n```')).toBe('[1]');
    expect(stripModelWrappers('<think>没写完 [1]')).toBe('<think>没写完 [1]');
  });
});

describe('sanitizeJsonForParse / repairExtractionJson', () => {
  it('转义字符串里的裸换行和控制字符', () => {
    expect(JSON.parse(sanitizeJsonForParse('{"a":"x\ny\u0001"}'))).toEqual({ a: 'x\ny\u0001' });
  });

  it('非法 priority 改成 50，去掉尾逗号', () => {
    expect(JSON.parse(repairExtractionJson('[{"content":"c","priority": high,}]'))).toEqual([{ content: 'c', priority: 50 }]);
  });

  it('parseLooseJson 先净化、失败再修复', () => {
    expect(parseLooseJson('[{"content":"a\nb","priority": sheet}]')).toEqual([{ content: 'a\nb', priority: 50 }]);
    expect(() => parseLooseJson('not json')).toThrow();
  });
});

describe('parseExtractionText', () => {
  it.each([
    ['裸数组', JSON.stringify([scene])],
    ['think 包裹', `<think>先想想 [x]</think>${JSON.stringify([scene])}`],
    ['代码围栏', `\`\`\`json\n${JSON.stringify([scene])}\n\`\`\``],
    ['对象里套 scenes 数组', JSON.stringify({ scenes: [scene] })],
    ['数组前后有说明文字', `结果如下：\n${JSON.stringify([scene])}\n以上。`],
  ])('%s 都得到场景数组', (_name, raw) => {
    expect(parseExtractionText(raw)).toEqual([scene]);
  });

  it('单个场景对象包成数组', () => {
    expect(parseExtractionText(JSON.stringify(scene))).toEqual([scene]);
  });

  it('{l1,l2,l3} 信封原样返回', () => {
    expect(parseExtractionText('{"l1":[{"content":"c","type":"work_fact"}]}')).toEqual({ l1: [{ content: 'c', type: 'work_fact' }] });
  });

  it('对象里没有数组时原样返回，交给 parseMemoryExtraction 判定', () => {
    expect(parseExtractionText('{"ok":true}')).toEqual({ ok: true });
    expect(parseExtractionText('{}')).toEqual({});
  });

  it('完全没有 JSON 时抛 invalid JSON，交给 TaskQueue 重试', () => {
    expect(() => parseExtractionText('我觉得没什么可记的。')).toThrow('system Pi returned invalid JSON');
  });
});
```

在 `memoryExtraction.test.ts` 末尾加：

```ts
describe('flattenSceneExtraction 补默认值', () => {
  it('priority 是数字字符串时转成数字，非法时给 50；source_message_ids 转成字符串；metadata 不是对象时给空对象', () => {
    expect(flattenSceneExtraction([{ scene_name: 's', memories: [
      { content: 'a', type: 'work_fact', priority: '70', source_message_ids: [0, 'm1'], metadata: 'x' },
      { content: 'b', type: 'work_fact', priority: 'high' },
    ] }])).toEqual({ l1: [
      { content: 'a', type: 'work_fact', priority: 70, source_message_ids: ['0', 'm1'], metadata: {}, scene_name: 's' },
      { content: 'b', type: 'work_fact', priority: 50, scene_name: 's' },
    ] });
  });
});
```

（`memoryExtraction.test.ts` 顶部 import 里加上 `flattenSceneExtraction`。）

在 `systemWorkerManager.test.ts` 的 `describe` 里加：

```ts
  it('memory_extract 能解析 think 包裹、对象套数组的输出', async () => {
    const memory = { content: 'prefer dark', type: 'work_fact', priority: 80 };
    const complete = vi.fn()
      .mockResolvedValueOnce(`<think>[草稿]</think>${JSON.stringify({ scenes: [{ scene_name: 's', memories: [memory] }] })}`);
    const manager = new SystemWorkerManager({ describeModel: async () => 'x/y', complete });
    await expect(manager.run({ id: 'p', kind: 'memory_extract', input: {} })).resolves.toEqual({ l1: [{ ...memory, scene_name: 's' }] });
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run --project main electron/agent/memoryOutputParse.test.ts electron/agent/memoryExtraction.test.ts electron/pi/systemWorkerManager.test.ts`
预期：FAIL，`memoryOutputParse` 不存在；priority 字符串的记忆被丢掉；think 包裹的输出报 `invalid JSON`

- [ ] **步骤 3：实现**

```ts
// electron-agent/electron/agent/memoryOutputParse.ts
/**
 * 抽取输出的宽松解析。移植自 TencentDB-Agent-Memory（MIT）：
 * - <think> 剥离与数组提取：MemoryCore/src/core/record/l1-extractor.ts:571-631
 * - sanitizeJsonForParse：MemoryCore/src/utils/sanitize.ts:316-405
 * - repairExtractionJson：MemoryCore/src/core/record/l1-extractor.ts:674-681
 */

/** 非贪婪、要求闭合标签：被 max_tokens 截断的 think 原样保留，不会吃掉后面的正文。 */
export function stripModelWrappers(raw: string): string {
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  return cleaned.trim();
}

const SHORT_ESCAPES: Record<number, string> = { 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0c: '\\f', 0x0d: '\\r' };

function escapeControlCharsInJsonStrings(text: string): string {
  const out: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);
    if (inString) {
      if (ch === '\\' && i + 1 < text.length) { out.push(ch, text[i + 1]!); i++; continue; }
      if (ch === '"') { out.push(ch); inString = false; continue; }
      if (code <= 0x1f) { out.push(SHORT_ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, '0')}`); continue; }
      out.push(ch);
    } else {
      if (ch === '"') inString = true;
      out.push(ch);
    }
  }
  return out.join('');
}

export function sanitizeJsonForParse(raw: string): string {
  const escaped = escapeControlCharsInJsonStrings(raw);
  try { JSON.parse(escaped); return escaped; } catch { /* 进入第二步 */ }
  return escaped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

export function repairExtractionJson(json: string): string {
  return json
    .replace(
      /("priority"\s*:\s*)(?!-?\d+(?:\.\d+)?\s*[,}]|"[^"\\]*(?:\\.[^"\\]*)*"\s*[,}])([\s\S]*?)(?=,\s*"(?:content|type|priority|source_message_ids|metadata)"\s*:|[}\]])/g,
      (_match, prefix: string) => `${prefix}50`,
    )
    .replace(/,\s*([}\]])/g, '$1');
}

export function parseLooseJson(text: string): unknown {
  const sanitized = sanitizeJsonForParse(text);
  try {
    return JSON.parse(sanitized);
  } catch (error) {
    const repaired = repairExtractionJson(sanitized);
    if (repaired === sanitized) throw error;
    return JSON.parse(repaired);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEnvelope(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === 'l1' || key === 'l2' || key === 'l3');
}

/**
 * 返回场景数组，或旧的 {l1,l2,l3} 信封（交给 flattenSceneExtraction / parseMemoryExtraction）。
 * 和上游的不同：完全找不到 JSON 时抛错（可重试），上游则当作「没有记忆」直接提交。
 */
export function parseExtractionText(raw: string): unknown {
  const cleaned = stripModelWrappers(raw);
  let whole: unknown;
  try { whole = parseLooseJson(cleaned); } catch { whole = undefined; }
  if (Array.isArray(whole)) return whole;
  if (isRecord(whole)) {
    if (isEnvelope(whole)) return whole;
    if (Array.isArray(whole.memories)) return [whole];
  }
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = parseLooseJson(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* 下面按整段的解析结果处理 */ }
  }
  // 合法 JSON 对象但没有场景数组（如 {"result":"…"}）原样交出，由 parseMemoryExtraction 的严格校验拒绝。
  if (isRecord(whole)) return whole;
  throw new Error('system Pi returned invalid JSON');
}
```

`systemWorkerManager.ts` 的 import 加：

```ts
import { parseExtractionText, parseLooseJson, stripModelWrappers } from '../agent/memoryOutputParse.js';
```

`parseCompleteOutput` 整个替换为：

```ts
function parseCompleteOutput(text: string, kind?: string): unknown {
  const trimmed = text.trim();
  if (kind && TEXT_OUTPUT_KINDS.has(kind)) {
    if (!trimmed) throw new Error('system Pi returned empty text');
    return trimmed;
  }
  if (kind === 'memory_extract') return flattenSceneExtraction(parseExtractionText(text));
  const json = stripModelWrappers(text);
  try {
    return parseLooseJson(json);
  } catch {
    const match = kind === 'memory_deduplicate' ? json.match(/\[[\s\S]*\]/) : undefined;
    if (!match) throw new Error('system Pi returned invalid JSON');
    try { return parseLooseJson(match[0]); } catch { throw new Error('system Pi returned invalid JSON'); }
  }
}
```

`memoryExtraction.ts` 里，在 `flattenSceneExtraction` 之前加：

```ts
/** 上游 parseExtractionResult（l1-extractor.ts:643-655）的字段默认值。type 缺失仍然丢弃：按 mode 过滤类型的是 parseMemoryExtraction。 */
function normalizeMemory(memory: unknown): unknown {
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) return memory;
  const rec = { ...(memory as Record<string, unknown>) };
  if (rec.priority !== undefined && typeof rec.priority !== 'number') {
    const numeric = typeof rec.priority === 'string' && rec.priority.trim() ? Number(rec.priority) : Number.NaN;
    rec.priority = Number.isFinite(numeric) ? numeric : 50;
  }
  if (Array.isArray(rec.source_message_ids)) rec.source_message_ids = rec.source_message_ids.map(String);
  else if (rec.source_message_ids !== undefined) delete rec.source_message_ids;
  if (rec.metadata !== undefined && (!rec.metadata || typeof rec.metadata !== 'object' || Array.isArray(rec.metadata))) rec.metadata = {};
  return rec;
}
```

并把 `flattenSceneExtraction` 循环里的

```ts
      const parsed = l1RecordSchema.safeParse(memory);
```

改为

```ts
      const parsed = l1RecordSchema.safeParse(normalizeMemory(memory));
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run --project main electron/agent electron/pi electron/app/memoryService.test.ts`
预期：PASS

- [ ] **步骤 5：写决策记录**

`docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-output-parse.md`：

```markdown
---
title: 抽取输出按上游宽松解析：剥 think、去围栏、对象里找数组、修复控制字符与 priority
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/agent/memoryOutputParse.ts
  - electron-agent/electron/pi/systemWorkerManager.ts
  - electron-agent/electron/agent/memoryExtraction.ts
supersedes:
superseded_by:
---

## 背景
2026-10-06 一个新会话的 5 个 memory_extract 任务里有 3 个因格式失败（两个 `memory extraction output is invalid`，一个 `invalid JSON`），花掉了抽取 token 的 68%。我们的解析要求整段输出能被 JSON.parse，而且必须是场景数组或 {l1,l2,l3}；对象套数组、单个场景对象、字符串里有裸换行、priority 写成单词，都会整批失败。上游 l1-extractor.ts:571-681 对这些都有处理。

## 决定
新增 memoryOutputParse.ts，移植上游的 <think> 剥离、代码围栏剥离、sanitizeJsonForParse、repairExtractionJson。memory_extract 依次尝试：整段解析得到数组或信封；整段是单个场景对象就包成数组；否则取第一个 [ 到最后一个 ] 再解析。flattenSceneExtraction 对每条记忆补默认值：priority 非数字时转数字或给 50，source_message_ids 转字符串，metadata 不是对象时给空对象。其余 JSON kind 也先剥 think 和围栏，再走净化与修复。

## 放弃的方案
- 完全照上游，找不到数组时当作「没有记忆」直接提交：2026-10-06 的数据显示同样的输入重试会成功（dd38bb31 失败、紧接着的 76997ac5 成功），直接提交会丢掉这批记忆。所以仍然抛错，交给 TaskQueue 重试一次。
- 用 JSON mode（response_format）：上游 Chat Memory 也没用，而且中转和不同 provider 的支持参差不齐。
- type 缺失时默认 episodic（上游做法）：Pi 默认 work 模式，episodic 会被 parseMemoryExtraction 的类型过滤丢掉，结果一样，不如保持「缺 type 即丢」更直白。

## 后果
贪婪地取 [ 到 ] 时，如果模型在 JSON 前后的文字里也写了方括号，会解析失败，然后照常重试。解析失败时的原文在 service_tasks.raw_output 里，可以据此继续补容错。
```

运行：`node scripts/check-notes.mjs`
预期：`notes OK`

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agent/memoryOutputParse.ts electron-agent/electron/agent/memoryOutputParse.test.ts electron-agent/electron/pi/systemWorkerManager.ts electron-agent/electron/pi/systemWorkerManager.test.ts electron-agent/electron/agent/memoryExtraction.ts electron-agent/electron/agent/memoryExtraction.test.ts docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-output-parse.md
git commit -m "fix(agentdata): 抽取输出按上游宽松解析，剥 think、对象里找数组、修复 JSON"
```

---

### 任务 4：调用参数与超时

**文件：**
- 修改：`electron-agent/electron/agent/modelRuntimeHost.ts`（`ShortCallInput`、`completeSimple`）
- 修改：`electron-agent/electron/pi/systemWorkerManager.ts`（`WorkerOptions.complete`、`serviceTaskRequest`）
- 修改：`electron-agent/electron/main.ts:116`
- 修改：`electron-agent/electron/agent/shortCall.ts:21-28`
- 修改：`electron-agent/electron/app/appServer/serviceTaskRegistry.ts:50-53`
- 测试：`electron-agent/electron/agent/modelRuntimeHost.test.ts`、`electron-agent/electron/pi/systemWorkerManager.test.ts`
- 创建：`docs/decisions/electron-agent/agentdata/2026-10-07-memory-call-limits.md`

- [ ] **步骤 1：编写失败的测试**

`modelRuntimeHost.test.ts` 的 `'ModelRuntimeHost 短调用'` describe 里加：

```ts
  it('completeSimple 只在给了 maxTokens 时才透传，不传 reasoning（pi-ai 不传即关闭思考）', async () => {
    const completeSimple = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const create = vi.fn().mockResolvedValue({
      completeSimple, getAvailableSnapshot: () => [model], getModel: () => model, hasConfiguredAuth: () => true, refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    await host.completeSimple({ user: 'q', maxTokens: 4096 });
    await host.completeSimple({ user: 'q' });
    expect(completeSimple.mock.calls[0][2]).toEqual({ signal: undefined, maxTokens: 4096 });
    expect(completeSimple.mock.calls[1][2]).toEqual({ signal: undefined });
  });
```

`systemWorkerManager.test.ts` 里，把 `'wiki_page_generate 与 memory_extract 都用 60s'` 整个替换为：

```ts
  it('wiki_page_generate 60s，memory_extract 对齐上游 180s', async () => {
    vi.useFakeTimers();
    try {
      const wiki = new SystemWorkerManager({ describeModel: async () => 'x/y', complete: hangUntilAbort() });
      const wikiRun = wiki.run({ id: 'wiki', kind: 'wiki_page_generate', input: {} });
      let wikiSettled = false;
      void wikiRun.then(() => { wikiSettled = true; }, () => { wikiSettled = true; });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(wikiSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(wikiRun).rejects.toThrow('aborted');

      const mem = new SystemWorkerManager({ describeModel: async () => 'x/y', complete: hangUntilAbort() });
      const memRun = mem.run({ id: 'mem', kind: 'memory_extract', input: {} });
      let memSettled = false;
      void memRun.then(() => { memSettled = true; }, () => { memSettled = true; });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(179_000);
      expect(memSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(memRun).rejects.toThrow('aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('memory_extract / memory_deduplicate 传 maxTokens 4096，scene / persona 不限', async () => {
    const complete = vi.fn(async (_input: CompleteInput & { maxTokens?: number }) => '{}');
    const manager = new SystemWorkerManager({ describeModel: async () => 'x/y', complete });
    await manager.run({ id: 'a', kind: 'memory_extract', input: {} });
    await manager.run({ id: 'b', kind: 'memory_deduplicate', input: {} }).catch(() => {});
    await manager.run({ id: 'c', kind: 'memory_scene', input: {} }).catch(() => {});
    expect(complete.mock.calls.map((call) => call[0].maxTokens)).toEqual([4096, 4096, undefined]);
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run --project main electron/agent/modelRuntimeHost.test.ts electron/pi/systemWorkerManager.test.ts`
预期：FAIL，`maxTokens` 没透传；memory_extract 在 60s 就中断

- [ ] **步骤 3：实现**

`modelRuntimeHost.ts` 的 `ShortCallInput` 里，在 `samplingParams?` 之后加：

```ts
  /** 输出 token 上限。记忆抽取 / 去重传 4096（上游 config.ts:652）；不传则用模型默认。 */
  maxTokens?: number;
```

`completeSimple` 里的调用改为：

```ts
    // reasoning 有意不透传：pi-ai 不传即关闭思考（openai-completions.js 的 enable_thinking = !!reasoningEffort），
    // 传 'minimal' 反而会打开。
    const options: { signal?: AbortSignal; maxTokens?: number } = { signal: input.signal };
    if (input.maxTokens !== undefined) options.maxTokens = input.maxTokens;
    const msg = await runtime.completeSimple(
      model,
      { systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: input.user, timestamp: Date.now() }] },
      options,
    );
```

`systemWorkerManager.ts`：

```ts
interface WorkerOptions {
  describeModel: () => Promise<string>;
  complete: (input: { user: string; systemPrompt?: string; maxTokens?: number; signal?: AbortSignal; onUsage?: SystemWorkerHooks['onUsage'] }) => Promise<string>;
  maxAttempts?: number;
  taskTimeoutMs?: number;
}
```

```ts
/** 上游 L1 抽取与去重的输出上限（config.ts:652）；L2 / L3 要写整篇 Markdown，上游不设上限。 */
const KIND_MAX_TOKENS: Record<string, number> = { memory_extract: 4096, memory_deduplicate: 4096 };

function serviceTaskRequest(task: SystemWorkerTask): { user: string; systemPrompt?: string; maxTokens?: number } {
  const maxTokens = KIND_MAX_TOKENS[task.kind];
  return { user: serviceTaskPrompt(task), systemPrompt: systemPromptFor(task), ...(maxTokens ? { maxTokens } : {}) };
}
```

（`serviceTaskRequestForTest` 的返回类型同步加上 `maxTokens?: number`。）

`main.ts:116`：

```ts
    const completeAgentData = (input: { user: string; systemPrompt?: string; maxTokens?: number; signal?: AbortSignal; onUsage?: (report: { model: string; usage: unknown }) => void }) =>
```

`shortCall.ts`：

```ts
/** 记忆任务对齐上游：L1 / 去重 / L3 180s（l1-extractor.ts:518、l1-dedup.ts:167、persona-generator.ts:207），L2 300s（scene-extractor.ts:118）。 */
export const KIND_TIMEOUT_MS: Record<string, number> = {
  goal_judge: 60_000,
  wiki_page_generate: 60_000,
  memory_extract: 180_000,
  memory_deduplicate: 180_000,
  memory_scene: 300_000,
  memory_persona: 180_000,
};
```

`serviceTaskRegistry.ts:50-53` 的四行 `timeoutMs` 改成同样的值（`180_000` / `180_000` / `300_000` / `180_000`）。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run --project main electron/agent electron/pi electron/app/appServer`
预期：PASS

- [ ] **步骤 5：写决策记录**

`docs/decisions/electron-agent/agentdata/2026-10-07-memory-call-limits.md`：

```markdown
---
title: 记忆任务超时对齐上游（180s / 300s），抽取与去重输出上限 4096，不传 reasoning
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/agent/modelRuntimeHost.ts
  - electron-agent/electron/pi/systemWorkerManager.ts
  - electron-agent/electron/agent/shortCall.ts
  - electron-agent/electron/app/appServer/serviceTaskRegistry.ts
supersedes:
superseded_by:
---

## 背景
记忆任务统一 60 秒超时，历史上有 36 个任务因此失败（72 次 attempt）。上游 L1 抽取、去重、L3 是 180 秒，L2 是 300 秒；L1 输出上限 4096 token。我们的系统 worker 只传 systemPrompt / user / signal。

## 决定
KIND_TIMEOUT_MS 和 ServiceTaskRegistry 两处超时都对齐上游。memory_extract、memory_deduplicate 传 maxTokens 4096；memory_scene、memory_persona 不设上限，因为它们要输出整篇 Markdown。ModelRuntimeHost.completeSimple 只在给了 maxTokens 时才透传。

## 放弃的方案
- 传 reasoning: 'minimal' 压低思考：pi-ai 不传 reasoning 就等于关闭思考（openai-completions.js 里 enable_thinking = !!reasoningEffort），传 'minimal' 反而会打开。
- 显式传 temperature：上游 Chat Memory 管线也不传；先看宽松解析之后的失败率再决定。
- 给 L2 也设 4096：场景文件常有几千字，截断会写坏场景。

## 后果
ShortCallQueue 是串行的，一个卡住的 L2 最多会让后面的 goal_judge、wiki 等 300 秒。如果出现明显排队，再把记忆任务和其他系统任务拆成两条队列。
```

运行：`node scripts/check-notes.mjs`
预期：`notes OK`

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agent/modelRuntimeHost.ts electron-agent/electron/agent/modelRuntimeHost.test.ts electron-agent/electron/pi/systemWorkerManager.ts electron-agent/electron/pi/systemWorkerManager.test.ts electron-agent/electron/main.ts electron-agent/electron/agent/shortCall.ts electron-agent/electron/app/appServer/serviceTaskRegistry.ts docs/decisions/electron-agent/agentdata/2026-10-07-memory-call-limits.md
git commit -m "fix(agentdata): 记忆任务超时对齐上游，抽取与去重输出上限 4096"
```

注意 `main.ts` 里还有不属于本计划的未提交改动，提交前用 `git add -p electron-agent/electron/main.ts` 只暂存这一处。

---

### 任务 5：抽取节奏（everyN、预热、空闲、启动补抽）

**文件：**
- 修改：`electron-agent/electron/app/memoryService.ts`
- 修改：`electron-agent/electron/agentData/memoryStore.ts`（新增 `listPendingCaptures`）
- 修改：`electron-agent/electron/agentData/runtime.ts:134-135`
- 测试：`electron-agent/electron/app/memoryService.test.ts`
- 创建：`docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-cadence.md`

上游的节奏是：每个会话累计到阈值轮数才抽一次，阈值从 1 开始，每抽一次翻倍直到 5（预热）；没到阈值时，空闲 600 秒也会抽；关闭时把剩下的冲掉。Pi 做不到在退出时等模型返回，所以改成启动后补抽。

- [ ] **步骤 1：让现有测试保持旧节奏**

`memoryService.test.ts` 的 `setup` 改为（现有测试都假设每轮立刻入队，所以显式关掉节奏）：

```ts
function setup(
  layerSchedule: MemoryServiceOptions['layerSchedule'] = { delayMs: 0, minIntervalMs: 0 },
  extractCadence: MemoryServiceOptions['extractCadence'] = { everyN: 1, warmup: false },
) {
  const db = new DatabaseSync(':memory:');
  const store = new MemoryStore(db);
  const tasks: QueueInput[] = [];
  const queue: MemoryTaskQueue & { enqueue: ReturnType<typeof vi.fn<(input: QueueInput) => Promise<ServiceTask>>> } = {
    enqueue: vi.fn((input: QueueInput) => {
      tasks.push(input);
      return Promise.resolve(taskResult(input));
    }),
  };
  const service = new MemoryService({ store, queue, layerSchedule, extractCadence });
  return { db, store, tasks, queue, service, layerSchedule };
}
```

文件里其余所有直接 `new MemoryService({ … })` 的地方（用 `rg -n "new MemoryService\(" electron-agent/electron/app/memoryService.test.ts` 列出，包括各个 `reopened`）都补上 `extractCadence: { everyN: 1, warmup: false }`。不补的话它们会用生产默认值，多数仍能通过，但行为不再等价于改动前。

- [ ] **步骤 2：编写失败的测试**

在 `memoryService.test.ts` 末尾加一个新的 describe：

```ts
describe('MemoryService 抽取节奏', () => {
  function cadenceSetup(options: MemoryServiceOptions['extractCadence'] = {}) {
    const timers: Array<{ ms: number; callback: () => void; cancelled: boolean }> = [];
    const setTimer = (callback: () => void, ms: number) => {
      const timer = { ms, callback, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    };
    const base = setup(undefined, { setTimer, ...options });
    const live = () => timers.filter((timer) => !timer.cancelled);
    return { ...base, timers, live };
  }
  const turn = (n: number) => ({
    ...scope, sessionId: 's', source: 'session:s',
    transcript: Array.from({ length: n }, (_, i) => `user: turn ${i}`).join('\n'), fingerprint: `fp${n}`,
  });

  it('预热阈值 1→2→4→5：第 1 轮立刻抽，之后第 3、7、12 轮才抽', async () => {
    const { db, tasks, service } = cadenceSetup();
    const fired: number[] = [];
    for (let n = 1; n <= 12; n++) {
      const result = await service.capture(turn(n));
      if (result.taskId) {
        fired.push(n);
        service.completeExtraction(result.taskId, {});
      } else {
        expect(result.extraction).toBe('deferred');
      }
    }
    expect(fired).toEqual([1, 3, 7, 12]);
    expect(tasks).toHaveLength(4);
    db.close();
  });

  it('不预热时每 everyN 轮抽一次', async () => {
    const { db, service } = cadenceSetup({ everyN: 3, warmup: false });
    const fired: number[] = [];
    for (let n = 1; n <= 6; n++) {
      const result = await service.capture(turn(n));
      if (result.taskId) { fired.push(n); service.completeExtraction(result.taskId, {}); }
    }
    expect(fired).toEqual([3, 6]);
    db.close();
  });

  it('没到阈值时空闲 idleMs 后补抽，新一轮会重置空闲计时', async () => {
    const { db, tasks, service, live } = cadenceSetup({ everyN: 5, warmup: false, idleMs: 600_000 });
    await service.capture(turn(1));
    await service.capture(turn(2));
    expect(live()).toHaveLength(1);
    expect(live()[0].ms).toBe(600_000);
    live()[0].callback();
    await Promise.resolve();
    expect(tasks).toHaveLength(1);
    expect((tasks[0].input as { newMessages: unknown[] }).newMessages).toHaveLength(2);
    db.close();
  });

  it('任务进行中到来的轮数照样计数，任务结束后够阈值就接着抽，不够就等空闲', async () => {
    const { db, tasks, service, live } = cadenceSetup({ everyN: 2, warmup: false });
    await service.capture(turn(1));
    const first = await service.capture(turn(2));
    expect(first.taskId).toBeDefined();
    await service.capture(turn(3));
    service.completeExtraction(first.taskId!, {});
    expect(tasks).toHaveLength(1);
    expect(live()).toHaveLength(1);
    await service.capture(turn(4));
    expect(tasks).toHaveLength(2);
    db.close();
  });

  it('启动补抽：延迟 recoverDelayMs 后对有 pending 的来源各入队一次', async () => {
    const { db, store, tasks, service, live } = cadenceSetup({ recoverDelayMs: 60_000 });
    store.capture({ ...scope, sessionId: 's1' }, 'session:s1', 'user: left over', 'fp1');
    store.capture({ ...scope, sessionId: 's2' }, 'session:s2', 'user: also left', 'fp2');
    service.recoverPendingCaptures();
    expect(tasks).toHaveLength(0);
    expect(live().map((timer) => timer.ms)).toEqual([60_000]);
    live()[0].callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tasks.map((task) => (task.input as { source: string }).source).sort()).toEqual(['session:s1', 'session:s2']);
    db.close();
  });

  it('dispose 取消所有节奏计时器', async () => {
    const { db, service, live } = cadenceSetup({ everyN: 5, warmup: false });
    await service.capture(turn(1));
    expect(live()).toHaveLength(1);
    service.dispose();
    expect(live()).toHaveLength(0);
    db.close();
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd electron-agent; npx vitest run --project main electron/app/memoryService.test.ts`
预期：FAIL，`extractCadence` 选项不存在、`recoverPendingCaptures` 不存在；第 2 轮也立刻入队

- [ ] **步骤 4：实现**

`memoryStore.ts`，在 `pendingCapture` 之后加：

```ts
  /** 启动补抽用：只取来源键，不读 transcript。 */
  listPendingCaptures(): Array<{ userId: string; workspace: string; projectId?: string; sessionId?: string; source: string }> {
    const rows = this.db.prepare(`SELECT user_id,workspace,project_id,session_id,source FROM memory_captures
      WHERE pending IS NOT NULL ORDER BY updated_at ASC`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      userId: String(row.user_id), workspace: String(row.workspace), source: String(row.source),
      ...(row.project_id == null ? {} : { projectId: String(row.project_id) }),
      ...(row.session_id == null ? {} : { sessionId: String(row.session_id) }),
    }));
  }
```

`memoryService.ts`：

在 `LayerScheduleOptions` 之后加：

```ts
/** 上游 pipeline-manager.ts 的 L1 节奏。默认值来自上游 config.ts:586-588。 */
export interface ExtractCadenceOptions {
  /** everyNConversations：累计多少轮抽一次。默认 5。 */
  everyN?: number;
  /** enableWarmup：新会话阈值 1→2→4→…→everyN。默认 true。 */
  warmup?: boolean;
  /** l1IdleTimeoutSeconds：没到阈值时，空闲多久补抽。默认 600_000 ms。 */
  idleMs?: number;
  /** 启动后多久补抽上次没抽完的来源（上游在关闭时冲掉，Pi 退出时等不了模型）。默认 60_000 ms。 */
  recoverDelayMs?: number;
  setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
}
type CaptureSource = Omit<MemoryCaptureInput, 'transcript' | 'fingerprint' | 'extract'>;
interface CadenceState { count: number; threshold: number; source: CaptureSource; timer?: { cancel: () => void } }
```

`MemoryServiceOptions` 加：

```ts
  extractCadence?: ExtractCadenceOptions;
```

类字段加：

```ts
  private readonly cadence = new Map<string, CadenceState>();
  private recoverTimer?: { cancel: () => void };
```

在 `immediateLayers()` 之后加这些私有方法：

```ts
  private everyN(): number { return Math.max(1, this.options.extractCadence?.everyN ?? 5); }
  private warmup(): boolean { return this.options.extractCadence?.warmup ?? true; }
  private idleMs(): number { return this.options.extractCadence?.idleMs ?? 600_000; }

  private setCadenceTimer(callback: () => void, ms: number): { cancel: () => void } {
    const setTimer = this.options.extractCadence?.setTimer ?? ((cb, wait) => {
      const handle = setTimeout(cb, wait);
      return { cancel: () => clearTimeout(handle) };
    });
    return setTimer(callback, ms);
  }

  private cadenceState(input: CaptureSource): CadenceState {
    const key = sourceKey(input);
    let state = this.cadence.get(key);
    if (!state) {
      state = { count: 0, threshold: this.warmup() ? 1 : this.everyN(), source: input };
      this.cadence.set(key, state);
    }
    state.source = input;
    return state;
  }

  /** 每次真正入队抽取后调用：计数清零、取消空闲计时、预热阈值翻倍直到 everyN（上游每次 L1 成功后翻倍，这里在入队时翻倍）。 */
  private consumeCadence(state: CadenceState): void {
    state.count = 0;
    state.timer?.cancel();
    state.timer = undefined;
    state.threshold = Math.min(state.threshold * 2, this.everyN());
  }

  private armIdle(state: CadenceState): void {
    state.timer?.cancel();
    state.timer = this.setCadenceTimer(() => {
      state.timer = undefined;
      void this.flushSource(state.source);
    }, this.idleMs());
  }

  /** 空闲计时和启动补抽共用：按存储里的 pending 强制入队一次。 */
  private async flushSource(source: CaptureSource): Promise<void> {
    const next = this.options.store.pendingCapture(source, source.source);
    if (!next) return;
    await this.capture({ ...source, transcript: next.transcript, fingerprint: next.fingerprint }, { force: true }).catch(() => {});
  }

  recoverPendingCaptures(): void {
    this.recoverTimer?.cancel();
    this.recoverTimer = this.setCadenceTimer(() => {
      this.recoverTimer = undefined;
      void (async () => {
        for (const row of this.options.store.listPendingCaptures()) {
          await this.flushSource({ ...row, projectId: row.projectId ?? row.workspace });
        }
      })();
    }, this.options.extractCadence?.recoverDelayMs ?? 60_000);
  }
```

`capture()` 的签名和开头改为（`force` 只给空闲计时、启动补抽、`finishCapture` 内部使用，RPC 不会传第二个参数）：

```ts
  async capture(input: MemoryCaptureInput, internal: { force?: boolean } = {}): Promise<MemoryCaptureResult> {
    const captured = this.options.store.capture(input, input.source, input.transcript, input.fingerprint);
    if (!captured.changed || !captured.delta) return captured;
    if (input.extract === false) {
      this.options.store.commitCapture(input, input.source, input.fingerprint);
      return captured;
    }
    const state = this.cadenceState(input);
    // 一次 agent_end 算一轮（上游 conversation_count）。任务进行中到来的轮数也计入，finishCapture 时据此决定接着抽还是等空闲。
    if (!internal.force) state.count += 1;
    const active = [...this.pending].find(([, value]) => sameSource(value.scope, value.source, input));
    if (active) return { ...captured, taskId: active[0], extraction: 'queued' };
    const queued = this.options.queue.findPending?.('memory_extract', (task) => {
      const value = this.captureFromTask(task.id, task);
      return !this.finishing.has(task.id) && value !== undefined && sameSource(value.scope, value.source, input);
    });
    if (queued) {
      this.pending.set(queued.id, this.captureFromTask(queued.id, queued)!);
      return { ...captured, taskId: queued.id, extraction: 'queued' };
    }
    if (!internal.force && state.count < state.threshold) {
      this.armIdle(state);
      return { ...captured, extraction: 'deferred' };
    }
    this.consumeCadence(state);
```

（原来开头的 `const active = …`、`if (input.extract === false) …`、`if (active) …`、`const queued = …` 这几段被上面整体替换；后面从 `const scope = …` 开始是任务 2 写好的内容，不变。注意原来 `active` 的查找在 `extract === false` 判断之前，现在移到之后，行为不变，因为 `extract === false` 直接返回。）

`finishCapture` 里的

```ts
    if (next && next.fingerprint !== capture.fingerprint) {
      // completeExtraction runs before TaskQueue persists "completed". Exclude
      // that still-running task while finding/creating the successor.
      this.finishing.add(taskId);
      void this.capture({ ...capture.scope, projectId: capture.scope.projectId ?? capture.scope.workspace, source: capture.source, ...next })
        .catch(() => {}).finally(() => { this.finishing.delete(taskId); });
    }
```

改为：

```ts
    if (next && next.fingerprint !== capture.fingerprint) {
      const source = { ...capture.scope, projectId: capture.scope.projectId ?? capture.scope.workspace, source: capture.source };
      // 任务进行中累计的轮数够了就接着抽，不够就等空闲补抽。这个进程里没见过该来源（重启后恢复的任务）
      // 时不知道积了多少轮，照旧立刻接着抽。
      const known = this.cadence.get(sourceKey(source));
      if (known && known.count < known.threshold) {
        this.armIdle(known);
        return;
      }
      // completeExtraction runs before TaskQueue persists "completed". Exclude
      // that still-running task while finding/creating the successor.
      this.finishing.add(taskId);
      void this.capture({ ...source, ...next }, { force: true })
        .catch(() => {}).finally(() => { this.finishing.delete(taskId); });
    }
```

`dispose()` 改为：

```ts
  dispose(): void {
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
    for (const state of this.cadence.values()) state.timer?.cancel();
    this.cadence.clear();
    this.recoverTimer?.cancel();
    this.recoverTimer = undefined;
  }
```

文件末尾的工具函数里加：

```ts
function sourceKey(input: { userId: string; workspace: string; sessionId?: string; source: string }): string {
  return `${input.userId}\0${input.workspace}\0${input.sessionId ?? ''}\0${input.source}`;
}
```

`runtime.ts` 在有执行器的分支里，`this.memoryService.recoverLayerSchedules();` 之后加一行（没有执行器的回退分支不加，那条路不跑模型）：

```ts
      this.memoryService.recoverPendingCaptures();
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd electron-agent; npx vitest run --project main electron/app/memoryService.test.ts electron/agentData`
预期：`memoryService.test.ts` 全部 PASS；`electron/agentData` 下只剩已知的 10 个失败（auditViewStore 4、jobCleanup 2、runtime 4，2026-10-06 已在基线确认）

运行：`cd extensions; npx vitest run memory`
预期：PASS

- [ ] **步骤 6：写决策记录**

`docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-cadence.md`：

```markdown
---
title: 记忆抽取按上游节奏：每 5 轮一批、预热 1→2→4→5、空闲 600 秒补抽、启动后补抽
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/app/memoryService.ts
  - electron-agent/electron/agentData/memoryStore.ts
  - electron-agent/electron/agentData/runtime.ts
supersedes:
superseded_by:
---

## 背景
我们每次 agent_end 都抽取一次。上游 pipeline-manager.ts 是每个会话累计 everyNConversations（默认 5）轮才抽，新会话阈值从 1 开始，每抽一次翻倍（预热）；没到阈值时空闲 l1IdleTimeoutSeconds（默认 600）秒补抽；关闭时冲掉剩余。2026-10-06 的交接单否决过 everyN 节流，理由是调用次数只占成本的 6%；但上游控制成本靠的是「节奏 + 每批 10+5 上限」两者配合，单看频率会漏掉后一半。上限已在 2026-10-07-memory-extract-window.md 落地，这里补上节奏。

## 决定
MemoryService 按来源（user、workspace、session、source）记录计数和阈值，都在内存里。一次 capture 算一轮；没到阈值时返回 extraction: 'deferred'，并重置空闲计时。到阈值就入队，计数清零、阈值翻倍直到 everyN。任务进行中到来的轮数照样计数，任务结束后够阈值就接着抽，不够就等空闲。启动 60 秒后对所有还有 pending 的来源各补抽一次，代替上游的关闭时冲掉。参数都可以通过 MemoryServiceOptions.extractCadence 覆盖，测试用 { everyN: 1, warmup: false } 保持旧行为。

## 放弃的方案
- 计数和阈值落库：重启后预热从 1 重新开始，只是早期多抽一次，代价很小，不值得为此加表。
- 退出时冲掉：Electron 退出时等不了模型返回，改为启动后补抽。
- 只做空闲补抽、不做 everyN：长会话一直在聊就一直不抽，pending 越积越大，最后被 10+5 窗口截掉。

## 后果
窗口外的消息被视为已处理，所以节奏越慢，单批里被跳过的早期对话越多。everyN 是 5 时，一批约 5 轮，正好落在 10 条新消息之内（每轮合并成 user + assistant 两条）。

如果某个来源的抽取每次都失败，每次启动会多试一次，不会无限重试。
```

运行：`node scripts/check-notes.mjs`
预期：`notes OK`

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/electron/app/memoryService.ts electron-agent/electron/app/memoryService.test.ts electron-agent/electron/agentData/memoryStore.ts electron-agent/electron/agentData/runtime.ts docs/decisions/electron-agent/agentdata/2026-10-07-memory-extract-cadence.md
git commit -m "feat(agentdata): 记忆抽取按上游节奏，每 5 轮一批、预热、空闲与启动补抽"
```

---

### 任务 6：去重候选按关键词召回

**文件：**
- 创建：`electron-agent/electron/app/memoryTerms.ts`
- 测试：`electron-agent/electron/app/memoryTerms.test.ts`
- 修改：`electron-agent/electron/agentData/memoryStore.ts`（新增 `searchL1ByTerms`）
- 修改：`electron-agent/electron/app/memoryDedup.ts:18-21`
- 测试：`electron-agent/electron/app/memoryDedup.test.ts`、`electron-agent/electron/app/memoryService.test.ts`
- 创建：`docs/decisions/electron-agent/agentdata/2026-10-07-memory-dedup-keyword-recall.md`

上游用向量 top-5。我们没有 embedding，先用中文二元组加英文词的重叠率，阈值 0.3。

- [ ] **步骤 1：编写失败的测试**

```ts
// electron-agent/electron/app/memoryTerms.test.ts
import { describe, expect, it } from 'vitest';
import { memoryTerms, sharedCount, termOverlap } from './memoryTerms';

describe('memoryTerms', () => {
  it('中文取二元组，英文取 3 字符以上的词，去停用词，转小写', () => {
    // 「团队决定用」切出 团队（停用）、队决、决定、定用；英文词排在中文之前。
    expect(memoryTerms('团队决定用 SQLite 存储')).toEqual(['sqlite', '队决', '决定', '定用', '存储']);
  });

  it('单字和两字以下英文不算', () => {
    expect(memoryTerms('a 的 is')).toEqual([]);
  });

  it('limit 截断', () => {
    expect(memoryTerms('一二三四五六七八', 3)).toHaveLength(3);
  });
});

describe('termOverlap / sharedCount', () => {
  it('按查询词计算命中比例和命中数', () => {
    const query = memoryTerms('团队决定用 SQLite 存储');
    const target = new Set(memoryTerms('存储层决定改用 SQLite'));
    expect(sharedCount(query, target)).toBe(3);
    expect(termOverlap(query, target)).toBe(0.6);
    expect(termOverlap([], target)).toBe(0);
  });
});
```

`memoryDedup.test.ts` 末尾加（文件顶部 import 里补上 `recallCandidates`、`DatabaseSync`、`MemoryStore`）：

```ts
describe('recallCandidates', () => {
  const scope = { userId: 'u', projectId: 'p', workspace: '/w' };
  const l1 = (content: string) => JSON.stringify({ content, type: 'work_method', priority: 80 });

  it('换个说法也能召回，按重叠率排序，低于 0.3 的不要', () => {
    const store = new MemoryStore(new DatabaseSync(':memory:'));
    // 查询 8 个二元组：close 命中 5 个（0.625），只共享「提交」的那条是 0.125，迁移那条是 0。
    const close = store.upsert(scope, { level: 1, content: l1('提交信息统一使用中文书写') });
    store.upsert(scope, { level: 1, content: l1('提交前先运行测试') });
    store.upsert(scope, { level: 1, content: l1('数据库迁移放在启动阶段') });
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: '提交信息统一使用中文' });
    const hits = recallCandidates(store, scope, '以后提交信息都使用中文', 5);
    expect(hits.map((hit) => hit.id)).toEqual([close.id]);
    expect(hits.every((hit) => hit.level === 1)).toBe(true);
  });

  it('只比对 L1 JSON 里的 content 字段，不被 type、priority 这些键干扰', () => {
    const store = new MemoryStore(new DatabaseSync(':memory:'));
    store.upsert(scope, { level: 1, content: l1('完全无关的事') });
    expect(recallCandidates(store, scope, 'work_method priority content', 5)).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run --project main electron/app/memoryTerms.test.ts electron/app/memoryDedup.test.ts`
预期：FAIL，`memoryTerms` 不存在；改写过的句子召回为空

- [ ] **步骤 3：实现**

```ts
// electron-agent/electron/app/memoryTerms.ts
/**
 * 记忆文本的关键词：中文按二元组切，英文取 3 字符以上的词。上游去重用向量召回，Pi 没有 embedding，
 * 先用词重叠近似；去重召回和 L2 预筛共用。
 */
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;
const WORD = /[a-z0-9][a-z0-9_.-]{2,}/g;
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'from', 'will', 'should', 'when',
  '用户', '团队', '进行', '使用', '一个', '这个', '需要', '可以', '我们', '已经', '以后',
]);

export function memoryTerms(text: string, limit = 32): string[] {
  const lower = text.toLowerCase();
  const terms = new Set<string>();
  for (const word of lower.match(WORD) ?? []) if (!STOP.has(word)) terms.add(word);
  for (const run of lower.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const pair = run.slice(i, i + 2);
      if (!STOP.has(pair)) terms.add(pair);
    }
  }
  return [...terms].slice(0, limit);
}

export function sharedCount(query: string[], target: Set<string>): number {
  let hits = 0;
  for (const term of query) if (target.has(term)) hits++;
  return hits;
}

export function termOverlap(query: string[], target: Set<string>): number {
  return query.length === 0 ? 0 : sharedCount(query, target) / query.length;
}
```

`memoryStore.ts`，在 `search` 之后加：

```ts
  /** 去重召回：L1 里命中任一关键词的记录，最近更新的在前。打分在调用方做。 */
  searchL1ByTerms(scope: MemoryScope, terms: string[], limit = 50): MemoryRecord[] {
    const used = terms.filter(Boolean).slice(0, 32);
    if (used.length === 0) return [];
    const rows = this.db.prepare(`SELECT id,level,content,source,project_id as sourceProjectId,memory_scope as scope,created_at as createdAt,updated_at as updatedAt
      FROM memories WHERE user_id=? AND level=1
        AND (memory_scope='global' OR project_id=? OR (? = 1 AND project_id IS NOT NULL))
        AND (${used.map(() => 'instr(lower(content), ?) > 0').join(' OR ')})
      ORDER BY updated_at DESC LIMIT ?`).all(
      scope.userId, projectId(scope), scope.includeOtherProjects ? 1 : 0, ...used, Math.max(1, Math.min(limit, 200)),
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRecord(row));
  }
```

`memoryDedup.ts:18-21` 替换为：

```ts
import { memoryTerms, termOverlap } from './memoryTerms';

/** 上游用向量 top-K（l1-dedup.ts）。Pi 没有 embedding，用关键词重叠近似：重叠率低于此值的不算候选。 */
export const MIN_RECALL_OVERLAP = 0.3;

function l1Text(content: string): string {
  try {
    const parsed = JSON.parse(content) as { content?: unknown };
    return typeof parsed.content === 'string' ? parsed.content : content;
  } catch {
    return content;
  }
}

export function recallCandidates(
  store: { searchL1ByTerms: (scope: MemoryScope, terms: string[], limit?: number) => MemoryRecord[] },
  scope: MemoryScope,
  content: string,
  topK = 5,
): MemoryRecord[] {
  const terms = memoryTerms(content);
  return store.searchL1ByTerms(scope, terms, 50)
    .map((hit) => ({ hit, score: termOverlap(terms, new Set(memoryTerms(l1Text(hit.content), 400))) }))
    .filter((entry) => entry.score >= MIN_RECALL_OVERLAP)
    .sort((a, b) => b.score - a.score || b.hit.updatedAt - a.hit.updatedAt)
    .slice(0, topK)
    .map((entry) => entry.hit);
}
```

（`import` 放在文件顶部，和原有 import 放在一起。）

`memoryService.ts` 不用改：它已经把 `this.options.store` 传给 `recallCandidates`，`MemoryStore` 现在有 `searchL1ByTerms` 了。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run --project main electron/app/memoryTerms.test.ts electron/app/memoryDedup.test.ts electron/app/memoryService.test.ts electron/agentData/memoryStore.browse.test.ts`
预期：PASS。`memoryService.test.ts` 里那几个去重测试用的是完全相同的句子，重叠率 1，照样触发。

- [ ] **步骤 5：写决策记录**

`docs/decisions/electron-agent/agentdata/2026-10-07-memory-dedup-keyword-recall.md`：

```markdown
---
title: 去重候选改为关键词重叠召回（中文二元组 + 英文词，阈值 0.3）
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/app/memoryTerms.ts
  - electron-agent/electron/app/memoryDedup.ts
  - electron-agent/electron/agentData/memoryStore.ts
supersedes:
superseded_by:
---

## 背景
recallCandidates 用整条新记忆做 lower(content) LIKE '%…%'，只有和旧记忆一字不差的才能命中，所以 memory_deduplicate 在库里一次都没执行过（0 条）。上游 l1-dedup.ts 用向量召回 top-5。

## 决定
新增 memoryTerms：中文按二元组、英文取 3 字符以上的词、去停用词。store.searchL1ByTerms 先用 instr 粗筛命中任一关键词的 L1，再在调用方按「查询词命中比例」打分，低于 0.3 的丢掉，取前 5。比对只看 L1 JSON 里的 content 字段。

## 放弃的方案
- 上 embedding：要配置 embedding provider、加向量表和索引，放到检索那份计划里一起做。
- SQLite FTS5：中文需要分词器，内置的 unicode61 按字切效果差；而且要新建虚表和触发器。
- 阈值 0.5：中文改写后二元组重合通常在 0.3 到 0.6 之间，0.5 会漏掉不少。

## 后果
去重任务会真正开始执行，每批有候选时多一次模型调用（输出上限 4096）。如果误召回导致模型频繁判 skip、丢掉新记忆，先把阈值调高再看。
```

运行：`node scripts/check-notes.mjs`
预期：`notes OK`

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/app/memoryTerms.ts electron-agent/electron/app/memoryTerms.test.ts electron-agent/electron/app/memoryDedup.ts electron-agent/electron/app/memoryDedup.test.ts electron-agent/electron/agentData/memoryStore.ts docs/decisions/electron-agent/agentdata/2026-10-07-memory-dedup-keyword-recall.md
git commit -m "fix(agentdata): 去重候选改为关键词重叠召回，让去重真正执行"
```

---

### 任务 7：L2 只内联相关场景正文

**文件：**
- 修改：`electron-agent/electron/app/memoryLayers.ts`（新增 `MAX_INLINE_SCENES`、`selectScenesToInline`）
- 修改：`electron-agent/electron/app/memoryService.ts`（`PendingLayer`、`enqueueScene`、`completeScene`、`layerFromTask`）
- 修改：`electron-agent/electron/agent/memoryLayerPrompts.ts:29、76-90、214`
- 测试：`electron-agent/electron/app/memoryLayers.test.ts`、`electron-agent/electron/app/memoryService.test.ts`、`electron-agent/electron/agent/memoryLayerPrompts.test.ts`
- 创建：`docs/decisions/electron-agent/agentdata/2026-10-07-memory-scene-inline-related.md`
- 修改：`docs/decisions/electron-agent/agentdata/2026-10-06-memory-scene-dedupe-raw-output-calibration.md`（顶部加墓碑）

规则：场景数 ≥ maxScenes − 1 时（橙色、红色预警，必须 MERGE），全部内联；否则按关键词重叠取最相关的 3 个内联，其余只出现在摘要清单里。模型只能 UPDATE / DELETE 正文已提供的场景，可以新建；落库时把对「已存在但没给正文」的场景的写入和删除丢掉。

- [ ] **步骤 1：编写失败的测试**

`memoryLayers.test.ts` 末尾加（import 里补上 `selectScenesToInline`、`MAX_INLINE_SCENES`）：

```ts
describe('selectScenesToInline', () => {
  const scenes = [
    { filename: '团队记忆-提交规范.md', summary: '提交信息用中文、提交前跑测试' },
    { filename: '团队记忆-数据库.md', summary: '迁移放启动阶段' },
    { filename: '团队记忆-前端.md', summary: '组件用 antd' },
    { filename: '团队记忆-发布.md', summary: '发布前打 tag' },
    { filename: '团队记忆-评审.md', summary: '评审要写放弃的方案' },
  ];

  it('按和新记忆的关键词重叠挑最相关的场景，最多 MAX_INLINE_SCENES 个，零分的不选', () => {
    const picked = selectScenesToInline(scenes, [{ content: '提交信息统一用中文', scene_name: '提交规范' }], 15);
    expect([...picked]).toEqual(['团队记忆-提交规范.md']);
    expect(MAX_INLINE_SCENES).toBe(3);
  });

  it('场景数到 maxScenes - 1 时全部内联，方便 MERGE', () => {
    expect(selectScenesToInline(scenes, [{ content: '无关' }], 6).size).toBe(5);
  });
});
```

`memoryService.test.ts` 末尾加：

```ts
describe('MemoryService L2 预筛', () => {
  const sceneBody = (summary: string) => `-----META-START-----\nsummary: ${summary}\n-----META-END-----\n正文 ${summary}`;

  it('只把相关场景的正文放进 memory_scene，其余只给文件名和摘要', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: sceneBody('提交信息用中文'), source: 'scene:团队记忆-提交规范.md' });
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: sceneBody('迁移放启动阶段'), source: 'scene:团队记忆-数据库.md' });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '提交信息统一用中文', type: 'work_method', priority: 80, scene_name: '提交规范' }] });
    const sceneTask = tasks.find((task) => task.kind === 'memory_scene')!;
    const input = sceneTask.input as { scenes: Array<{ filename: string; summary: string; content?: string }> };
    expect(input.scenes).toHaveLength(2);
    expect(input.scenes).toEqual(expect.arrayContaining([
      expect.objectContaining({ filename: '团队记忆-提交规范.md', content: expect.stringContaining('正文') }),
      { filename: '团队记忆-数据库.md', summary: '迁移放启动阶段' },
    ]));
    db.close();
  });

  it('落库时丢掉对没给正文的已有场景的写入和删除，新建和改相关场景照常', async () => {
    const { db, store, tasks, service } = setup();
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: sceneBody('提交信息用中文'), source: 'scene:团队记忆-提交规范.md' });
    store.upsert({ ...scope, scope: 'global' }, { level: 2, content: sceneBody('迁移放启动阶段'), source: 'scene:团队记忆-数据库.md' });
    const captured = await service.capture({ ...scope, source: 'session:s1', transcript: 'user: a', fingerprint: 'fp1' });
    service.completeExtraction(captured.taskId!, { l1: [{ content: '提交信息统一用中文', type: 'work_method', priority: 80 }] });
    const sceneTask = tasks.find((task) => task.kind === 'memory_scene')!;
    service.completeScene(sceneTask.id, { scenes: [
      { filename: '团队记忆-提交规范.md', action: 'write', content: sceneBody('提交信息用中文，已更新') },
      { filename: '团队记忆-数据库.md', action: 'delete' },
      { filename: '团队记忆-新场景.md', action: 'write', content: sceneBody('新的') },
    ] });
    const sources = db.prepare("SELECT source, content FROM memories WHERE level=2 ORDER BY source").all() as Array<{ source: string; content: string }>;
    expect(sources.map((row) => row.source)).toEqual(['scene:团队记忆-提交规范.md', 'scene:团队记忆-数据库.md', 'scene:团队记忆-新场景.md']);
    expect(sources[0].content).toContain('已更新');
    db.close();
  });
});
```

`memoryLayerPrompts.test.ts` 里 `'内联已有场景正文和 L1 列表'` 测试末尾加两行断言：

```ts
    expect(user).toContain('### 📁 与新记忆相关的场景正文');
    expect(user).toContain('其余场景只在上方摘要里');
```

并在同一个 describe 里加：

```ts
  it('没有相关场景时写明只能新建', () => {
    const user = formatSceneUserPrompt({ memoriesJson: '[]', sceneSummaries: '当前场景总数: 2', currentTimestamp: 't', existingScenes: [] });
    expect(user).toContain('（没有与新记忆相关的已有场景，只能新建）');
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent; npx vitest run --project main electron/app/memoryLayers.test.ts electron/app/memoryService.test.ts electron/agent/memoryLayerPrompts.test.ts`
预期：FAIL，`selectScenesToInline` 不存在；`memory_scene` 输入里所有场景都带正文；提示词文案不对

- [ ] **步骤 3：实现**

`memoryLayers.ts`：

```ts
import { memoryTerms, sharedCount } from './memoryTerms';

/** 主进程预筛：系统 worker 没有 read 工具（上游让模型按需读正文），只内联最相关的几个场景。 */
export const MAX_INLINE_SCENES = 3;

export function selectScenesToInline(
  scenes: Array<{ filename: string; summary: string }>,
  memories: Array<{ content: string; scene_name?: string }>,
  maxScenes: number,
): Set<string> {
  // 橙色 / 红色预警时必须 MERGE，模型得看到所有正文才能挑合并对象。
  if (scenes.length >= maxScenes - 1) return new Set(scenes.map((scene) => scene.filename));
  const query = memoryTerms(memories.map((memory) => `${memory.scene_name ?? ''} ${memory.content}`).join('\n'), 96);
  return new Set(scenes
    .map((scene) => ({ filename: scene.filename, score: sharedCount(query, new Set(memoryTerms(`${scene.filename} ${scene.summary}`, 400))) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename))
    .slice(0, MAX_INLINE_SCENES)
    .map((entry) => entry.filename));
}
```

`memoryService.ts`：

import 里从 `./memoryLayers` 多导入 `selectScenesToInline`。

`PendingLayer` 改为：

```ts
interface PendingLayer {
  scope: MemoryScope;
  source: string;
  /** memory_scene：正文已内联给模型的已有场景。undefined 表示旧任务，不做限制。 */
  editable?: Set<string>;
}
```

`enqueueScene` 开头构造 `scenes` 的那段替换为：

```ts
    const all = listGlobalLevel(this.options.store, scope.userId, 2).flatMap((row) => {
      const filename = sceneFilenameFromSource(row.source);
      return filename ? [{ filename, content: row.content, summary: sceneSummary(row.content) }] : [];
    });
    const editable = selectScenesToInline(all, l1, DEFAULT_MAX_SCENES);
    // 没内联的场景只留文件名和摘要；sceneUserPrompt 只渲染带 content 的条目。
    const scenes = all.map((scene) => editable.has(scene.filename) ? scene : { filename: scene.filename, summary: scene.summary });
    const taskId = randomUUID();
    this.pendingScene.set(taskId, { scope, source, editable });
```

（原来的 `const taskId = randomUUID();` 和 `this.pendingScene.set(taskId, { scope, source });` 两行删掉。）`sceneSummaries` 那一行改成基于 `all` 生成：

```ts
          sceneSummaries: `当前场景总数: ${all.length}\n${all.map((scene) => `- ${scene.filename}: ${scene.summary}`).join('\n')}`,
```

`completeScene` 里的

```ts
    const parsed = parseMemoryScene(output);
    const writes = applySceneDecisions(this.options.store, pending.scope, parsed.scenes);
```

改为：

```ts
    const parsed = parseMemoryScene(output);
    const writes = applySceneDecisions(this.options.store, pending.scope, this.allowedSceneDecisions(pending, parsed.scenes));
```

并在类里加：

```ts
  /** 模型没看到正文的已有场景不能写也不能删，否则会用残缺内容覆盖或误删。新建不受限。 */
  private allowedSceneDecisions(pending: PendingLayer, scenes: ParsedMemoryScene['scenes']): ParsedMemoryScene['scenes'] {
    if (!pending.editable) return scenes;
    const existing = new Set(listGlobalLevel(this.options.store, pending.scope.userId, 2).flatMap((row) => sceneFilenameFromSource(row.source) ?? []));
    return scenes.filter((scene) => !existing.has(scene.filename) || pending.editable!.has(scene.filename));
  }
```

`layerFromTask` 的返回值改为带上 `editable`（任务重启恢复时从输入里还原）：

```ts
    const editable = kind === 'memory_scene' && Array.isArray(input.scenes)
      ? new Set(input.scenes.flatMap((item) => (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string'
        && typeof (item as { filename?: unknown }).filename === 'string') ? [(item as { filename: string }).filename] : []))
      : undefined;
    return {
      scope: {
        userId: typeof input.userId === 'string' ? input.userId : 'local',
        projectId: task.sourceProjectId,
        workspace: typeof input.workspace === 'string' ? input.workspace : task.sourceProjectId,
        sessionId: typeof task.sourceSessionId === 'string' ? task.sourceSessionId : undefined,
      },
      source: input.source,
      ...(editable ? { editable } : {}),
    };
```

注意：数据库里的 `service_tasks.input` 存的是原始输入，带 `content` 的条目正是内联过的那些。`systemWorkerManager` 的 `sceneInputNotRendered` 只在拼 prompt 时去掉 `content`，不影响存储。

`memoryLayerPrompts.ts:29` 改为：

```ts
你没有文件工具，不能调用 read / write / edit。与新记忆相关的已有场景正文已内联在用户消息中；其余场景只给出文件名和摘要。只能 UPDATE / MERGE / DELETE 正文已提供的场景，其余已有场景不要出现在 scenes 中；需要时可以用新的 filename CREATE。
```

`formatSceneUserPrompt` 里：

```ts
  const bodies = input.existingScenes.length > 0
    ? input.existingScenes.map((scene) => `#### ${scene.filename}\n\`\`\`markdown\n${scene.content}\n\`\`\``).join('\n\n')
    : '（没有与新记忆相关的已有场景，只能新建）';
```

以及末尾的标题行：

```ts
### 📁 与新记忆相关的场景正文（只能修改或删除这些文件；其余场景只在上方摘要里）
${bodies}`;
```

`memoryLayerPrompts.ts:214` 改为：

```ts
将新记忆与 Existing Scene Blocks Summary 以及用户消息中已内联的相关场景正文进行比对。没有提供正文的场景视为与本批新记忆无关。
```

`systemWorkerManager.test.ts` 里 `'memory_scene 把系统提示放进 systemPrompt，用户侧内联场景正文'` 测试照旧通过（它传了 `content`）。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent; npx vitest run --project main electron/app electron/agent electron/pi`
预期：PASS（`electron/app` 下只剩已知的 `taskViewService.test.ts` 4 个失败；全量跑时 `gitService`、`piRuntimeService`、`subagentService` 等负载超时也可能出现，与本计划无关，单独复跑确认）

- [ ] **步骤 5：写决策记录**

`docs/decisions/electron-agent/agentdata/2026-10-07-memory-scene-inline-related.md`：

```markdown
---
title: L2 只内联与新记忆相关的场景正文（最多 3 个），没给正文的已有场景不许写也不许删
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/app/memoryLayers.ts
  - electron-agent/electron/app/memoryService.ts
  - electron-agent/electron/agent/memoryLayerPrompts.ts
supersedes: 2026-10-06-memory-scene-dedupe-raw-output-calibration.md
superseded_by:
---

## 背景
被推翻的笔记在「放弃的方案」里写过：只发相关场景「会改变上游模板『全部场景内联』的语义」。这句话是错的。上游 scene-extraction.ts:551-565 只给文件清单和摘要，正文由模型用 read 工具按需读；「全部内联」是 Pi 移植时因为系统 worker 没有工具而自己加的。2026-10-06 一次 L2 调用就用了 66,593 prompt token，占当天记忆 token 的 74%，而且场景越多越贵。

## 决定
主进程用关键词重叠（memoryTerms）挑出和本批新记忆最相关的最多 3 个场景内联正文，其余只出现在摘要清单里。场景数 ≥ maxScenes − 1 时（必须 MERGE）全部内联。提示词写明只能改或删正文已提供的场景，可以新建。completeScene 落库前丢掉对「已存在但没给正文」的场景的写入和删除；重启恢复的任务从存储的输入里还原哪些场景给过正文。

被推翻的旧笔记里，以下结论仍然有效：memory_scene 的 Input 行去掉已渲染字段（memories、sceneSummaries、currentTimestamp、场景 content）；service_tasks.raw_output 在解析失败时留下模型原文；用量统计直接读埋点 token，不做字节换算（同一中转对相同 prompt 报出的数相差近一倍，当天样本在 1.9 到 4.5 chars/token 之间）。

## 放弃的方案
- 给 L2 worker 开只读 read 工具，完全对齐上游：要让系统 worker 跑工具循环，改动大，用户选择了主进程预筛。
- 只发摘要、一律不内联正文：UPDATE 要输出完整正文，模型看不到原文就只能凭摘要重写，会丢内容。
- 按 L1 的 scene_name 精确匹配文件名：L1 的情境名是一句话（「用户在围绕英语时态学习」），和场景文件名对不上。

## 后果
预筛靠关键词，相关场景用词差别大时可能漏选，模型就会新建一个本该合并的场景；场景数逼近上限时会全部内联、强制 MERGE，把这类重复收回来。被丢掉的写入或删除没有记录，要排查时看 service_tasks.output 和 L2 的实际变化。
```

在 `2026-10-06-memory-scene-dedupe-raw-output-calibration.md` 的第一行（frontmatter 的 `---` 之前）加墓碑，正文不动：

```markdown
> 已过时 → 见 2026-10-07-memory-scene-inline-related.md
```

并把它 frontmatter 的 `status` 改为 `superseded`，`superseded_by` 填 `2026-10-07-memory-scene-inline-related.md`。

运行：`node scripts/check-notes.mjs`
预期：`notes OK`

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/app/memoryLayers.ts electron-agent/electron/app/memoryLayers.test.ts electron-agent/electron/app/memoryService.ts electron-agent/electron/app/memoryService.test.ts electron-agent/electron/agent/memoryLayerPrompts.ts electron-agent/electron/agent/memoryLayerPrompts.test.ts docs/decisions/electron-agent/agentdata/2026-10-07-memory-scene-inline-related.md docs/decisions/electron-agent/agentdata/2026-10-06-memory-scene-dedupe-raw-output-calibration.md
git commit -m "fix(agentdata): L2 只内联相关场景正文，未提供正文的场景不许改删"
```

---

### 任务 8：回放验证与实机验收

**文件：** 不改代码。临时脚本放在 `electron-agent/electron/app/__replay.test.ts`，跑完删除，不提交。

- [ ] **步骤 1：用历史任务回放新窗口**

写入临时文件：

```ts
// electron-agent/electron/app/__replay.test.ts
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { formatExtractionPrompt, messagesFromTranscript } from '../agent/memoryPrompts';
import { buildExtractionWindow } from './memoryExtractionWindow';

it('replay', () => {
  const db = new DatabaseSync(join(process.env.APPDATA!, 'electron-agent', 'agent-data.db'), { readOnly: true });
  const rows = db.prepare("SELECT input FROM service_tasks WHERE kind='memory_extract'").all() as Array<{ input: string }>;
  let before = 0; let after = 0; let maxAfter = 0; let empty = 0;
  for (const row of rows) {
    const input = JSON.parse(row.input) as { delta?: string; background?: string };
    const delta = input.delta ?? ''; const background = input.background ?? '';
    before += formatExtractionPrompt({ newMessages: messagesFromTranscript(delta), backgroundMessages: messagesFromTranscript(background) }).length;
    const window = buildExtractionWindow(delta, background, 0);
    if (window.newMessages.length === 0) { empty += 1; continue; }
    const prompt = formatExtractionPrompt(window).length;
    after += prompt; maxAfter = Math.max(maxAfter, prompt);
  }
  writeFileSync(join(process.env.TEMP!, 'replay.json'), JSON.stringify({ n: rows.length, empty, avgBefore: Math.round(before / rows.length), avgAfter: Math.round(after / Math.max(1, rows.length - empty)), maxAfter, ratio: +(after / before).toFixed(3) }));
});
```

运行：`cd electron-agent; npx vitest run --project main electron/app/__replay.test.ts; Get-Content $env:TEMP/replay.json; Remove-Item electron/app/__replay.test.ts`
预期：`ratio` 小于 0.1（工具输出占 94.7%，再加 10+5 上限），`maxAfter` 不超过约 60,000 字符（15 条 × 4000 字的理论上限）。把实际数字记下来，写进最终汇报。

- [ ] **步骤 2：全量相关测试**

运行：`cd electron-agent; npx vitest run --project main electron/app electron/agent electron/pi electron/agentData`
预期：除已知的 14 个基线失败（auditViewStore 4、taskViewService 4、jobCleanup 2、runtime 4）外全部 PASS

运行：`cd extensions; npx vitest run memory _shared/oneshot.test.ts prompt-metadata.test.ts`
预期：PASS

- [ ] **步骤 3：实机验收**

重启 GrenAgent（新代码和 `raw_output` 列都要重启才生效），确认 `MEMORY_AUTO_CAPTURE=1`、`MEMORY_EXTRACT=1`。在一个真实项目里新开会话，聊至少 8 轮有工作内容、带工具调用的对话（比如让它查代码、改文件），其中有一轮重复表达之前说过的约定（换个说法），用来触发去重。

运行：`node .pi/memory-check.cjs "<开始时间>"`
验收标准：
1. memory_extract 只在第 1、3、7 轮附近触发（预热），不是每轮都触发。
2. 每个 memory_extract 的 prompt token（input + cache_read + cache_write）在 10,000 以内。
3. 格式类失败（`invalid JSON` / `output is invalid`）明显少于 2026-10-06 的一半；失败时 `raw_output` 有值。
4. 出现至少一次 memory_deduplicate。
5. memory_scene 的 prompt token 明显低于 66,593，并且 L2 能正常写入或更新。
6. L1 有新增记录。

不达标的项把 `service_tasks` 里对应行的 `error`、`raw_output` 和 token 列贴出来，回到对应任务排查。
```
