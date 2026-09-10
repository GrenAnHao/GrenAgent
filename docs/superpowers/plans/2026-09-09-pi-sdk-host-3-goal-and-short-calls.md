# Pi SDK 宿主 · 第 3 份：Goal 每-jsonl 单持有者与短调用 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按 Q1-A 把 Goal 回合接到「每 jsonl 单持有者」模型（命中可见 session → 交互 handle + `origin:"goal"`；否则 `GoalHost` 独立打开该文件），并按 Q4 用 `ModelRuntime.completeSimple / streamSimple` 替换 system worker / oneshot / probe 的 sidecar。

**架构：** 不保留「Goal 与交互共享同一 jsonl 所以必须双 runtime」的旧断言——审查一.1 已推翻。`GoalHost` 只在 Goal 的 session **不是**当前可见 session 时存在。11 条 Goal 规则全部留在 `PiRuntimeService`。短调用走第 1 份的 `ModelRuntimeHost` 单例 + 新 `ShortCallQueue`；`describeModel()` 继续返回 `provider/id` 字符串。

**技术栈：** TypeScript、`@earendil-works/pi-coding-agent@0.85.1`、vitest（electron-agent / extensions）、`node --test` + tsx（cli）

**规格来源：** `docs/superpowers/specs/2026-09-09-electron-pi-sdk-host-design.md` 的「Goal 回合」「短调用」「验证 · Goal / 短调用」，以及 review 第四节「第 3 份」+ 附录 A 全部 11 条。

**依赖：** 第 1、2 份之后。ALS 消费点必须已就位，否则 Goal 回合的 `PI_HUMAN_ORIGIN_TOKEN='0'` 读不到。

---

## 前置知识（工作者必读）

### Q1-A：每 jsonl 单持有者（不是「共享文件所以双 runtime」）

旧计划写「Goal 与交互共享 session 文件，必须第二套 runtime」——**事实不成立**（review 一.1：Goal worker 从未和交互 worker 打开同一 jsonl）。定稿规格是：

| 情形 | 做法 |
| --- | --- |
| Goal 的 `sessionId` **等于**可见 session | 在交互 `WorkspaceHandle` 上 `prompt(..., 'goal')`。`GoalHost` 不开 handle。 |
| Goal 的 `sessionId` **不等于**可见 session | `GoalHost.open(workspace, sessionId, sessionPath)` 用 `SessionManager.open(sessionPath)` 打开该 jsonl。交互 handle 不持有该文件。 |
| 交互 `switchSession(S)` / `fork` 目标命中 Goal handle 的 S | 先 `goalHost.dispose`（abort 当前 Goal，走 `agent_end(aborted)` 失败上报），再切换。 |
| 同 handle 上 Goal 回合占用中，交互 `agent_prompt` 或 `SESSION_REPLACING_COMMANDS` 到达 | **交互优先**：`session.abort()` + `waitForIdle()`，再执行交互命令。 |

`AgentSessionRuntime` 同一时刻一个活跃 session——所以「同文件」只能有一个 handle。这是单持有者，不是「永远两套 runtime」。

### 11 条 Goal 规则（附录 A）全部留在 `PiRuntimeService`

不要把这些规则搬进 `GoalHost`。`GoalHost` 只负责「非可见 session 的 handle 生命周期」。

1. goal 源禁 `SESSION_REPLACING_COMMANDS`
2. 必须自报 `sessionId` / `sessionPath`，`readSessionIdentity` 校验，`SESSION_ID_MISMATCH`
3. 同 stateKey 有活跃回合则 `queueGoalTurnFromArgs`，`followUp` 拒绝
4. prompt 须带 `goalId / idempotencyKey / revision / nextRound`，`GOAL_TURN_IDEMPOTENCY_CONFLICT`
5. `get_state` 双重校验 `GOAL_WORKER_SESSION_MISMATCH`；goal `get_state` 不移动可见指针
6. 失败 / 退出时 `failQueuedGoalTurns`；`drainGoalTurn` 出错继续排空
7. prompt 固定 `goalPrompt(condition)`，profile `automation`
8. `migrateLegacyGoal` / `onSessionForked`
9. Goal UI 请求一律取消（第 1 份 adapter 已按 `isGoalTurn` 立即默认值；`rejectUiRequest` 改走 handle）
10. `bind / unbindGoalSession`、关闭后恢复 interactive 绑定、`ownsSession` 含 Goal handle
11. 身份由 ALS `origin:"goal"` + `PI_HUMAN_ORIGIN_TOKEN='0'`（`PI_GOAL_WORKER` 废止）

### Q4：`completeSimple`，不是第三套 `AgentSessionRuntime`

审查已否决旧计划里的假 API：

| 旧计划（错） | 真实（`oneshot.ts:59-84`、`model-runtime.d.ts:89-90`） |
| --- | --- |
| `runtime.complete({prompt, model: string, signal})` | `completeSimple(Model, { systemPrompt?, messages:[{role:'user', content, timestamp}] }, { signal })` |
| `result.text` | `content[]` 文本，复用 `formatNonStream` |
| `snapshot.models` / `displayName` | `getAvailableSnapshot(): readonly Model[]`，显示名 `name` |
| `resolveModelId(): string` | 模型身份是 `provider + id`；`describeModel()` 返回 `` `${provider}/${id}` `` |

`signal` 受支持（`ProviderRequestOptions.signal`）。`agentData/runtime.ts:63` 的 `wikiModelLabel: () => Promise<string>` 与 `expectedModel` **相等比较**依赖 `provider/id`，**禁止**改成 `{id, displayName}`。

三类任务 prompt（`systemWorkerManager.ts:12-17` 的 `KIND_INSTRUCTIONS`）只要求 JSON 或 Markdown 文本，不读文件、不调工具——语义变化已接受。实施时仍把这三个字符串原样搬进新队列，不要重写文案。

### 第 1 份已经就位、本份接着用的 API

- `WorkspaceHandle.prompt(text, options, origin)`、`currentTurnOrigin`、`session.abort` / `waitForIdle`
- `ModelRuntimeHost.ensure()` / `refresh()`（原地）
- `PiRuntimeService.turnConfig(workspace, cwd, origin)`、`runOnHandle`、`SessionOps`（本份删 `clientOps`）
- `AgentHostPort`（本份把 `Pick` 补上 `currentTurnOrigin` / `dispose` / `sessionFile` 相关）

### 测试命令

| 包 | 命令 |
| --- | --- |
| `electron-agent/` | `cd electron-agent && npx vitest run --project main` |
| 单文件 | `cd electron-agent && npx vitest run --project main electron/agent/goalHost.test.ts` |
| `extensions/` | `cd extensions && npx vitest run` |
| `cli/` | `cd cli && node --import tsx --test src/probe-models.test.ts` |

类型检查门槛（本份触及文件）：

```bash
cd electron-agent && npx tsc -p tsconfig.node.json --noEmit 2>&1 \
  | grep -E "electron/agent/(modelRuntimeHost|goalHost|createGoalHandle|shortCall|systemWorkerManager)\.ts|electron/app/(piRuntimeService|providerService|mcpPolicyService)\.ts|electron/main\.ts|cli/src/pi-sdk\.ts|extensions/_shared/oneshot\.ts|extensions/mcp/probe\.ts"
```

预期：空输出。

---

## 文件结构

