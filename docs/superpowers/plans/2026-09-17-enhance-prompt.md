# 输入框增强提示词 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 主对话输入栏发送按钮左侧增加「增强提示词」：一次性改写当前正文，预览浮层流式展示，应用后只写回编辑器；并把 Electron 短调用收口到 `ModelRuntimeHost`。

**架构：** 默认路径只调 `ModelRuntimeHost.streamSimple`。mermaid / 诊断的 JSON 行适配器也改调 Host 并透传 `AbortSignal`。实验开关打开后，主进程用 `ModelRuntime.stream`（Context.tools）跑最多 4 回合 / 8 次只读工具，工具 JSON 不进 Channel。前端独立 portal 锚定 `composer-surface`。

**技术栈：** TypeScript、React、antd-style、@lobehub/ui、lucide-react `Wand2`、zustand、vitest。只改 `electron-agent`。

**上游规格：** `docs/superpowers/specs/2026-09-17-enhance-prompt-design.md`（以用户修订稿为准）。

---

## 动工前必读

- **不要隔离 worktree**，在当前仓库原地做。工作区很脏：每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。
- **按编号顺序执行，不要跳序。** 短调用收口是增强默认路径的前置；实验工具循环在默认路径测试通过后再做。
- **用户未明确要求提交时，跳过每个任务的 Commit 步骤。**
- Windows 提交用 PowerShell here-string，不要 bash `EOF` heredoc。
- 禁止 emoji。图标用 `@lobehub/ui` 的 `Icon` / `ActionIcon` + `lucide-react`。
- **不要**向渲染层加通用 `pi.oneshot` IPC。**不要**删 `extensions/_shared/oneshot.ts` 的 CLI `runOneshot()`。**不要**让增强走 `agent_prompt`、`ShortCallQueue`、子代理。
- `session.model` 与 `ModelRuntime.getModel()` 返回的 `Model` 不同形。解析会话模型时用 `snapshotSessionModel` / `getState().model` 的 `provider`+`id` 再 `getModel`，禁止把 `session.model` 对象直接传给 `streamSimple`。
- 设置读 `SettingsService.getAll()`，不要用 `SettingsManager.getDefaultProvider`。
- Channel 流式：**必须**按 `diagnose_provider_model` 从 `args.onChunk.__grenChannelId` 构造 `event.sender.send`。
- `readDraft` 目前是 `ChatInput.tsx` 局部闭包，动作按钮拿不到；必须进 `ChatInputContext`。
- 同一 workspace 新的 `enhance_prompt` **先中止上一次**（bump seq），不是忽略新请求。
- `send()` 里 abort 增强必须在 `cancelPendingOverlay` **之前**、且在 `editor.cleanDocument()` 之前。
- 实验工具只用 `agentData.request`：`wiki.search` / `wiki.read` / `memory.search` / `codeRetrieval.call`。**不要**调 `wiki.pages.search` / `wiki.pages.read`。`memory.search` 的 `userId` 取不到则 `'local'`。
- `ModelRuntime.stream(model, context, { signal })` 才带 `Context.tools`。`streamSimple` / `completeSimple` 不跑工具。
- **`for await` 无法被 abort 打断。** `stream` / `streamSimple` 返回的是 `AssistantMessageEventStream`（`AsyncIterable`，不是本文件的 generator，外部也 break 不了）。只 `controller.abort()` 不会让挂起的迭代返回，`run()` 会永远挂着——超时用例直接 hang、切工作区/发送时的 abort 也会漏 promise。必须用「手动 iterator + `Promise.race([iterator.next(), abortPromise])`」，胜出后在 `finally` 里 `await iterator.return?.()` 收尾。**默认路径与实验工具循环都要这么做。**
- 带 tools 的事件形状（`pi-ai` `AssistantMessageEvent`）：`done` 带 `{ reason: 'stop' | 'length' | 'toolUse' | 'deferred', message: AssistantMessage }`；`error` 带 `{ reason: 'aborted' | 'error', error: AssistantMessage }`——**不是** `streamSimple` 那套 `{ usage, errorMessage }`。取最终消息优先用 `AssistantMessageEventStream.result(): Promise<AssistantMessage>`，别去猜最后一次 `partial`。
- 工具块形状：`{ type: "toolCall", id, name, arguments }`；回灌 `{ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp }`（`timestamp` 是必填字段）。
- `Type` 由 `pi-ai` 从 `typebox` 再导出（`export { Type } from "typebox"`），`Tool` 是 `{ name, description, parameters }`。两者都直接从 `@earendil-works/pi-ai` 导入，**不要**经过 `cli/src/pi-sdk.ts`——那里没导出它们。
- UI 以 vitest 为准，不要求点 Electron 真窗。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project main <本任务列出的 electron 测试>
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project renderer <本任务列出的 src 测试>
```

涉及主进程类型的任务再加：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx tsc --noEmit -p tsconfig.node.json
```

**提交（仅当用户要求时）：**

```powershell
git add <本任务文件>
git commit -m @"
feat(输入框): <本任务一句话>

"@
```

---

## 文件结构

新建：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron/agent/hostOneshotAdapter.ts` | mermaid / 诊断 JSON 行 → Host |
| `electron-agent/electron/agent/hostOneshotAdapter.test.ts` | 行形状、未命中模型、signal |
| `electron-agent/electron/app/enhancePrompt.ts` | 解析模型、默认流式、实验工具循环、清洗、中止 |
| `electron-agent/electron/app/enhancePrompt.test.ts` | §9 主进程用例 |
| `electron-agent/src/stores/enhancePromptStore.ts` | 按 workspace 分槽 |
| `electron-agent/src/stores/enhancePromptStore.test.ts` | seq / awaitingContext |
| `electron-agent/src/features/chat/input/EnhancePromptOverlay.tsx` | 预览 portal |
| `electron-agent/src/features/chat/input/EnhancePromptOverlay.test.tsx` | 流式、应用、取消、实验状态 |
| `electron-agent/src/features/chat/input/actions/EnhancePromptAction.tsx` | 右侧按钮 |
| `electron-agent/src/features/chat/input/actions/EnhancePromptAction.test.tsx` | 禁用、Goal 格式 |

修改：

| 文件 | 职责 |
| --- | --- |
| `electron-agent/electron/agent/modelRuntimeHost.ts` | 抽出 `ShortCallInput`，按 provider/id 解析 |
| `electron-agent/electron/agent/modelRuntimeHost.test.ts` | provider+id、streamSimple signal |
| `electron-agent/electron/app/providerService.ts` | `oneshot` 第三参 `signal?` |
| `electron-agent/electron/main.ts` | oneshot 改调适配器；注入 enhancePrompt |
| `electron-agent/electron/ipc/register.ts` | `enhance_prompt` / `enhance_prompt_abort` |
| `electron-agent/electron/ipc/register.test.ts` | Channel emit / abort 一条 |
| `electron-agent/src/lib/pi.ts` | `enhancePrompt` / `abortEnhancePrompt` |
| `electron-agent/src/features/settings/settingsSchema.ts` | 两项设置 |
| `electron-agent/src/features/settings/settingsSchema.test.ts` | 字段顺序 |
| `electron-agent/src/features/settings/scrubLinkedModelSettings.test.ts` | 删供应商清 `enhancePromptModel` |
| `electron-agent/src/features/chat/input/config.tsx` | 登记动作、右侧默认、宽度、文案 |
| `electron-agent/src/features/chat/input/ChatInputContext.tsx` | `readDraft` |
| `electron-agent/src/features/chat/ChatInput.tsx` | ctx 暴露 `readDraft`；发送前 abort |
| `electron-agent/src/features/chat/ChatInput.test.tsx` | 发送前 abort |
| `electron-agent/src/features/chat/input/GoalPill.tsx` | 导出 `readSessionId` |
| `electron-agent/src/features/chat/input/editor/MessageEditor.tsx` | 挂浮层 |
| `electron-agent/src/features/chat/input/actions/actions.test.tsx` | ctx 补 `readDraft` |
| `electron-agent/src/features/chat/input/actions/extensionActions.test.tsx` | ctx 补 `readDraft` |

不改：`extensions/_shared/oneshot.ts` 的 CLI `runOneshot`、诊断 usage 字段、ChatTag pill、子代理输入栏、`ShortCallQueue`。

---

### 任务 1：Host 抽出 `ShortCallInput` 并按 provider/id 解析

**文件：**
- 修改：`electron-agent/electron/agent/modelRuntimeHost.ts`
- 测试：`electron-agent/electron/agent/modelRuntimeHost.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `modelRuntimeHost.test.ts` 的 `describe('ModelRuntimeHost 短调用')` 末尾追加：

