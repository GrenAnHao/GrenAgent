# 热控制面：运行时读内存 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 审批与模式各只留一张进程内 live 表；对话中切档先改内存，下一刀工具按新档拦截，文件只做重启恢复。

**架构：** 审批收口到已有的 `extensions/_shared/approval.ts`，删掉主进程 `approvalPolicyStore`。模式在 `extensions/agent-mode/modes.ts` 补与审批同形的 `get` / `set` / `has`。宿主 `write*` 先 `set(workspace)` 再落盘。热路径只 `get*`。`session_start` 只在该 cwd 未写入时灌盘。模式本回合靠门闩读 live；工具集下一轮 `before_agent_start` 用 `sessionCtx` 对齐。`applyMode` 必须同时 `setAgentMode`。

**技术栈：** TypeScript、vitest、Electron 进程内 SDK 宿主、`extensions/` 扩展。

**上游规格：** `docs/superpowers/specs/2026-09-11-live-control-plane-design.md`

---

## 关键约束（动工前必读）

**不要重做已到位的部分。** `writeApprovalPolicy` 已经是「先 `set(workspace)` 再 resolved / 落盘」；`safety` / `mcp-policy` 已 `getApprovalPolicy()`；审批「盘盖不过内存」单测已有。本计划只收口第二张表、补 `has*`、改模式写路径与扩展接线。

**进程内宿主可以跨包 import `extensions/`。** `piRuntimeService.ts` 已经 `import { setApprovalPolicy } from '../../../extensions/_shared/approval.js'`。本计划同样允许 `import { getAgentMode, setAgentMode } from '../../../extensions/agent-mode/modes.js'`。不要套用 S1「两包不得互引」的旧约束。

**`gateToolCall(mode, toolName, input)` 保持纯函数。** 改的是 `tool_call` hook，不是 `modes.ts` 里那份签名。纯函数单测继续按传入的 `mode` 测。

**`get*` 的默认值不是「已写入」。** 未写入时 `getApprovalPolicy` 回退 `auto`、`getAgentMode` 回退 `agent`。冷路径用 `hasApprovalPolicy` / `hasAgentMode`（`Map.has`）判断该 cwd 是否写过。显式 `set('auto')` / `set('agent')` 之后 `has*` 为 true。

**键。** 写路径继续双写 IPC 别名 + `resolveWorkspace` 后的路径。热路径读 `ctx.cwd` / ALS `cwd` / `call.workspace`（`collectFacts` 填的是 `ctx.cwd`）。

**不改 Tauri、slash 菜单、删段 pulse。** `/plan-build` 与 `/brainstorm-deliver` 不收成 IPC，但必须走 `applyMode`（内含 `setAgentMode`）。

**不要求本回合 `setActiveTools`。** 桌面切档后同一回合门闩已是新档即可；工具可见集下一轮再齐。

**测试命令。** 扩展包统一 `cd extensions` 再 `npx vitest run <相对路径>`；宿主 `cd electron-agent`。不要用根目录 `tsc -p tsconfig.json` 当类型检查（solution 配置检查 0 个文件）。

**模式 `session_start` 清 todos。** 仅当文件档位存在、与条目里已恢复的 `currentMode` 不一致、且文件不是 `plan` 时才清。文件与条目同为 `agent`（或同为 `ask` / `debug`）且条目带 `executing` + todos 时必须保留，否则跨会话 plan 执行恢复会被清掉。

**冷路径不要 `appendEntry`。** `!hasAgentMode` 灌表时 `applyMode(..., { silent: true, persist: false })`。`has live && live !== currentMode` 才走默认 persist，用来把 IPC 新档写进会话。

**桌面切走 plan。** IPC 让 `watchConfig` 空操作之后，`before_agent_start` 必须对齐现网 `switchMode`：`currentMode === "plan" && live !== "plan"` 时先清 todos / `executionMode`，再 `applyMode`。

---

## 文件结构

修改（不新建业务文件；删一个）：

