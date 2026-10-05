# 子代理任务名 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
>
> 本计划对应的代码已在当前工作区落地，尚未提交。勾选表示该代码步骤已完成。

**目标：** 主代理调用 `spawn_agent` 时自带一句短任务名，界面用它做子代理卡片名；auto-title 仍只给主会话起名。

**架构：** `title` 是 `spawn_agent` 的可选参数。单任务写在顶层，并行项和链式步骤写在各自对象上。解析流式参数时，顶层 `title` 和每一项的 `title` 都等字符串或对象闭合后再进卡片。展示函数优先用这份名字，缺省时仍从任务原文截一句。`normalizeTasks` 不把 `title` 抄进子代理正文。

**技术栈：** TypeScript、TypeBox、Vitest、React。

**规格：** `docs/superpowers/specs/2026-10-04-subagent-task-title-design.md`

---

## 文件结构

- 修改 `extensions/multi-agent/tasks.ts`：闭合的并行/链式项带上 `title`；只认根对象上的 `title`。
- 修改 `extensions/multi-agent/tasks.test.ts`：覆盖闭合标题、链式步骤、嵌套标题不算顶层。
- 修改 `extensions/multi-agent/index.ts`：schema 与 Guidelines。执行路径继续只把 `task` 交给子代理。
- 修改 `electron-agent/src/stores/agentReducer.ts`：流式 `spawn_agent` 参数在标题闭合前不写进卡片。
- 修改 `electron-agent/src/stores/agentReducer.test.ts`：未闭合标题不出现，闭合后同时有 `title` 和 `task`。
- 修改 `electron-agent/src/features/panels/subagentUtils.ts`：卡片名、按调用展开出的 `title`。
- 修改 `electron-agent/src/features/panels/subagentUtils.test.ts`。
- 修改 `electron-agent/src/features/chat/SubAgentInline.tsx`、`ChatMessageItems.tsx`、`SubAgentGroupInline.tsx`。
- 修改 `electron-agent/src/features/subagents/SubAgentCard.tsx`、`SubAgentMenuButton.tsx`。
- 修改对应的 `SubAgentInline.test.tsx`、`SubAgentMenuButton.test.tsx`。
- 创建 `docs/superpowers/specs/2026-10-04-subagent-task-title-design.md`。
- 创建 `docs/decisions/extensions/2026-10-04-subagent-task-title.md`。

不改 `extensions/auto-title/`。不改组标题「并行子代理 · N 个」「链式子代理 · N 步」。

---

### 任务 1：闭合解析带上 title

**文件：**
- 修改：`extensions/multi-agent/tasks.ts`
- 测试：`extensions/multi-agent/tasks.test.ts`

- [x] **步骤 1：编写失败的测试**

在 `tasks.test.ts` 增加：

```ts
import { closedChainSteps, closedParallelTasks, closedTopLevelString, normalizeTasks, spawnHasWork } from "./tasks.js";

it("keeps a closed title and waits for the object to close", () => {
  const partial = '{"tasks":[{"title":"审服务端","task":"请完整审查服务端"';
  expect(closedParallelTasks(partial)).toEqual([]);
  expect(closedParallelTasks(`${partial}}]`)).toEqual([
    { task: "请完整审查服务端", model: undefined, agent: undefined, title: "审服务端" },
  ]);
});

it("returns only closed steps, including title", () => {
  const raw = '{"chain":[{"title":"第一步","task":"做甲"},{"title":"第二';
  expect(closedChainSteps(raw)).toEqual([
    { task: "做甲", model: undefined, agent: undefined, title: "第一步" },
  ]);
});

it("reads a closed top-level title and ignores nested titles", () => {
  expect(closedTopLevelString('{"title":"审服务端","task":"全文"}', "title")).toBe("审服务端");
  expect(closedTopLevelString('{"tasks":[{"title":"嵌套"}],"title":"顶层"}', "title")).toBe("顶层");
  expect(closedTopLevelString('{"tasks":[{"title":"嵌套"}]}', "title")).toBeUndefined();
});

it("returns null while the top-level title string is still open", () => {
  expect(closedTopLevelString('{"title":"审', "title")).toBeNull();
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run multi-agent/tasks.test.ts`
预期：FAIL，`closedChainSteps` / `closedTopLevelString` 尚未导出，或闭合对象没有 `title`。

