# Agent MCP 与 Skill 添加工具实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Pi 增加可由 Agent 直接调用、强制确认、可回滚的 `add_mcp_server` 与 `add_skill` 工具，并让桌面 MCP 面板管理 Agent 写入的全局/项目配置。

**架构：** 新的 `resource-manager` 内置扩展负责校验、确认和事务写入；MCP Manager 分层读取桌面设置、全局文件和项目文件并监听热更新；Skill 安装后通过进程内事件请求，在当前回合结束时触发现有 Pi reload。Tauri 仅为桌面面板提供受限的独立 MCP 文件读写命令，不参与 Agent 工具执行。

**技术栈：** TypeScript、TypeBox、Node.js `fs`、Pi Extension API、MCP SDK、Vitest、Rust/Tauri 2、React 19、Testing Library。

---

## 文件结构

### 新建

- `extensions/resource-manager/validation.ts`：MCP/Skill 输入类型、名称、URL 和 frontmatter 校验。
- `extensions/resource-manager/validation.test.ts`：纯校验测试。
- `extensions/resource-manager/mcp-store.ts`：独立 MCP 文件解析、分层合并、冲突检查和事务写入。
- `extensions/resource-manager/mcp-store.test.ts`：MCP 文件与优先级测试。
- `extensions/resource-manager/skill-store.ts`：Skill 暂存、目录安全检查、切换和回滚。
- `extensions/resource-manager/skill-store.test.ts`：三种来源及事务失败测试。
- `extensions/resource-manager/index.ts`：注册 `add_mcp_server`、`add_skill` 并执行强制确认。
- `extensions/resource-manager/index.test.ts`：工具注册、取消、脱敏和成功结果测试。
- `extensions/_shared/resource-reload.ts`：Sidecar 进程内的资源 reload 请求总线。
- `extensions/_shared/resource-reload.test.ts`：请求注册、注销和错误隔离测试。
- `tauri-agent/src-tauri/src/commands/mcp_resources.rs`：桌面端受限读取/写入全局与项目 MCP 文件。
- `tauri-agent/src/lib/mcpResourceIo.ts`：Tauri MCP 文件命令的前端封装。

### 修改

- `extensions/mcp/manager.ts`：从三层用户配置读取并监听独立文件。
- `extensions/mcp/manager.test.ts`：验证配置文件变化触发连接差异更新。
- `extensions/mcp/probe.ts`：stdio 探测传递 `cwd`。
- `extensions/index.ts`：导出并注册 `resource-manager`。
- `cli/src/extension-profile.ts`：chat profile 排除资源安装工具。
- `cli/src/extension-profile.test.ts`：验证 project/chat profile 的工具边界。
- `cli/src/runtime.ts`：订阅资源 reload 请求，复用现有回合结束 reload 调度。
- `tauri-agent/src-tauri/src/commands/mod.rs`：导出 MCP 资源命令模块。
- `tauri-agent/src-tauri/src/lib.rs`：注册两个 MCP 资源 Tauri command。
- `tauri-agent/src/features/extensions/mcpConfig.ts`：增加来源模型和单文件启用/禁用集合操作。
- `tauri-agent/src/features/extensions/mcpConfig.test.ts`：验证来源、优先级和单文件启停。
- `tauri-agent/src/features/extensions/McpServerCard.tsx`：显示 MCP 配置来源。
- `tauri-agent/src/features/extensions/McpServerCard.test.tsx`：验证来源标签。
- `tauri-agent/src/features/extensions/ExtensionsPanel.tsx`：加载、展示并按来源修改独立文件配置。
- `tauri-agent/src/features/extensions/ExtensionsPanel.test.tsx`：验证三来源展示和来源内修改。
- `README.md`：补充两个 Agent 工具及 MCP 文件路径。
- `docs/architecture.md`：更新扩展与 MCP 配置数据流。

## 任务 1：输入类型与纯校验

**文件：**
- 创建：`extensions/resource-manager/validation.ts`
- 创建：`extensions/resource-manager/validation.test.ts`

- [ ] **步骤 1：编写失败的校验测试**