| 文件 | 职责 |
| --- | --- |
| `extensions/_shared/approval.ts` | 补 `hasApprovalPolicy` |
| `extensions/_shared/approval.test.ts` | `has*`：未写入 vs 显式默认档 |
| `extensions/approval/index.ts` | `session_start` 仅未写入时灌表 |
| `extensions/approval/index.test.ts` | 已有 live 不被过期 `getConfig` 覆盖 |
| `extensions/agent-mode/modes.ts` | 补 `getAgentMode` / `setAgentMode` / `hasAgentMode` / `__resetAgentModeForTest` |
| `extensions/agent-mode/modes.test.ts` | 模式 live 表单测 |
| `extensions/agent-mode/index.ts` | hook 读 live；`applyMode` 写 live；`before_agent_start` 对齐；`session_start` / `watchConfig` 按规格 |
| `extensions/agent-mode/index.test.ts` | hook、plan-build、session_start、before_agent_start |
| `electron-agent/electron/app/toolPermission/toolDecisionService.ts` | `evaluate` 改 `getApprovalPolicy` |
| `electron-agent/electron/app/toolPermission/toolDecisionService.test.ts` | 夹具改 `setApprovalPolicy`；补空表覆盖 `facts.preset` |
| `electron-agent/electron/app/piRuntimeService.ts` | 删 `setLiveApprovalPolicy`；`writeAgentMode` 先写内存 |
| `electron-agent/electron/app/piRuntimeService.test.ts` | 去掉 live store；补模式内存优先 / 非法档 / 无路径 |
| `electron-agent/electron/app/toolPermission/approvalPolicyStore.ts` | **删除** |

不改：`ApprovalAction.tsx`、`ModeAction.tsx`、Tauri、`runtime-config.ts` 的 150 ms 防抖、删段 pulse。

---

### 任务 1：`hasApprovalPolicy`

**文件：**
- 修改：`extensions/_shared/approval.ts`
- 测试：`extensions/_shared/approval.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `extensions/_shared/approval.test.ts` 顶部 import 加上 `hasApprovalPolicy`。在 `describe("getApprovalPolicy 分键")` 末尾追加：

```typescript
  it("hasApprovalPolicy 区分未写入与显式默认档", () => {
    expect(hasApprovalPolicy("D:/a")).toBe(false);
    expect(getApprovalPolicy("D:/a")).toBe("auto");
    setApprovalPolicy("auto", "D:/a");
    expect(hasApprovalPolicy("D:/a")).toBe(true);
    expect(hasApprovalPolicy("D:/b")).toBe(false);
  });
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd extensions
npx vitest run _shared/approval.test.ts
```

预期：FAIL，`hasApprovalPolicy is not defined` 或编译失败。

- [ ] **步骤 3：编写最少实现代码**

在 `extensions/_shared/approval.ts` 的 `setApprovalPolicy` 之后加入：

```typescript
export function hasApprovalPolicy(cwd?: string): boolean {
  return byCwd.has(resolveCwd(cwd));
}
```

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd extensions
npx vitest run _shared/approval.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/_shared/approval.ts extensions/_shared/approval.test.ts
git commit -m "feat(审批): 用 hasApprovalPolicy 区分未写入与默认档"
```

---

### 任务 2：审批 `session_start` 不覆盖已写入的 live

**文件：**
- 修改：`extensions/approval/index.ts`
- 测试：`extensions/approval/index.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `extensions/approval/index.test.ts` 顶部 import 加上 `setApprovalPolicy` 与 `hasApprovalPolicy`（若测试里只用 `set`/`get` 也可不加 `has`）。在 `describe("approval policy inheritance on session_start")` 末尾追加：

```typescript
  it("session_start 不覆盖该 cwd 已写入的 live", async () => {
    setApprovalPolicy("full", "D:/proj-a");
    vi.mocked(getConfig).mockReturnValue("ask");
    await loadSessionStart()(
      {},
      ctx([{ type: "custom", customType: "approval", data: { policy: "ask" } }], "D:/proj-a"),
    );
    expect(getApprovalPolicy("D:/proj-a")).toBe("full");
  });
```

`ctx` 助手已支持第二参 `cwd`。现有「空表从文件灌」用例不要改——`beforeEach` 会 `__resetApprovalForTest()`，那些用例仍走未写入分支。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd extensions
npx vitest run approval/index.test.ts
```

预期：FAIL，`getApprovalPolicy("D:/proj-a")` 变成 `"ask"`（无条件 `set` 覆盖）。

- [ ] **步骤 3：编写最少实现代码**

`extensions/approval/index.ts` 增加 `hasApprovalPolicy` 的 import。把 `session_start` 里无条件的 `setApprovalPolicy(...)` 改成：

```typescript
    if (!hasApprovalPolicy(ctx.cwd)) {
      setApprovalPolicy(
        parseApproval(getConfig(approvalPolicyConfigKey(cwd()))) ??
          parseApproval(getConfig("APPROVAL_POLICY")) ??
          parseApproval(data?.policy) ??
          "auto",
        ctx.cwd,
      );
    }
    push(ctx);
```

