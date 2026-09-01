# Electron 自动对话标题开关实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 恢复 Electron 首轮对话的自动标题生成，并在“通用与模型”页增加一个保存后即时生效、位于独立设置行最右侧的开关。

**架构：** Electron 继续通过现有设置 schema、`useSettingsForm` 和 `SettingsService` 写入 `runtime-settings.json`。`auto-title` 扩展在每次 `agent_end` 时读取热配置，优先使用标题模型；该模型失败或返回空标题时最多回退一次当前对话模型，并在写入前重新检查手动标题。

**技术栈：** TypeScript、React 19、Ant Design、Vitest、Electron Vite、Pi extension API

---

## 文件结构

- 创建：`extensions/auto-title/index.test.ts`：覆盖热开关、跳过条件、模型回退和手动命名竞态。
- 修改：`extensions/auto-title/index.ts`：按事件读取 `AUTO_TITLE`，执行有限回退并保护已有标题。
- 创建：`electron-agent/src/features/settings/settingsSchema.test.ts`：锁定 Electron 字段定义、默认值和排列顺序。
- 修改：`electron-agent/src/features/settings/settingsSchema.ts`：在标题模型后增加 `AUTO_TITLE` boolean 字段。
- 修改：`electron-agent/src/features/settings/useSettingsForm.test.ts`：验证开关值通过现有手动保存流程写入。

### 任务 1：让自动标题开关支持运行时热更新

**文件：**
- 创建：`extensions/auto-title/index.test.ts`
- 修改：`extensions/auto-title/index.ts`

- [ ] **步骤 1：编写热开关和基础跳过条件的失败测试**

在 `extensions/auto-title/index.test.ts` 建立扩展测试夹具。mock 必须在导入扩展前定义，使 `getConfig`、`resolveSummaryModel` 和 `summarize` 可逐用例控制：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: new Map<string, string>(),
  summarize: vi.fn(),
  resolveSummaryModel: vi.fn(),
}));

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: (key: string) => mocks.config.get(key),
}));
vi.mock("../_shared/summarize.js", () => ({
  summarize: mocks.summarize,
  resolveSummaryModel: mocks.resolveSummaryModel,
}));

import autoTitle from "./index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

function makePi() {
  const handlers: Record<string, Handler> = {};
  const setSessionName = vi.fn(() => Promise.resolve());
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
    setSessionName,
  } as never;
  autoTitle(pi);
  return { handlers, setSessionName };
}

function makeContext(entries: Array<{ type?: string; name?: string }> = []) {
  return {
    model: { provider: "chat", id: "main" },
    modelRegistry: { find: vi.fn() },
    sessionManager: { getEntries: () => entries },
    signal: undefined,
  } as never;
}

const EVENT = { messages: [{ role: "user", content: "修复自动标题" }] };

beforeEach(() => {
  mocks.config.clear();
  mocks.summarize.mockReset().mockResolvedValue("自动标题修复");
  mocks.resolveSummaryModel.mockReset().mockReturnValue({ provider: "title", id: "fast" });
  delete process.env.PI_IS_SUBAGENT;
});

afterEach(() => {
  delete process.env.PI_IS_SUBAGENT;
});