```ts
  it('completeSimple 接受 provider+modelId 并 getModel', async () => {
    const completeSimple = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const getModel = vi.fn((_p: string, _id: string) => model);
    const create = vi.fn().mockResolvedValue({
      completeSimple, getAvailableSnapshot: () => [model], getModel, hasConfiguredAuth: () => true, refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'other', modelId: 'nope' }) });
    await expect(host.completeSimple({ user: 'q', provider: 'openai', modelId: 'gpt-x' })).resolves.toBe('ok');
    expect(getModel).toHaveBeenCalledWith('openai', 'gpt-x');
    expect(completeSimple.mock.calls[0][0]).toBe(model);
  });

  it('provider+modelId 未命中时抛 模型不可用，不回退默认', async () => {
    const completeSimple = vi.fn();
    const create = vi.fn().mockResolvedValue({
      completeSimple, getAvailableSnapshot: () => [model], getModel: () => undefined, hasConfiguredAuth: () => true, refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    await expect(host.completeSimple({ user: 'q', provider: 'gone', modelId: 'x' })).rejects.toThrow('模型不可用');
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it('streamSimple 把 signal 透传到第三参并映射 text_delta', async () => {
    const signal = new AbortController().signal;
    async function* streamSimple() {
      yield { type: 'text_delta', delta: '你好' };
      yield { type: 'done', message: { usage: { totalTokens: 1 } } };
    }
    const create = vi.fn().mockResolvedValue({
      completeSimple: vi.fn(),
      streamSimple,
      getAvailableSnapshot: () => [model],
      getModel: () => model,
      hasConfiguredAuth: () => true,
      refresh: vi.fn(),
    });
    const host = new ModelRuntimeHost({ create, resolveSettings: async () => ({ provider: 'openai', modelId: 'gpt-x' }) });
    const events: Array<{ type: string; text?: string }> = [];
    for await (const ev of host.streamSimple({ user: 'q', signal })) events.push(ev);
    expect(events).toEqual([
      { type: 'delta', text: '你好' },
      { type: 'done', usage: { totalTokens: 1 } },
    ]);
  });
```

第三段用例需要把 `streamSimple` 的调用参数也断言 signal。在 generator 外包一层 `vi.fn`：

```ts
    const inner = vi.fn(streamSimple);
    // mockResolvedValue({ streamSimple: inner, ... })
    // 跑完后：
    expect(inner.mock.calls[0][2]).toEqual({ signal });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project main electron/agent/modelRuntimeHost.test.ts
```

预期：FAIL，没有 provider/id 解析或 streamSimple 用例失败。

- [ ] **步骤 3：编写最少实现代码**

`modelRuntimeHost.ts` 把两个方法的入参换成共用接口，并增加解析：

```ts
export interface ShortCallInput {
  user: string;
  systemPrompt?: string;
  model?: Model;
  provider?: string;
  modelId?: string;
  signal?: AbortSignal;
}

export class ModelRuntimeHost {
  // ...ensure / refresh / peek / resolveDefaultModel / describeModel 保持原样

  async completeSimple(input: ShortCallInput): Promise<string> {
    const runtime = await this.ensure();
    const model = await this.resolveCallModel(input, runtime);
    const msg = await runtime.completeSimple(
      model,
      { systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: input.user, timestamp: Date.now() }] },
      { signal: input.signal },
    );
    const formatted = formatNonStream(msg);
    if (!formatted.ok) throw new Error(formatted.error);
    return formatted.content;
  }

  async *streamSimple(input: ShortCallInput): AsyncGenerator<{ type: 'delta' | 'done' | 'error'; text?: string; usage?: unknown; error?: string }> {
    const runtime = await this.ensure();
    const model = await this.resolveCallModel(input, runtime);
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

  private async resolveCallModel(input: ShortCallInput, runtime: ModelRuntime): Promise<Model> {
    if (input.model) return input.model;
    if (input.provider || input.modelId) {
      if (!input.provider || !input.modelId) throw new Error('模型不可用');
      const found = runtime.getModel(input.provider, input.modelId);
      if (!found) throw new Error('模型不可用');
      return found as Model;
    }
    return this.resolveDefaultModel();
  }
}
```

`ModelRuntime` 类型已从 `pi-sdk.js` 导入，把 `ensure()` 的返回值类型用于 `resolveCallModel` 第二参。

- [ ] **步骤 4：运行测试验证通过**

同一 vitest 命令。预期：PASS。已有 `completeSimple 把 signal 透传到第三参` 必须仍绿。

- [ ] **步骤 5：Commit**（仅当用户要求）

---

### 任务 2：JSON 行适配器替换 `runOneshotWithRuntime`

**文件：**
- 创建：`electron-agent/electron/agent/hostOneshotAdapter.ts`
- 测试：`electron-agent/electron/agent/hostOneshotAdapter.test.ts`
- 修改：`electron-agent/electron/app/providerService.ts`
- 修改：`electron-agent/electron/main.ts`

- [ ] **步骤 1：编写失败的测试**

`hostOneshotAdapter.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { runHostOneshot } from './hostOneshotAdapter.js';

function hostStub(overrides: Record<string, unknown> = {}) {
  return {
    completeSimple: vi.fn().mockResolvedValue('fixed'),
    streamSimple: vi.fn(async function* () {
      yield { type: 'delta' as const, text: 'he' };
      yield { type: 'delta' as const, text: 'llo' };
      yield { type: 'done' as const, usage: { total_tokens: 3 } };
    }),
    ...overrides,
  };
}

describe('runHostOneshot', () => {
  it('非流式成功 emit { ok, content }，system 映到 systemPrompt，signal 传到 Host', async () => {
    const signal = new AbortController().signal;
    const host = hostStub();
    const lines: unknown[] = [];
    await runHostOneshot(host as never, {
      provider: 'openai', modelId: 'gpt-x', user: 'hi', system: 'sys',
    }, (line) => lines.push(JSON.parse(line)), signal);
    expect(host.completeSimple).toHaveBeenCalledWith({
      user: 'hi', systemPrompt: 'sys', provider: 'openai', modelId: 'gpt-x', signal,
    });
    expect(host.streamSimple).not.toHaveBeenCalled();
    expect(lines).toEqual([{ ok: true, content: 'fixed' }]);
  });

  it('流式行形状为 delta / done', async () => {
    const host = hostStub();
    const lines: unknown[] = [];
    await runHostOneshot(host as never, {
      provider: 'openai', modelId: 'gpt-x', user: 'hi', stream: true,
    }, (line) => lines.push(JSON.parse(line)));
    expect(lines).toEqual([
      { type: 'delta', text: 'he' },
      { type: 'delta', text: 'llo' },
      { type: 'done', usage: { total_tokens: 3 } },
    ]);
  });

  it('模型不可用 emit model not found: provider/id', async () => {
    const host = hostStub({
      completeSimple: vi.fn().mockRejectedValue(new Error('模型不可用')),
    });
    const lines: unknown[] = [];
    await runHostOneshot(host as never, {
      provider: 'gone', modelId: 'x', user: 'hi',
    }, (line) => lines.push(JSON.parse(line)));
    expect(lines).toEqual([{ ok: false, error: 'model not found: gone/x' }]);
  });
});
```

再补一条规格 §9 要求的源码断言（放在同一文件末尾）。`enhancePrompt.ts` 要到任务 4 才存在，届时把第二个 `expect` 打开：

```ts
  it('main.ts 与 enhancePrompt.ts 都不再 import runOneshotWithRuntime', async () => {
    const { readFile } = await import('node:fs/promises');
    const main = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    expect(main).not.toMatch(/runOneshotWithRuntime/);
    // const enhance = await readFile(new URL('../app/enhancePrompt.ts', import.meta.url), 'utf8');
    // expect(enhance).not.toMatch(/runOneshotWithRuntime/);
  });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project main electron/agent/hostOneshotAdapter.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：编写最少实现代码**

`hostOneshotAdapter.ts`：

```ts
import type { ModelRuntimeHost } from './modelRuntimeHost.js';

export async function runHostOneshot(
  host: Pick<ModelRuntimeHost, 'completeSimple' | 'streamSimple'>,
  request: Record<string, unknown>,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const provider = typeof request.provider === 'string' ? request.provider : '';
  const modelId = typeof request.modelId === 'string' ? request.modelId : '';
  const user = typeof request.user === 'string' ? request.user : '';
  const systemPrompt = typeof request.system === 'string' ? request.system : undefined;
  const emit = (obj: unknown) => onLine?.(JSON.stringify(obj));
  const input = { user, systemPrompt, provider, modelId, signal };
  try {
    if (request.stream === true) {
      for await (const ev of host.streamSimple(input)) {
        if (ev.type === 'delta') emit({ type: 'delta', text: ev.text });
        else if (ev.type === 'done') emit({ type: 'done', usage: ev.usage ?? {} });
        else if (ev.type === 'error') emit({ type: 'error', error: ev.error, usage: ev.usage });
      }
      return;
    }
    const content = await host.completeSimple(input);
    emit({ ok: true, content });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === '模型不可用') emit({ ok: false, error: `model not found: ${provider}/${modelId}` });
    else emit({ ok: false, error: message });
  }
}
```

`providerService.ts` 把 `oneshot` 改成：

```ts
oneshot?: (request: Record<string, unknown>, onLine?: (line: string) => void, signal?: AbortSignal) => Promise<void>;
```

`main.ts`：删掉 `runOneshotWithRuntime` / `OneshotRequest` 的 import（第 46 行）。oneshot 注入改为：

```ts
import { runHostOneshot } from "./agent/hostOneshotAdapter";
// ...
oneshot: (request, onLine, signal) => runHostOneshot(modelRuntimeHost, request, onLine, signal),
```

`main.ts` 里 `./app/...`、`./agent/...` 的本地 import 一律**不带** `.js` 后缀（见文件顶部第 3–48 行），照抄保持风格一致。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project main electron/agent/hostOneshotAdapter.test.ts electron/app/providerService.test.ts electron/agent/modelRuntimeHost.test.ts
```