**新建：**

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron/agent/goalHost.ts` | 仅管理「非可见 session」的 Goal handle。 |
| `electron-agent/electron/agent/goalHost.test.ts` | 同文件不重复开、驱逐、关 workspace。 |
| `electron-agent/electron/agent/createGoalHandle.ts` | `SessionManager.open(sessionPath)` 组装 Goal handle。 |
| `electron-agent/electron/agent/shortCall.ts` | 串行队列 + 超时 AbortSignal + `completeSimple` / `streamSimple` 封装。 |
| `electron-agent/electron/agent/shortCall.test.ts` | 串行、超时 abort、文本提取、流式行形状。 |

**修改：**

| 文件 | 改动 |
| --- | --- |
| `cli/src/pi-sdk.ts` | 再导出 `SettingsManager`、`ModelRegistry`。 |
| `electron-agent/electron/agent/modelRuntimeHost.ts` | `resolveDefaultModel` / `describeModel` / `completeSimple` / `streamSimple`。 |
| `electron-agent/electron/app/piRuntimeService.ts` | Goal 路由 + 交互优先 + 驱逐；`openGoalWorker` 改 `goalHost`；删 `clientOps`。 |
| `electron-agent/electron/app/piRuntimeService.test.ts` | Goal 用例改 stub handle / GoalHost。 |
| `electron-agent/electron/pi/systemWorkerManager.ts` | 内部改短调用；对外 `run` / `describeModel` / `taskState` / `close` 保留。 |
| `electron-agent/electron/pi/systemWorkerManager.test.ts` | 去掉 `createClient`，改注入 `complete` / `describe`。 |
| `electron-agent/electron/app/providerService.ts` | 不改对外 API；oneshot 由 main 注入进程内实现。 |
| `electron-agent/electron/app/mcpPolicyService.ts` | `probe` 改 `probeServer` + `writeToolsCacheEntry`。 |
| `electron-agent/electron/main.ts` | 建 `GoalHost`；`probeModels` / `oneshot` / `activeModel` / `wikiModelLabel` 接线。 |
| `extensions/_shared/oneshot.ts` | 抽出 `runOneshotWithRuntime`（不写 stdout）；保留 CLI `runOneshot`。 |
| `extensions/mcp/probe.ts` | 超时补 kill；`probeServer` 签名不变。 |

**本份不删：** `cli/src/runtime.ts` 的 `probe-*` / `oneshot` 子命令、`PiClient` / `manager`（第 5 份删）。主进程不再 spawn 它们。

---

## 任务 1：`pi-sdk.ts` 补导出 + `ModelRuntimeHost` 短调用

**文件：**
- 修改：`cli/src/pi-sdk.ts`
- 修改：`electron-agent/electron/agent/modelRuntimeHost.ts`
- 测试：`electron-agent/electron/agent/modelRuntimeHost.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `modelRuntimeHost.test.ts` 追加。`Model` 用最小结构（`provider` + `id` + 调用方不读的其余字段用 `as never`）：

```ts
import { formatNonStream } from '../../../extensions/_shared/oneshot.js';

const model = { provider: 'openai', id: 'gpt-x', name: 'GPT-X' } as never;

describe('ModelRuntimeHost 短调用', () => {
  it('completeSimple 传 Model 对象与 messages，文本取 content[]', async () => {
    const completeSimple = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '模型回答' }],
    });
    const create = vi.fn().mockResolvedValue({
      completeSimple,
      getAvailableSnapshot: () => [model],
      getModel: () => model,
      hasConfiguredAuth: () => true,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    await expect(host.completeSimple({ user: '问题' })).resolves.toBe('模型回答');
    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        messages: [expect.objectContaining({ role: 'user', content: '问题' })],
      }),
      expect.objectContaining({ signal: undefined }),
    );
  });

  it('completeSimple 把 signal 透传到第三参', async () => {
    const signal = new AbortController().signal;
    const completeSimple = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
    const create = vi.fn().mockResolvedValue({
      completeSimple, getAvailableSnapshot: () => [model], getModel: () => model, hasConfiguredAuth: () => true, refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    await host.completeSimple({ user: 'q', signal });
    expect(completeSimple.mock.calls[0][2]).toEqual({ signal });
  });

  it('describeModel 返回 provider/id，不是 displayName', async () => {
    const create = vi.fn().mockResolvedValue({
      completeSimple: vi.fn(),
      getAvailableSnapshot: () => [model],
      getModel: () => model,
      hasConfiguredAuth: () => true,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    await expect(host.describeModel()).resolves.toBe('openai/gpt-x');
  });

  it('settings 模型无鉴权时回退快照第一项', async () => {
    const fallback = { provider: 'anthropic', id: 'claude', name: 'Claude' } as never;
    const create = vi.fn().mockResolvedValue({
      completeSimple: vi.fn(),
      getAvailableSnapshot: () => [fallback],
      getModel: () => undefined,
      hasConfiguredAuth: () => false,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'missing' }) });
    await expect(host.describeModel()).resolves.toBe('anthropic/claude');
  });

  it('没有任何模型时 describeModel 抛 MODEL_UNAVAILABLE', async () => {
    const create = vi.fn().mockResolvedValue({
      completeSimple: vi.fn(),
      getAvailableSnapshot: () => [],
      getModel: () => undefined,
      hasConfiguredAuth: () => false,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'x', modelId: 'y' }) });
    await expect(host.describeModel()).rejects.toThrow('MODEL_UNAVAILABLE');
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/agent/modelRuntimeHost.test.ts`
预期：FAIL，`completeSimple` / `describeModel` 不存在。

- [ ] **步骤 3：`pi-sdk.ts` 补导出**

在第 1 份的导出列表上增加：

```ts
export {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ModelRegistry,
  createAgentSessionRuntime,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
```

`SettingsManager.create(cwd, agentDir)`、`getDefaultProvider()` / `getDefaultModel()` 以 `.d.ts` 为准。若 0.85.1 方法名不同，**以声明文件为准**改 `resolveSettings` 适配器，不要改 `describeModel` 的返回格式。

- [ ] **步骤 4：实现短调用方法**

`ModelRuntimeHostOptions` 增加：

```ts
  /** 读 userData 下的默认模型。生产：SettingsManager.create(userDataCwd, agentDir)。 */
  resolveSettings: () => Promise<{ provider: string; modelId: string }>;
```

`main.ts` 里第 1 份已 `new ModelRuntimeHost({ create })`，本份补：

```ts
resolveSettings: async () => {
  const { SettingsManager, getAgentDir } = await import('../../../cli/src/pi-sdk.js');
  const settings = SettingsManager.create(app.getPath('userData'), getAgentDir());
  return { provider: settings.getDefaultProvider(), modelId: settings.getDefaultModel() };
},
```

cwd 用 userData，与今日 system worker（`SWM:132`）一致。

`modelRuntimeHost.ts` 追加（`formatNonStream` 从 `oneshot.ts` import，不要重写提取逻辑）：