`watchConfig` 不要动（已与 `get*` 比较）。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd extensions
npx vitest run approval/index.test.ts _shared/approval.test.ts
```

预期：PASS。原有 inheritance 用例仍绿。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/approval/index.ts extensions/approval/index.test.ts
git commit -m "feat(审批): session_start 不覆盖已写入的 live"
```

---

### 任务 3：模式 live API

**文件：**
- 修改：`extensions/agent-mode/modes.ts`
- 测试：`extensions/agent-mode/modes.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `extensions/agent-mode/modes.test.ts` **顶部** import 增加 `beforeEach`、`getAgentMode`、`setAgentMode`、`hasAgentMode`、`__resetAgentModeForTest`，以及与 `approval.test.ts` 相同的 `mkdtemp` / `writeFile` / `join` / `tmpdir` / `runInWorkspace`。文件级 `beforeEach(() => __resetAgentModeForTest())`。现有 `describe` 保持不动，在文件末尾追加：

```typescript
describe("agent mode live 表", () => {
  it("未写入时 get 回退 agent，has 为 false", () => {
    expect(hasAgentMode("D:/a")).toBe(false);
    expect(getAgentMode("D:/a")).toBe("agent");
  });

  it("set 之后立刻 get 为新值，随后改盘也盖不过", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-mode-live-"));
    const runtime = join(directory, "runtime-settings.json");
    process.env.PI_RUNTIME_CONFIG = runtime;
    setAgentMode("ask", "D:/a");
    await writeFile(runtime, JSON.stringify({ [agentModeConfigKey("D:/a")]: "plan" }));
    expect(getAgentMode("D:/a")).toBe("ask");
    expect(getAgentMode("D:/b")).toBe("agent");
    expect(hasAgentMode("D:/a")).toBe(true);
    delete process.env.PI_RUNTIME_CONFIG;
  });

  it("无参时读 ALS cwd", async () => {
    setAgentMode("plan", "D:/a");
    setAgentMode("debug", "D:/b");
    await runInWorkspace(
      { origin: "main", workspace: "D:/a", cwd: "D:/a", config: {} },
      async () => {
        expect(getAgentMode()).toBe("plan");
      },
    );
  });

  it("显式写成 agent 之后 has 为 true", () => {
    setAgentMode("agent", "D:/a");
    expect(hasAgentMode("D:/a")).toBe(true);
    expect(getAgentMode("D:/a")).toBe("agent");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd extensions
npx vitest run agent-mode/modes.test.ts
```

预期：FAIL，`getAgentMode is not exported`。

- [ ] **步骤 3：编写最少实现代码**

在 `extensions/agent-mode/modes.ts` 顶部增加：

```typescript
import { currentCwd } from "../_shared/workspace-context.js";
```

把文件头「无 I/O」改成「无磁盘 I/O；live 表只碰内存」。在 `agentModeConfigKey` 之后、`ASK_TOOLS` 之前插入（`normalizeCwd` 已在文件里，复用，不要再写一份）：

```typescript
const byCwd = new Map<string, AgentMode>();

function resolveCwd(cwd?: string): string {
  return normalizeCwd(cwd ?? currentCwd());
}

export function getAgentMode(cwd?: string): AgentMode {
  return byCwd.get(resolveCwd(cwd)) ?? DEFAULT_MODE;
}

export function setAgentMode(mode: AgentMode, cwd?: string): void {
  byCwd.set(resolveCwd(cwd), mode);
}

export function hasAgentMode(cwd?: string): boolean {
  return byCwd.has(resolveCwd(cwd));
}

/** 仅测试。 */
export function __resetAgentModeForTest(): void {
  byCwd.clear();
}
```

`gateToolCall` 不要改签名。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd extensions
npx vitest run agent-mode/modes.test.ts
```

预期：PASS。原有 `gateToolCall` 纯函数用例仍绿。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/agent-mode/modes.ts extensions/agent-mode/modes.test.ts
git commit -m "feat(模式): 增加与审批同形的 live API"
```

---

### 任务 4：`evaluate` 收口到 `getApprovalPolicy`，删除第二张表

**文件：**
- 修改：`electron-agent/electron/app/toolPermission/toolDecisionService.ts`
- 修改：`electron-agent/electron/app/toolPermission/toolDecisionService.test.ts`
- 修改：`electron-agent/electron/app/piRuntimeService.ts`
- 修改：`electron-agent/electron/app/piRuntimeService.test.ts`
- 删除：`electron-agent/electron/app/toolPermission/approvalPolicyStore.ts`

- [ ] **步骤 1：编写失败的测试**

`electron-agent/electron/app/toolPermission/toolDecisionService.test.ts`：

1. 把

```typescript
import { __resetLiveApprovalPoliciesForTest, setLiveApprovalPolicy } from './approvalPolicyStore';
```

改成

```typescript
import { __resetApprovalForTest, setApprovalPolicy } from '../../../../extensions/_shared/approval.js';
```

2. `afterEach` 里 `__resetLiveApprovalPoliciesForTest()` 改成 `__resetApprovalForTest()`。
3. 两处 `setLiveApprovalPolicy('D:/repo', …)` 改成 `setApprovalPolicy(…, 'D:/repo')`（注意参数顺序：档位在前，cwd 在后）。
4. 在 `describe('ToolDecisionService live approval preset')` 里追加：

```typescript
  it('空表时忽略 facts.preset=full，按 auto 拦危险命令', async () => {
    const { service } = await fixture();
    const decision = service.evaluate(facts({
      preset: 'full',
      flags: { ...NO_FLAGS, dangerousCommand: true },
    }));
    expect(decision).toMatchObject({ decision: 'ask', ruleId: 'builtin.dangerous-command' });
  });
```

`piRuntimeService.test.ts`：删掉 `getLiveApprovalPolicy` / `__resetLiveApprovalPoliciesForTest` 的 import 与所有调用。保留 `getApprovalPolicy` / `__resetApprovalForTest` 的断言（`expect(getApprovalPolicy('C:/work')).toBe('full')` 已有）。在「对话中切审批档立刻打进内存」那个 `describe` 附近追加（与现有 `fakeAgentHost` / `noopModelHost` / `emptyGoalHost` 同一文件）：

```typescript
  it('非法审批档不写内存也不落盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-approval-invalid-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, JSON.stringify({ 'APPROVAL_POLICY:c:/work': 'ask' }));
    __resetApprovalForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      goalHost: emptyGoalHost(),
      runtimeConfigPath,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_approval', { level: 'nope' })).rejects.toThrow('INVALID_APPROVAL_POLICY');
      expect(getApprovalPolicy('C:/work')).toBe('auto');
      expect(JSON.parse(await readFile(runtimeConfigPath, 'utf8'))['APPROVAL_POLICY:c:/work']).toBe('ask');
    } finally {
      __resetApprovalForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('无 runtimeConfigPath 时审批内存已改再抛', async () => {
    __resetApprovalForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      goalHost: emptyGoalHost(),
    });
    try {
      await expect(service.send('C:/work', 'agent_set_approval', { level: 'full' })).rejects.toThrow('RUNTIME_CONFIG_UNAVAILABLE');
      expect(getApprovalPolicy('C:/work')).toBe('full');
    } finally {
      __resetApprovalForTest();
    }
  });
```

「无路径」用例今天就会过（`writeApprovalPolicy` 已先 `set` 再抛）。先写下、一并跑；不要为它改生产代码。非法档用例今天就会过。空表 `evaluate` 今天会 FAIL（未写入时不覆盖 `facts.preset`，`full` 放行危险命令）。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd electron-agent
npx vitest run electron/app/toolPermission/toolDecisionService.test.ts
```

预期：空表用例 FAIL，`decision` 为 `allow` 而不是 `ask`。若 import 已改但 `evaluate` 仍引用 `getLiveApprovalPolicy`，整文件编译失败——也算本步预期，进入步骤 3。

- [ ] **步骤 3：编写最少实现代码**

`toolDecisionService.ts`：

```typescript
import { getApprovalPolicy } from '../../../../extensions/_shared/approval.js';
```

删掉 `approvalPolicyStore` 的 import。`evaluate` 开头改成：

```typescript
    const live = getApprovalPolicy(call.workspace);
    const facts = live !== call.preset ? { ...call, preset: live } : call;
```

`piRuntimeService.ts`：

- 删掉 `setLiveApprovalPolicy` / `LiveApprovalPolicy` 的 import。
- `writeApprovalPolicy` 里两处 `setLiveApprovalPolicy(...)` 删掉，只留 `setApprovalPolicy`。档位类型直接用 `'ask' | 'auto' | 'full'`，不要再经过 `LiveApprovalPolicy`。

删除文件 `electron-agent/electron/app/toolPermission/approvalPolicyStore.ts`。生产代码与测试不得再出现 `approvalPolicyStore`、`setLiveApprovalPolicy`、`getLiveApprovalPolicy`、`LiveApprovalPolicy`（规格 / 本计划文档里的历史名字可留）。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd electron-agent
npx vitest run electron/app/toolPermission/toolDecisionService.test.ts electron/app/piRuntimeService.test.ts
```

预期：PASS。再用搜索确认无残留符号。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/electron/app/toolPermission/toolDecisionService.ts electron-agent/electron/app/toolPermission/toolDecisionService.test.ts electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/app/piRuntimeService.test.ts
git add -u electron-agent/electron/app/toolPermission/approvalPolicyStore.ts
git commit -m "feat(审批): evaluate 只读 getApprovalPolicy，删除第二张表"
```

---

### 任务 5：`writeAgentMode` 先写内存再落盘

**文件：**
- 修改：`electron-agent/electron/app/piRuntimeService.ts`
- 测试：`electron-agent/electron/app/piRuntimeService.test.ts`

- [ ] **步骤 1：编写失败的测试**

`piRuntimeService.test.ts` 顶部增加：

```typescript
import { getAgentMode, __resetAgentModeForTest } from '../../../extensions/agent-mode/modes.js';
```

在审批 live 测试附近追加：

```typescript
  it('对话中切模式立刻打进内存，不跟盘上旧值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-mode-live-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, JSON.stringify({ 'AGENT_MODE:c:/work': 'agent' }));
    __resetAgentModeForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      goalHost: emptyGoalHost(),
      runtimeConfigPath,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'ask' })).resolves.toEqual({ ok: true, mode: 'ask' });
      await writeFile(runtimeConfigPath, JSON.stringify({ 'AGENT_MODE:c:/work': 'agent' }));
      expect(getAgentMode('C:/work')).toBe('ask');
    } finally {
      __resetAgentModeForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writeAgentMode 同时写入 resolved 键', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-mode-resolved-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, '{}');
    __resetAgentModeForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      goalHost: emptyGoalHost(),
      runtimeConfigPath,
      resolveWorkspace: async () => 'D:/resolved-project',
    });
    try {
      await expect(service.send('alias', 'agent_set_mode', { mode: 'debug' })).resolves.toEqual({ ok: true, mode: 'debug' });
      expect(getAgentMode('alias')).toBe('debug');
      expect(getAgentMode('D:/resolved-project')).toBe('debug');
      const written = JSON.parse(await readFile(runtimeConfigPath, 'utf8')) as Record<string, string>;
      expect(written['AGENT_MODE:alias']).toBe('debug');
      expect(written['AGENT_MODE:d:/resolved-project']).toBe('debug');
    } finally {
      __resetAgentModeForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('非法模式不写内存也不落盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-mode-invalid-'));
    const runtimeConfigPath = join(root, 'runtime-settings.json');
    await writeFile(runtimeConfigPath, JSON.stringify({ 'AGENT_MODE:c:/work': 'agent' }));
    __resetAgentModeForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      goalHost: emptyGoalHost(),
      runtimeConfigPath,
    });
    try {
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'nope' })).rejects.toThrow('INVALID_AGENT_MODE');
      expect(getAgentMode('C:/work')).toBe('agent');
      expect(hasAgentMode('C:/work')).toBe(false);
      expect(JSON.parse(await readFile(runtimeConfigPath, 'utf8'))['AGENT_MODE:c:/work']).toBe('agent');
    } finally {
      __resetAgentModeForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('无 runtimeConfigPath 时模式内存已改再抛', async () => {
    __resetAgentModeForTest();
    const service = new PiRuntimeService({
      agentDir: 'C:/agent',
      agentHost: fakeAgentHost().host,
      modelRuntimeHost: noopModelHost,
      goalHost: emptyGoalHost(),
    });
    try {
      await expect(service.send('C:/work', 'agent_set_mode', { mode: 'plan' })).rejects.toThrow('RUNTIME_CONFIG_UNAVAILABLE');
      expect(getAgentMode('C:/work')).toBe('plan');
    } finally {
      __resetAgentModeForTest();
    }
  });
```

非法档用例的 `hasAgentMode` 也要从 `modes.js` import。今天「切模式立刻打进内存」和「无路径」会 FAIL：`writeAgentMode` 不碰内存，无路径时在 `set` 之前就抛。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd electron-agent
npx vitest run electron/app/piRuntimeService.test.ts
```

预期：FAIL，`getAgentMode('C:/work')` 仍是 `'agent'`，或无路径时内存未改。

- [ ] **步骤 3：编写最少实现代码**

`piRuntimeService.ts` 增加：

```typescript
import { isAgentMode, setAgentMode } from '../../../extensions/agent-mode/modes.js';
```

把 `writeAgentMode` 整段换成（校验失败不得 `set`；`set(workspace)` 必须在第一个 `await` 之前）：

```typescript
  private async writeAgentMode(workspace: string, rawMode: unknown): Promise<{ ok: true; mode: string }> {
    const mode = String(rawMode ?? '').trim().toLowerCase();
    if (!isAgentMode(mode)) throw new Error('INVALID_AGENT_MODE');
    setAgentMode(mode, workspace);
    const path = this.options.runtimeConfigPath;
    if (!path) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
    const resolved = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    setAgentMode(mode, resolved);
    await mergeRuntimeSettingsFile(path, {
      [agentModeConfigKey(workspace)]: mode,
      [agentModeConfigKey(resolved)]: mode,
    });
    return { ok: true, mode };
  }
```

宿主不要调用 `applyMode`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd electron-agent
npx vitest run electron/app/piRuntimeService.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```powershell
git add electron-agent/electron/app/piRuntimeService.ts electron-agent/electron/app/piRuntimeService.test.ts
git commit -m "feat(模式): writeAgentMode 先写内存再落盘"
```

---

### 任务 6：扩展门闩、`applyMode`、冷路径与下一轮对齐

**文件：**
- 修改：`extensions/agent-mode/index.ts`
- 测试：`extensions/agent-mode/index.test.ts`

- [ ] **步骤 1：编写失败的测试**

先改 `index.test.ts` 的 `load()`，让它能调到命令和 hook（原有断言不要丢）：

```typescript
import {
  agentModeConfigKey,
  getAgentMode,
  setAgentMode,
  __resetAgentModeForTest,
} from "./modes.js";

function load() {
  const commands: string[] = [];
  const commandHandlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const handlers: Record<string, (event: unknown, ctx?: unknown) => unknown> = {};
  const setActiveTools = vi.fn();
  const appendEntry = vi.fn();
  factory({
    registerCommand: (name: string, spec?: { handler?: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.push(name);
      if (spec?.handler) commandHandlers[name] = spec.handler;
    },
    on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
      handlers[event] = handler;
    },
    appendEntry,
    getActiveTools: () => ["read", "write", "bash", "edit"],
    setActiveTools,
    registerTool: () => {},
    sendMessage: vi.fn(),
  } as never);
  return { commands, commandHandlers, handlers, setActiveTools, appendEntry };
}
```

`beforeEach` 增加 `__resetAgentModeForTest()`。

在 `describe("agent-mode factory")` 里追加（保留现有 watch / session_start 两条）：

```typescript
  it("tool_call 按 live 拦截，即使闭包 currentMode 未刷", async () => {
    const { handlers } = load();
    const session = ctx("D:/proj-a");
    await handlers.session_start?.({}, session);
    setAgentMode("ask", "D:/proj-a");
    const result = await handlers.tool_call?.({ toolName: "write", input: { path: "a.ts" } }, session);
    expect(result).toMatchObject({ block: true });
  });

  it("plan-build 之后 live 为 agent，门闩放行 write", async () => {
    const { handlers, commandHandlers } = load();
    const session = ctx("D:/proj-a", [
      {
        type: "custom",
        customType: "agent-mode",
        data: {
          mode: "plan",
          todos: [{ step: 1, text: "写文件", completed: false }],
          executing: false,
        },
      },
    ]);
    vi.mocked(getConfig).mockImplementation((name: string) =>
      name === agentModeConfigKey("D:/proj-a") ? "plan" : undefined,
    );
    await handlers.session_start?.({}, session);
    expect(getAgentMode("D:/proj-a")).toBe("plan");
    await commandHandlers["plan-build"]?.("", session);
    expect(getAgentMode("D:/proj-a")).toBe("agent");
    const result = await handlers.tool_call?.({ toolName: "write", input: { path: "a.ts" } }, session);
    expect(result).toBeUndefined();
  });

  it("session_start 不覆盖已写入的 live", async () => {
    setAgentMode("plan", "D:/proj-a");
    vi.mocked(getConfig).mockImplementation((name: string) =>
      name === agentModeConfigKey("D:/proj-a") ? "ask" : undefined,
    );
    const { handlers } = load();
    const session = ctx("D:/proj-a", [
      { type: "custom", customType: "agent-mode", data: { mode: "ask" } },
    ]);
    await handlers.session_start?.({}, session);
    expect(getAgentMode("D:/proj-a")).toBe("plan");
    expect(session.ui.setStatus).toHaveBeenCalledWith("agent-mode", "plan");
  });

  it("before_agent_start 按 live 对齐工具集", async () => {
    const { handlers, setActiveTools } = load();
    const session = ctx("D:/proj-a");
    await handlers.session_start?.({}, session);
    setActiveTools.mockClear();
    setAgentMode("ask", "D:/proj-a");
    await handlers.before_agent_start?.({});
    expect(setActiveTools).toHaveBeenCalled();
    expect(session.ui.setStatus).toHaveBeenCalledWith("agent-mode", "ask");
  });

  it("session_start 文件与条目同为 agent 时保留 executing 与 todos", async () => {
    const key = agentModeConfigKey("D:/proj-a");
    vi.mocked(getConfig).mockImplementation((name: string) =>
      name === key ? "agent" : undefined,
    );
    const { handlers, appendEntry } = load();
    const session = ctx("D:/proj-a", [
      {
        type: "custom",
        customType: "agent-mode",
        data: {
          mode: "agent",
          todos: [{ step: 1, text: "写文件", completed: false }],
          executing: true,
        },
      },
    ]);
    await handlers.session_start?.({}, session);
    expect(appendEntry).not.toHaveBeenCalled();
    const injected = await handlers.before_agent_start?.({});
    expect(injected).toMatchObject({ message: { customType: "plan-execution-context" } });
  });

  it("before_agent_start 离开 plan 时清 todos", async () => {
    const { handlers, commandHandlers } = load();
    const session = ctx("D:/proj-a", [
      {
        type: "custom",
        customType: "agent-mode",
        data: {
          mode: "plan",
          todos: [{ step: 1, text: "写文件", completed: false }],
          executing: false,
        },
      },
    ]);
    vi.mocked(getConfig).mockImplementation((name: string) =>
      name === agentModeConfigKey("D:/proj-a") ? "plan" : undefined,
    );
    await handlers.session_start?.({}, session);
    setAgentMode("ask", "D:/proj-a");
    await handlers.before_agent_start?.({});
    await commandHandlers["plan-build"]?.("", session);
    expect(session.ui.notify).toHaveBeenCalledWith("没有可执行的计划步骤。", "warning");
  });
```

现有 `watchConfig applies desktop AGENT_MODE` 必须继续绿：`session_start` 先灌默认 `agent`，watch 再给 `ask`，`get*` 不同，应 `applyMode`。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd extensions
npx vitest run agent-mode/index.test.ts
```

预期：FAIL。典型情况：`tool_call` 仍按闭包 `agent` 放行 `write`；`plan-build` 后 `getAgentMode` 仍是 `plan`。

- [ ] **步骤 3：编写最少实现代码**

`extensions/agent-mode/index.ts` 从 `./modes.js` 增加 import：`getAgentMode`、`setAgentMode`、`hasAgentMode`。

`applyMode` 签名改为 `opts?: { silent?: boolean; persist?: boolean }`（`persist` 默认 true）。在 `currentMode = next;` 之后立刻 `setAgentMode(next, ctx.cwd)`。`persist !== false` 时才 `persistState()`。

`watchConfig` 与 `get*` 比较，不要和闭包比：

```typescript
  watchConfig((next) => {
    if (!sessionCtx) return;
    const parsed = parseModeArg(next[agentModeConfigKey(sessionCtx.cwd)] ?? "");
    if (!parsed || parsed === getAgentMode(sessionCtx.cwd)) return;
    switchMode(parsed, sessionCtx);
  });
```

`tool_call`：

```typescript
  pi.on("tool_call", async (event, ctx) =>
    gateToolCall(getAgentMode(ctx?.cwd ?? sessionCtx?.cwd), event.toolName, event.input),
  );
```

`before_agent_start` 整段换成：

```typescript
  pi.on("before_agent_start", async () => {
    if (sessionCtx) {
      const live = getAgentMode(sessionCtx.cwd);
      if (live !== currentMode) {
        if (currentMode === "plan" && live !== "plan") {
          todoItems = [];
          executionMode = false;
        }
        applyMode(live, sessionCtx, { silent: true });
      }
    }
    if (executionMode && todoItems.length > 0) {
      const remaining = todoItems
        .filter((t) => !t.completed)
        .map((t) => `${t.step}. ${t.text}`)
        .join("\n");
      return {
        message: {
          customType: "plan-execution-context",
          content: `[EXECUTING PLAN]\nRemaining steps:\n${remaining}\nExecute in order; mark each finished step with [DONE:n] in your reply.`,
          display: false,
        },
      };
    }
    return undefined;
  });
```

`session_start` 换成：先恢复条目里的 todos / executing / savedTools / planId，以及把 `currentMode` 当作缓存初值；**只有 `!hasAgentMode(ctx.cwd)` 时才按「文件 > 条目 > agent」灌表**。然后按 live 对齐工具。

```typescript
  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;
    const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
    const entry = entries.filter((e) => e.type === "custom" && e.customType === "agent-mode").pop();
    const data = entry?.data as PersistedState | undefined;
    if (data) {
      currentMode = isAgentMode(data.mode) ? data.mode : DEFAULT_MODE;
      todoItems = data.todos ?? [];
      executionMode = data.executing ?? false;
      savedTools = data.savedTools;
      planId = data.planId;
    } else {
      currentMode = DEFAULT_MODE;
      todoItems = [];
      executionMode = false;
      savedTools = undefined;
      planId = undefined;
    }

    if (!hasAgentMode(ctx.cwd)) {
      const fromFile = parseModeArg(getConfig(agentModeConfigKey(ctx.cwd)) ?? "");
      const fromEntry = isAgentMode(data?.mode) ? data.mode : undefined;
      const next = fromFile ?? fromEntry ?? DEFAULT_MODE;
      if (fromFile && fromFile !== currentMode && fromFile !== "plan") {
        todoItems = [];
        executionMode = false;
      }
      applyMode(next, ctx, { silent: true, persist: false });
      return;
    }

    const live = getAgentMode(ctx.cwd);
    if (live !== currentMode) {
      applyMode(live, ctx, { silent: true });
      return;
    }
    if (toolWhitelist(currentMode)) {
      pi.setActiveTools(activeToolsFor(currentMode, savedTools ?? pi.getActiveTools()) ?? []);
    } else if (savedTools) {
      pi.setActiveTools(savedTools);
    }
    pushStatus(ctx);
  });
```

`/plan-build` 与 `/brainstorm-deliver` 已经调用 `applyMode`，不要再抄一份 `setAgentMode`。不要改 slash 注册。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd extensions
npx vitest run agent-mode/index.test.ts agent-mode/modes.test.ts
```

预期：PASS，包括原有 watch / session_start 文件优先两条。

再跑一遍宿主侧，避免模式表单例污染（各文件 `beforeEach` / `finally` 已 reset）：

```powershell
cd electron-agent
npx vitest run electron/app/piRuntimeService.test.ts electron/app/toolPermission/toolDecisionService.test.ts
```

```powershell
cd extensions
npx vitest run _shared/approval.test.ts approval/index.test.ts
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```powershell
git add extensions/agent-mode/index.ts extensions/agent-mode/index.test.ts
git commit -m "feat(模式): 门闩与 applyMode 以 live 表为准"
```

---

## 规格覆盖对照

| 规格 | 任务 |
| --- | --- |
| 3.1 `hasApprovalPolicy` / `Map.has` | 1 |
| 3.2 删 store，`evaluate` 总用 live，空表=`auto` | 4 |
| 3.3 模式 live API | 3 |
| 3.3 `gateToolCall` 纯函数不改、hook 读 live | 6 |
| 3.3 `applyMode` 写 live | 6 |
| 3.3 `before_agent_start` 用 `sessionCtx` 对齐 | 6 |
| 3.4 `writeApprovalPolicy` 去掉第二张表 | 4 |
| 3.4 `writeAgentMode` 先 `set` 再落盘；无路径不回滚 | 5 |
| 3.5 审批 `session_start` 不覆盖 | 2 |
| 3.5 模式 `session_start` / `watchConfig` 与 `get*` | 6 |
| 3.6 `/plan-build` 写 live | 6（经 `applyMode`） |
| 测试 1 模式侧 | 3 |
| 测试 2 模式侧 | 5 |
| 测试 3 + 空表 | 4 |
| 测试 4 hook | 6 |
| 测试 5 非法档 / 无路径 | 4（审批）、5（模式） |
| 测试 6 `session_start` | 2、6 |
| 测试 7 `plan-build` | 6 |
| plan 执行态跨 `session_start` 恢复 | 6 |
| 桌面切走 plan 清 todos | 6 |
| 2.3 已到位项 | 不重做 |

非目标（Tauri、slash 收 IPC、pulse、通用 bus、本回合 `setActiveTools`）无对应实现任务。