```ts
import { describe, expect, it } from "vitest";
import { normalizeSkillMarkdown, redactSecrets, validateMcpInput, validateResourceName } from "./validation.js";

describe("resource-manager validation", () => {
  it("accepts stable names and rejects traversal", () => {
    expect(validateResourceName("context7.v2")).toBeUndefined();
    expect(validateResourceName("../escape")).toMatch(/名称/);
    expect(validateResourceName("a".repeat(65))).toMatch(/64/);
  });

  it("enforces transport-specific MCP fields", () => {
    expect(validateMcpInput({ name: "x", scope: "global", transport: "stdio" })).toMatch(/command/);
    expect(validateMcpInput({ name: "x", scope: "global", transport: "sse", url: "file:///x" })).toMatch(/http/);
    expect(validateMcpInput({ name: "x", scope: "project", transport: "stdio", command: "npx" })).toBeUndefined();
  });

  it("adds frontmatter but rejects a conflicting skill name", () => {
    expect(normalizeSkillMarkdown("review", "Review code", "# Steps")).toContain("name: review");
    expect(() => normalizeSkillMarkdown("review", "", "---\nname: other\n---\n# X")).toThrow(/other/);
  });

  it("redacts secret values from dependency errors", () => {
    expect(redactSecrets("spawn failed: top-secret-token", ["top-secret-token"])).toBe("spawn failed: [REDACTED]");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions; npx vitest run resource-manager/validation.test.ts`

预期：FAIL，提示无法解析 `./validation.js`。

- [ ] **步骤 3：实现最小校验模块**

在 `validation.ts` 定义并导出以下稳定接口：

```ts
export type McpScope = "global" | "project";

export interface AddMcpServerInput {
  name: string;
  scope: McpScope;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  replace?: boolean;
}

export type SkillSource =
  | { type: "content"; content: string }
  | { type: "file"; path: string }
  | { type: "directory"; path: string };

export interface AddSkillInput {
  name: string;
  source: SkillSource;
  description?: string;
  replace?: boolean;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateResourceName(name: string): string | undefined {
  return NAME.test(name) ? undefined : "名称只能包含字母、数字、点、连字符和下划线，且长度不超过 64";
}

export function validateMcpInput(input: AddMcpServerInput): string | undefined {
  const nameError = validateResourceName(input.name);
  if (nameError) return nameError;
  if (input.transport === "stdio") return input.command?.trim() ? undefined : "stdio MCP 必须提供 command";
  if (!input.url) return "sse MCP 必须提供 URL";
  try {
    const url = new URL(input.url);
    return url.protocol === "http:" || url.protocol === "https:" ? undefined : "URL 必须使用 http/https";
  } catch {
    return "URL 格式无效";
  }
}
```

`normalizeSkillMarkdown()` 只解析首个 YAML frontmatter 区块中的单行 `name`；无 frontmatter 时生成 `name`/可选 `description`，已有 `name` 与参数不同则抛错。描述使用 JSON 风格双引号转义，避免冒号破坏 YAML。

`redactSecrets(text, secrets)` 过滤空字符串，把每个非空 secret 的所有字面出现替换为 `[REDACTED]`；`add_mcp_server` 对 probe、Manager 和文件错误统一调用它。

- [ ] **步骤 4：运行测试确认通过**

运行：`cd extensions; npx vitest run resource-manager/validation.test.ts`

预期：4 tests PASS。

- [ ] **步骤 5：提交**

```bash
git add extensions/resource-manager/validation.ts extensions/resource-manager/validation.test.ts
git commit -m "feat: validate agent resource inputs"
```

## 任务 2：MCP 独立文件存储与分层合并

**文件：**
- 创建：`extensions/resource-manager/mcp-store.ts`
- 创建：`extensions/resource-manager/mcp-store.test.ts`

- [ ] **步骤 1：编写失败的存储测试**

测试使用 `mkdtempSync()` 创建隔离的 home/workspace，覆盖以下断言：

```ts
const root = mkdtempSync(join(tmpdir(), "resource-mcp-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
const { global: globalPath, project: projectPath } = mcpConfigPaths(workspace, home);
const writeDoc = (path: string, doc: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc), "utf8");
};
const desktopJson = '{"mcpServers":{"desktop":{"command":"desktop"},"same":{"command":"desktop-same"}}}';

it("merges desktop, global and project with project precedence", () => {
  writeDoc(globalPath, { mcpServers: { same: { command: "global" }, g: { command: "g" } } });
  writeDoc(projectPath, { mcpServers: { same: { command: "project" }, p: { command: "p" } } });
  const out = readLayeredMcpServers(workspace, desktopJson, home);
  expect(out.find((s) => s.name === "same")?.command).toBe("project");
  expect(out.map((s) => s.name).sort()).toEqual(["desktop", "g", "p", "same"]);
});

it("keeps disabledMcpServers out of the effective list", () => {
  writeDoc(globalPath, { mcpServers: {}, disabledMcpServers: { off: { command: "x" } } });
  expect(readLayeredMcpServers(workspace, "", home)).toEqual([]);
});

it("refuses corrupt JSON and preserves the original file", async () => {
  writeFileSync(globalPath, "{broken", "utf8");
  await expect(writeMcpServer(input, workspace, home)).rejects.toThrow(globalPath);
  expect(readFileSync(globalPath, "utf8")).toBe("{broken");
});

it("requires replace and preserves unrelated entries", async () => {
  writeDoc(globalPath, { mcpServers: { keep: { command: "keep" }, same: { command: "v1" } } });
  const first: AddMcpServerInput = { name: "same", scope: "global", transport: "stdio", command: "v2" };
  await expect(writeMcpServer(first, workspace, home)).rejects.toThrow(/replace/);
  await writeMcpServer({ ...first, replace: true }, workspace, home);
  expect(readMcpDocument(globalPath).mcpServers.keep.command).toBe("keep");
  expect(readMcpDocument(globalPath).mcpServers.same.command).toBe("v2");
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions; npx vitest run resource-manager/mcp-store.test.ts`