预期：PASS。`providerService.test.ts` 里 oneshot mock 仍是两参，第三参可选，不必改测试体。

确认 `main.ts` 不再出现 `runOneshotWithRuntime`（全文搜索）。

- [ ] **步骤 5：Commit**（仅当用户要求）

---

### 任务 3：设置项

**文件：**
- 修改：`electron-agent/src/features/settings/settingsSchema.ts`
- 测试：`electron-agent/src/features/settings/settingsSchema.test.ts`
- 测试：`electron-agent/src/features/settings/scrubLinkedModelSettings.test.ts`

- [ ] **步骤 1：编写失败的测试**

`settingsSchema.test.ts` 里 general 字段表改为：

```ts
    expect(fields.map((field) => field.key)).toEqual([
      'defaultSessionModel',
      'titleModel',
      'enhancePromptModel',
      'enhancePromptUseProjectContext',
      'AUTO_TITLE',
      'COMPACTION_PREVIEW',
      'goal.autoContinueOnOpen',
    ]);
```

同一 describe 追加：

```ts
  it('在标题模型后提供增强提示词模型与实验开关', () => {
    const fields = SETTINGS_SCHEMA.find((category) => category.id === 'general')?.fields ?? [];
    expect(fields.find((field) => field.key === 'enhancePromptModel')).toMatchObject({
      label: '增强提示词模型',
      type: 'model',
      placeholder: '留空＝当前会话模型',
      description: '输入框「增强提示词」使用的模型；留空＝当前会话模型',
      effect: 'instant',
    });
    expect(fields.find((field) => field.key === 'enhancePromptUseProjectContext')).toMatchObject({
      label: '增强提示词结合项目（实验）',
      type: 'boolean',
      default: '0',
      description: '打开后允许查阅会话目标、wiki/记忆和代码图；更慢，且依赖索引。默认关',
    });
  });
```

`scrubLinkedModelSettings.test.ts` 在 `clears defaultSessionModel...` 之后追加：

```ts
  it('clears enhancePromptModel when it points at the deleted provider', () => {
    const { next, changed, clearedKeys } = scrubLinkedModelSettings(
      { enhancePromptModel: 'gone/flash', titleModel: 'openai/gpt-4o' },
      ['gone'],
    );
    expect(changed).toBe(true);
    expect(next.enhancePromptModel).toBe('');
    expect(next.titleModel).toBe('openai/gpt-4o');
    expect(clearedKeys).toContain('enhancePromptModel');
  });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project renderer src/features/settings/settingsSchema.test.ts src/features/settings/scrubLinkedModelSettings.test.ts
```

预期：FAIL，字段表不含新 key。scrub 用例因 `type: 'model'` 已覆盖 schema 扫描，**在 schema 加上 type:model 字段后会自动清**；先跑确认 schema 失败即可。

- [ ] **步骤 3：编写最少实现代码**

在 `settingsSchema.ts` 的 `titleModel` 对象之后、`AUTO_TITLE` 之前插入：

```ts
      {
        key: 'enhancePromptModel',
        label: '增强提示词模型',
        type: 'model',
        placeholder: '留空＝当前会话模型',
        description: '输入框「增强提示词」使用的模型；留空＝当前会话模型',
        effect: 'instant',
      },
      {
        key: 'enhancePromptUseProjectContext',
        label: '增强提示词结合项目（实验）',
        type: 'boolean',
        default: '0',
        description: '打开后允许查阅会话目标、wiki/记忆和代码图；更慢，且依赖索引。默认关',
      },
```

- [ ] **步骤 4：运行测试验证通过**

同一 vitest 命令。预期：PASS。testid 由 `SettingFieldInput` 自动生成 `set-field-enhancePromptModel` / `set-field-enhancePromptUseProjectContext`，不必改 SettingField。

- [ ] **步骤 5：Commit**（仅当用户要求）

---

### 任务 4：清洗与系统提示纯函数

**文件：**
- 创建：`electron-agent/electron/app/enhancePrompt.ts`（本任务只放纯函数与常量）
- 测试：`electron-agent/electron/app/enhancePrompt.test.ts`

- [ ] **步骤 1：编写失败的测试**

`enhancePrompt.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENHANCE_SYSTEM,
  PROJECT_ENHANCE_SYSTEM,
  buildEnhanceSystemPrompt,
  sanitizeEnhanceOutput,
} from './enhancePrompt.js';

describe('sanitizeEnhanceOutput', () => {
  it('剥掉整段围栏', () => {
    expect(sanitizeEnhanceOutput('```\nhello\n```')).toEqual({ ok: true, content: 'hello' });
    expect(sanitizeEnhanceOutput('```markdown\nhello\n```')).toEqual({ ok: true, content: 'hello' });
  });

  it('保留中间代码块', () => {
    const raw = '先做：\n```ts\nconst x = 1;\n```\n然后提交';
    expect(sanitizeEnhanceOutput(raw)).toEqual({ ok: true, content: raw });
  });

  it('剥完为空失败', () => {
    expect(sanitizeEnhanceOutput('```\n  \n```')).toEqual({ ok: false, error: '模型返回为空' });
    expect(sanitizeEnhanceOutput('   ')).toEqual({ ok: false, error: '模型返回为空' });
  });
});

describe('buildEnhanceSystemPrompt', () => {
  it('关实验只用默认文案', () => {
    expect(buildEnhanceSystemPrompt({ useProjectContext: false, goalText: '状态: active\n条件: 完成' })).toBe(DEFAULT_ENHANCE_SYSTEM);
  });

  it('开实验时用 \\n\\n 拼接，缺 Goal 写「无」', () => {
    expect(buildEnhanceSystemPrompt({ useProjectContext: true, goalText: '' })).toBe(
      `${DEFAULT_ENHANCE_SYSTEM}\n\n${PROJECT_ENHANCE_SYSTEM}无`,
    );
    expect(buildEnhanceSystemPrompt({ useProjectContext: true, goalText: '状态: active\n条件: 完工' })).toBe(
      `${DEFAULT_ENHANCE_SYSTEM}\n\n${PROJECT_ENHANCE_SYSTEM}状态: active\n条件: 完工`,
    );
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project main electron/app/enhancePrompt.test.ts
```

预期：FAIL。

- [ ] **步骤 3：编写最少实现代码**

`enhancePrompt.ts` 先只放这些（后续任务往同一文件追加，不要另起文件）：

```ts
export const MAX_ENHANCE_CHARS = 16000;
export const DEFAULT_ENHANCE_TIMEOUT_MS = 60_000;
export const PROJECT_ENHANCE_TIMEOUT_MS = 90_000;
export const MAX_TOOL_ROUNDS = 4;
export const MAX_TOOL_CALLS = 8;
export const MAX_TOOL_RESULT_CHARS = 4000;
export const MAX_GOAL_CHARS = 2000;

export const DEFAULT_ENHANCE_SYSTEM = `你是提示词改写器。把用户的草稿改写成更清晰、更完整的提示词：保留原意，补上结构、约束和成功标准。
只输出改写后的提示词正文，不要开场白、不要解释、不要用代码围栏包住整段。
原文中的 @路径、/命令、URL、文件名必须原样保留。
使用与原文相同的语言。`;

export const PROJECT_ENHANCE_SYSTEM = `你可以调用只读工具查阅本项目的 wiki、记忆和代码图，以便改写后的提示词贴合该项目的关键约定与实现。
不要向用户复述工具原始输出。最终只输出改写后的提示词正文。
当前会话目标：
`;

const FENCE_RE = /^```[^\n]*\n([\s\S]*?)\n```$/;

export function sanitizeEnhanceOutput(raw: string): { ok: true; content: string } | { ok: false; error: string } {
  let text = raw.trim();
  const fenced = FENCE_RE.exec(text);
  if (fenced) text = fenced[1].trim();
  if (!text) return { ok: false, error: '模型返回为空' };
  return { ok: true, content: text };
}

export function buildEnhanceSystemPrompt(input: { useProjectContext: boolean; goalText?: string }): string {
  if (!input.useProjectContext) return DEFAULT_ENHANCE_SYSTEM;
  const goal = input.goalText?.trim() ? input.goalText.trim() : '无';
  return `${DEFAULT_ENHANCE_SYSTEM}\n\n${PROJECT_ENHANCE_SYSTEM}${goal}`;
}
```