```ts
import { formatNonStream } from '../../../extensions/_shared/oneshot.js';
import type { ModelRuntime } from '../../../cli/src/pi-sdk.js';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;

export class ModelRuntimeHost {
  // ...ensure / refresh / peek 保持第 1 份

  async resolveDefaultModel(): Promise<Model> {
    const runtime = await this.ensure();
    const { provider, modelId } = await this.options.resolveSettings();
    const configured = runtime.getModel(provider, modelId);
    if (configured && runtime.hasConfiguredAuth(provider)) return configured;
    const first = runtime.getAvailableSnapshot()[0];
    if (!first) throw new Error('MODEL_UNAVAILABLE');
    return first as Model;
  }

  async describeModel(): Promise<string> {
    const model = await this.resolveDefaultModel();
    return `${model.provider}/${model.id}`;
  }

  async completeSimple(input: { user: string; systemPrompt?: string; model?: Model; signal?: AbortSignal }): Promise<string> {
    const runtime = await this.ensure();
    const model = input.model ?? await this.resolveDefaultModel();
    const msg = await runtime.completeSimple(
      model,
      { systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: input.user, timestamp: Date.now() }] },
      { signal: input.signal },
    );
    const formatted = formatNonStream(msg);
    if (!formatted.ok) throw new Error(formatted.error);
    return formatted.content;
  }

  async *streamSimple(input: { user: string; systemPrompt?: string; model?: Model; signal?: AbortSignal }): AsyncGenerator<{ type: 'delta' | 'done' | 'error'; text?: string; usage?: unknown; error?: string }> {
    const runtime = await this.ensure();
    const model = input.model ?? await this.resolveDefaultModel();
    for await (const ev of runtime.streamSimple(
      model,
      { systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: input.user, timestamp: Date.now() }] },
      { signal: input.signal },
    )) {
      if (ev.type === 'text_delta' && ev.delta) yield { type: 'delta', text: ev.delta };
      else if (ev.type === 'done') yield { type: 'done', usage: ev.message.usage };
      else if (ev.type === 'error') yield { type: 'error', usage: ev.error.usage, error: ev.error.errorMessage };
    }
  }
}
```

`formatNonStream` 今日已 export。构造 `ModelRuntimeHost` 的测试必须补 `resolveSettings`，否则现有 5 个用例的 `new ModelRuntimeHost({ create })` 会缺字段——给 `resolveSettings` 默认 `async () => ({ provider: '', modelId: '' })` 或更新那 5 个构造。

- [ ] **步骤 5：运行验证通过**

运行：`cd electron-agent && npx vitest run --project main electron/agent/modelRuntimeHost.test.ts`
预期：PASS。门槛 grep 空输出。

- [ ] **步骤 6：Commit**

```bash
git add cli/src/pi-sdk.ts electron-agent/electron/agent/modelRuntimeHost.ts electron-agent/electron/agent/modelRuntimeHost.test.ts electron-agent/electron/main.ts
git commit -m "feat(electron): add completeSimple and provider/id describeModel on ModelRuntimeHost"
```

---

## 任务 2：`GoalHost` + `createGoalHandle`

只为「Goal session ≠ 可见 session」服务。同文件情形**不得**进这里。

**文件：**
- 创建：`electron-agent/electron/agent/goalHost.ts`、`goalHost.test.ts`、`createGoalHandle.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it, vi } from 'vitest';
import { GoalHost } from './goalHost.js';

function fakeHandle(sessionPath: string, sessionId: string) {
  return {
    session: { sessionId, sessionFile: sessionPath, abort: vi.fn(async () => {}), waitForIdle: vi.fn(async () => {}) },
    dispose: vi.fn(async () => {}),
    currentTurnOrigin: 'goal' as const,
  };
}

describe('GoalHost', () => {
  it('同一 workspace+sessionId 只构造一次', async () => {
    const created: string[] = [];
    const host = new GoalHost({
      create: async (workspace, sessionId, sessionPath) => {
        created.push(`${workspace}\0${sessionId}\0${sessionPath}`);
        return fakeHandle(sessionPath, sessionId) as never;
      },
    });
    const a = await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    const b = await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it('findBySessionPath 按规范化路径查找', async () => {
    const host = new GoalHost({ create: async (_w, id, p) => fakeHandle(p, id) as never });
    await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    expect(host.findBySessionPath('D:/a/s1.jsonl')?.sessionId).toBe('s1');
    expect(host.findBySessionPath('D:/a/other.jsonl')).toBeUndefined();
  });

  it('dispose 后可以重新 open', async () => {
    const handle = fakeHandle('D:/a/s1.jsonl', 's1');
    const host = new GoalHost({ create: async () => handle as never });
    await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    await host.dispose('D:/a', 's1');
    expect(handle.dispose).toHaveBeenCalled();
    const again = await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    expect(again).not.toBe(handle);
  });

  it('disposeAllForWorkspace 只关该项目', async () => {
    const a = fakeHandle('D:/a/s1.jsonl', 's1');
    const b = fakeHandle('D:/b/s2.jsonl', 's2');
    const host = new GoalHost({
      create: async (workspace) => (workspace === 'D:/a' ? a : b) as never,
    });
    await host.open('D:/a', 's1', 'D:/a/s1.jsonl');
    await host.open('D:/b', 's2', 'D:/b/s2.jsonl');
    await host.disposeAllForWorkspace('D:/a');
    expect(a.dispose).toHaveBeenCalled();
    expect(b.dispose).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/agent/goalHost.test.ts`
预期：FAIL，无法解析。

- [ ] **步骤 3：编写 `goalHost.ts`**

```ts
import type { WorkspaceHandle } from './workspaceHandle.js';

export interface GoalHostOptions {
  create: (workspace: string, sessionId: string, sessionPath: string) => Promise<WorkspaceHandle>;
}

function key(workspace: string, sessionId: string): string {
  return `${workspace}\0${sessionId}`;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export class GoalHost {
  private readonly handles = new Map<string, WorkspaceHandle>();

  constructor(private readonly options: GoalHostOptions) {}

  async open(workspace: string, sessionId: string, sessionPath: string): Promise<WorkspaceHandle> {
    const k = key(workspace, sessionId);
    const existing = this.handles.get(k);
    if (existing) return existing;
    const handle = await this.options.create(workspace, sessionId, sessionPath);
    this.handles.set(k, handle);
    return handle;
  }

  get(workspace: string, sessionId: string): WorkspaceHandle | undefined {
    return this.handles.get(key(workspace, sessionId));
  }

  findBySessionPath(sessionPath: string): { workspace: string; sessionId: string; handle: WorkspaceHandle } | undefined {
    const want = normalizePath(sessionPath);
    for (const [k, handle] of this.handles) {
      const file = handle.session.sessionFile;
      if (typeof file === 'string' && normalizePath(file) === want) {
        const sep = k.indexOf('\0');
        return { workspace: k.slice(0, sep), sessionId: k.slice(sep + 1), handle };
      }
    }
    return undefined;
  }

  async dispose(workspace: string, sessionId: string): Promise<void> {
    const k = key(workspace, sessionId);
    const handle = this.handles.get(k);
    if (!handle) return;
    this.handles.delete(k);
    await handle.dispose();
  }

  async disposeAllForWorkspace(workspace: string): Promise<void> {
    const prefix = `${workspace}\0`;
    const ids = [...this.handles.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    for (const sessionId of ids) await this.dispose(workspace, sessionId);
  }
}
```

- [ ] **步骤 4：编写 `createGoalHandle.ts`**