预期：FAIL，提示 `mcp-store.js` 不存在。

- [ ] **步骤 3：实现配置文档与路径解析**

`mcp-store.ts` 导出：

```ts
export interface McpFileServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

export interface McpDocument {
  mcpServers: Record<string, McpFileServer>;
  disabledMcpServers: Record<string, McpFileServer>;
}

export function mcpConfigPaths(cwd: string, home = homedir()) {
  return {
    global: join(home, ".pi", "agent", "mcp.json"),
    project: join(cwd, ".pi", "mcp.json"),
  } as const;
}

export function readMcpDocument(path: string): McpDocument;
export function readLayeredMcpServers(cwd: string, desktopJson: string, home?: string): McpServerConfig[];
export function findMcpConflict(name: string, cwd: string, desktopJson: string, home?: string): McpScope | "settings" | undefined;
export async function writeMcpServer(input: AddMcpServerInput, cwd: string, home?: string): Promise<string>;
export function watchMcpConfigFiles(cwd: string, onChange: () => void, home?: string): () => void;
```

`readMcpDocument()` 对不存在文件返回两个空集合，对存在但非对象、集合非对象或 JSON 损坏抛出包含绝对路径的错误。`readLayeredMcpServers()` 依次把桌面、全局、项目的启用条目写入 `Map<string, McpServerConfig>`，后写覆盖先写。

- [ ] **步骤 4：实现事务写入与文件监听**

`writeMcpServer()` 只更新目标文档的 `mcpServers[input.name]`，从同文件的 `disabledMcpServers` 删除同名项，并保留其他字段。写入流程固定为：创建父目录、写同目录临时文件、权限 `0o600`、rename 替换；替换失败时保留原文件并清理临时文件。

`watchMcpConfigFiles()` 对目标文件或最近已存在父目录建立 `fs.watch`，150ms 防抖后调用 `onChange` 并重新挂载 watcher，从而覆盖首次创建 `.pi`、原子 rename 和删除。单个 watcher 的 error 只触发重新挂载，不抛到 MCP Manager。

- [ ] **步骤 5：运行测试确认通过**

运行：`cd extensions; npx vitest run resource-manager/mcp-store.test.ts`

预期：全部 PASS，测试结束时关闭 watcher 并删除临时目录。

- [ ] **步骤 6：提交**

```bash
git add extensions/resource-manager/mcp-store.ts extensions/resource-manager/mcp-store.test.ts
git commit -m "feat: persist layered MCP resource files"
```

## 任务 3：MCP Manager 接入文件层与热更新

**文件：**
- 修改：`extensions/mcp/manager.ts`
- 修改：`extensions/mcp/manager.test.ts`

- [ ] **步骤 1：扩展 Manager 失败测试**

保留现有依赖注入测试，并新增默认配置源的单元边界：

```ts
it("reconciles when the layered config watcher fires", async () => {
  let servers = [srv("global", "v1")];
  let notify = () => {};
  const mgr = createManager({
    connect: vi.fn(async () => fakeClient([{ name: "tool" }])),
    readServers: () => servers,
    watch: (cb) => { notify = cb; return () => {}; },
    writeCache: () => {},
  });
  mgr.init();
  await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.get("global")?.status === "connected");
  servers = [srv("project", "v2")];
  notify();
  await waitFor(mgr.subscribe, mgr.snapshot, (s) => s.servers.has("project") && !s.servers.has("global"));
});
```

同时在 `mcp-store.test.ts` 通过真实 watcher 创建/替换/删除项目文件，断言回调至少触发一次。

- [ ] **步骤 2：运行测试确认新增真实 watcher 用例失败**