围栏正则必须要求**首尾各一行围栏包住全部内容**。中间另有围栏时 `^...$` 不会整段匹配，从而保留中间代码块。

- [ ] **步骤 4：运行测试验证通过**

同一 vitest 命令。预期：PASS。

- [ ] **步骤 5：Commit**（仅当用户要求）

---

### 任务 5：模型解析 + 默认流式 + 中止

**文件：**
- 修改：`electron-agent/electron/app/enhancePrompt.ts`
- 测试：`electron-agent/electron/app/enhancePrompt.test.ts`

本任务实现 `createEnhancePrompt`：开关关走 `host.streamSimple`；开关开先返回「未实现」也可以，但测试会要求关时**不**调 `runtime.stream` / `runtime.complete`。实验循环放到任务 7。

- [ ] **步骤 1：编写失败的测试**

在 `enhancePrompt.test.ts` 追加（可用 `vi.useFakeTimers` 的超时用例放最后）：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnhancePrompt, MAX_ENHANCE_CHARS } from './enhancePrompt.js';

const model = { provider: 'openai', id: 'gpt-x' };

function setup(options?: {
  settings?: Record<string, string>;
  sessionModel?: { provider: string; id: string } | null;
  getModel?: (provider: string, id: string) => unknown;
  streamSimple?: (input: unknown) => AsyncGenerator<unknown>;
}) {
  async function* defaultStream() {
    yield { type: 'delta', text: '改' };
    yield { type: 'delta', text: '写稿' };
    yield { type: 'done' };
  }
  const streamSimple = vi.fn(options?.streamSimple ?? defaultStream);
  const stream = vi.fn(async function* () { /* 实验才用 */ });
  const complete = vi.fn();
  const getModel = vi.fn(options?.getModel ?? ((provider: string, id: string) => (
    provider === model.provider && id === model.id ? model : undefined
  )));
  const host = {
    streamSimple,
    ensure: vi.fn(async () => ({ stream, complete, getModel })),
  };
  const agentHost = {
    get: vi.fn(() => options?.sessionModel ? { session: { model: options.sessionModel }, getState: () => ({ model: options.sessionModel }) } : undefined),
  };
  const agentData = { request: vi.fn() };
  const service = createEnhancePrompt({
    host: host as never,
    agentHost: agentHost as never,
    settings: async () => options?.settings ?? {},
    agentData: agentData as never,
  });
  return { service, streamSimple, stream, complete, getModel, agentData };
}

describe('createEnhancePrompt 默认路径', () => {
  afterEach(() => vi.useRealTimers());

  it('留空设置 → 用会话模型的 provider/id 再 getModel', async () => {
    const { service, streamSimple, getModel } = setup({ sessionModel: { provider: 'openai', id: 'gpt-x' } });
    const chunks: string[] = [];
    await expect(service.run({ workspace: '/ws', text: '帮我改 README' }, (c) => chunks.push(c)))
      .resolves.toEqual({ ok: true, content: '改写稿' });
    expect(getModel).toHaveBeenCalledWith('openai', 'gpt-x');
    expect(streamSimple.mock.calls[0][0]).toMatchObject({
      user: '帮我改 README',
      model,
    });
    expect(chunks).toEqual(['改', '写稿']);
  });

  it('有设置且 getModel 命中 → 用设置，不回退会话', async () => {
    const other = { provider: 'anthropic', id: 'claude' };
    const { service, streamSimple } = setup({
      settings: { enhancePromptModel: 'anthropic/claude' },
      sessionModel: { provider: 'openai', id: 'gpt-x' },
      getModel: (p, id) => (p === 'anthropic' && id === 'claude' ? other : undefined),
    });
    await service.run({ workspace: '/ws', text: 'x' }, () => {});
    expect(streamSimple.mock.calls[0][0].model).toBe(other);
  });

  it('有设置但未命中 → 失败不回退', async () => {
    const { service, streamSimple } = setup({
      settings: { enhancePromptModel: 'gone/x' },
      sessionModel: { provider: 'openai', id: 'gpt-x' },
    });
    await expect(service.run({ workspace: '/ws', text: 'x' }, () => {}))
      .resolves.toMatchObject({ ok: false, error: '增强提示词模型不可用，请在设置中重选或留空' });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('超长拒绝', async () => {
    const { service, streamSimple } = setup({ sessionModel: model });
    await expect(service.run({ workspace: '/ws', text: '汉'.repeat(MAX_ENHANCE_CHARS + 1) }, () => {}))
      .resolves.toMatchObject({ ok: false, error: '正文过长，请缩短后再增强' });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('开关关不调 stream/complete，忽略 goalText', async () => {
    const { service, stream, complete, streamSimple } = setup({
      settings: { enhancePromptUseProjectContext: '0' },
      sessionModel: model,
    });
    await service.run({ workspace: '/ws', text: 'x', goalText: '状态: active\n条件: 完工' }, () => {});
    expect(stream).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(streamSimple.mock.calls[0][0].systemPrompt).toBe(DEFAULT_ENHANCE_SYSTEM);
  });

  it('abort 后不把后续 delta 当成功', async () => {
    let yieldNext: () => void = () => {};
    async function* hanging() {
      yield { type: 'delta', text: 'a' };
      await new Promise<void>((resolve) => { yieldNext = resolve; });
      yield { type: 'delta', text: 'b' };
      yield { type: 'done' };
    }
    const { service } = setup({ sessionModel: model, streamSimple: hanging });
    const chunks: string[] = [];
    const pending = service.run({ workspace: '/ws', text: 'x' }, (c) => chunks.push(c));
    // 不要只 await Promise.resolve()——run() 里先 await settings()，一个 tick 不够，abort 会早于首包。
    await vi.waitFor(() => expect(chunks).toEqual(['a']));
    service.abort('/ws');
    yieldNext();
    await expect(pending).resolves.toMatchObject({ cancelled: true, ok: false });
    expect(chunks).toEqual(['a']);
  });
});
```

把 `DEFAULT_ENHANCE_SYSTEM` 加进 import。超时用例：

```ts
  it('超时返回增强超时，请重试', async () => {
    vi.useFakeTimers();
    async function* hang() {
      await new Promise(() => {});
    }
    const { service } = setup({ sessionModel: model, streamSimple: hang });
    const pending = service.run({ workspace: '/ws', text: 'x' }, () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toMatchObject({ ok: false, error: '增强超时，请重试' });
  });
```

这条用例能过的前提是 `drain`（见下方实现）：假时钟推进到 60s 触发 `controller.abort()` 后，`Promise.race` 立刻判负并返回，不必等挂起的 `next()`。没有 `drain` 的话这条用例会永久挂起。

- [ ] **步骤 2：运行测试验证失败**

同一 `enhancePrompt.test.ts`。预期：FAIL，`createEnhancePrompt` 未导出。

- [ ] **步骤 3：编写最少实现代码**

在 `enhancePrompt.ts` 追加（保留任务 4 的导出）：

```ts
import { snapshotSessionModel } from '../agent/workspaceHandle.js';
import type { ModelRuntimeHost, ShortCallInput } from '../agent/modelRuntimeHost.js';
import type { AgentHost } from '../agent/agentHost.js';
import type { AgentDataService } from './agentDataService.js';

export interface EnhancePromptResult {
  ok: boolean;
  content: string;
  error?: string;
  cancelled?: boolean;
}

export interface EnhancePromptDeps {
  host: Pick<ModelRuntimeHost, 'streamSimple' | 'ensure'>;
  agentHost: Pick<AgentHost, 'get'>;
  settings: () => Promise<Record<string, string>>;
  agentData: Pick<AgentDataService, 'request'>;
}

function splitProviderId(value: string): { provider: string; id: string } | null {
  const cut = value.indexOf('/');
  if (cut <= 0 || cut === value.length - 1) return null;
  return { provider: value.slice(0, cut), id: value.slice(cut + 1) };
}

function isProjectContextEnabled(settings: Record<string, string>): boolean {
  return settings.enhancePromptUseProjectContext === '1';
}

/**
 * 迭代 + 可被 abort 打断。不能直接 `for await`：abort 不会让挂起的 next() 返回，
 * run() 会永远挂着（超时用例 hang、切工作区漏 promise）。必须 race，并在 finally 收 iterator。
 */
async function drain(
  source: AsyncGenerator<{ type: string; text?: string; error?: string }>,
  signal: AbortSignal,
  onDelta: (chunk: string) => void,
): Promise<{ status: 'done' | 'aborted' | 'error'; error: string }> {
  const iterator = source[Symbol.asyncIterator]();
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) { resolve('aborted'); return; }
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next === 'aborted') return { status: 'aborted', error: '' };
      if (next.done) return { status: 'done', error: '' };
      const ev = next.value;
      if (ev.type === 'delta' && ev.text) onDelta(ev.text);
      else if (ev.type === 'error') return { status: 'error', error: ev.error || '增强失败' };
    }
  } finally {
    await iterator.return?.(undefined);
  }
}

export function createEnhancePrompt(deps: EnhancePromptDeps) {
  const inflight = new Map<string, { controller: AbortController; reason: 'user' | 'timeout' | 'replaced' }>();

  function abort(workspace: string, reason: 'user' | 'timeout' | 'replaced' = 'user'): void {
    const current = inflight.get(workspace);
    if (!current) return;
    current.reason = reason;
    current.controller.abort();
  }

  async function resolveModel(workspace: string, settings: Record<string, string>) {
    const runtime = await deps.host.ensure();
    const configured = (settings.enhancePromptModel ?? '').trim();
    if (configured) {
      const split = splitProviderId(configured);
      const found = split ? runtime.getModel(split.provider, split.id) : undefined;
      if (!found) throw new Error('增强提示词模型不可用，请在设置中重选或留空');
      return found;
    }
    const handle = deps.agentHost.get(workspace);
    const snap = snapshotSessionModel(handle?.session.model);
    const provider = typeof snap?.provider === 'string' ? snap.provider : '';
    const id = typeof snap?.id === 'string' ? snap.id : '';
    const found = provider && id ? runtime.getModel(provider, id) : undefined;
    if (!found) throw new Error('没有可用模型');
    return found;
  }

  async function run(
    input: { workspace: string; text: string; goalText?: string },
    emit: (chunk: string) => void,
  ): Promise<EnhancePromptResult> {
    const text = input.text;
    if (text.length > MAX_ENHANCE_CHARS) return { ok: false, content: '', error: '正文过长，请缩短后再增强' };
    abort(input.workspace, 'replaced');
    const controller = new AbortController();
    inflight.set(input.workspace, { controller, reason: 'user' });
    const settings = await deps.settings();
    const useProject = isProjectContextEnabled(settings);
    const timeoutMs = useProject ? PROJECT_ENHANCE_TIMEOUT_MS : DEFAULT_ENHANCE_TIMEOUT_MS;
    const timer = setTimeout(() => abort(input.workspace, 'timeout'), timeoutMs);
    try {
      const model = await resolveModel(input.workspace, settings);
      const systemPrompt = buildEnhanceSystemPrompt({
        useProjectContext: useProject,
        goalText: typeof input.goalText === 'string' ? input.goalText : '',
      });
      if (useProject) {
        return { ok: false, content: '', error: '实验路径尚未实现' };
      }
      let raw = '';
      const drained = await drain(
        deps.host.streamSimple({
          user: text, systemPrompt, model: model as ShortCallInput['model'], signal: controller.signal,
        }),
        controller.signal,
        (chunk) => { raw += chunk; emit(chunk); },
      );
      const slot = inflight.get(input.workspace);
      if (slot?.reason === 'timeout') return { ok: false, content: '', error: '增强超时，请重试' };
      if (drained.status === 'aborted' || controller.signal.aborted) return { ok: false, content: '', cancelled: true };
      if (drained.status === 'error') return { ok: false, content: '', error: drained.error };
      const cleaned = sanitizeEnhanceOutput(raw);
      if (!cleaned.ok) return { ok: false, content: '', error: cleaned.error };
      return { ok: true, content: cleaned.content };
    } catch (error) {
      const slot = inflight.get(input.workspace);
      if (slot?.reason === 'timeout') return { ok: false, content: '', error: '增强超时，请重试' };
      if (controller.signal.aborted) return { ok: false, content: '', cancelled: true };
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, content: '', error: message };
    } finally {
      clearTimeout(timer);
      const slot = inflight.get(input.workspace);
      if (slot?.controller === controller) inflight.delete(input.workspace);
    }
  }

  return { run, abort: (workspace: string) => abort(workspace, 'user') };
}
```

注意：`host.ensure()` 在默认路径也调用了以便 `getModel`。`streamSimple` 已能收 `model` 对象，不要再传 provider/id。

`snapshotSessionModel` 已在 `workspaceHandle.ts` 导出。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project main electron/app/enhancePrompt.test.ts
```