```ts
import { createAgentSessionRuntime, getAgentDir, SessionManager, type ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { makeGrenRuntimeFactory } from '../../../cli/src/gren-runtime.js';
import { runInWorkspace } from '../../../extensions/_shared/workspace-context.js';
import { WorkspaceHandle, type WorkspaceHandleOptions } from './workspaceHandle.js';

export interface CreateGoalHandleInput {
  workspace: string;
  cwd: string;
  sessionId: string;
  sessionPath: string;
  modelRuntime: ModelRuntime;
  allowedExtensionsJson: string;
  resolveConfig: WorkspaceHandleOptions['resolveConfig'];
  onEvent: WorkspaceHandleOptions['onEvent'];
  onFatal: WorkspaceHandleOptions['onFatal'];
  onDispose?: WorkspaceHandleOptions['onDispose'];
}

export async function createGoalHandle(input: CreateGoalHandleInput): Promise<WorkspaceHandle> {
  const config = await input.resolveConfig('goal');
  const runtime = await runInWorkspace(
    { origin: 'goal', workspace: input.workspace, cwd: input.cwd, config },
    () => createAgentSessionRuntime(
      makeGrenRuntimeFactory({ modelRuntime: input.modelRuntime, allowedExtensionsJson: input.allowedExtensionsJson }),
      { cwd: input.cwd, agentDir: getAgentDir(), sessionManager: SessionManager.open(input.sessionPath) },
    ),
  );
  const handle = new WorkspaceHandle({
    workspace: input.workspace,
    cwd: input.cwd,
    runtime,
    resolveConfig: input.resolveConfig,
    emitUiRequest: () => { /* Goal UI 不广播；adapter 在 isGoalTurn 时已立即默认值 */ },
    onEvent: input.onEvent,
    onFatal: input.onFatal,
    onDispose: input.onDispose,
  });
  await handle.start();
  if (handle.session.sessionId && handle.session.sessionId !== input.sessionId) {
    await handle.dispose();
    throw new Error('GOAL_WORKER_SESSION_MISMATCH');
  }
  return handle;
}
```

`SessionManager.open` 以 SDK 声明为准。若 0.85.1 导出的是静态方法但名字不同（例如 `SessionManager.fromPath`），只改这一处调用，测试与规格用词仍按 `open(sessionPath)`。

`WorkspaceHandle.start()` 会 `bindExtensions`（emit `session_start`）。Goal handle 的 UI 请求被 adapter 吞掉。事件 `source` 由 `prompt(..., 'goal')` 的 `currentTurnOrigin` 决定。

- [ ] **步骤 5：运行验证通过**

运行：`cd electron-agent && npx vitest run --project main electron/agent/goalHost.test.ts`
预期：PASS。门槛 grep 含 `createGoalHandle.ts` 空输出。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/electron/agent/goalHost.ts electron-agent/electron/agent/goalHost.test.ts electron-agent/electron/agent/createGoalHandle.ts
git commit -m "feat(electron): add GoalHost for non-visible session files"
```

---

## 任务 3：`PiRuntimeService` Goal 路由 + 交互优先 + 驱逐

本任务是规格「Goal 回合」的核心。`send()` 里 11 条规则的**判定顺序不要改**（禁 SESSION_REPLACING → 鉴权 → 排队 → metadata 校验 → prepareTurn），只把「打开 client」换成「解析 handle」。

**文件：**
- 修改：`electron-agent/electron/app/piRuntimeService.ts`
- 测试：`electron-agent/electron/app/piRuntimeService.test.ts`

- [ ] **步骤 1：扩端口类型**

第 1 份的 `WorkspaceHandlePort` 补：

```ts
export type WorkspaceHandlePort = Pick<WorkspaceHandle,
  'session' | 'prompt' | 'getState' | 'getCommands' | 'newSession' | 'switchSession' | 'fork' | 'ui' | 'currentTurnOrigin' | 'dispose'>;