运行：`cd extensions; npx vitest run mcp/manager.test.ts resource-manager/mcp-store.test.ts`

预期：新增 watcher 用例 FAIL，默认 Manager 尚未组合文件配置。

- [ ] **步骤 3：替换 Manager 默认依赖**

把 `defaultReadServers()` 改为先调用：

```ts
const configured = readLayeredMcpServers(process.cwd(), getConfig("MCP_SERVERS") ?? "");
return expandServerVars(
  injectDefaultServers(configured, getAllConfig(), process.platform, readToolsCache(), process.arch, secrets),
  process.cwd(),
);
```

默认 `watch` 同时订阅 `watchConfig()` 与 `watchMcpConfigFiles(process.cwd(), cb)`，返回的清理函数注销两者。保持 `ManagerDeps` 现有签名，避免影响调用方测试。

- [ ] **步骤 4：运行 MCP 测试**

运行：`cd extensions; npx vitest run mcp/ resource-manager/mcp-store.test.ts`

预期：全部 PASS；原有 MCP 设置测试不回归。

- [ ] **步骤 5：提交**

```bash
git add extensions/mcp/manager.ts extensions/mcp/manager.test.ts extensions/resource-manager/mcp-store.test.ts
git commit -m "feat: hot reload MCP resource files"
```

## 任务 4：Skill 事务安装

**文件：**
- 创建：`extensions/resource-manager/skill-store.ts`
- 创建：`extensions/resource-manager/skill-store.test.ts`

- [ ] **步骤 1：编写失败的 Skill 存储测试**

测试覆盖三种来源、冲突、目录资源、符号链接和回滚：

```ts
it("installs content and a directory with assets", async () => {
  const contentResult = await installSkill({ name: "inline", source: { type: "content", content: "# Inline" } }, home);
  expect(readFileSync(join(contentResult.path, "SKILL.md"), "utf8")).toContain("name: inline");

  const source = join(root, "source");
  mkdirSync(join(source, "references"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: copied\n---\n# Copied");
  writeFileSync(join(source, "references", "guide.md"), "guide");
  await installSkill({ name: "copied", source: { type: "directory", path: source } }, home);
  expect(readFileSync(join(home, ".agents", "skills", "copied", "references", "guide.md"), "utf8")).toBe("guide");
});

it("does not replace unless requested", async () => {
  await installSkill(first, home);
  await expect(installSkill(second, home)).rejects.toThrow(/replace/);
  expect(readFileSync(targetSkillMd, "utf8")).toContain("first");
});

it("restores the old skill when the staged rename fails", async () => {
  let calls = 0;
  const deps: SkillFsDeps = {
    rename: async (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error("switch failed");
      await rename(from, to);
    },
  };
  await expect(installSkill(replacement, home, deps)).rejects.toThrow(/switch/);
  expect(readFileSync(targetSkillMd, "utf8")).toContain("old");
});
```

在支持创建符号链接的平台增加逃逸链接用例；Windows 无创建权限时显式 skip，而不是让测试误报。

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions; npx vitest run resource-manager/skill-store.test.ts`

预期：FAIL，提示 `skill-store.js` 不存在。

- [ ] **步骤 3：实现暂存与安全复制**

导出稳定接口：

```ts
export interface InstallSkillResult { name: string; path: string; files: number }

export interface SkillFsDeps {
  rename(from: string, to: string): Promise<void>;
}

export async function prepareSkill(input: AddSkillInput, home?: string): Promise<PreparedSkill>;
export async function commitPreparedSkill(prepared: PreparedSkill, replace: boolean, deps?: SkillFsDeps): Promise<InstallSkillResult>;
export async function discardPreparedSkill(prepared: PreparedSkill): Promise<void>;
export async function installSkill(input: AddSkillInput, home?: string, deps?: SkillFsDeps): Promise<InstallSkillResult>;
```

`prepareSkill()` 在 `~/.agents/skills` 内用 `mkdtemp` 创建同文件系统暂存目录。目录复制前递归 `lstat`：任何符号链接直接拒绝；来源目录规范化后若等于目标、位于目标内或包含目标则拒绝递归导入。`SKILL.md` 统一交给 `normalizeSkillMarkdown()`。

- [ ] **步骤 4：实现覆盖切换和回滚**

`commitPreparedSkill()`：

1. 目标存在且 `replace !== true` 时抛错并保留暂存目录供调用方清理。
2. 覆盖时把目标 rename 到同级 `.name.backup-<uuid>`。
3. 把暂存目录 rename 为目标。
4. 第 3 步失败时把备份 rename 回目标；恢复失败的错误同时包含目标和备份绝对路径。
5. 成功后删除备份，返回实际文件数量。

- [ ] **步骤 5：运行测试确认通过**

运行：`cd extensions; npx vitest run resource-manager/validation.test.ts resource-manager/skill-store.test.ts`

预期：全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add extensions/resource-manager/skill-store.ts extensions/resource-manager/skill-store.test.ts
git commit -m "feat: install local skills transactionally"
```