预期：PASS。任务 4 的纯函数用例仍绿。

- [ ] **步骤 5：Commit**（仅当用户要求）

---

### 任务 6：IPC 与 `pi.enhancePrompt`

**文件：**
- 修改：`electron-agent/electron/ipc/register.ts`
- 修改：`electron-agent/electron/main.ts`
- 修改：`electron-agent/src/lib/pi.ts`
- 测试：`electron-agent/electron/ipc/register.test.ts`（追加一条）

- [ ] **步骤 1：编写失败的测试**

在 `register.test.ts` 末尾追加：

```ts
  it('enhance_prompt 从 onChunk.__grenChannelId 推 delta，abort 调 service.abort', async () => {
    const run = vi.fn(async (_input: unknown, emit: (chunk: string) => void) => {
      emit('chunk-1');
      return { ok: true, content: 'chunk-1' };
    });
    const abort = vi.fn();
    registerIpcHandlers({ enhancePrompt: { run, abort } } as never);
    const invoke = handler(IPC_CHANNELS.invoke);
    const sender = { send: vi.fn() };
    await invoke({ sender }, { command: 'enhance_prompt', args: { workspace: '/ws', text: 'hello', onChunk: { __grenChannelId: 'channel-9' } } });
    expect(run).toHaveBeenCalledWith(
      { workspace: '/ws', text: 'hello', goalText: '' },
      expect.any(Function),
    );
    expect(sender.send).toHaveBeenCalledWith(`${IPC_CHANNELS.eventPrefix}channel:channel-9`, 'chunk-1');
    await invoke({ sender }, { command: 'enhance_prompt_abort', args: { workspace: '/ws' } });
    expect(abort).toHaveBeenCalledWith('/ws');
  });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project main electron/ipc/register.test.ts
```

预期：FAIL，command 未注册。

- [ ] **步骤 3：编写最少实现代码**

`register.ts` 的 `IpcServices` 增加：

```ts
  enhancePrompt?: {
    run(input: { workspace: string; text: string; goalText?: string }, emit: (chunk: string) => void): Promise<unknown>;
    abort(workspace: string): void;
  };
```

在 `registerIpcHandlers` 里、`if (services.provider)` 附近：

```ts
  if (services.enhancePrompt) {
    registerCommand('enhance_prompt', (event, args) => {
      const channel = args.onChunk;
      const emit = channel && typeof channel === 'object' && typeof (channel as Record<string, unknown>).__grenChannelId === 'string'
        ? (chunk: string) => event.sender.send(`${IPC_CHANNELS.eventPrefix}channel:${(channel as Record<string, string>).__grenChannelId}`, chunk)
        : () => {};
      const goalText = typeof args.goalText === 'string' ? args.goalText : '';
      return services.enhancePrompt!.run(
        { workspace: readString(args, 'workspace'), text: readText(args, 'text'), goalText },
        emit,
      );
    });
    registerCommand('enhance_prompt_abort', (_event, args) => {
      services.enhancePrompt!.abort(readString(args, 'workspace'));
    });
  }
```

`main.ts` 在 `registerIpcHandlers({...})` 前构造：

```ts
import { createEnhancePrompt } from "./app/enhancePrompt";
const enhancePrompt = createEnhancePrompt({
  host: modelRuntimeHost,
  agentHost,
  settings: () => settings.getAll(),
  agentData,
});
```

`agentHost` / `settings` / `agentData` 变量名以 `main.ts` 现有为准（`settings` 是 `SettingsService` 实例，`agentHost` 是 `AgentHost`）。把 `enhancePrompt` 放进 `registerIpcHandlers({ ... })`。

`pi.ts` 在 `DiagnoseResult` 旁增加：

```ts
export interface EnhancePromptResult {
  ok: boolean;
  content: string;
  error?: string;
  cancelled?: boolean;
}
```

`pi` 对象里、`diagnoseProviderModel` 附近：

```ts
  enhancePrompt: (workspace: string, text: string, onChunk: Channel<string>, goalText?: string) =>
    invoke<EnhancePromptResult>('enhance_prompt', { workspace, text, onChunk, goalText }),
  abortEnhancePrompt: (workspace: string) => invoke<void>('enhance_prompt_abort', { workspace }),
```

`Channel` 已从 `platform/runtime` 导入。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project main electron/ipc/register.test.ts electron/app/enhancePrompt.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（仅当用户要求）

---

### 任务 7：实验只读工具循环

**文件：**
- 修改：`electron-agent/electron/app/enhancePrompt.ts`
- 测试：`electron-agent/electron/app/enhancePrompt.test.ts`