export interface GoalHostPort {
  open(workspace: string, sessionId: string, sessionPath: string): Promise<WorkspaceHandlePort>;
  get(workspace: string, sessionId: string): WorkspaceHandlePort | undefined;
  findBySessionPath(sessionPath: string): { workspace: string; sessionId: string; handle: WorkspaceHandlePort } | undefined;
  dispose(workspace: string, sessionId: string): Promise<void>;
  disposeAllForWorkspace(workspace: string): Promise<void>;
}
```

`PiRuntimeOptions` 增加 `goalHost: GoalHostPort`。`runOnHandle` 的 `agent_prompt` / `agent_set_mode` 第三参不要写死 `'main'`——改成调用方传入的 origin：

```ts
  private async runOnHandle(
    handle: WorkspaceHandlePort,
    command: PiCommand,
    args: Record<string, unknown>,
    origin: 'main' | 'goal',
  ): Promise<unknown> {
```

所有 `handle.prompt(..., 'main')` 改为 `origin`。Goal 路径传 `'goal'`。

删除 `clientOps`。`SessionOps` 只剩 `handleOps`；或直接内联 `runOnHandle`。过渡注释改成「第 3 份已删除 client 接缝」。

- [ ] **步骤 2：编写失败的测试**

在 `piRuntimeService.test.ts` 用 handle stub（不要再 `manager.openGoalWorker`）。关键用例（名称必须覆盖规格验证节）：

```ts
function handleStub(over: Partial<WorkspaceHandlePort> = {}): WorkspaceHandlePort {
  return {
    session: {
      sessionId: 'visible',
      sessionFile: 'D:/a/visible.jsonl',
      abort: vi.fn(async () => {}),
      waitForIdle: vi.fn(async () => {}),
      steer: vi.fn(), followUp: vi.fn(), setModel: vi.fn(), /* 其余 runOnHandle 用到的方法按需 vi.fn */
    } as never,
    prompt: vi.fn(async () => {}),
    getState: vi.fn(() => ({ sessionId: 'visible', sessionFile: 'D:/a/visible.jsonl', model: { provider: 'x', id: 'y' } })),
    getCommands: vi.fn(() => ({ commands: [] })),
    newSession: vi.fn(), switchSession: vi.fn(), fork: vi.fn(),
    ui: { respond: vi.fn(), context: {} as never, cancelAll: vi.fn() },
    currentTurnOrigin: 'main',
    dispose: vi.fn(async () => {}),
    ...over,
  } as WorkspaceHandlePort;
}

it('Goal session = 可见 session：走交互 handle，GoalHost.open 不被调用', async () => {
  const interactive = handleStub({ currentTurnOrigin: 'main' });
  const goalOpen = vi.fn();
  const service = makeService({
    agentHost: { open: async () => interactive, get: () => interactive, close: async () => {} },
    goalHost: { open: goalOpen, get: () => undefined, findBySessionPath: () => undefined, dispose: async () => {}, disposeAllForWorkspace: async () => {} },
  });
  await service.send('D:/a', 'agent_prompt', {
    source: 'goal', sessionId: 'visible', sessionPath: 'D:/a/visible.jsonl',
    message: 'x', goalId: 'g', idempotencyKey: 'k', revision: 1, nextRound: 1, turnId: 't1',
  });
  expect(goalOpen).not.toHaveBeenCalled();
  expect(interactive.prompt).toHaveBeenCalledWith(expect.stringContaining('Goal condition'), expect.anything(), 'goal');
});

it('Goal session ≠ 可见 session：GoalHost.open 独立文件', async () => {
  const interactive = handleStub();
  const goal = handleStub({ session: { sessionId: 'other', sessionFile: 'D:/a/other.jsonl' } as never });
  const goalOpen = vi.fn(async () => goal);
  const service = makeService({
    agentHost: { open: async () => interactive, get: () => interactive, close: async () => {} },
    goalHost: { open: goalOpen, get: () => undefined, findBySessionPath: () => undefined, dispose: async () => {}, disposeAllForWorkspace: async () => {} },
  });
  await service.send('D:/a', 'agent_prompt', {
    source: 'goal', sessionId: 'other', sessionPath: 'D:/a/other.jsonl',
    message: 'x', goalId: 'g', idempotencyKey: 'k', revision: 1, nextRound: 1, turnId: 't1',
  });
  expect(goalOpen).toHaveBeenCalledWith('D:/a', 'other', 'D:/a/other.jsonl');
  expect(goal.prompt).toHaveBeenCalled();
  expect(interactive.prompt).not.toHaveBeenCalled();
});

it('同 handle 上 Goal 回合中交互 prompt 先 abort Goal', async () => {
  const abort = vi.fn(async () => {});
  const waitForIdle = vi.fn(async () => {});
  const interactive = handleStub({
    currentTurnOrigin: 'goal',
    session: { sessionId: 'visible', sessionFile: 'D:/a/visible.jsonl', abort, waitForIdle } as never,
  });
  const service = makeService({
    agentHost: { open: async () => interactive, get: () => interactive, close: async () => {} },
    goalHost: emptyGoalHost(),
  });
  await service.send('D:/a', 'agent_prompt', { message: 'user' });
  expect(abort).toHaveBeenCalled();
  expect(waitForIdle).toHaveBeenCalled();
  expect(interactive.prompt).toHaveBeenCalledWith('user', expect.anything(), 'main');
});

it('switchSession 命中 Goal handle 持有的文件时先 dispose', async () => {
  const goal = handleStub({ session: { sessionId: 'g1', sessionFile: 'D:/a/g1.jsonl' } as never });
  const dispose = vi.fn(async () => {});
  const interactive = handleStub();
  const service = makeService({
    agentHost: { open: async () => interactive, get: () => interactive, close: async () => {} },
    goalHost: {
      open: async () => goal,
      get: () => goal,
      findBySessionPath: (p) => p.includes('g1') ? { workspace: 'D:/a', sessionId: 'g1', handle: goal } : undefined,
      dispose,
      disposeAllForWorkspace: async () => {},
    },
  });
  await service.send('D:/a', 'agent_switch_session', { sessionPath: 'D:/a/g1.jsonl' });
  expect(dispose).toHaveBeenCalledWith('D:/a', 'g1');
  expect(interactive.switchSession).toHaveBeenCalled();
});
```

`makeService` 按第 1 份改造后的 options 补 `goalHost`。既有 Goal 排队 / 幂等 / `SESSION_ID_MISMATCH` 用例保留，只把 `manager.openGoalWorker` 断言改成 handle stub。

- [ ] **步骤 3：运行测试验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/app/piRuntimeService.test.ts`
预期：FAIL，Goal 仍走 sidecar client 或 `prompt` 第三参仍是 `'main'`。

- [ ] **步骤 4：改 `send()` 解析 handle**

在第 1 份的 `SessionOps` 分支处替换为：

```ts
    if (session.source !== 'goal') {
      await this.preemptGoalTurn(workspace, command, args);
    }
    const handle = await this.resolveHandle(workspace, session);
    // 此后所有 ops.run / ops.getState 改为 runOnHandle(handle, command, args, session.source === 'goal' ? 'goal' : 'main')
    // get_state 在 session.source === 'goal' 时仍不调用 refreshCurrentSession（今日 :338）
```

`resolveHandle`：

```ts
  private async resolveHandle(workspace: string, session: SessionContext): Promise<WorkspaceHandlePort> {
    const interactive = this.options.agentHost.get(workspace) ?? await this.openInteractive(workspace);
    if (session.source !== 'goal') return interactive;
    if (!session.sessionId || !session.sessionPath) throw new Error('INVALID_SESSION_IDENTITY');
    const visibleId = interactive.session.sessionId;
    if (visibleId && visibleId === session.sessionId) return interactive;
    return this.options.goalHost.open(workspace, session.sessionId, session.sessionPath);
  }

  private async preemptGoalTurn(workspace: string, command: string, args: Record<string, unknown>): Promise<void> {
    const interactive = this.options.agentHost.get(workspace);
    if (interactive && (command === 'agent_prompt' || SESSION_REPLACING_COMMANDS.includes(command)) && interactive.currentTurnOrigin === 'goal') {
      await interactive.session.abort();
      await interactive.session.waitForIdle();
    }
    if (!SESSION_REPLACING_COMMANDS.includes(command)) return;
    const target = command === 'agent_switch_session' && typeof args.sessionPath === 'string'
      ? args.sessionPath
      : undefined;
    if (!target) return;
    const held = this.options.goalHost.findBySessionPath(target);
    if (held) await this.options.goalHost.dispose(held.workspace, held.sessionId);
  }
```

`openGoalWorker` 改为：校验身份后 `goalHost.open`（不再 `manager.open`）。`closeGoalWorker` 改为 `goalHost.dispose` + 今日的 `unbindGoalSession` / 恢复 interactive 绑定。`closeWorkspace` 的 `goalSessions` 循环改 `goalHost.disposeAllForWorkspace`。

`rejectUiRequest`：

```ts
  async rejectUiRequest(workspace: string, metadata: PiEventMeta | undefined, requestId: string): Promise<void> {
    if (!requestId.trim()) return;
    const handle = metadata?.source === 'goal' && metadata.sessionId
      ? this.options.goalHost.get(workspace, metadata.sessionId) ?? this.options.agentHost.get(workspace)
      : this.options.agentHost.get(workspace);
    handle?.ui.respond(requestId, { type: 'extension_ui_response', id: requestId, cancelled: true });
  }
```

`respondUi` 走 `agentHost.get(workspace)?.ui.respond`。

`ownsSession`：在今日 `goalWorkers` 判断处改为 `goalHost.get(workspace, sessionId)`。

`refreshModelRegistry`：只 `await this.options.modelRuntimeHost.refresh()`，删掉 `manager.all()` 的 `switch_session` 循环（共享 runtime 已原地刷新）。

`runOnHandle('agent_prompt')` 对 Goal 必须使用 `goalPrompt` 文案吗？**不。** `dispatchGoalTurn` 已经把 `message` 设成 `goalPrompt(condition)`。`runOnHandle` 只转发 `readInput(args)`。

- [ ] **步骤 5：main.ts 接线**

在第 1 份的 `AgentHost` 旁：

```ts
const goalHost = new GoalHost({
  create: (workspace, sessionId, sessionPath) => createGoalHandle({
    workspace,
    cwd: workspace,
    sessionId,
    sessionPath,
    modelRuntime: modelRuntimeHost.peek() ?? await modelRuntimeHost.ensure(),
    allowedExtensionsJson: JSON.stringify(allowedPluginIds()),
    resolveConfig: (origin) => piRuntime!.turnConfig(workspace, workspace, origin),
    onEvent: (event, meta) => {
      const envelope = piRuntime!.eventEnvelope(workspace, event, meta);
      broadcastPiEvent('pi://event', envelope);
      void piRuntime!.handlePiEvent(workspace, event, meta);
    },
    onFatal: (error) => {
      void goalHost.dispose(workspace, sessionId);
      broadcastPiEvent('pi://exit', { workspace, code: 1, sessionId, source: 'goal' });
      void piRuntime!.handlePiExit(workspace, 1, { sessionId, source: 'goal' });
    },
  }),
});
```

`create` 是 async 工厂，上面 `await` 不能写在对象字面量里——写成 `async (workspace, sessionId, sessionPath) => { const modelRuntime = await modelRuntimeHost.ensure(); return createGoalHandle({...}); }`。

`PiRuntimeService` 构造补 `goalHost`。`closeWorkspace` / `before-quit` 已有 `agentHost.closeAll()`，再加 `goalHost.disposeAllForWorkspace` 由 `closeWorkspace` 间接触发即可；`before-quit` 对每个 open workspace 调 `closeWorkspace` 或给 GoalHost 加 `closeAll`（本份加 `disposeAllForWorkspace` 足够，quit 走现有关项目循环）。

- [ ] **步骤 6：运行验证通过**

运行：`cd electron-agent && npx vitest run --project main electron/app/piRuntimeService.test.ts`
预期：PASS。既有 11 条规则用例全绿。

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/app/piRuntimeService.test.ts electron-agent/electron/main.ts
git commit -m "feat(electron): route Goal turns onto a single session-file holder"
```

---

## 任务 4：`ShortCallQueue` + 改写 `SystemWorkerManager`

保留 `SystemWorkerManager` 的对外 API（`run` / `describeModel` / `taskState` / `close`），因为 `main.ts:122`、`goalJudge.ts`、既有测试都依赖它。内部不再 spawn sidecar。

**文件：**
- 创建：`electron-agent/electron/agent/shortCall.ts`、`shortCall.test.ts`
- 修改：`electron-agent/electron/pi/systemWorkerManager.ts`、`systemWorkerManager.test.ts`

- [ ] **步骤 1：编写 `ShortCallQueue` 失败测试**

```ts
import { describe, expect, it, vi } from 'vitest';
import { ShortCallQueue } from './shortCall.js';

describe('ShortCallQueue', () => {
  it('串行执行，第二个等第一个结束', async () => {
    const order: string[] = [];
    const q = new ShortCallQueue();
    let release!: () => void;
    const first = q.run(async () => {
      order.push('a-start');
      await new Promise<void>((r) => { release = r; });
      order.push('a-end');
      return 1;
    });
    const second = q.run(async () => {
      order.push('b');
      return 2;
    });
    await Promise.resolve();
    expect(order).toEqual(['a-start']);
    release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('超时 abort 后队列继续', async () => {
    const q = new ShortCallQueue();
    const sawAbort: boolean[] = [];
    await expect(q.run(async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => { sawAbort.push(true); reject(new Error('aborted')); });
      });
    }, 20)).rejects.toThrow('aborted');
    await expect(q.run(async () => 'ok', 1000)).resolves.toBe('ok');
    expect(sawAbort).toEqual([true]);
  });
});
```

- [ ] **步骤 2：运行验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/agent/shortCall.test.ts`
预期：FAIL。