- [x] **步骤 3：编写最少实现代码**

`NormalizedTask` 增加可选 `title`。把原来的 `closedParallelTasks` 收成按键名取数组的 `closedTaskArray`。对象闭合后读出 `title`。`normalizeTasks` 仍只输出 `task` / `model` / `agent`，不把 `title` 交给子代理。

```ts
export interface NormalizedTask {
  task: string;
  model?: string;
  agent?: string;
  /** 卡片上的短任务名。不进入子代理正文。 */
  title?: string;
}

export function closedParallelTasks(raw: string): NormalizedTask[] {
  return closedTaskArray(raw, "tasks");
}

export function closedChainSteps(raw: string): NormalizedTask[] {
  return closedTaskArray(raw, "chain");
}
```

对象分支在已有 `task` / `model` / `agent` 上追加：

```ts
const title = typeof obj.title === "string" ? clean(obj.title) : undefined;
out.push({
  task,
  model: typeof obj.model === "string" ? clean(obj.model) : undefined,
  agent: typeof obj.agent === "string" ? clean(obj.agent) : undefined,
  ...(title ? { title } : {}),
});
```

`arrayContent` 的键名从写死的 `"tasks"` 改成参数 `key`。

顶层标题只在根对象深度为 1、且当前期待键名时匹配，避免把 `tasks[].title` 当成顶层 `title`：

```ts
export function closedTopLevelString(raw: string, key: string): string | undefined | null {
  let depth = 0;
  let i = 0;
  let expectKey = false;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '"') {
      const parsed = readJsonString(raw, i);
      if (!parsed) return null;
      if (depth === 1 && expectKey && parsed.value === key) {
        let j = parsed.end;
        while (j < raw.length && /\s/.test(raw[j]!)) j++;
        if (raw[j] !== ":") return null;
        j++;
        while (j < raw.length && /\s/.test(raw[j]!)) j++;
        if (j >= raw.length || raw[j] !== '"') return null;
        const value = readJsonString(raw, j);
        if (!value) return null;
        return value.value;
      }
      if (depth === 1 && expectKey) expectKey = false;
      i = parsed.end;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      if (c === "{" && depth === 1) expectKey = true;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      depth--;
      i++;
      continue;
    }
    if (depth === 1 && c === ",") expectKey = true;
    i++;
  }
  return undefined;
}
```

