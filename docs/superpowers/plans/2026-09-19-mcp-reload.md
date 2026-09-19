# MCP 列表按钮改为实时重载 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 扩展面板 MCP 卡片上的刷新按钮强制重连该条实时 MCP，agent 立刻用上新工具列表；不再走一次性探测。

**架构：** `McpManager.reloadServer(name)` 关旧 client、保留 catalog、标 `connecting` 并立刻 emit，再 `connectServer`。桌面经 `McpConfigService.reload` → IPC `reload_mcp_server` → `pi.reloadMcpServer`。卡片改文案与接线。`reconcile()`、`probe_mcp_server`、首次无缓存自动探测不动。

**技术栈：** TypeScript、React、vitest + testing-library。改 `extensions/mcp` 与 `electron-agent`。

**规格：** `docs/superpowers/specs/2026-09-19-mcp-reload-design.md`

**硬约束：** TDD；不要隔离 worktree，在当前仓库原地做（工作区很脏）。每个任务 `git add` **只加本任务列出的文件**，禁止 `git add -A`。用户未要求提交则跳过各任务的 Commit 步骤。禁止 emoji。不要删除探测 IPC / 自动探测。不要做「重载全部」。

---

## 动工前必读

- `reconcile()` 只在配置 diff 时重连。本功能必须在配置未变时也重连。
- `disconnectServer` 会从 catalog **删除**条目。重载路径禁止走它，否则列表会闪没。
- `getMcpManager()` 用 ALS / cwd。桌面 IPC 必须走 `getMcpManagerFor(workspace)`，否则会连错工作区。
- `init()` 现在是 `void Promise.all(...)`。`reloadServer` 在未 init 时要能 await 目标那条连接，必须把 in-flight Promise 留下来。
- 并发重载用 generation：过期的 `connectServer` 不得写回 `clients` / `catalog`。
- 没有会话时 `bind()` 尚未 subscribe，`emit` 到不了 `mcp.state.publish`。这是规格里的已知限制，不要另开推送。
- Windows 测试命令见下。不要为验 UI 去点 Electron 真窗。

**测试命令：**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run mcp/manager.test.ts
```

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/mcpConfigService.test.ts src/features/extensions/McpServerCard.test.tsx src/features/extensions/ExtensionsPanel.test.tsx
```

**提交（仅当用户明确要求时）：**

```powershell
git add <本任务文件>
git commit -m @"
feat(mcp): <本任务一句话>

"@
```

---

## 文件结构

不新建文件。

| 文件 | 改动 |
| --- | --- |
| `extensions/mcp/manager.ts` | `reloadServer`、`getMcpManagerFor`、`reloadMcpServer`；`connectServer` 进入 connecting 立刻 emit；in-flight + generation |
| `extensions/mcp/manager.test.ts` | 重载、未 init、不存在、catalog 不消失 |
| `electron-agent/electron/app/mcpConfigService.ts` | `reload(workspace, name)` 转发 |
| `electron-agent/electron/app/mcpConfigService.test.ts` | 转发且不写配置 |
| `electron-agent/electron/ipc/register.ts` | `reload_mcp_server` |
| `electron-agent/src/lib/pi.ts` | `reloadMcpServer` |
| `electron-agent/src/features/extensions/McpServerCard.tsx` | title / testid / `onReload` / disabled |
| `electron-agent/src/features/extensions/McpServerCard.test.tsx` | 文案、disabled |
| `electron-agent/src/features/extensions/ExtensionsPanel.tsx` | 按钮走 `pi.reloadMcpServer`；页头文案 |
| `electron-agent/src/features/extensions/ExtensionsPanel.test.tsx` | 点击走 reload、不走 probe |

不修改：`extensions/mcp/probe.ts`、`mcpPolicyService.ts` 的 `probe`、`hotReload` / `reconcile()` 语义、权限/审计、添加编辑删除 MCP。

---

### 任务 1：Manager.reloadServer