把任务 5 里 `useProject` 的 `'实验路径尚未实现'` 换成真正循环。

- [ ] **步骤 1：编写失败的测试**

```ts
describe('createEnhancePrompt 实验路径', () => {
  function projectSetup(streamImpl: (context: { tools?: unknown[] }) => AsyncGenerator<unknown>, request = vi.fn()) {
    const stream = vi.fn(async function* (model: unknown, context: { tools?: unknown[] }) {
      yield* streamImpl(context);
    });
    const getModel = vi.fn(() => model);
    const host = {
      streamSimple: vi.fn(async function* () { yield { type: 'done' }; }),
      ensure: vi.fn(async () => ({ stream, complete: vi.fn(), getModel })),
    };
    const service = createEnhancePrompt({
      host: host as never,
      agentHost: { get: () => ({ session: { model }, getState: () => ({ model }) }) } as never,
      settings: async () => ({ enhancePromptUseProjectContext: '1' }),
      agentData: { request } as never,
    });
    return { service, stream, request, streamSimple: host.streamSimple };
  }

  it('只允许五个只读工具；wiki.replace / codegraph_impact 回错误字符串且不 request', async () => {
    const request = vi.fn();
    async function* impl() {
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: '1', name: 'wiki.replace', arguments: { page: 'x' } },
            { type: 'toolCall', id: '2', name: 'codegraph_impact', arguments: { symbol: 'Foo' } },
          ],
          stopReason: 'toolUse',
        },
      };
      yield {
        type: 'done',
        message: { role: 'assistant', content: [{ type: 'text', text: '改写稿' }], reason: 'stop' },
      };
    }
    const { service, request: req } = projectSetup(impl, request);
    const chunks: string[] = [];
    await expect(service.run({ workspace: '/ws', text: '修登录' }, (c) => chunks.push(c)))
      .resolves.toEqual({ ok: true, content: '改写稿' });
    expect(req).not.toHaveBeenCalled();
    expect(chunks).toEqual(['改写稿']);
  });

  it('wiki.search 空结果仍能改写', async () => {
    const request = vi.fn().mockResolvedValue([]);
    let round = 0;
    async function* impl() {
      round += 1;
      if (round === 1) {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: '1', name: 'wiki.search', arguments: { query: '登录' } }],
            reason: 'toolUse',
          },
        };
        return;
      }
      yield { type: 'text_delta', delta: '贴合项目的改写' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '贴合项目的改写' }], reason: 'stop' } };
    }
    const { service, request: req } = projectSetup(impl, request);
    await expect(service.run({ workspace: '/ws', text: '修登录' }, () => {}))
      .resolves.toEqual({ ok: true, content: '贴合项目的改写' });
    expect(req).toHaveBeenCalledWith('wiki.search', expect.objectContaining({ workspace: '/ws', query: '登录' }));
  });

  it('第 9 次工具调用被拒绝；超过 4 轮不再带 tools', async () => {
    const request = vi.fn().mockResolvedValue('ok');
    const toolSets: number[] = [];
    let round = 0;
    async function* impl(context: { tools?: unknown[] }) {
      toolSets.push(context.tools?.length ?? 0);
      round += 1;
      if (round <= 5) {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [
              { type: 'toolCall', id: `a${round}`, name: 'memory.search', arguments: { query: 'q' } },
              { type: 'toolCall', id: `b${round}`, name: 'memory.search', arguments: { query: 'q' } },
            ],
            reason: 'toolUse',
          },
        };
        return;
      }
      yield { type: 'text_delta', delta: '终稿' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '终稿' }], reason: 'stop' } };
    }
    const { service, request: req } = projectSetup(impl, request);
    await expect(service.run({ workspace: '/ws', text: 'x' }, () => {})).resolves.toMatchObject({ ok: true, content: '终稿' });
    expect(req).toHaveBeenCalledTimes(8);
    expect(toolSets.some((n) => n === 0)).toBe(true);
  });

  it('单次工具结果超过 4000 字被截断', async () => {
    const request = vi.fn().mockResolvedValue('字'.repeat(5000));
    const resultLens: number[] = [];
    let round = 0;
    const stream = vi.fn(async function* (_model: unknown, context: { messages: Array<{ role?: string; content?: Array<{ text?: string }> }> }) {
      for (const msg of context.messages) {
        if (msg.role === 'toolResult' && Array.isArray(msg.content)) {
          resultLens.push(msg.content[0]?.text?.length ?? 0);
        }
      }
      round += 1;
      if (round === 1) {
        yield {
          type: 'done',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: '1', name: 'wiki.read', arguments: { page: 'p' } }],
            reason: 'toolUse',
          },
        };
        return;
      }
      yield { type: 'text_delta', delta: '稿' };
      yield { type: 'done', message: { role: 'assistant', content: [{ type: 'text', text: '稿' }], reason: 'stop' } };
    });
    const host = {
      streamSimple: vi.fn(async function* () { yield { type: 'done' }; }),
      ensure: vi.fn(async () => ({ stream, complete: vi.fn(), getModel: vi.fn(() => model) })),
    };
    const service = createEnhancePrompt({
      host: host as never,
      agentHost: { get: () => ({ session: { model }, getState: () => ({ model }) }) } as never,
      settings: async () => ({ enhancePromptUseProjectContext: '1' }),
      agentData: { request } as never,
    });
    await service.run({ workspace: '/ws', text: 'x' }, () => {});
    expect(resultLens).toContain(4000);
  });
});
```

最后一条若与 `round` 闭包时序拧巴，改成：在自定义 `stream` 里当 `context.messages` 含 `role === 'toolResult'` 时记录 `content[0].text.length`。目标是 **4000**。

同时补：`codegraph_search` 走 `request('codeRetrieval.call', { workspace, tool: 'codegraph_search', args })`。

- [ ] **步骤 2：运行测试验证失败**

预期：FAIL，实验仍返回「尚未实现」或未调 `runtime.stream`。

- [ ] **步骤 3：编写最少实现代码**

工具表用 `@earendil-works/pi-ai` 的 `Type`：

```ts
import { Type, type AssistantMessage, type Message, type Tool } from '@earendil-works/pi-ai';

const ENHANCE_TOOLS: Tool[] = [
  { name: 'wiki.search', description: '按关键词搜索本工作区 wiki。', parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }) },
  { name: 'wiki.read', description: '读取 wiki 页面。', parameters: Type.Object({ page: Type.String() }) },
  { name: 'memory.search', description: '搜索本工作区记忆。', parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }) },
  { name: 'codegraph_search', description: '搜索代码图符号。', parameters: Type.Object({ query: Type.String(), kind: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }) },
  { name: 'codegraph_explore', description: '展开代码图上下文。', parameters: Type.Object({ query: Type.String(), maxFiles: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }) },
];
```

`executeEnhanceTool`：

- 未知名 → 返回 `{ isError: true, text: '不允许的工具' }`，不 `request`
- `wiki.search` → `agentData.request('wiki.search', { workspace, query, limit: limit ?? 8 })`
- `wiki.read` → `request('wiki.read', { workspace, page })`
- `memory.search` → `request('memory.search', { userId, workspace, query, limit: limit ?? 8 })`；`userId` 取当前用户 id，**取不到回退 `'local'`**（与 `memoryService.ts:153` 的既有回退一致）。第一版可直接传 `'local'`，但要在代码注释里写明这是回退值
- `codegraph_search` / `codegraph_explore` → `request('codeRetrieval.call', { workspace, tool: name, args })`
- `request` 抛错 → `{ isError: true, text: error.message }`
- 结果 `JSON.stringify` 后若超过 4000 字则 `slice(0, 4000)`

循环（`runProjectEnhance`）：

1. `messages: Message[] = [{ role: 'user', content: text, timestamp: Date.now() }]`
2. `executed = 0`，`round = 0`
3. `runtime = await host.ensure()`，`tools = executed >= 8 || round >= 4 ? [] : ENHANCE_TOOLS`
4. `buffered = ''`；`const stream = runtime.stream(model, { systemPrompt, messages, tools }, { signal })`，用**同一个 `drain`**（任务 5 已导出，把泛型放宽到 `AssistantMessageEvent`）迭代：`text_delta` 累加到 buffered，**仅当 `tools.length === 0` 时 emit**；最终消息取 `await stream.result()`（不要去猜 `done.message`——`done` 确实带 `message`，但 `result()` 是 SDK 给的正道，且异常路径也能拿到）
5. 从 assistant `content` 抽出 `toolCall[]`
6. 无 toolCall：若刚才没 live emit，则 `emit(buffered)`（可一次整段）；`return sanitizeEnhanceOutput(buffered)`
7. 有 toolCall：对每个 call，若 `executed >= 8` 则 toolResult 文本为「已达到工具次数上限」，`isError: true`，不 request；否则 `executed++`，执行工具
8. `messages.push(assistant, ...toolResults)`，`round++`，回到 3
9. 工具 JSON / toolcall 事件不 `emit`