- [x] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run multi-agent/tasks.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/multi-agent/tasks.ts extensions/multi-agent/tasks.test.ts
git commit -m "feat: parse closed spawn titles without sending them to the child"
```

---

### 任务 2：spawn_agent 接收 title

**文件：**
- 修改：`extensions/multi-agent/index.ts`（`registerTool` 的 `spawn_agent`，约 444 行起）

- [x] **步骤 1：改 schema 和 Guidelines**

`description` 在 “Returns the sub-agent output(s).” 前加一句：`title` 是短卡片名，子代理仍接收完整 `task`。

`promptGuidelines` 第一条：

```ts
"Use spawn_agent 时每次都带 title：一句任务名，不超过 24 字，用用户当前语言。单任务写在顶层；并行 tasks 和链式 chain 的每一项各自带 title。title 只做卡片名，完整要求仍写在 task。",
```

参数：

- 顶层 `title`：`Type.Optional(Type.String({ description: "Short card name: one clause, at most 24 characters, in the user's language. Not sent to the sub-agent." }))`，放在 `task` 之前。
- `tasks` 的对象项、`chain` 的每一步同样加可选 `title`。
- 数组说明改为 `{ title, task, model, agent }`；链式说明写明每步都带 `title`。
- `title` 保持可选。不在 `execute` 里读取它，子代理正文仍来自 `normalizeTasks` 的 `task`。

- [x] **步骤 2：确认执行路径不消费 title**

`extensions/multi-agent/index.ts` 里 `const list = normalizeTasks(params)` 之后，子代理只拿到 `task` 字符串。不要把 `params.title` 拼进提示词，也不要写进子会话名。

- [ ] **步骤 3：Commit**

```bash
git add extensions/multi-agent/index.ts
git commit -m "feat: accept a short title on spawn_agent"
```

---

### 任务 3：流式参数等 title 闭合

**文件：**
- 修改：`electron-agent/src/stores/agentReducer.ts` 的 `closedSpawnArgs`
- 测试：`electron-agent/src/stores/agentReducer.test.ts` 的 `toolcall streaming`

- [x] **步骤 1：编写失败的测试**

```ts
it('spawn_agent 的 title 等字符串闭合后才写进卡片', () => {
  let s = applyEvent(initialAgentState(), toolUpdate({
    type: 'toolcall_start', contentIndex: 0, id: 'call_title', toolName: 'spawn_agent',
  }));
  s = applyEvent(s, toolUpdate({
    type: 'toolcall_delta', contentIndex: 0, delta: '{"title":"审服',
  }));
  const growing = materializeToolDrafts(s, 10_000, parsePartialArgs);
  const growingCard = toolCards(growing.state)[0];
  expect(growingCard?.kind === 'tool' ? growingCard.args : { title: 'kept' }).toEqual({});

  s = applyEvent(s, toolUpdate({
    type: 'toolcall_delta', contentIndex: 0, delta: '务端","task":"请完整审查"}',
  }));
  const closed = materializeToolDrafts(s, 10_000, parsePartialArgs);
  expect(toolCards(closed.state)[0]).toMatchObject({ args: { title: '审服务端', task: '请完整审查' } });
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/stores/agentReducer.test.ts`
预期：FAIL。未闭合时卡片上已经有半截 `title`，或闭合后没有 `title`。

- [x] **步骤 3：编写最少实现代码**

`closedSpawnArgs` 从 `@extensions/multi-agent/tasks` 引入 `closedChainSteps`、`closedTopLevelString`、`NormalizedTask`。

并行项有 `title` 时保留对象，不能压成纯字符串，否则标题会丢：

```ts
function closedTaskArg(item: NormalizedTask): string | { task: string; title?: string; model?: string; agent?: string } {
  if (!item.model && !item.agent && !item.title) return item.task;
  return {
    task: item.task,
    ...(item.title ? { title: item.title } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.agent ? { agent: item.agent } : {}),
  };
}
```

链式步骤始终是对象。顶层 `title` 用 `closedTopLevelString`：是字符串就写入，否则 `delete next.title`。

```ts
const chain = closedChainSteps(json);
if ('chain' in parsed || chain.length > 0) {
  next.chain = chain.map((item) => ({
    task: item.task,
    ...(item.title ? { title: item.title } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.agent ? { agent: item.agent } : {}),
  }));
}
const titleField = closedTopLevelString(json, 'title');
if (typeof titleField === 'string') next.title = titleField;
else delete next.title;
```

- [x] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/stores/agentReducer.test.ts`
预期：PASS。原有「未闭合的 tasks 和 task 不写进卡片」仍然通过。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/stores/agentReducer.ts electron-agent/src/stores/agentReducer.test.ts
git commit -m "fix: show spawn titles only after the argument string closes"
```

---

### 任务 4：卡片名优先用 title

**文件：**
- 修改：`electron-agent/src/features/panels/subagentUtils.ts`
- 测试：`electron-agent/src/features/panels/subagentUtils.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
expect(subAgentCardTitle('审服务端', '请完整审查一次已完成的服务端改动，审完再回复。')).toBe('审服务端');
expect(subAgentCardTitle('标'.repeat(30), '任务')).toBe(`${'标'.repeat(24)}…`);
expect(subAgentCardTitle(undefined, '你是代码审查代理。请完整审查服务端改动。')).toBe('完整审查服务端改动');

expect(spawnUnitTitle({ title: '审服务端', task: '全文' }, null)).toBe('审服务端');
expect(spawnUnitTitle({ tasks: [{ title: '审接口', task: '全文' }, '另一项'] }, 0)).toBe('审接口');
expect(spawnUnitTitle({ tasks: ['没有标题'] }, 0)).toBeUndefined();
expect(spawnUnitTitle({ chain: [{ title: '第一步', task: '做甲' }] }, 0)).toBe('第一步');

const single = expandSubAgents('m1', { title: '审服务端', task: '请完整审查服务端改动。' }, {}, 'done');
expect(single[0]?.title).toBe('审服务端');
expect(single[0]?.task).toBe('请完整审查服务端改动。');
```

并行字符串项的 `title` 为 `undefined`。已有 `expandSubAgents` 用例不带 `title` 时，结果对象里也不要出现 `title` 键。

- [x] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/panels/subagentUtils.test.ts`
预期：FAIL，`subAgentCardTitle` 未导出。

- [x] **步骤 3：编写最少实现代码**

```ts
const CARD_TITLE_MAX = 24;

export function subAgentCardTitle(title: string | undefined, task: string): string {
  const explicit = title?.replace(/\s+/g, ' ').trim();
  if (explicit) return explicit.length > CARD_TITLE_MAX ? `${explicit.slice(0, CARD_TITLE_MAX)}…` : explicit;
  return taskTitle(task);
}

export function spawnUnitTitle(args: unknown, subIndex: number | null): string | undefined {
  const a = (args ?? {}) as SpawnArgs;
  if (subIndex == null) {
    const top = cleanTitle(a.title);
    if (top) return top;
    const only = a.tasks?.length === 1 ? a.tasks[0] : undefined;
    if (only && typeof only === 'object') return cleanTitle(only.title);
    return undefined;
  }
  const step = a.chain?.[subIndex];
  if (step) return cleanTitle(step.title);
  const item = a.tasks?.[subIndex];
  if (item && typeof item === 'object') return cleanTitle(item.title);
  return undefined;
}
```

`SpawnArgs` 的 `task`、`tasks` 项、`chain` 项都加上可选 `title`。`unitWorks` / `explicitWorks` 把非空 `title` 带到 `UnitWork`。`unitTasks` 仍只返回任务原文，给 `subAgentMode` 计数。`SubAgentUnit` 增加可选 `title`。`expandSubAgents` 仅在有标题时展开 `{ title }`。

`subAgentUnitView(...).task` 继续是完整任务原文，右坞对话不拿短标题代替指令。

- [x] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/panels/subagentUtils.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/panels/subagentUtils.ts electron-agent/src/features/panels/subagentUtils.test.ts
git commit -m "feat: prefer the spawn title on sub-agent cards"
```

---

### 任务 5：把卡片名接到界面

**文件：**
- 修改：`electron-agent/src/features/chat/SubAgentInline.tsx`
- 修改：`electron-agent/src/features/chat/ChatMessageItems.tsx`
- 修改：`electron-agent/src/features/chat/SubAgentGroupInline.tsx`
- 修改：`electron-agent/src/features/subagents/SubAgentCard.tsx`
- 修改：`electron-agent/src/features/subagents/SubAgentMenuButton.tsx`
- 测试：`electron-agent/src/features/chat/SubAgentInline.test.tsx`
- 测试：`electron-agent/src/features/subagents/SubAgentMenuButton.test.tsx`

- [x] **步骤 1：编写失败的测试**

`SubAgentInline`：传入 `title="审服务端"` 和一段带角色句的长 `task`。折叠头出现「审服务端」，不出现从原文截出的「完整审查一次已完成的服务端改动」。

`SubAgentMenuButton`：registry 项的 `task` 是长文，当前会话里对应 `spawn_agent` 的 `args.title` 是「审改动」。打开菜单后卡片文字是「审改动」。

- [x] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/SubAgentInline.test.tsx src/features/subagents/SubAgentMenuButton.test.tsx`
预期：FAIL。折叠头仍显示截句；菜单仍显示 registry 长任务。

- [x] **步骤 3：编写最少实现代码**

`SubAgentInline` 增加可选 `title`。折叠头 `role` 和右坞标签都用 `subAgentCardTitle(title, task)`。展开后的「查看指令」仍渲染完整 `task`。

`ChatMessageItems` 把 `only?.unit.title` 传给 `SubAgentInline`。

`SubAgentGroupInline` 每一行和右坞标签用 `subAgentCardTitle(unit.title, unit.task)`。组头文案保持「并行子代理」「链式子代理」加数量，不改成某一步的 `title`。

`SubAgentCard` 增加可选 `label`。可见文字用 `label || item.task`。`title` 属性仍是 registry 里的完整任务，身份色仍按 `item.task` 计算。

`SubAgentMenuButton` 在当前会话消息里按 `agentId` 找到 `spawn_agent`，用 `spawnUnitTitle` 取出标题再交给 `subAgentCardTitle`。找不到时 `label` 为 `undefined`，卡片继续显示 registry 任务原文。打开右坞时，对得上的标签用这个短名。

- [x] **步骤 4：运行测试验证通过**

运行：

```bash
cd electron-agent && npx vitest run src/features/panels/subagentUtils.test.ts src/stores/agentReducer.test.ts src/features/chat/SubAgentInline.test.tsx src/features/subagents/SubAgentMenuButton.test.tsx
```

预期：PASS（本次为 4 files、126 tests）。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/SubAgentInline.tsx electron-agent/src/features/chat/SubAgentInline.test.tsx electron-agent/src/features/chat/ChatMessageItems.tsx electron-agent/src/features/chat/SubAgentGroupInline.tsx electron-agent/src/features/subagents/SubAgentCard.tsx electron-agent/src/features/subagents/SubAgentMenuButton.tsx electron-agent/src/features/subagents/SubAgentMenuButton.test.tsx
git commit -m "feat: show spawn titles on sub-agent cards and the menu"
```

---

### 任务 6：规格与决策记录

**文件：**
- 创建：`docs/superpowers/specs/2026-10-04-subagent-task-title-design.md`
- 创建：`docs/decisions/extensions/2026-10-04-subagent-task-title.md`

- [x] **步骤 1：写规格**

规格写明：顶层与每项可选 `title`；不进入子代理正文；Guidelines 要求一句、不超过 24 字；界面优先显示并截断；旧会话和未闭合参数退回 `taskTitle`；菜单对不上当前会话时显示 registry 原文；组标题不变；不另跑标题模型；不改 auto-title。

- [x] **步骤 2：写决策笔记**

按 `docs/decisions/_template.md`。决定是主代理在参数里提交任务名。放弃的方案：派发时再调摘要模型；继续只截任务原文。后果：模型可能漏写，漏写时退回截句；跨会话菜单看不到这份参数。

- [ ] **步骤 3：Commit**

与代码同一次提交，或单独：

```bash
git add docs/superpowers/specs/2026-10-04-subagent-task-title-design.md docs/superpowers/plans/2026-10-04-subagent-task-title.md docs/decisions/extensions/2026-10-04-subagent-task-title.md
git commit -m "docs: record the spawn_agent task title decision"
```

提交前跑 `node scripts/check-notes.mjs`。

---

## 规格覆盖

| 规格 | 任务 |
| --- | --- |
| 单任务顶层 `title`，并行/链式对象各自带 `title`，字符串项仍合法 | 任务 2、任务 4 |
| `title` 不进入子代理正文 | 任务 1 的 `normalizeTasks`、任务 2 |
| schema 可选；Guidelines 要求每次都写，一句、不超过 24 字 | 任务 2 |
| 卡片、每一行、菜单、右坞标签优先显示，超过 24 字截断 | 任务 4、任务 5 |
| 没有 `title` 或字符串未闭合时用 `taskTitle` | 任务 3、任务 4 |
| 菜单对不上当前会话时显示 registry 原文 | 任务 5 |
| 组标题不变 | 任务 5 |
| 不另跑标题模型，不改 auto-title，不写子会话名 | 无对应代码任务，明确不做 |