**文件：**
- 修改：`extensions/mcp/manager.ts`
- 测试：`extensions/mcp/manager.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `extensions/mcp/manager.test.ts` 的 import 里加上 `getMcpManagerFor, reloadMcpServer`。在文件末尾、现有 `describe("reconcile")` 之后追加：

```ts
describe("reloadServer", () => {
  it("已连接时关旧 client 再连，中间 catalog 仍在且为 connecting", async () => {
    let releaseSecond = () => {};
    let connectCount = 0;
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => {
      connectCount += 1;
      if (connectCount === 1) {
        return { ...fakeClient([{ name: "t1" }]), close };
      }
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      return fakeClient([{ name: "t2" }]);
    });
    const mgr = createManager({
      connect,
      readServers: () => [srv("a")],
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");

    const reloading = mgr.reloadServer("a");
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connecting");
    expect(mgr.snapshot().servers.has("a")).toBe(true);
    expect(close).toHaveBeenCalled();

    releaseSecond();
    await reloading;
    expect(mgr.snapshot().servers.get("a")?.status).toBe("connected");
    expect(mgr.snapshot().servers.get("a")?.tools.map((t) => t.name)).toEqual(["t2"]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("配置未变也会重连", async () => {
    const connect = vi.fn(async () => fakeClient([{ name: "t" }]));
    const mgr = createManager({
      connect,
      readServers: () => [srv("a")],
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    expect(connect).toHaveBeenCalledTimes(1);
    await mgr.reloadServer("a");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("名称不在已启用列表时 reject，且文案含 server 名", async () => {
    const connect = vi.fn(async () => fakeClient([{ name: "t" }]));
    const mgr = createManager({
      connect,
      readServers: () => [srv("a")],
      watch: () => () => {},
      writeCache: () => {},
    });
    mgr.init();
    await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("a")?.status === "connected");
    await expect(mgr.reloadServer("ghost")).rejects.toThrow(/ghost/);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("未 init 时触发 init，目标 connect 恰好一次，resolve 时已是终态", async () => {
    const connect = vi.fn(async () => fakeClient([{ name: "t" }]));
    const mgr = createManager({
      connect,
      readServers: () => [srv("a"), srv("b")],
      watch: () => () => {},
      writeCache: () => {},
    });
    await mgr.reloadServer("a");
    expect(connect.mock.calls.filter(([s]) => s.name === "a")).toHaveLength(1);
    expect(mgr.snapshot().servers.get("a")?.status).toBe("connected");
    expect(mgr.snapshot().servers.get("b")?.status).toBe("connected");
  });
});

describe("getMcpManagerFor", () => {
  it("按 workspace 分键，同键返回同一实例", () => {
    const a = getMcpManagerFor("D:/a");
    const b = getMcpManagerFor("D:/b");
    expect(a).not.toBe(b);
    expect(getMcpManagerFor("D:/a")).toBe(a);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run mcp/manager.test.ts
```

预期：FAIL。`reloadServer` / `getMcpManagerFor` 不存在，或 import 失败。

- [ ] **步骤 3：编写最少实现代码**

在 `extensions/mcp/manager.ts` 的 `McpManager` 接口增加：

```ts
reloadServer(name: string): Promise<void>;
```

在 `createManager` 内、`clients` / `catalog` 旁增加：

```ts
const inflight = new Map<string, Promise<void>>();
const generation = new Map<string, number>();
```

改 `connectServer`：进入时立刻 emit；用 generation 丢弃过期结果。

```ts
const connectServer = async (s: McpServerConfig): Promise<void> => {
  const gen = (generation.get(s.name) ?? 0) + 1;
  generation.set(s.name, gen);
  catalog.set(s.name, { status: "connecting", tools: [] });
  emit();
  try {
    const client = await connect(s);
    if (generation.get(s.name) !== gen) {
      await client.close().catch(() => {});
      return;
    }
    clients.set(s.name, client);
    const { tools } = await withTimeout(client.listTools(), MCP_TIMEOUT_MS);
    if (generation.get(s.name) !== gen) return;
    catalog.set(s.name, { status: "connected", tools });
    try {
      writeCache(s.name, { ok: true, toolNames: tools.map((t) => `mcp__${sanitize(s.name)}__${sanitize(t.name)}`) });
    } catch {
      // best-effort 缓存
    }
  } catch (e) {
    if (generation.get(s.name) !== gen) return;
    const msg = e instanceof Error ? e.message : String(e);
    catalog.set(s.name, { status: "failed", error: msg, tools: [] });
    try {
      writeCache(s.name, { ok: false, toolNames: [], error: msg });
    } catch {
      // best-effort 缓存
    }
  }
  if (generation.get(s.name) === gen) emit();
};

const runConnect = (s: McpServerConfig): Promise<void> => {
  const p = connectServer(s).finally(() => {
    if (inflight.get(s.name) === p) inflight.delete(s.name);
  });
  inflight.set(s.name, p);
  return p;
};

const forceReconnect = async (s: McpServerConfig): Promise<void> => {
  const existing = clients.get(s.name);
  if (existing) {
    await existing.close().catch(() => {});
    clients.delete(s.name);
  }
  catalog.set(s.name, { status: "connecting", tools: [] });
  emit();
  await runConnect(s);
};

const findEnabled = (name: string, servers: McpServerConfig[]): McpServerConfig => {
  const found = servers.find((s) => s.name === name);
  if (!found) throw new Error(`MCP server not enabled: ${name}`);
  return found;
};
```

`init` 改为：

```ts
init() {
  if (started) return;
  started = true;
  current = readServers();
  for (const s of current) void runConnect(s);
  unwatch = watch(onConfigChange);
},
```

`onConfigChange` 里新增/变更项改走 `runConnect`（原来的 `connectServer`）：

```ts
await Promise.all([...added, ...changed].map(runConnect));
```

在 return 对象上增加：

```ts
async reloadServer(name) {
  if (!started) {
    this.init();
    const target = findEnabled(name, current);
    await inflight.get(target.name);
    return;
  }
  await forceReconnect(findEnabled(name, readServers()));
},
```

注意：`this.init()` 在普通对象字面量里没有 `this`。写成直接调用已声明的 `init` 闭包。实现时应把 `init` 提成具名函数，或在 `reloadServer` 里内联「若未 started 则执行与 `init` 相同的启动」。推荐：

```ts
const start = (): void => {
  if (started) return;
  started = true;
  current = readServers();
  for (const s of current) void runConnect(s);
  unwatch = watch(onConfigChange);
};

return {
  init: start,
  async reloadServer(name) {
    if (!started) {
      start();
      const target = findEnabled(name, current);
      await inflight.get(target.name);
      return;
    }
    await forceReconnect(findEnabled(name, readServers()));
  },
  // snapshot / callTool / subscribe / reconcile / closeAll 保持原样
};
```

`closeAll` 增加 `inflight.clear()`。`generation` 可不清（workspace dispose 会丢掉整个 manager）。

文件底部，`getMcpManager` 改为委托：

```ts
export function getMcpManagerFor(workspace: string): McpManager {
  let mgr = managers.get(workspace);
  if (!mgr) {
    mgr = createManager({ workspace });
    managers.set(workspace, mgr);
  }
  return mgr;
}

export function getMcpManager(): McpManager {
  return getMcpManagerFor(currentWorkspaceContext()?.workspace ?? process.cwd());
}

export async function reloadMcpServer(workspace: string, name: string): Promise<void> {
  await getMcpManagerFor(workspace).reloadServer(name);
}
```

`disposeMcpManager` / `reconcileMcpManager` / `__resetMcpManagersForTest` 不改语义。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run mcp/manager.test.ts
```

预期：PASS（含原有 init / reconcile / 分键用例）。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add extensions/mcp/manager.ts extensions/mcp/manager.test.ts
git commit -m @"
feat(mcp): 按名强制重连实时 MCP 连接

"@
```

---

### 任务 2：桌面 reload IPC

**文件：**
- 修改：`electron-agent/electron/app/mcpConfigService.ts`
- 修改：`electron-agent/electron/app/mcpConfigService.test.ts`
- 修改：`electron-agent/electron/ipc/register.ts`
- 修改：`electron-agent/src/lib/pi.ts`
- 测试：`electron-agent/electron/app/mcpConfigService.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `mcpConfigService.test.ts` 的 `describe('McpConfigService')` 内追加。用构造函数第三参注入 stub，不要 `vi.mock` 整个 manager（该文件还依赖真实的 `setLiveWorkspaceMcpConfig` / `reconcileMcpManager`）。

```ts
it('reload 按 workspace 与 name 转发，不写配置文件', async () => {
  const { home, workspace, settings, currentSettings } = await fixture();
  const reload = vi.fn(async () => {});
  const before = JSON.stringify(currentSettings());
  const service = new McpConfigService(home, settings, reload);

  await service.reload(workspace, 'settings');

  expect(reload).toHaveBeenCalledWith(workspace, 'settings');
  expect(JSON.stringify(currentSettings())).toBe(before);
});
```

`import` 行加上 `vi`：`import { afterEach, describe, expect, it, vi } from 'vitest';`

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/mcpConfigService.test.ts
```

预期：FAIL。`reload` 不是函数，或构造函数不接受第三参。

- [ ] **步骤 3：编写最少实现代码**

`mcpConfigService.ts` 顶部 import 增加 `reloadMcpServer`：

```ts
import { reconcileMcpManager, reloadMcpServer, setLiveWorkspaceMcpConfig } from '../../../extensions/mcp/manager.js';
```

构造函数与方法：

```ts
export class McpConfigService {
  constructor(
    private readonly home: string,
    private readonly settings: SettingsPort,
    private readonly reloadFn: (workspace: string, name: string) => Promise<void> = reloadMcpServer,
  ) {}

  async reload(workspace: string, name: string): Promise<void> {
    await this.reloadFn(workspace, name);
  }
  // list / effective / runtime / upsert / remove / hotReload 保持原样
}
```

`electron-agent/electron/ipc/register.ts` 的 `registerMcpConfigCommands` 增加：

```ts
registerCommand('reload_mcp_server', (_event, args) =>
  service.reload(readString(args, 'workspace'), readString(args, 'name')));
```

放在 `remove_mcp_config` 旁边。

`electron-agent/src/lib/pi.ts` 在 `removeMcpConfig` 后增加：

```ts
reloadMcpServer: (workspace: string, name: string) =>
  invoke<void>('reload_mcp_server', { workspace, name }),
```

`main.ts` 的 `new McpConfigService(app.getPath('home'), settings)` 不用改（第三参有默认值）。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/mcpConfigService.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/electron/app/mcpConfigService.ts electron-agent/electron/app/mcpConfigService.test.ts electron-agent/electron/ipc/register.ts electron-agent/src/lib/pi.ts
git commit -m @"
feat(mcp): 暴露按名重载 MCP 的桌面 IPC

"@
```

---

### 任务 3：卡片改为「重载」

**文件：**
- 修改：`electron-agent/src/features/extensions/McpServerCard.tsx`
- 测试：`electron-agent/src/features/extensions/McpServerCard.test.tsx`

- [ ] **步骤 1：改测试为失败**

把 `McpServerCard.test.tsx` 整份换成：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServerCard } from './McpServerCard';

afterEach(cleanup);

describe('McpServerCard', () => {
  it('shows transport, cached tool count and wires actions', () => {
    const onToggle = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onReload = vi.fn();
    render(
      <McpServerCard
        name="gh"
        config={{ command: 'npx' }}
        enabled
        cachedTools={Array.from({ length: 12 }, (_, i) => `mcp__gh__t${i}`)}
        onToggle={onToggle}
        onEdit={onEdit}
        onDelete={onDelete}
        onReload={onReload}
      />,
    );
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('stdio');
    expect(screen.getByTestId('mcp-server-gh').textContent).toContain('12 工具');
    expect(screen.getByTestId('mcp-toggle-gh').getAttribute('aria-checked')).toBe('true');
    const reload = screen.getByTestId('mcp-reload-gh');
    expect(reload.getAttribute('title')).toBe('重载');
    fireEvent.click(reload);
    expect(onReload).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mcp-edit-gh'));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mcp-delete-gh'));
    expect(onDelete).toHaveBeenCalled();
  });

  it('disables reload when the server is not enabled or connecting', () => {
    const onReload = vi.fn();
    const { rerender } = render(
      <McpServerCard
        name="gh"
        config={{ command: 'npx' }}
        enabled={false}
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReload={onReload}
      />,
    );
    expect((screen.getByTestId('mcp-reload-gh') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('mcp-reload-gh'));
    expect(onReload).not.toHaveBeenCalled();

    rerender(
      <McpServerCard
        name="gh"
        config={{ command: 'npx' }}
        enabled
        runtimeStatus="connecting"
        onToggle={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReload={onReload}
      />,
    );
    expect((screen.getByTestId('mcp-reload-gh') as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/extensions/McpServerCard.test.tsx
```

预期：FAIL。仍是 `mcp-probe-gh` / title「测试连接」/ `onProbe`。

- [ ] **步骤 3：编写最少实现代码**

`McpServerCard.tsx`：

1. props：`onProbe?: () => void` 改为 `onReload?: () => void`。
2. 解构里同步改名。
3. 按钮：

```tsx
<button
  type="button"
  className={styles.iconbtn}
  title="重载"
  data-testid={`mcp-reload-${name}`}
  disabled={!enabled || probing || runtimeStatus === 'connecting'}
  onClick={onReload}
>
  <RefreshCw size={14} className={probing ? styles.spin : undefined} />
</button>
```

4. 空工具提示：

```tsx
<div className={styles.hint}>{probeError ? `连接失败：${probeError}` : '点右侧「重载」刷新连接与工具列表'}</div>
```

`probing` prop 名保持不变。不要改旋转动画 class 名。

此步改完后 `ExtensionsPanel.tsx` 若仍传 `onProbe` 会类型失败。下一步立刻接线；若本步要单独通过 tsc，可先在面板临时把 `onProbe={...}` 改成 `onReload={...}` 但仍调用 `probeOne`（下一步再换成 `reloadMcpServer`）。**不要**在本步改页头文案以外的面板行为，除非为了编译。

推荐本步同时把 `ExtensionsPanel.tsx` 的 `onProbe={() => void probeOne(...)}` 改成 `onReload={() => void probeOne(...)}`，行为仍是探测，任务 4 再换成 reload。这样卡片测试能过，面板测试暂时仍过。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/extensions/McpServerCard.test.tsx
```

预期：PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/extensions/McpServerCard.tsx electron-agent/src/features/extensions/McpServerCard.test.tsx electron-agent/src/features/extensions/ExtensionsPanel.tsx
git commit -m @"
feat(mcp): 卡片刷新按钮改为重载文案与禁用规则

"@
```

若本步未改 `ExtensionsPanel.tsx`，commit 不要加它。

---

### 任务 4：面板按钮走实时重载

**文件：**
- 修改：`electron-agent/src/features/extensions/ExtensionsPanel.tsx`
- 测试：`electron-agent/src/features/extensions/ExtensionsPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`ExtensionsPanel.test.tsx` 的 hoisted mock 增加 `reloadMcpServer`，并 mock `mcpPolicyIo`，避免自动探测干扰断言。

把文件顶部改成：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace, packageList, reloadMcpServer, probeMcpServer, readMcpToolsCache } = vi.hoisted(() => ({
  getSettings: vi.fn((): Promise<Record<string, string>> => Promise.resolve({})),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
  packageList: vi.fn(() => Promise.resolve([])),
  reloadMcpServer: vi.fn(() => Promise.resolve()),
  probeMcpServer: vi.fn(() => Promise.resolve(JSON.stringify({ ok: true, toolNames: [] }))),
  readMcpToolsCache: vi.fn(() => Promise.resolve(JSON.stringify({
    fs: { ok: true, toolNames: ['mcp__fs__t'], probedAt: 't' },
  }))),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
  useOptionalAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace, packageList, reloadMcpServer },
}));
vi.mock('../../lib/mcpPolicyIo', () => ({
  probeMcpServer,
  readMcpPolicy: () => Promise.resolve(''),
  readMcpToolsCache,
  writeMcpPolicy: () => Promise.resolve(),
}));
```

其余现有三个用例保持不变。在 `describe` 内追加：

```tsx
  it('reload button reconnects the live server instead of probing', async () => {
    getSettings.mockResolvedValueOnce({
      MCP_SERVERS: '{"mcpServers":{"fs":{"command":"npx","args":[]}}}',
    });
    render(<ExtensionsPanel />);
    await waitFor(() => expect(screen.getByTestId('mcp-reload-fs')).toBeTruthy());
    expect(screen.getByTestId('extensions-panel').textContent).toContain('点「重载」');
    probeMcpServer.mockClear();
    fireEvent.click(screen.getByTestId('mcp-reload-fs'));
    await waitFor(() => expect(reloadMcpServer).toHaveBeenCalledWith('/ws', 'fs'));
    expect(probeMcpServer).not.toHaveBeenCalled();
  });
```

不要把 `listMcpConfigs` 加进默认 `pi` mock：现有用例靠 `typeof pi.listMcpConfigs !== 'function'` 走 settings 回退。加上会让 `listMcpConfigs` 变成函数并返回 `undefined`，现有列表用例会炸。

- [ ] **步骤 2：运行测试验证失败**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/extensions/ExtensionsPanel.test.tsx
```

预期：FAIL。页头仍是「测试连接」，点击仍走 `probeOne`（`reloadMcpServer` 未被调用，或 `probeMcpServer` 被按钮调用）。

- [ ] **步骤 3：编写最少实现代码**

`ExtensionsPanel.tsx`：

1. 页头 `heroDesc` 改为：

```tsx
连接外部 MCP server，其工具以 <code className={styles.code}>mcp__server__tool</code> 暴露给 agent。点「重载」重新连接并刷新工具（即时生效）。
```

2. 新增 `reloadOne`（可紧挨 `probeOne`）。`probeOne` **保留**，供首次无缓存自动探测使用。

```ts
const reloadOne = async (serverName: string) => {
  setProbing((current) => new Set(current).add(serverName));
  setMcpError(null);
  try {
    await pi.reloadMcpServer(workspace, serverName);
  } catch (cause) {
    setMcpError(cause instanceof Error ? cause.message : String(cause));
  } finally {
    await reloadCache();
    setProbing((current) => {
      const next = new Set(current);
      next.delete(serverName);
      return next;
    });
  }
};
```

3. 卡片接线：

```tsx
onReload={() => void reloadOne(entry.name)}
```

不要再 `onReload={() => void probeOne(...)}`。

- [ ] **步骤 4：运行测试验证通过**

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run src/features/extensions/ExtensionsPanel.test.tsx src/features/extensions/McpServerCard.test.tsx
```

预期：PASS。

再跑回归：

```powershell
cd "D:\OneDrive\Project Files\Pi\extensions"; npx vitest run mcp/manager.test.ts
```

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"; npx vitest run electron/app/mcpConfigService.test.ts
```

预期：全部 PASS。

- [ ] **步骤 5：Commit**（用户未要求则跳过）

```powershell
git add electron-agent/src/features/extensions/ExtensionsPanel.tsx electron-agent/src/features/extensions/ExtensionsPanel.test.tsx
git commit -m @"
feat(mcp): 扩展面板刷新按钮改为实时重载

"@
```

---

## 自检

**规格覆盖**

| 规格 | 任务 |
| --- | --- |
| §2 强制重连一条、工具立刻给 agent | 任务 1 `reloadServer` + 任务 4 接线 |
| §2 重连中条目不消失、显示连接中 | 任务 1 catalog 保留 + connecting emit |
| §2 / §5.3 文案「重载」 | 任务 3、任务 4 |
| §2 / §5.3 未启用不可点 | 任务 3 disabled |
| §3 / §5.1 未 init 先 init、目标不双连、等到终态 | 任务 1 未 init 用例 |
| §3 配置未变也重连 | 任务 1 |
| §3 / §2 非目标：保留 probe 与自动探测 | 任务 4 保留 `probeOne` |
| §5.1 `getMcpManagerFor` / `reloadMcpServer` | 任务 1 |
| §5.2 service / IPC / `pi.reloadMcpServer` | 任务 2 |
| §5.3 `mcp-reload-*`、`onReload`、probing 包住 await | 任务 3、任务 4 |
| §7 IPC throw → `mcpError` | 任务 4 `reloadOne` catch |
| §7 连接失败走 catalog failed | 任务 1 复用现有 `connectServer` catch |
| §8 全部测试项 | 任务 1–4 |

**占位符：** 无 TODO / 待定 /「类似任务 N」。

**类型名：** 全程使用 `reloadServer`、`getMcpManagerFor`、`reloadMcpServer`、`reload_mcp_server`、`onReload`、`mcp-reload-${name}`。不要把桌面方法也叫 `reloadServer`（桌面是 `McpConfigService.reload`）。