`run()` 在 `useProject === true` 时走 `runProjectEnhance`，超时 90s（任务 5 已按开关选 timeout）。

事件形状已核实（`electron-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts`）：`AssistantMessageEvent` 的 `done` 是 `{ type: 'done', reason: 'stop' | 'length' | 'toolUse' | 'deferred', message: AssistantMessage }`，`error` 是 `{ type: 'error', reason: 'aborted' | 'error', error: AssistantMessage }`。据此：

- 判「这轮还要不要跑工具」用 `message.content` 里的 `toolCall`，**不要**依赖 `stopReason` 字段（真实事件里没有，只有 `reason`）。
- 报错文案从 `AssistantMessage` 里取 `errorMessage` / `content[].text`，没有就回落 `'增强失败'`。
- `AssistantMessageEventStream` 有 `result(): Promise<AssistantMessage>`，正常结束与 `error` 结束都能拿到最终消息。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project main electron/app/enhancePrompt.test.ts
```

预期：PASS。默认路径用例仍不调用 `runtime.stream`。

- [ ] **步骤 5：Commit**（仅当用户要求）

---

### 任务 8：`enhancePromptStore`

**文件：**
- 创建：`electron-agent/src/stores/enhancePromptStore.ts`
- 测试：`electron-agent/src/stores/enhancePromptStore.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { useEnhancePromptStore } from './enhancePromptStore';

describe('enhancePromptStore', () => {
  it('start bump seq 并清空 preview；过期 append 忽略', () => {
    useEnhancePromptStore.setState({ byWorkspace: {} });
    const seq1 = useEnhancePromptStore.getState().start('/ws', { awaitingContext: true, source: '原文' });
    useEnhancePromptStore.getState().append('/ws', seq1, 'a');
    const seq2 = useEnhancePromptStore.getState().start('/ws', { source: '原文2' });
    useEnhancePromptStore.getState().append('/ws', seq1, '旧');
    useEnhancePromptStore.getState().append('/ws', seq2, '新');
    const slot = useEnhancePromptStore.getState().byWorkspace['/ws'];
    expect(seq2).toBeGreaterThan(seq1);
    expect(slot.preview).toBe('新');
    expect(slot.awaitingContext).toBe(false);
    expect(slot.source).toBe('原文2');
    expect(slot.status).toBe('streaming');
  });

  it('finish 用清洗稿替换 preview；cancel 变 idle', () => {
    useEnhancePromptStore.setState({ byWorkspace: {} });
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    useEnhancePromptStore.getState().append('/ws', seq, '流');
    useEnhancePromptStore.getState().finish('/ws', seq, '清洗');
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']).toMatchObject({ status: 'done', preview: '清洗' });
    useEnhancePromptStore.getState().cancel('/ws');
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']?.status ?? 'idle').toBe('idle');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project renderer src/stores/enhancePromptStore.test.ts
```

- [ ] **步骤 3：编写最少实现代码**

```ts
import { create } from 'zustand';

export type EnhancePromptStatus = 'idle' | 'streaming' | 'done' | 'error';

export interface EnhancePromptSlot {
  status: EnhancePromptStatus;
  preview: string;
  error: string;
  seq: number;
  awaitingContext: boolean;
  source: string;
}

interface EnhancePromptState {
  byWorkspace: Record<string, EnhancePromptSlot>;
  start: (workspace: string, opts?: { awaitingContext?: boolean; source?: string }) => number;
  append: (workspace: string, seq: number, chunk: string) => void;
  finish: (workspace: string, seq: number, content: string) => void;
  fail: (workspace: string, seq: number, error: string) => void;
  cancel: (workspace: string) => void;
  clear: (workspace: string) => void;
}

const empty = (): EnhancePromptSlot => ({
  status: 'idle', preview: '', error: '', seq: 0, awaitingContext: false, source: '',
});

export const useEnhancePromptStore = create<EnhancePromptState>((set, get) => ({
  byWorkspace: {},
  start: (workspace, opts) => {
    const prev = get().byWorkspace[workspace];
    const seq = (prev?.seq ?? 0) + 1;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [workspace]: {
          status: 'streaming',
          preview: '',
          error: '',
          seq,
          awaitingContext: Boolean(opts?.awaitingContext),
          source: opts?.source ?? '',
        },
      },
    });
    return seq;
  },
  append: (workspace, seq, chunk) => {
    const cur = get().byWorkspace[workspace];
    if (!cur || cur.seq !== seq) return;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [workspace]: { ...cur, preview: cur.preview + chunk, awaitingContext: false },
      },
    });
  },
  finish: (workspace, seq, content) => {
    const cur = get().byWorkspace[workspace];
    if (!cur || cur.seq !== seq) return;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [workspace]: { ...cur, status: 'done', preview: content, awaitingContext: false, error: '' },
      },
    });
  },
  fail: (workspace, seq, error) => {
    const cur = get().byWorkspace[workspace];
    if (!cur || cur.seq !== seq) return;
    set({
      byWorkspace: {
        ...get().byWorkspace,
        [workspace]: { ...cur, status: 'error', error, awaitingContext: false },
      },
    });
  },
  cancel: (workspace) => {
    const cur = get().byWorkspace[workspace];
    if (!cur) return;
    // seq 必须 +1：cancel 后若还没 start，主进程迟到的 delta 仍带着旧 seq，匹配上就会写进空槽。
    set({ byWorkspace: { ...get().byWorkspace, [workspace]: { ...empty(), seq: cur.seq + 1 } } });
  },
  clear: (workspace) => {
    const next = { ...get().byWorkspace };
    delete next[workspace];
    set({ byWorkspace: next });
  },
}));
```

`clear` 直接删槽（`status` 变 `undefined`，浮层按「槽不存在」不 portal）；`cancel` 保留槽但置 `idle` 且 `seq + 1`。两条路径都不能让迟到 delta 复活预览。

- [ ] **步骤 4：运行测试验证通过**

- [ ] **步骤 5：Commit**（仅当用户要求）

---

### 任务 9：预览浮层

**文件：**
- 创建：`electron-agent/src/features/chat/input/EnhancePromptOverlay.tsx`
- 测试：`electron-agent/src/features/chat/input/EnhancePromptOverlay.test.tsx`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx`

- [ ] **步骤 1：编写失败的测试**

对标 `ComposerPromptOverlay.test.tsx`：mock `AgentStoreContext` workspace=`/ws`，mock `useChatInput` 的 `setValue`，mock `pi.abortEnhancePrompt`。

```ts
it('idle 不 portal', () => {
  renderOverlay();
  expect(screen.queryByTestId('enhance-prompt-overlay')).toBeNull();
});

it('delta 追加；应用调用 setValue；取消不调用 setValue', async () => {
  const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
  renderOverlay();
  useEnhancePromptStore.getState().append('/ws', seq, '美化');
  expect(screen.getByTestId('enhance-prompt-preview').textContent).toContain('美化');
  fireEvent.click(screen.getByTestId('enhance-prompt-apply'));
  expect(setValue).toHaveBeenCalledWith('美化');
});

it('awaitingContext 显示正在结合项目上下文…，首包后生成中', () => {
  useEnhancePromptStore.getState().start('/ws', { awaitingContext: true, source: '原文' });
  renderOverlay();
  expect(screen.getByTestId('enhance-prompt-status').textContent).toContain('正在结合项目上下文');
  useEnhancePromptStore.getState().append('/ws', useEnhancePromptStore.getState().byWorkspace['/ws'].seq, 'x');
  expect(screen.getByTestId('enhance-prompt-status').textContent).toContain('生成中');
});
```

取消用例：点 `enhance-prompt-cancel` 后 `setValue` 未被调用，且 `abortEnhancePrompt('/ws')` 被调用。