describe("auto-title", () => {
  it("缺少 AUTO_TITLE 时默认启用，并在运行时关闭后跳过", async () => {
    const { handlers, setSessionName } = makePi();
    await handlers.agent_end(EVENT, makeContext());
    await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith("自动标题修复"));

    mocks.config.set("AUTO_TITLE", "0");
    setSessionName.mockClear();
    mocks.summarize.mockClear();
    await handlers.agent_end(EVENT, makeContext());
    await Promise.resolve();
    expect(mocks.summarize).not.toHaveBeenCalled();
    expect(setSessionName).not.toHaveBeenCalled();
  });

  it("子代理和已有名字的会话不生成标题", async () => {
    const { handlers } = makePi();
    process.env.PI_IS_SUBAGENT = "1";
    await handlers.agent_end(EVENT, makeContext());
    delete process.env.PI_IS_SUBAGENT;
    await handlers.agent_end(EVENT, makeContext([{ type: "session_info", name: "手动标题" }]));
    expect(mocks.summarize).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行测试并确认当前模块级开关无法满足热更新**

运行：

```bash
cd extensions
npm test -- auto-title/index.test.ts
```

预期：FAIL；第二次触发 `agent_end` 时仍调用 `summarize`，因为现有 `ENABLED` 只在模块加载时读取一次环境变量。

- [ ] **步骤 3：实现按事件读取热配置的最小改动**

在 `extensions/auto-title/index.ts` 导入运行时配置，删除模块级 `ENABLED` 和 factory 提前返回，并把开关判断放到事件处理器最前面：

```ts
import { getConfig } from "../_shared/runtime-config.js";

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    try {
      if ((getConfig("AUTO_TITLE") ?? "1") === "0") return;
      if (process.env.PI_IS_SUBAGENT === "1") return;
      if (alreadyNamed(ctx)) return;
      // 保留后续现有流程。
    } catch (err) {
      console.error("[auto-title] error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
  });
}
```

- [ ] **步骤 4：运行定向测试验证热开关通过**

运行：

```bash
cd extensions
npm test -- auto-title/index.test.ts
```

预期：PASS，2 个测试全部通过。

- [ ] **步骤 5：提交热开关改动**

```bash
git add extensions/auto-title/index.ts extensions/auto-title/index.test.ts
git commit -m "fix: 支持自动标题开关热更新"
```

### 任务 2：增加标题模型回退和手动命名竞态保护

**文件：**
- 修改：`extensions/auto-title/index.test.ts`
- 修改：`extensions/auto-title/index.ts`

- [ ] **步骤 1：补充模型回退和竞态的失败测试**

在 `extensions/auto-title/index.test.ts` 的 `describe` 中增加：

```ts
it("标题模型返回空内容时回退当前对话模型", async () => {
  const { handlers, setSessionName } = makePi();
  mocks.summarize.mockResolvedValueOnce("").mockResolvedValueOnce("回退标题");
  await handlers.agent_end(EVENT, makeContext());
  await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith("回退标题"));
  expect(mocks.summarize).toHaveBeenCalledTimes(2);
  expect(mocks.summarize.mock.calls[1]?.[2]).toMatchObject({ modelSpec: "chat/main" });
});

it("标题模型抛错时回退当前对话模型", async () => {
  const { handlers, setSessionName } = makePi();
  mocks.summarize.mockRejectedValueOnce(new Error("title failed")).mockResolvedValueOnce("回退标题");
  await handlers.agent_end(EVENT, makeContext());
  await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith("回退标题"));
  expect(mocks.summarize).toHaveBeenCalledTimes(2);
});

it("标题模型就是当前对话模型时不重复调用", async () => {
  const { handlers, setSessionName } = makePi();
  mocks.resolveSummaryModel.mockReturnValue({ provider: "chat", id: "main" });
  mocks.summarize.mockResolvedValue("");
  await handlers.agent_end(EVENT, makeContext());
  await vi.waitFor(() => expect(mocks.summarize).toHaveBeenCalledTimes(1));
  expect(setSessionName).not.toHaveBeenCalled();
});

it("回退也失败时不写标题", async () => {
  const { handlers, setSessionName } = makePi();
  mocks.summarize.mockResolvedValue("");
  await handlers.agent_end(EVENT, makeContext());
  await vi.waitFor(() => expect(mocks.summarize).toHaveBeenCalledTimes(2));
  expect(setSessionName).not.toHaveBeenCalled();
});

it("生成期间出现手动标题时不覆盖", async () => {
  const entries: Array<{ type?: string; name?: string }> = [];
  let finish!: (value: string) => void;
  mocks.summarize.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
  const { handlers, setSessionName } = makePi();
  await handlers.agent_end(EVENT, makeContext(entries));
  await vi.waitFor(() => expect(mocks.summarize).toHaveBeenCalledTimes(1));
  entries.push({ type: "session_info", name: "用户命名" });
  finish("模型标题");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(setSessionName).not.toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行测试并确认回退与竞态用例失败**

运行：

```bash
cd extensions
npm test -- auto-title/index.test.ts
```

预期：FAIL；当前实现只调用一次 `summarize`，且生成后没有再次检查 `session_info`。

- [ ] **步骤 3：实现模型身份比较和一次性回退**

在 `extensions/auto-title/index.ts` 增加局部辅助函数。它只接受当前扩展已使用的模型字段，不修改共享 `summarize` API：

```ts
type SummaryModel = { provider: string; id: string };

function modelSpec(model: SummaryModel): string {
  return `${model.provider}/${model.id}`;
}

function sameModel(left: SummaryModel, right: SummaryModel): boolean {
  return left.provider === right.provider && left.id === right.id;
}

async function generateTitle(
  ctx: ExtensionContext,
  input: string,
  primaryModel: SummaryModel,
): Promise<string> {
  const options = { systemPrompt: TITLE_PROMPT, maxChars: 80, signal: ctx.signal };
  try {
    const title = await summarize(ctx, input, options);
    if (title) return title;
  } catch {
    // 标题模型失败后仅允许下方的一次对话模型回退。
  }

  const currentModel = ctx.model as SummaryModel | undefined;
  if (!currentModel || sameModel(primaryModel, currentModel)) return "";
  return summarize(ctx, input, { ...options, modelSpec: modelSpec(currentModel) });
}
```

在 `agent_end` 中保存已解析的首选模型，并替换后台任务正文：

```ts
const primaryModel = resolveSummaryModel(ctx) as SummaryModel | undefined;
if (!primaryModel) return;

void (async () => {
  try {
    const title = await generateTitle(ctx, firstUser, primaryModel);
    if (title && !alreadyNamed(ctx)) await pi.setSessionName(title);
  } catch (err) {
    console.error("[auto-title] error:", err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
})();
```

- [ ] **步骤 4：运行扩展测试验证全部通过**

运行：

```bash
cd extensions
npm test -- auto-title/index.test.ts
```

预期：PASS，热开关、跳过条件、成功、两类回退、回退失败和手动命名竞态全部通过。

- [ ] **步骤 5：提交回退与竞态保护**

```bash
git add extensions/auto-title/index.ts extensions/auto-title/index.test.ts
git commit -m "fix: 为自动标题增加模型回退"
```

### 任务 3：在 Electron 设置页增加右侧对齐开关

**文件：**
- 创建：`electron-agent/src/features/settings/settingsSchema.test.ts`
- 修改：`electron-agent/src/features/settings/settingsSchema.ts`
- 修改：`electron-agent/src/features/settings/useSettingsForm.test.ts`

- [ ] **步骤 1：编写字段结构、排列和保存值的失败测试**

创建 `electron-agent/src/features/settings/settingsSchema.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { SETTINGS_SCHEMA } from './settingsSchema';

describe('SETTINGS_SCHEMA general', () => {
  it('在标题模型后提供默认开启的自动标题开关', () => {
    const fields = SETTINGS_SCHEMA.find((category) => category.id === 'general')?.fields ?? [];
    const autoTitle = fields.find((field) => field.key === 'AUTO_TITLE');
    expect(autoTitle).toMatchObject({
      label: '自动生成对话标题',
      type: 'boolean',
      default: '1',
      description: '首轮对话结束后生成简短标题（默认开）',
    });
    expect(fields.map((field) => field.key)).toEqual([
      'titleModel',
      'AUTO_TITLE',
      'COMPACTION_PREVIEW',
    ]);
  });
});
```

在 `electron-agent/src/features/settings/useSettingsForm.test.ts` 增加：

```ts
it('保存自动标题开关值且不重启 sidecar', async () => {
  const { result } = renderHook(() => useSettingsForm());
  await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
  act(() => result.current.setValue('AUTO_TITLE', '0'));
  await act(async () => {
    await result.current.persist();
  });
  expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ AUTO_TITLE: '0' }));
  expect(closeWorkspace).not.toHaveBeenCalled();
  expect(openWorkspace).not.toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行设置定向测试确认 schema 测试失败**

运行：

```bash
cd electron-agent
npm test -- src/features/settings/settingsSchema.test.ts src/features/settings/SettingField.test.tsx src/features/settings/useSettingsForm.test.ts
```

预期：FAIL；`AUTO_TITLE` 字段不存在。

- [ ] **步骤 3：在 Electron schema 中插入独立 boolean 行**

在 `electron-agent/src/features/settings/settingsSchema.ts` 的 `titleModel` 后、`COMPACTION_PREVIEW` 前插入：

```ts
{
  key: 'AUTO_TITLE',
  label: '自动生成对话标题',
  type: 'boolean',
  default: '1',
  description: '首轮对话结束后生成简短标题（默认开）',
},
```

不修改 `SettingField.tsx`：现有 boolean 分支已经使用 `styles.row` 的 `justify-content: space-between` 和固定宽度 `styles.control`，新字段会自然与“压缩上下文前确认”的开关共享最右侧对齐线。

- [ ] **步骤 4：运行 Electron 设置测试验证字段、默认态、布局组件和保存通过**

运行：

```bash
cd electron-agent
npm test -- src/features/settings/settingsSchema.test.ts src/features/settings/SettingField.test.tsx src/features/settings/useSettingsForm.test.ts
```

预期：PASS；schema、通用 boolean 右侧行渲染和 `AUTO_TITLE=0` 保存测试全部通过。

- [ ] **步骤 5：提交 Electron 设置改动**

```bash
git add electron-agent/src/features/settings/settingsSchema.ts electron-agent/src/features/settings/settingsSchema.test.ts electron-agent/src/features/settings/useSettingsForm.test.ts
git commit -m "feat: 添加 Electron 自动标题开关"
```

### 任务 4：完成构建与 Electron 行为验收

**文件：**
- 验证：`extensions/auto-title/index.ts`
- 验证：`electron-agent/src/features/settings/settingsSchema.ts`

- [ ] **步骤 1：运行扩展定向回归测试**

运行：

```bash
cd extensions
npm test -- auto-title/index.test.ts _shared/runtime-config.test.ts
```

预期：两个测试文件全部 PASS，进程退出码为 0。

- [ ] **步骤 2：运行 Electron 设置定向回归测试**

运行：

```bash
cd electron-agent
npm test -- src/features/settings/settingsSchema.test.ts src/features/settings/SettingField.test.tsx src/features/settings/useSettingsForm.test.ts electron/app/settingsService.test.ts
```

预期：PASS，进程退出码为 0。

- [ ] **步骤 3：构建 Electron 应用**

运行：

```bash
cd electron-agent
npm run build
```

预期：TypeScript 检查和 `electron-vite build` 均成功，进程退出码为 0。

- [ ] **步骤 4：启动 Electron 开发版并目视验收设置布局**

运行：

```bash
cd electron-agent
npm run dev
```

验收：打开“设置 → 通用与模型”，确认“自动生成对话标题”位于“对话标题模型”和“压缩上下文前确认”之间；开关处于独立行最右侧，并与下方开关右边缘对齐。关闭并保存后重新进入页面仍显示关闭，开启并保存后无需重启 sidecar。

- [ ] **步骤 5：验收真实标题生成链路**

在 Electron 中完成三次新对话：开关开启时侧栏出现自动标题；关闭并保存后新对话保持默认标题；重新开启并保存后下一次新对话恢复自动标题。已有手动标题不得被后台结果覆盖。

- [ ] **步骤 6：检查最终差异范围**

运行：

```bash
git diff -- extensions/auto-title/index.ts extensions/auto-title/index.test.ts electron-agent/src/features/settings/settingsSchema.ts electron-agent/src/features/settings/settingsSchema.test.ts electron-agent/src/features/settings/useSettingsForm.test.ts
git status --short
```

预期：功能差异只涉及计划列出的 5 个文件；工作区其余既有改动保持原样。