- [ ] **步骤 3：实现队列**

```ts
export class ShortCallQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const run = this.tail.then(() => this.withTimeout(fn, timeoutMs));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const KIND_TIMEOUT_MS: Record<string, number> = {
  goal_judge: 60_000,
  wiki_page_generate: 60_000,
};

export function timeoutForKind(kind: string, fallback = 30_000): number {
  return KIND_TIMEOUT_MS[kind] ?? fallback;
}
```

默认 30s = 今日 `memory_extract`。

- [ ] **步骤 4：改写 `SystemWorkerManager`**

`WorkerOptions` 换成：

```ts
interface WorkerOptions {
  describeModel: () => Promise<string>;
  complete: (input: { user: string; systemPrompt?: string; signal?: AbortSignal }) => Promise<string>;
  maxAttempts?: number;
  taskTimeoutMs?: number;
}
```

删除 `processCommand` / `createClient` / `PiClient` / `idleTimeout` / `env`。`KIND_INSTRUCTIONS` 与 `serviceTaskPrompt` **逐字保留**（`systemWorkerManager.ts:12-17,196-199`）。`parseWorkerOutput` 改为解析 `complete` 返回的字符串：

```ts
  run(task: SystemWorkerTask): Promise<unknown> {
    const run = this.tail.run(async (signal) => this.runTask(task, signal), timeoutForKind(task.kind, this.options.taskTimeoutMs));
    return run;
  }

  describeModel(): Promise<string> {
    return this.tail.run(async () => {
      try { return await this.options.describeModel(); }
      catch { throw new Error('MODEL_UNAVAILABLE'); }
    }, this.options.taskTimeoutMs ?? 30_000);
  }

  private async runTask(task: SystemWorkerTask, signal: AbortSignal): Promise<unknown> {
    // 重试循环保持今日 maxAttempts 语义
    if (task.kind === 'wiki_page_generate' && isRecord(task.input) && task.input.expectedModel !== undefined) {
      const model = await this.options.describeModel();
      if (model !== task.input.expectedModel) throw new Error('MODEL_CHANGED');
    }
    const text = await this.options.complete({ user: serviceTaskPrompt(task), signal });
    return parseCompleteOutput(text, task.kind);
  }
```

`parseCompleteOutput`：从今日 `parseWorkerOutput` 抽出「文本 / JSON」分支（`TEXT_OUTPUT_KINDS` 含 `wiki_page_generate`），输入改为字符串而不是 `event.messages`。

`main.ts` 的 `new SystemWorkerManager({ processCommand, env, createClient })` 改为：

```ts
const shortCalls = new ShortCallQueue(); // 若 SWM 内已持有队列，不要套两层。SWM 内部 new ShortCallQueue()。
const systemWorker = new SystemWorkerManager({
  describeModel: () => modelRuntimeHost.describeModel(),
  complete: (input) => modelRuntimeHost.completeSimple(input),
});
```

不要两层队列：`describeModel` 与 `run` 必须共享 SWM 内部那一条 `tail`（今日就是这样，保证 `expectedModel` 检查与任务串行）。

- [ ] **步骤 5：重写 `systemWorkerManager.test.ts`**

删除所有 `createClient` / `PiClient` 用例。用注入函数锁这些行为（从旧文件平移断言，不要丢）：

```ts
it('describeModel 返回 provider/id', async () => {
  const manager = new SystemWorkerManager({ describeModel: async () => 'test-provider/test-model', complete: async () => '' });
  await expect(manager.describeModel()).resolves.toBe('test-provider/test-model');
});

it('describeModel 失败统一成 MODEL_UNAVAILABLE', async () => {
  const manager = new SystemWorkerManager({ describeModel: async () => { throw new Error('nope'); }, complete: async () => '' });
  await expect(manager.describeModel()).rejects.toThrow('MODEL_UNAVAILABLE');
});

it('wiki_page_generate 在执行前比对 expectedModel', async () => {
  const complete = vi.fn(async () => '# page');
  const manager = new SystemWorkerManager({
    describeModel: async () => 'openai/gpt-x',
    complete,
  });
  await expect(manager.run({ id: '1', kind: 'wiki_page_generate', input: { expectedModel: 'anthropic/other' } })).rejects.toThrow('MODEL_CHANGED');
  expect(complete).not.toHaveBeenCalled();
});

it('goal_judge 超时 abort', async () => {
  const manager = new SystemWorkerManager({
    describeModel: async () => 'x/y',
    complete: ({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    taskTimeoutMs: 20,
  });
  await expect(manager.run({ id: '1', kind: 'goal_judge', input: {} })).rejects.toThrow('aborted');
});

it('任务串行：第二个 complete 在第一个结束后才调用', async () => {
  const order: string[] = [];
  let release!: () => void;
  const manager = new SystemWorkerManager({
    describeModel: async () => 'x/y',
    complete: async ({ user }) => {
      if (user.includes('first')) {
        order.push('first');
        await new Promise<void>((r) => { release = r; });
        return '{"ok":true}';
      }
      order.push('second');
      return '{"ok":true}';
    },
  });
  const a = manager.run({ id: 'a', kind: 'memory_extract', input: { tag: 'first' } });
  const b = manager.run({ id: 'b', kind: 'memory_extract', input: { tag: 'second' } });
  await Promise.resolve();
  expect(order).toEqual(['first']);
  release();
  await a; await b;
  expect(order).toEqual(['first', 'second']);
});
```