粘贴块仍在：本浮层只 `setValue`，不断言 chips；在注释里写明由 ChatInput 状态保持。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project renderer src/features/chat/input/EnhancePromptOverlay.test.tsx
```

- [ ] **步骤 3：编写最少实现代码**

复制 `ComposerPromptOverlay` 的量位置：`MENU_GAP = 8`，`position: fixed`，`left/bottom/width` 来自 `anchorRef.getBoundingClientRect()`。**z-index: 1040**（低于询问浮层 1050 与 slash 菜单 1100）。

portal：`document.getElementById(LOBE_THEME_APP_ID) ?? document.body`。

当前 workspace 槽 `status === 'idle'` 或不存在 → `return null`。

卡片：标题「增强提示词」、状态、`<pre>` 或可滚动预览、`取消`、`应用`、关闭 X。

状态文案：

- `awaitingContext` → 「正在结合项目上下文…」
- `streaming` → 「生成中」
- `done` → 「完成」
- `error` → 错误一行写在按钮上方；预览优先 `preview`，空则 `source`

应用：`preview.trim()` 为空或 `status === 'error'` 时禁用。生成中且 preview 非空可应用。点击：`setValue(preview)`，`pi.abortEnhancePrompt(workspace)`，`store.clear(workspace)`。

取消 / X：`abortEnhancePrompt` + `cancel`/`clear`，不 toast。

Esc：**capture** 阶段 `window.addEventListener('keydown', onKey, true)`，`key === 'Escape'` 等同取消。不关：失焦、点外面。

切工作区（规格 §2 / §4.3）：本组件内 `useEffect` 依赖 `workspace`，卸载/切换时 `pi.abortEnhancePrompt(prevWorkspace)` + `store.clear(prevWorkspace)`。用 ref 记住上一个 workspace，不要在 cleanup 里读已变的值。另外 `EnhancePromptAction` 侧也要在切工作区时清掉「浮层已开」的判断。

`MessageEditor.tsx` 在 `ComposerPromptOverlay` 旁：

```tsx
<EnhancePromptOverlay anchorRef={surfaceRef} />
```

- [ ] **步骤 4：运行测试验证通过**

同一 vitest + `src/features/chat/input/editor/MessageEditor.test.tsx`（若因未 mock 新浮层而挂，在该测试文件 mock `../EnhancePromptOverlay` 为 `() => null`，与现有对重型子组件的处理一致）。

- [ ] **步骤 5：Commit**（仅当用户要求）

---

### 任务 10：按钮、context.readDraft、发送前 abort

**文件：**
- 修改：`electron-agent/src/features/chat/input/config.tsx`
- 创建：`electron-agent/src/features/chat/input/actions/EnhancePromptAction.tsx`
- 测试：`electron-agent/src/features/chat/input/actions/EnhancePromptAction.test.tsx`
- 修改：`electron-agent/src/features/chat/input/ChatInputContext.tsx`
- 修改：`electron-agent/src/features/chat/ChatInput.tsx`
- 测试：`electron-agent/src/features/chat/ChatInput.test.tsx`
- 修改：`electron-agent/src/features/chat/input/GoalPill.tsx`
- 修改：`electron-agent/src/features/chat/input/actions/actions.test.tsx`
- 修改：`electron-agent/src/features/chat/input/actions/extensionActions.test.tsx`

- [ ] **步骤 1：编写失败的测试**

先给两个 action 测试的 `ChatInputContextValue` 字面量补 `readDraft: () => ''`，否则任务中途类型失败。

`EnhancePromptAction.test.tsx`：

- mock `useChatInput`：`empty`、`readDraft`、`setValue`
- mock `peekComposerModel`、`pi.getSettings` / `pi.getState` / `pi.enhancePrompt` / `Channel`
- mock `useInlineQuestionStore` / `useUiPromptStore` / `useGoalStore`

用例：

1. `empty === true` 时按钮 `disabled`（有 `title=增强提示词`）
2. 询问 store 有条目时 disabled
3. `empty === false` 且 `peekComposerModel` 有值时可点
4. 实验开：`getState` 返回 sessionId，goalStore 有 snapshot → `enhancePrompt` 第四参为 `状态: active\n条件: 完成登录`
5. 取不到 sessionId → goalText 为 `''`

`ChatInput.test.tsx` 追加：mock `../../lib/pi` 的 `abortEnhancePrompt`，点发送后 **先** `abortEnhancePrompt('/ws')` 再 `cancelPendingOverlay`。断言 `onSend` 的正文仍是 `getDocument()` 的原文，不是预览稿。把 abort mock 放进 hoisted，并在 `send()` 路径可观察调用顺序：

```ts
expect(abortEnhancePrompt.mock.invocationCallOrder[0]).toBeLessThan(cancelPendingOverlay.mock.invocationCallOrder[0]);
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project renderer src/features/chat/input/actions/EnhancePromptAction.test.tsx src/features/chat/ChatInput.test.tsx
```

- [ ] **步骤 3：编写最少实现代码**

`config.tsx`：

- import `EnhancePromptAction`
- `actionMap.enhancePrompt = EnhancePromptAction`
- `ACTION_LABELS.enhancePrompt = '增强提示词'`
- `DEFAULT_RIGHT_ACTIONS = ['enhancePrompt']`
- **不要**写入 `COLLAPSE_PRIORITY`
- `ACTION_WIDTH.enhancePrompt = 28`

`ChatInputContextValue` 增加 `readDraft: () => string`。`ChatInput.tsx` 的 `ctx` 放入已有 `readDraft`。

`GoalPill.tsx`：`export function readSessionId`（原 function 改 export）。

`EnhancePromptAction.tsx` 要点：

- `ActionIcon` + `Wand2`，`size="small"`，`title`「增强提示词」，`data-testid="composer-enhance-prompt"`
- 设置只在挂载 / `workspace` 变化时拉一次：`useEffect` 里 `pi.getSettings()` 存进 `useState`。渲染层没有 settings store，只有 `pi.getSettings` 这一条 IPC（`pi.ts:262`），别在 render 里同步读。拿到之前按「未配置增强模型」处理。
- 禁用：`empty` 或 `hasBlockingPrompt(workspace)` 或（`!peekComposerModel(workspace)` 且 `enhancePromptModel?.trim()` 为空）
- `hasBlockingPrompt`：`inlineQuestionStore.byWorkspace[workspace]` 或 `uiPrompt` 且 `shouldRenderUiPromptInOverlay`
- 点击：若当前槽 status 不是 `idle`（浮层已开）则 return
- `const text = readDraft().trim()`；`text.length > 16000` → `App.useApp().message.warning('正文过长，请缩短后再增强')` 并 return（`App` 从 `antd` 导入，`ChatInput.tsx` 已用 `App.useApp()`）
- 判实验开关用**已拉到的那一份** settings（`useState` 里的值，不再 `await getSettings()`）：开则 `awaitingContext: true` 并组装 goal（`readSessionId(await pi.getState(workspace))` + `useGoalStore.getState().bySession[id]` → `状态: ${status}\n条件: ${condition}`，超 `MAX_GOAL_CHARS` 截断）
- `store.start(workspace, { awaitingContext, source: text })`
- `const onChunk = new Channel<string>(); onChunk.onmessage = (c) => store.append(workspace, seq, c)`
- `const result = await pi.enhancePrompt(workspace, text, onChunk, goalText)`
- `cancelled` → `clear`；`ok` → `finish(seq, result.content)`；否则 `fail(seq, result.error || '增强失败')`
- 加载中：`aria-busy`，`title`「正在增强…」，外观可点但不重复 `start`

`ChatInput.tsx` `send`：在 `sendingRef.current = true` 之后、`cancelPendingOverlay` 之前：

```ts
      void pi.abortEnhancePrompt(workspace);
      useEnhancePromptStore.getState().clear(workspace);
```

从 `../../lib/pi` 导入 `pi`（若 ChatInput 尚未 import pi）。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project renderer src/features/chat/input/actions/EnhancePromptAction.test.tsx src/features/chat/input/actions/actions.test.tsx src/features/chat/input/actions/extensionActions.test.tsx src/features/chat/ChatInput.test.tsx src/features/chat/input/EnhancePromptOverlay.test.tsx src/features/settings/settingsSchema.test.ts
```

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run --project main electron/app/enhancePrompt.test.ts electron/agent/hostOneshotAdapter.test.ts electron/agent/modelRuntimeHost.test.ts electron/ipc/register.test.ts
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**（仅当用户要求）

---

## 自检

1. **规格覆盖**
   - 按钮位置 / Wand2 / 不折叠 → 任务 10 `config.tsx`
   - 预览 portal / z-index 1040 / Esc capture / 应用 setValue → 任务 9
   - readDraft 进 context / 发送前 abort → 任务 10
   - 模型解析不传 session.model 对象 / SettingsService.getAll → 任务 5
   - Host.streamSimple 默认路径 / 不经 oneshot JSON 行 → 任务 5、2
   - 清洗 / 系统提示原文 → 任务 4
   - 设置两项 + default `'0'` + scrub → 任务 3
   - IPC Channel emit → 任务 6
   - 实验五工具 / 4 回合 / 8 次 / 4000 字 / 90s / 非 short call → 任务 7
   - ShortCallInput / hostOneshotAdapter / main 不再 runOneshotWithRuntime → 任务 1–2
   - 中止 / 超时可打断（`drain` + `iterator.return`）→ 任务 5，任务 7 工具循环复用同一个
   - 切工作区中止并关浮层 → 任务 9
2. **占位符：** 任务 5 曾用「实验路径尚未实现」仅作为中间 commit；任务 7 必须删掉该分支。
3. **类型名：** `EnhancePromptResult`、`ShortCallInput`、`createEnhancePrompt`、`runHostOneshot`、`drain`、store 字段 `awaitingContext` / `seq` / `source` 前后任务一致。
4. **不要**把 `AssistantMessageEventStream` 当 generator 用：`for await` 收不住 abort，两处短调用/工具循环都必须走 `drain`。