## 任务 5：回合结束资源重载请求

**文件：**
- 创建：`extensions/_shared/resource-reload.ts`
- 创建：`extensions/_shared/resource-reload.test.ts`
- 修改：`cli/src/runtime.ts`

- [ ] **步骤 1：编写失败的请求总线测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { onResourceReloadRequested, requestResourceReload } from "./resource-reload.js";

it("notifies subscribers and stops after unsubscribe", () => {
  const fn = vi.fn();
  const off = onResourceReloadRequested(fn);
  expect(requestResourceReload()).toBe(true);
  expect(fn).toHaveBeenCalledOnce();
  off();
  expect(requestResourceReload()).toBe(false);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions; npx vitest run _shared/resource-reload.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现同步调度总线**

```ts
type ReloadListener = () => void;
const listeners = new Set<ReloadListener>();

export function onResourceReloadRequested(listener: ReloadListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestResourceReload(): boolean {
  const scheduled = listeners.size > 0;
  for (const listener of listeners) {
    try { listener(); } catch { /* isolate subscriber */ }
  }
  return scheduled;
}
```

- [ ] **步骤 4：让 runtime 复用现有 reload 调度**

把 `runtime.ts` 的 `reloadResources` 保持为“空闲立即 reload、streaming 时订阅一次 `agent_end`”。在 `run()` 的 RPC 分支订阅：

```ts
const unwatchResourceReload = onResourceReloadRequested(reloadResources);
process.on("exit", () => {
  unwatchReload();
  unwatchResourceReload();
});
```

为避免同一回合多个安装请求重复订阅，给 `reloadResources` 增加 `reloadPending` 布尔锁；`agent_end` 后清锁并执行一次 reload。

- [ ] **步骤 5：运行测试和 CLI 类型检查**

运行：`cd extensions; npx vitest run _shared/resource-reload.test.ts`

运行：`cd cli; npm run typecheck`

预期：测试 PASS，TypeScript 无错误。

- [ ] **步骤 6：提交**

```bash
git add extensions/_shared/resource-reload.ts extensions/_shared/resource-reload.test.ts cli/src/runtime.ts
git commit -m "feat: schedule resource reloads after agent turns"
```

## 任务 6：注册两个 Agent 工具

**文件：**
- 创建：`extensions/resource-manager/index.ts`
- 创建：`extensions/resource-manager/index.test.ts`
- 修改：`extensions/mcp/probe.ts`
- 修改：`extensions/index.ts`
- 修改：`cli/src/extension-profile.ts`
- 修改：`cli/src/extension-profile.test.ts`

- [ ] **步骤 1：编写工具注册与确认失败测试**

构造假的 `ExtensionAPI` 收集工具，假的 `ctx.ui.confirm` 控制结果：

```ts
it("registers both tools and cancellation has no writes", async () => {
  const { tools, pi } = loadExtension();
  resourceManager(pi);
  expect(Object.keys(tools).sort()).toEqual(["add_mcp_server", "add_skill"]);
  const result = await tools.add_skill.execute("1", contentInput, undefined, undefined, context(false));
  expect(result.details).toMatchObject({ status: "cancelled" });
  expect(existsSync(target)).toBe(false);
});

it("refuses headless execution instead of bypassing confirmation", async () => {
  const result = await tools.add_mcp_server.execute("1", mcpInput, undefined, undefined, contextWithoutUi());
  expect(result.details).toMatchObject({ status: "error" });
  expect(result.content[0].text).toMatch(/交互确认/);
});

it("never exposes environment values", async () => {
  const secret = "top-secret-token";
  await tools.add_mcp_server.execute("1", { ...mcpInput, env: { TOKEN: secret } }, undefined, undefined, context(true));
  expect(confirm.mock.calls.flat().join(" ")).not.toContain(secret);
  expect(JSON.stringify(lastResult)).not.toContain(secret);
});
```

依赖通过 `createResourceManager(deps)` 注入 `probeServer`、home 路径和 reload requester；默认导出调用真实依赖。

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions; npx vitest run resource-manager/index.test.ts`

预期：FAIL，`index.js` 不存在。

- [ ] **步骤 3：实现 `add_mcp_server`**

使用 TypeBox 为两个工具声明与任务 1 类型一致的 schema。MCP 执行顺序必须固定：校验、读取冲突、检查 `replace`、强制确认、`probeServer()`、`writeMcpServer()`、等待 Manager snapshot 最多 5 秒、返回结构化 details。

统一结果形状：

```ts
type ResourceToolDetails =
  | { status: "cancelled"; resource: "mcp" | "skill" }
  | { status: "error"; resource: "mcp" | "skill"; error: string }
  | { status: "saved"; resource: "mcp"; name: string; scope: McpScope; path: string; connection: "connected" | "failed"; tools: string[] }
  | { status: "installed"; resource: "skill"; name: string; path: string; reloadScheduled: boolean };
```

`ctx.hasUI === false` 直接返回 error。确认文案用 shell 风格连接 command/args，但 `env` 只列 `Object.keys(env)`。probe 错误截断为 1000 字符。

- [ ] **步骤 4：实现 `add_skill`**

先检查 `ctx.hasUI`；无 UI 时不得创建暂存目录。随后调用 `prepareSkill()` 得到文件数和可确认来源摘要，再调用 `ctx.ui.confirm()`。取消时 `discardPreparedSkill()`；确认后 `commitPreparedSkill()`，成功后调用 `requestResourceReload()` 并返回 `reloadScheduled`。

任何异常都转换为 `status: "error"` 工具结果；错误文本不得拼接 MCP 输入对象或 `env`。

- [ ] **步骤 5：修正 probe cwd 并注册扩展**

`extensions/mcp/probe.ts` 的 `StdioClientTransport` 增加：

```ts
...(s.cwd ? { cwd: s.cwd } : {}),
```

在 `extensions/index.ts` 的导出、`allExtensions` 与 `namedExtensions` 增加 `resource-manager`。在 `CHAT_EXCLUDED` 增加 `resource-manager`，并在 profile 测试中断言 project 保留、chat 排除。

- [ ] **步骤 6：运行扩展与 CLI 测试**

运行：`cd extensions; npx vitest run resource-manager/ mcp/`

运行：`cd cli; npm test; npm run typecheck`

预期：全部 PASS；project profile 包含两个新工具，chat profile 不加载扩展。

- [ ] **步骤 7：提交**

```bash
git add extensions/resource-manager/index.ts extensions/resource-manager/index.test.ts extensions/mcp/probe.ts extensions/index.ts cli/src/extension-profile.ts cli/src/extension-profile.test.ts
git commit -m "feat: expose MCP and skill add tools"
```

## 任务 7：Tauri 独立 MCP 文件桥

**文件：**
- 创建：`tauri-agent/src-tauri/src/commands/mcp_resources.rs`
- 修改：`tauri-agent/src-tauri/src/commands/mod.rs`
- 修改：`tauri-agent/src-tauri/src/lib.rs`
- 创建：`tauri-agent/src/lib/mcpResourceIo.ts`

- [ ] **步骤 1：先在 Rust 模块中编写路径与写入测试**

```rust
#[test]
fn resource_paths_are_scoped_to_home_and_workspace() {
    let paths = resolve_paths(Path::new("C:/home"), Path::new("D:/repo"));
    assert_eq!(paths.global, PathBuf::from("C:/home/.pi/agent/mcp.json"));
    assert_eq!(paths.project, PathBuf::from("D:/repo/.pi/mcp.json"));
}

#[test]
fn parse_resource_doc_rejects_invalid_json() {
    assert!(validate_resource_doc("{broken").is_err());
    assert!(validate_resource_doc(r#"{"mcpServers":{}}"#).is_ok());
}

#[test]
fn transactional_write_preserves_existing_file_on_failure() {
    let dir = temp_resource_dir();
    let path = dir.join("mcp.json");
    fs::write(&path, "old").unwrap();
    let fail_switch = |_from: &Path, _to: &Path| Err(std::io::Error::other("switch failed"));
    assert!(write_resource_file_with(&path, "new", &fail_switch).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "old");
}
```

- [ ] **步骤 2：运行 Rust 测试确认失败**

运行：`cd tauri-agent/src-tauri; cargo test mcp_resources`

预期：FAIL，新模块尚未导出。

- [ ] **步骤 3：实现受限 command**

定义：

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceConfigs { pub global: String, pub project: String }

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpResourceScope { Global, Project }

#[tauri::command]
pub async fn read_mcp_resource_configs(workspace: String) -> Result<McpResourceConfigs, String>;

#[tauri::command]
pub async fn write_mcp_resource_config(
    workspace: String,
    scope: McpResourceScope,
    content: String,
) -> Result<(), String>;
```

项目路径必须经 `resolve_workspace_dir()`；目标路径只能由 home/workspace 与固定相对路径构造。写入前解析 JSON 并确认 `mcpServers`、`disabledMcpServers` 若存在均为对象。使用同目录临时文件和备份切换，失败恢复旧文件。

创建全局文件后，在 Unix 使用 `PermissionsExt::set_mode(0o600)`；Windows 沿用用户配置目录 ACL，不尝试放宽权限。测试在 Unix 断言 mode 的低九位为 `0o600`。

- [ ] **步骤 4：注册命令并增加前端封装**

`mcpResourceIo.ts`：

```ts
export interface McpResourceConfigs { global: string; project: string }
export type McpResourceScope = 'global' | 'project';

export const readMcpResourceConfigs = (workspace: string) =>
  invoke<McpResourceConfigs>('read_mcp_resource_configs', { workspace });

export const writeMcpResourceConfig = (workspace: string, scope: McpResourceScope, content: string) =>
  invoke<void>('write_mcp_resource_config', { workspace, scope, content });
```

- [ ] **步骤 5：运行 Rust 测试与格式检查**

运行：`cd tauri-agent/src-tauri; cargo fmt --check; cargo test mcp_resources`

预期：全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add tauri-agent/src-tauri/src/commands/mcp_resources.rs tauri-agent/src-tauri/src/commands/mod.rs tauri-agent/src-tauri/src/lib.rs tauri-agent/src/lib/mcpResourceIo.ts
git commit -m "feat: expose scoped MCP resource files to UI"
```

## 任务 8：桌面 MCP 面板统一来源管理

**文件：**
- 修改：`tauri-agent/src/features/extensions/mcpConfig.ts`
- 修改：`tauri-agent/src/features/extensions/mcpConfig.test.ts`
- 修改：`tauri-agent/src/features/extensions/McpServerCard.tsx`
- 修改：`tauri-agent/src/features/extensions/McpServerCard.test.tsx`
- 修改：`tauri-agent/src/features/extensions/ExtensionsPanel.tsx`
- 修改：`tauri-agent/src/features/extensions/ExtensionsPanel.test.tsx`

- [ ] **步骤 1：编写来源模型失败测试**

在 `mcpConfig.test.ts` 增加：

```ts
it('parses enabled and disabled entries from a resource document', () => {
  const entries = listResourceEntries(
    '{"mcpServers":{"on":{"command":"npx"}},"disabledMcpServers":{"off":{"url":"https://x"}}}',
    'global',
  );
  expect(entries).toEqual([
    expect.objectContaining({ name: 'on', enabled: true, source: 'global' }),
    expect.objectContaining({ name: 'off', enabled: false, source: 'global' }),
  ]);
});

it('moves only the selected file entry when toggled', () => {
  const next = updateResourceEntry(doc, 'global', { type: 'toggle', name: 'on', enabled: false });
  expect(JSON.parse(next).mcpServers.on).toBeUndefined();
  expect(JSON.parse(next).disabledMcpServers.on.command).toBe('npx');
});
```

在 `ExtensionsPanel.test.tsx` mock `readMcpResourceConfigs`/`writeMcpResourceConfig`，断言全局、项目条目出现，切换全局条目只调用 `scope: 'global'`。

- [ ] **步骤 2：运行前端测试确认失败**

运行：`cd tauri-agent; bunx vitest run src/features/extensions/mcpConfig.test.ts src/features/extensions/ExtensionsPanel.test.tsx`

预期：FAIL，来源 helper 和 API 调用尚不存在。

- [ ] **步骤 3：实现来源数据模型**

在 `mcpConfig.ts` 增加：

```ts
export type McpSource = 'settings' | 'global' | 'project';
export interface SourcedMcpEntry extends McpEntry { source: McpSource }
export type ResourceMutation =
  | { type: 'upsert'; entry: { name: string; config: McpConfig }; enabled: boolean }
  | { type: 'toggle'; name: string; enabled: boolean }
  | { type: 'remove'; name: string };

export function listResourceEntries(content: string, source: Exclude<McpSource, 'settings'>): SourcedMcpEntry[];
export function updateResourceEntry(content: string, source: Exclude<McpSource, 'settings'>, mutation: ResourceMutation): string;
export function listAllSources(settings: Collections, global: string, project: string): SourcedMcpEntry[];
```

资源 JSON 损坏时 `listResourceEntries` 抛错，让面板显示来源文件错误，不能静默当空配置。排序按 `project > global > settings`，相同来源内启用项优先；保留同名的多来源条目，以来源标签区分遮蔽关系。

- [ ] **步骤 4：在卡片显示来源**

给 `McpServerCard` 增加必填 `source: McpSource`，名称旁显示固定文案：`settings=桌面设置`、`global=全局文件`、`project=项目文件`。测试断言 `mcp-source-<name>-<source>` 存在。

- [ ] **步骤 5：让 ExtensionsPanel 按来源读写**

从 `useAgentStoreContext()` 取得 workspace，mount 时调用 `readMcpResourceConfigs(workspace)`。状态保持：

```ts
const [resourceConfigs, setResourceConfigs] = useState<McpResourceConfigs>({ global: '', project: '' });
const entries = listAllSources(cols, resourceConfigs.global, resourceConfigs.project);
```

设置来源继续走现有 `writeCols()`；全局/项目来源的编辑、启停、删除调用 `updateResourceEntry()` 后立即 `writeMcpResourceConfig()`，成功再更新本地 state。React key 改为 `${entry.source}:${entry.name}`。新增按钮仍写桌面设置，不扩大现有 UI 新增流程。

同名工具缓存仍按 server 名读取；被遮蔽的低优先级卡片显示来源但禁用“测试连接”，避免把有效运行配置误归因到低优先级条目。

- [ ] **步骤 6：运行前端测试与类型检查**

运行：`cd tauri-agent; bunx vitest run src/features/extensions/`

运行：`cd tauri-agent; bunx tsc --noEmit`

预期：全部 PASS，无 React key、未处理 Promise 或类型错误。

- [ ] **步骤 7：提交**

```bash
git add tauri-agent/src/features/extensions/mcpConfig.ts tauri-agent/src/features/extensions/mcpConfig.test.ts tauri-agent/src/features/extensions/McpServerCard.tsx tauri-agent/src/features/extensions/McpServerCard.test.tsx tauri-agent/src/features/extensions/ExtensionsPanel.tsx tauri-agent/src/features/extensions/ExtensionsPanel.test.tsx
git commit -m "feat: manage MCP resource file sources"
```

## 任务 9：文档、全量验证与验收

**文件：**
- 修改：`README.md`
- 修改：`docs/architecture.md`

- [ ] **步骤 1：更新用户与架构文档**

README 的内置扩展表增加 `resource-manager`，列出 `add_mcp_server`、`add_skill`。MCP 章节记录：

```text
桌面设置 MCP_SERVERS < ~/.pi/agent/mcp.json < <workspace>/.pi/mcp.json
```

说明文件中的 `disabledMcpServers` 是 GrenAgent 的可选扩展，Skill 仅接受本地内容/文件/目录，所有安装强制确认。

架构文档补充 Sidecar 工具写文件、MCP Manager watch/reconcile，以及 Skill 在 `agent_end` 后 reload 的数据流。

- [ ] **步骤 2：运行扩展全量测试**

运行：`cd extensions; npx vitest run`

预期：全部 PASS。

- [ ] **步骤 3：运行 CLI 测试、类型检查与构建**

运行：`cd cli; npm test; npm run typecheck; npm run build`

预期：全部成功，sidecar bundle 包含 `resource-manager`。

- [ ] **步骤 4：运行桌面前端全量测试与类型检查**

运行：`cd tauri-agent; bun test; bunx tsc --noEmit`

预期：全部 PASS。

- [ ] **步骤 5：运行 Rust 全量测试**

运行：`cd tauri-agent/src-tauri; cargo fmt --check; cargo test`

预期：全部 PASS。

- [ ] **步骤 6：执行手工验收**

在开发模式打开一个测试工作区，逐项确认：

1. Agent 调用 `add_mcp_server` 时弹出强制确认，取消后两个 `mcp.json` 均不变化。
2. 添加一个可探测的项目 MCP 后，`.pi/mcp.json` 原子生成，下一 Agent 回合能看到 `mcp__<server>__<tool>`。
3. 同名添加不带 `replace` 被拒；带 `replace: true` 时确认文案明确显示覆盖/遮蔽。
4. Agent 用 content、Markdown 文件、目录各添加一个 Skill；目录资源完整，当前回合结束 reload 后下一回合可发现。
5. MCP 面板显示桌面/全局/项目来源；切换或删除只修改对应来源文件。
6. 确认卡、工具结果、控制台与 MCP 审计中均搜索不到测试 token 原值。

- [ ] **步骤 7：检查差异与提交文档**

运行：`git diff --check; git status --short`

预期：无空白错误，只包含本计划范围内文档修改或已提交实现。

```bash
git add README.md docs/architecture.md
git commit -m "docs: document agent resource add tools"
```