`serviceTaskPrompt` 把 `input` JSON.stringify 进 user 文本，所以用 `user.includes('first')` 区分。`memory_extract` 走 JSON.parse；返回 `'{"ok":true}'`。

核对三个 prompt 构造器：打开 `systemWorkerManager.ts` 的 `KIND_INSTRUCTIONS`，确认没有「读文件 / 调工具」字样。有则把文件内容显式塞进 `task.input`（本仓库这三句没有）。

- [ ] **步骤 6：运行验证通过**

运行：`cd electron-agent && npx vitest run --project main electron/agent/shortCall.test.ts electron/pi/systemWorkerManager.test.ts`
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/electron/agent/shortCall.ts electron-agent/electron/agent/shortCall.test.ts electron-agent/electron/pi/systemWorkerManager.ts electron-agent/electron/pi/systemWorkerManager.test.ts electron-agent/electron/main.ts
git commit -m "feat(electron): run system worker tasks via completeSimple on a serial queue"
```

---

## 任务 5：oneshot 进程内化

`ProviderService.fixMermaid` / `diagnose` 的 `oneshot(request, onLine)` 回调形状不变。只换 main 注入。

**文件：**
- 修改：`extensions/_shared/oneshot.ts`、`oneshot.test.ts`（若无则新建）
- 修改：`electron-agent/electron/main.ts`
- 测试：`electron-agent/electron/app/providerService.test.ts`（不断言 spawn）

- [ ] **步骤 1：抽出不写 stdout 的函数**

在 `oneshot.ts` 的 `runOneshot` 旁增加：

```ts
export async function runOneshotWithRuntime(
  runtime: {
    getModel(provider: string, modelId: string): unknown;
    completeSimple: ModelRuntime['completeSimple'];
    streamSimple: ModelRuntime['streamSimple'];
  },
  req: OneshotRequest,
  emit: (obj: unknown) => void,
): Promise<void> {
  const model = runtime.getModel(req.provider, req.modelId);
  if (!model) {
    emit({ ok: false, error: `model not found: ${req.provider}/${req.modelId}` });
    return;
  }
  const context = {
    systemPrompt: req.system,
    messages: [{ role: 'user', content: req.user, timestamp: Date.now() }],
  } as Parameters<typeof runtime.completeSimple>[1];
  if (req.stream) {
    for await (const ev of runtime.streamSimple(model as never, context)) {
      if (ev.type === 'text_delta' && ev.delta) emit({ type: 'delta', text: ev.delta });
      else if (ev.type === 'done') emit({ type: 'done', usage: ev.message.usage });
      else if (ev.type === 'error') emit({ type: 'error', usage: ev.error.usage, error: ev.error.errorMessage });
    }
    return;
  }
  const msg = await runtime.completeSimple(model as never, context);
  emit(formatNonStream(msg as AssistantLike));
}
```

`runOneshot` 改为：`ModelRuntime.create` 后调 `runOneshotWithRuntime(..., (obj) => process.stdout.write(JSON.stringify(obj)+'\n'))`。CLI 子命令保留到第 5 份。

- [ ] **步骤 2：测试 `runOneshotWithRuntime`**

创建 `extensions/_shared/oneshot.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { runOneshotWithRuntime } from './oneshot.js';

describe('runOneshotWithRuntime', () => {
  it('非流式 emit formatNonStream 形状', async () => {
    const emit = vi.fn();
    await runOneshotWithRuntime(
      {
        getModel: () => ({}),
        completeSimple: async () => ({ content: [{ type: 'text', text: 'hello' }] }) as never,
        streamSimple: async function* () {},
      },
      { provider: 'openai', modelId: 'gpt', user: 'hi' },
      emit,
    );
    expect(emit).toHaveBeenCalledWith({ ok: true, content: 'hello' });
  });

  it('流式行是 delta/done/error', async () => {
    const emit = vi.fn();
    await runOneshotWithRuntime(
      {
        getModel: () => ({}),
        completeSimple: async () => ({ content: [] }) as never,
        streamSimple: async function* () {
          yield { type: 'text_delta', delta: 'A' };
          yield { type: 'done', message: { usage: { input: 1, output: 2 } } };
        } as never,
      },
      { provider: 'openai', modelId: 'gpt', user: 'hi', stream: true },
      emit,
    );
    expect(emit.mock.calls.map((c) => c[0])).toEqual([
      { type: 'delta', text: 'A' },
      { type: 'done', usage: { input: 1, output: 2 } },
    ]);
  });

  it('模型不存在时 emit ok:false', async () => {
    const emit = vi.fn();
    await runOneshotWithRuntime(
      { getModel: () => undefined, completeSimple: async () => ({}) as never, streamSimple: async function* () {} },
      { provider: 'x', modelId: 'y', user: 'hi' },
      emit,
    );
    expect(emit).toHaveBeenCalledWith({ ok: false, error: 'model not found: x/y' });
  });
});
```

- [ ] **步骤 3：main.ts 换注入**

第 1 份已把 `activeModel` 改成 `agentHost.get(workspace)?.session.model`。本份确认它返回 `{ provider, modelId }`：

```ts
activeModel: async (workspace) => {
  const model = agentHost.get(workspace)?.session.model;
  if (!model) throw new Error(`workspace not open: ${workspace}`);
  return { provider: model.provider, modelId: model.id };
},
oneshot: async (request, onLine) => {
  const runtime = await modelRuntimeHost.ensure();
  await runOneshotWithRuntime(runtime, request, (obj) => onLine(JSON.stringify(obj)));
},
```

`diagnose` 的 `usage.completion_tokens / prompt_tokens` 与 pi-ai `Usage {input, output}` 不符——今日就恒 null，**本期不修**（规格 TODO）。

- [ ] **步骤 4：运行验证通过**

运行：`cd extensions && npx vitest run _shared/oneshot.test.ts`；`cd electron-agent && npx vitest run --project main electron/app/providerService.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/_shared/oneshot.ts extensions/_shared/oneshot.test.ts electron-agent/electron/main.ts
git commit -m "feat(electron): run oneshot against the in-process ModelRuntime"
```

---

## 任务 6：probe 进程内化

审查：`runModelProbe` / `runProbeCli` 写 stdout、返回 void，不能当纯函数 import。真实纯函数是 `collectModels` 与 `probeServer`；缓存必须继续 `writeToolsCacheEntry`。

**文件：**
- 修改：`electron-agent/electron/main.ts`、`electron-agent/electron/app/mcpPolicyService.ts`、`mcpPolicyService.test.ts`
- 修改：`extensions/mcp/probe.ts`（超时 kill）

- [ ] **步骤 1：编写失败的测试**

`mcpPolicyService.test.ts` 今日断言 spawn 参数含 `probe-mcp`。改成：

```ts
it('probe 调用 probeServer 并写缓存，不 spawn', async () => {
  const probeServer = vi.fn(async () => ({ ok: true, toolNames: ['mcp__s__t'] }));
  const writeCache = vi.fn();
  const spawn = vi.fn();
  const service = new McpPolicyService(home, { probeServer, writeToolsCacheEntry: writeCache, run: spawn });
  const out = await service.probe(JSON.stringify({ name: 's', transport: 'stdio', command: 'x', args: [] }));
  expect(JSON.parse(out)).toEqual({ ok: true, toolNames: ['mcp__s__t'] });
  expect(writeCache).toHaveBeenCalledWith('s', { ok: true, toolNames: ['mcp__s__t'] });
  expect(spawn).not.toHaveBeenCalled();
});
```

`ProviderService` 的 `probeModels`：在 `providerService.test.ts` 或 main 不方便单测，把纯函数调用放到 `mcpPolicyService` 同级的小包装不值得。`probeModels` 改 main 后用 `collectModels` 单测已在 `cli/src/probe-models.test.ts`——本份跑那条即可。给 `ProviderService` 增加可选 `listModels?: () => Promise<string>` 不是必须：`probeModels` 已是 options 注入，main 换实现就行。

- [ ] **步骤 2：运行验证失败**

运行：`cd electron-agent && npx vitest run --project main electron/app/mcpPolicyService.test.ts`
预期：FAIL，构造参数不认识 `probeServer`。

- [ ] **步骤 3：改 `McpPolicyService.probe`**

```ts
export interface McpPolicyServiceOptions {
  probeServer?: (cfg: McpServerConfig) => Promise<ProbeResult>;
  writeToolsCacheEntry?: (name: string, result: ProbeResult) => void;
  permissionManager?: Pick<PermissionManager, 'authorize'>;
  // 删除 piCommand / run / piPackageDir 的生产路径；测试可继续注入 probeServer。
}

  async probe(configJson: string): Promise<string> {
    let cfg: McpServerConfig;
    try { cfg = JSON.parse(configJson) as McpServerConfig; }
    catch { return JSON.stringify({ ok: false, toolNames: [], error: 'invalid MCP_PROBE_CONFIG' }); }
    const probe = this.options.probeServer ?? (await import('../../../extensions/mcp/probe.js')).probeServer;
    const write = this.options.writeToolsCacheEntry ?? (await import('../../../extensions/mcp/toolsCache.js')).writeToolsCacheEntry;
    const result = await probe(cfg);
    try { write(cfg.name, result); } catch { /* 与 runProbeCli 一致：缓存失败打不得倒 stdout */ }
    return JSON.stringify(result);
  }
```

- [ ] **步骤 4：`probeServer` 超时杀子进程**

`probe.ts` 的 stdio 分支在 `new StdioClientTransport(...)` 之后记下 pid。MCP SDK 的 transport 若暴露 `pid` 或 `_process.pid` 就用；读不到则在超时后仍 `client.close()`（今日行为）并在注释写明「未暴露 pid 时无法 killTree」。有 pid 时：

```ts
function killProbeChild(pid: number): void {
  try {
    if (process.platform === 'win32') process.kill(pid);
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已退 */ }
  }
}
```

`withTimeout` reject 后 `finally` 里 `client.close()` + 若超时则 `killProbeChild`。POSIX 进程组语义的完整版是第 4 份的 `killTree`；本份先保证超时不会留下 MCP server。`detached: true` **不要**在本份加到 MCP transport 上（那会改 SDK 默认）。

- [ ] **步骤 5：main.ts `probeModels`**

```ts
import { collectModels } from '../../cli/src/probe-models.js';
import { ModelRegistry } from '../../cli/src/pi-sdk.js';

probeModels: async () => {
  const runtime = await modelRuntimeHost.ensure();
  return JSON.stringify({ ok: true, models: collectModels(new ModelRegistry(runtime) as never) });
},
```

返回值形状与今日 stdout 一行 JSON 一致（渲染层 `list_models_global` 读字符串）。

- [ ] **步骤 6：运行验证通过**

```bash
cd electron-agent && npx vitest run --project main electron/app/mcpPolicyService.test.ts electron/app/providerService.test.ts
cd ../cli && node --import tsx --test src/probe-models.test.ts
cd ../extensions && npx vitest run mcp/probe.test.ts
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/electron/app/mcpPolicyService.ts electron-agent/electron/app/mcpPolicyService.test.ts electron-agent/electron/main.ts extensions/mcp/probe.ts
git commit -m "feat(electron): probe models and MCP in-process and keep the tools cache"
```

---

## 任务 7：本份收尾验证

- [ ] **步骤 1：11 条规则对表**

打开 `piRuntimeService.ts`，确认下列符号仍在且 Goal 路径仍调用它们（不是「改到 GoalHost 里」）：

`GOAL_SESSION_COMMAND_FORBIDDEN`、`readSessionIdentity` / `SESSION_ID_MISMATCH`、`queueGoalTurnFromArgs`、`INVALID_GOAL_TURN`、`GOAL_TURN_IDEMPOTENCY_CONFLICT`、`GOAL_WORKER_SESSION_MISMATCH`、`failQueuedGoalTurns`、`drainGoalTurn`、`goalPrompt`、`migrateLegacyGoal`、`bindGoalSession` / `unbindGoalSession`、`ownsSession`。

`PI_GOAL_WORKER` 不得再写入 `turnConfig`（第 1 份已 delete）。`dispatchGoalTurn` 仍设 `source:'goal'` + `permissionProfile:'automation'`。

- [ ] **步骤 2：全量测试**

```bash
cd electron-agent && npx vitest run --project main
cd ../extensions && npx vitest run
cd ../cli && node --import tsx --test "src/**/*.test.ts"
```

预期：PASS。门槛 grep 空输出。

- [ ] **步骤 3：Commit（若步骤 1 有漏补）**

只提交为对齐 11 条而做的修复，不要顺手删 sidecar。

---

## 交付标准

- Goal session = 可见 session：交互 handle + `origin:"goal"`，`GoalHost.open` 不调用。
- Goal session ≠ 可见 session：`GoalHost` 独立 handle；交互 handle 不持有该文件。
- 同 handle 下交互 `agent_prompt` 先 abort Goal；`switchSession` 命中 Goal 文件先 dispose。
- 11 条规则仍在 `PiRuntimeService`；`describeModel()` 返回 `provider/id`；`MODEL_CHANGED` 保留。
- 三类任务经 `completeSimple` + 串行队列 + 每 kind 超时 abort。
- oneshot 流式行 `{type:"delta"|"done"|"error"}` 不变；`activeModel` 来自 `session.model`。
- probe 不 spawn；`~/.pi/mcp-tools-cache.json` 仍写入。
- 不删 `PiClient` / `runtime.ts` 子命令（第 5 份）。

**本份不可发布**：fork 子代理仍可能指向 sidecar（第 4 份），主线仍是双栈中间态。

## 已知风险（交给后续计划）

1. **`SessionManager.open` 的准确导出名字以 0.85.1 `.d.ts` 为准。** 任务 2 步骤 4 已写适配句。
2. **MCP probe 的 pid 能否从 `StdioClientTransport` 读到未在本机核实。** 读不到就退回 `client.close()`，第 4 份 `killTree` 覆盖子代理，不覆盖 MCP probe。
3. **`diagnose` usage 字段映射不修。**
4. **sidecar / `resources/pi` 仍在**，第 5 份才删。
