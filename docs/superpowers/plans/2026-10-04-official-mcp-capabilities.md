# 自建 MCP 补齐官方能力 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 Pi 升到 1.0.2，MCP 工具默认不进模型列表，由官方 codemode / tool_search 调用；连接、权限和面板仍走现有 `extensions/mcp`，并补上 OAuth、供应商 token、资源和扩展登记。

**架构：** 管理器继续用 `@modelcontextprotocol/sdk` 连接，不加载 `createMcpExtension`。纯函数负责配置合并、工具名、结果形状、OAuth 校验。扩展入口按 `exposure` 注册工具。桌面会话在过滤后的工厂列表末尾挂上官方 codemode 和 tool_search。走 `main()` 的路径只关掉内置 MCP。

**技术栈：** Pi SDK 1.0.2、`@modelcontextprotocol/sdk`、Vitest、Electron、React。

**规格：** `docs/superpowers/specs/2026-10-04-official-mcp-capabilities-design.md`

---

## 文件结构

- 创建 `extensions/_shared/promptDisposition.ts`：判断 prompt 是否被接受。
- 修改 `electron-agent/electron/agent/workspaceHandle.ts`、`extensions/multi-agent/embedded-runner.ts`：改用该判断。
- 修改 `extensions/loop-guard/index.ts`、`extensions/after-tool-feedback/index.ts`：替换 `content` 时带回 `structuredContent`。
- 修改 `electron-agent/package.json`、`cli/package.json`、`extensions/package.json` 及各自的锁文件：钉到 1.0.2。
- 修改 `cli/scripts/patch-pi-shell.mjs`、`cli/scripts/patch-pi-edit-preview.mjs`：对准 1.0.2 的 `dist`。
- 修改 `electron-agent/electron-builder.yml`：解开 codemode worker 和 wasm。
- 创建 `extensions/mcp/naming.ts`：注册名、哈希、服务器名冲突。
- 创建 `extensions/mcp/merge.ts`：三层配置合并、变量展开、exposure。
- 创建 `extensions/mcp/resultShape.ts`：截断文本、组装 `isError` 与 `structuredContent`。
- 创建 `extensions/mcp/wait.ts`：direct 服务器的 10 秒等待预算。
- 创建 `extensions/mcp/oauthRules.ts`：回调 URL、`iss`、scope、`auth.provider`、cimd。
- 创建 `extensions/mcp/logRotate.ts`：5 MB 轮转。
- 修改 `extensions/mcp/config.ts`、`index.ts`、`manager.ts`、`transport.ts`：接入上述函数。
- 修改 `cli/src/gren-runtime.ts`：挂上官方 codemode 和 tool_search。
- 修改 `cli/src/runtime.ts`、`cli/src/pi-worker.ts`：关掉 `builtin:mcp`。
- 修改 `electron-agent/src/lib/pi.ts`、`electron-agent/src/stores/agentReducer.ts`、工具卡片：按 `parentToolCallId` 归组。
- 修改 `electron-agent/src/features/extensions/McpServerCard.tsx`、`AddMcpModal.tsx`：登录状态，保存时保留 oauth 字段。

任务 1–3 做完后，现有 MCP 仍全部直接声明给模型，应用能在 1.0.2 上编译。任务 4–10 做完后，默认 exposure 变为 codemode。任务 11 之后补登录、资源和日志。

---

### 任务 1：prompt 被拒绝时不再挂住

**文件：**
- 创建：`extensions/_shared/promptDisposition.ts`
- 测试：`extensions/_shared/promptDisposition.test.ts`
- 修改：`electron-agent/electron/agent/workspaceHandle.ts`
- 修改：`extensions/multi-agent/embedded-runner.ts`
- 测试：`electron-agent/electron/agent/workspaceHandle.test.ts`、`extensions/multi-agent/embedded-runner.run.test.ts`

- [ ] **步骤 1：编写失败的测试**

`extensions/_shared/promptDisposition.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { promptWasAccepted } from "./promptDisposition.js";

describe("promptWasAccepted", () => {
  it("accepts handled, queued, and started", () => {
    expect(promptWasAccepted("handled")).toBe(true);
    expect(promptWasAccepted("queued")).toBe(true);
    expect(promptWasAccepted("started")).toBe(true);
  });
  it("rejects booleans and other strings", () => {
    expect(promptWasAccepted(true)).toBe(false);
    expect(promptWasAccepted(false)).toBe(false);
    expect(promptWasAccepted("nope")).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run _shared/promptDisposition.test.ts`

预期：FAIL，找不到 `./promptDisposition.js`。

- [ ] **步骤 3：编写最少实现代码**

```ts
const ACCEPTED = new Set(["handled", "queued", "started"]);

export function promptWasAccepted(disposition: unknown): boolean {
  return typeof disposition === "string" && ACCEPTED.has(disposition);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run _shared/promptDisposition.test.ts`

预期：PASS。

- [ ] **步骤 5：改两处调用**

`workspaceHandle.ts` 的 `prompt()` 里，把 `preflightResult: (ok: boolean) => { if (ok) { settled = true; resolve(); } }` 换成：

```ts
preflightResult: (disposition: unknown) => {
  if (!promptWasAccepted(disposition)) return;
  settled = true;
  resolve();
},
```

`prompt()` 返回的 Promise 在 fulfilled 且 `settled === false` 时同样 `reject(new Error("prompt not accepted"))`，并把 `turnOrigin` 设回 `"main"`。rejected 且未 settled 时保持现在的 `reject(error)`。

`embedded-runner.ts` 的 `acceptPrompt` 与 `runEmbeddedSubagent` 里的 `preflightResult: (ok) => ok && resolve()` 改为：回调里 `promptWasAccepted` 才 `resolve()`；`prompt()` fulfilled 但没接受过则 `reject(new Error("embedded sub-agent: prompt not accepted"))`。

把 `workspaceHandle.test.ts` 里 `preflightResult?.(true)` 改成 `preflightResult?.("started")`，`preflightResult?.(false)` 改成不调用回调并 `throw`。补一条：回调未调用且 `prompt()` resolve 时，`handle.prompt` reject，消息含 `prompt not accepted`。

`embedded-runner.run.test.ts` 里把 `preflightResult?.(true)` 改成 `preflightResult?.("started")`。

- [ ] **步骤 6：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/agent/workspaceHandle.test.ts`

运行：`cd extensions && npx vitest run multi-agent/embedded-runner.run.test.ts _shared/promptDisposition.test.ts`

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add extensions/_shared/promptDisposition.ts extensions/_shared/promptDisposition.test.ts extensions/multi-agent/embedded-runner.ts extensions/multi-agent/embedded-runner.run.test.ts electron-agent/electron/agent/workspaceHandle.ts electron-agent/electron/agent/workspaceHandle.test.ts
git commit -m "fix: treat prompt disposition as accepted only for handled, queued, or started"
```

---

### 任务 2：改工具结果时留下 structuredContent

**文件：**
- 修改：`extensions/loop-guard/index.ts`
- 修改：`extensions/after-tool-feedback/index.ts`
- 测试：`extensions/loop-guard/index.test.ts`（若没有则创建）、`extensions/after-tool-feedback` 下已有测试文件

- [ ] **步骤 1：编写失败的测试**

在 loop-guard 的测试里构造一次会追加提醒的 `tool_result`，事件带 `structuredContent: { output: "full" }`。断言返回值同时有新的 `content` 和原来的 `structuredContent`。

after-tool-feedback 同理：诊断有新增时，返回的对象包含传入的 `structuredContent`。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run loop-guard after-tool-feedback`

预期：FAIL，返回值没有 `structuredContent`。

- [ ] **步骤 3：编写最少实现代码**

两处 `return { content: ... }` 改为：

```ts
const structured = (event as { structuredContent?: unknown }).structuredContent;
return {
  content: /* 现有表达式 */,
  ...(structured !== undefined ? { structuredContent: structured } : {}),
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run loop-guard after-tool-feedback`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/loop-guard extensions/after-tool-feedback
git commit -m "fix: keep structuredContent when tool_result handlers replace content"
```

---

### 任务 3：把 Pi 钉到 1.0.2

**文件：**
- 修改：`electron-agent/package.json`、`cli/package.json`、`extensions/package.json` 及锁文件
- 修改：`cli/scripts/patch-pi-shell.mjs`、`cli/scripts/patch-pi-edit-preview.mjs`
- 修改：`electron-agent/electron-builder.yml`
- 修改：`extensions/multi-agent/index.ts`、`model-selection.ts`、`embedded-runner.ts`、`extensions/agent-mode/index.ts`（仅当 1.0.2 的类型编译失败）

- [ ] **步骤 1：改版本并安装**

三份 `package.json` 里 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core` 的版本改为 `1.0.2`（cli 只声明 coding-agent 的，改为 `1.0.2`）。

```bash
cd electron-agent && pnpm add @earendil-works/pi-coding-agent@1.0.2 @earendil-works/pi-ai@1.0.2 @earendil-works/pi-agent-core@1.0.2
cd cli && npm install @earendil-works/pi-coding-agent@1.0.2
cd extensions && npm install -D @earendil-works/pi-coding-agent@1.0.2 @earendil-works/pi-ai@1.0.2 @earendil-works/pi-agent-core@1.0.2
```

然后在每个锁文件里确认 `@earendil-works/pi-ai` 只有 1.0.2 这一版。出现第二份就在对应包的 `overrides` 里钉死 `1.0.2` 再装一次。

- [ ] **步骤 2：对准 postinstall 补丁**

```bash
cd cli && node scripts/patch-pi-shell.mjs && node scripts/patch-pi-edit-preview.mjs
```

预期：两个脚本都退出码 0。`patch-pi-edit-preview` 若因找不到 `contextLines = 4` 而退出 1，打开 `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js`，把脚本里的查找改成该文件实际的 `generateDiffString` 默认参数，替换结果仍是 `contextLines = 5`。`patch-pi-shell` 若找不到 `isLegacyWslBashPath`，把现有的 `winWhereExe` / `getWindowsSearchPath` / `spawnWhere` / `findGitBashFromGitCmd` 插到 1.0.2 里解析 `where.exe` 的那个函数之前，并让 Windows 上的 where 调用走 `spawnWhere`。行为与脚本头注释一致：用 System32 的 where.exe，并搜索注册表里的 Machine+User PATH。

- [ ] **步骤 3：解开 codemode 的 worker**

在 `electron-agent/electron-builder.yml` 的 `asarUnpack` 追加：

```yaml
  - node_modules/@earendil-works/pi-codemode/dist/runtime/worker.js
  - node_modules/quickjs-wasi/quickjs.wasm
  - node_modules/.pnpm/quickjs-wasi@*/node_modules/quickjs-wasi/quickjs.wasm
```

- [ ] **步骤 4：编译**

```bash
cd extensions && npx tsc --noEmit --pretty false
cd electron-agent && npx tsc -p tsconfig.json --noEmit --pretty false
cd cli && npm run typecheck
```

`ThinkingLevel` 或 `AgentMessage` 报不存在时，改从 `@earendil-works/pi-ai` 或 `@earendil-works/pi-coding-agent` 里仍然导出该符号的那个包引入。不要改成 `any`。

预期：三条 typecheck 都退出码 0。

- [ ] **步骤 5：跑已有相关测试**

```bash
cd electron-agent && npx vitest run electron/agent/workspaceHandle.test.ts electron/app/enhancePrompt.test.ts electron/agent/modelRuntimeHost.test.ts
cd extensions && npx vitest run mcp multi-agent/embedded-runner.run.test.ts loop-guard after-tool-feedback
```

预期：PASS。这一步还不改变 MCP 工具的激活方式。

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/package.json electron-agent/pnpm-lock.yaml electron-agent/package-lock.json electron-agent/electron-builder.yml cli/package.json cli/package-lock.json cli/scripts extensions/package.json extensions/package-lock.json extensions/multi-agent extensions/agent-mode
git commit -m "chore: pin pi packages to 1.0.2"
```

只加入本步实际改过的文件。锁文件里若没有 `package-lock.json` 的变更就不要 `git add` 它。

---

### 任务 4：配置合并与 exposure

**文件：**
- 创建：`extensions/mcp/merge.ts`
- 测试：`extensions/mcp/merge.test.ts`
- 修改：`extensions/mcp/config.ts`（类型增加可选字段；`parseMcpServers` 读出这些字段）

- [ ] **步骤 1：编写失败的测试**

`merge.test.ts` 覆盖规格第 6 节：

```ts
import { describe, expect, it } from "vitest";
import { mergeMcpLayers, normalizeExposure } from "./merge.js";

const stdio = (name: string) => ({ name, transport: "stdio" as const, command: "npx", args: [] as string[], env: {} });

describe("mergeMcpLayers", () => {
  it("lets project mcp.json override the desktop server", () => {
    const merged = mergeMcpLayers({
      desktop: [stdio("fs")],
      global: [],
      project: [{ ...stdio("fs"), command: "node" }],
      globalDisabled: [],
      projectDisabled: [],
      globalAutoEnableCodemode: undefined,
      projectAutoEnableCodemode: undefined,
    });
    expect(merged.servers.find((s) => s.name === "fs")?.command).toBe("node");
  });

  it("drops names listed in disabledMcpServers and enabled:false", () => {
    const merged = mergeMcpLayers({
      desktop: [stdio("a"), { ...stdio("b"), enabled: false }],
      global: [],
      project: [],
      globalDisabled: ["a"],
      projectDisabled: [],
      globalAutoEnableCodemode: undefined,
      projectAutoEnableCodemode: undefined,
    });
    expect(merged.servers.map((s) => s.name)).toEqual([]);
  });

  it("applies a project entry that only sets exposure", () => {
    const merged = mergeMcpLayers({
      desktop: [stdio("fs")],
      global: [],
      project: [{ name: "fs", exposure: "direct" }],
      globalDisabled: [],
      projectDisabled: [],
      globalAutoEnableCodemode: true,
      projectAutoEnableCodemode: false,
    });
    expect(merged.servers[0].exposure).toBe("direct");
    expect(merged.servers[0].command).toBe("npx");
    expect(merged.autoEnableCodemode).toBe(false);
  });

  it("records an error when a project override names an unknown server", () => {
    const merged = mergeMcpLayers({
      desktop: [],
      global: [],
      project: [{ name: "missing", exposure: "direct" }],
      globalDisabled: [],
      projectDisabled: [],
      globalAutoEnableCodemode: undefined,
      projectAutoEnableCodemode: undefined,
    });
    expect(merged.servers).toEqual([]);
    expect(merged.errors).toEqual(["项目配置只写了 exposure，但没有名为 missing 的服务器"]);
  });
});

describe("normalizeExposure", () => {
  it("defaults to codemode and accepts the deferred alias", () => {
    expect(normalizeExposure(undefined)).toBe("codemode");
    expect(normalizeExposure("codemode-deferred")).toBe("codemode");
  });
  it("rejects unknown values", () => {
    expect(normalizeExposure("sideways")).toBeUndefined();
  });
});

describe("exposureForTool", () => {
  it("prefers an exact toolExposure name over the first matching pattern", () => {
    expect(exposureForTool("read_file", { exposure: "codemode", toolExposure: { "read_*": "deferred", read_file: "direct" } })).toBe("direct");
    expect(exposureForTool("read_other", { exposure: "codemode", toolExposure: { "write_*": "hidden", "read_*": "deferred" } })).toBe("deferred");
  });
});

describe("expandConfigValues", () => {
  it("expands env vars, home, and a full-value command", () => {
    const expanded = expandConfigValues(
      { command: "npx", args: ["${WORKSPACE}"], env: { T: "${TOKEN}" }, headers: { A: "!node -p process.version" }, cwd: "~/proj" },
      { WORKSPACE: "/ws", TOKEN: "s3cret", home: "/home/u", sessionCwd: "/ws" },
    );
    expect(expanded.args).toEqual(["/ws"]);
    expect(expanded.env).toEqual({ T: "s3cret" });
    expect(expanded.cwd).toBe("/home/u/proj");
    expect(expanded.headers?.A.startsWith("v")).toBe(true);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/merge.test.ts`

预期：FAIL，找不到 `./merge.js`。

- [ ] **步骤 3：编写最少实现代码**

`McpExposure = "codemode" | "deferred" | "direct" | "hidden"`。

`normalizeExposure`：`undefined` 返回 `"codemode"`；`"codemode-deferred"` 返回 `"codemode"`；四档原样返回；其他返回 `undefined`。

`mergeMcpLayers` 按 desktop → global → project 放入 `Map`。没有 `command` 且没有 `url` 的项目条目只写入已存在服务器的 `enabled`、`exposure`、`toolExposure`、`description`，名字不存在时往 `errors` 推规格里的那句中文。`enabled === false` 或出现在 disabled 列表的名字从 Map 删除。`autoEnableCodemode` 用项目值，否则用全局值，都没有则为 `true`。无效 `exposure` 的服务器不进 `servers`，并往 `errors` 推 `` `服务器 ${name} 的 exposure 无效` ``。

`parseMcpServers` 把 `exposure`、`toolExposure`、`description`、`enabled`、`timeout`、`oauth`、`auth` 原样挂到配置对象上。现有测试断言的字段保持不变，新字段只在输入里出现时存在。

`exposureForTool(toolName, server)`：`toolExposure` 里与 `toolName` 全等的键优先；否则按对象键的书写顺序，把 `*` 当成通配的第一条命中；都没有则用服务器的 `exposure`，再没有则 `"codemode"`。

`expandConfigValues` 供 `expandServerVars` 调用。`${NAME}` 从传入的 env 读取。整个值匹配 `/^!(.+)$/` 时执行该命令并取 stdout 去首尾空白（测试里用 `node -p process.version`，断言以 `v` 开头）。`cwd` 的 `~/` 换成传入的 `home`。相对路径用 `resolve(sessionCwd, cwd)`。`headers` 与 `env`、`args`、`url`、`command` 走同一套替换。

管理器读配置时先 `mergeMcpLayers`，再对结果调用现有的 `injectDefaultServers`，最后 `expandServerVars`。`open-websearch` 的注入条件不变。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/merge.test.ts mcp/config.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/merge.ts extensions/mcp/merge.test.ts extensions/mcp/config.ts extensions/mcp/config.test.ts
git commit -m "feat: merge MCP layers with exposure and disabled servers"
```

---

### 任务 5：工具注册名

**文件：**
- 创建：`extensions/mcp/naming.ts`
- 测试：`extensions/mcp/naming.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { registerToolName, serverNamesConflict } from "./naming.js";

describe("registerToolName", () => {
  it("sanitizes and prefixes", () => {
    expect(registerToolName("my-server", "read-file", new Set()).name).toBe("mcp__my_server__read_file");
  });
  it("appends an 8-hex hash when two tools sanitize to the same name", () => {
    const first = registerToolName("s", "read-file", new Set());
    const second = registerToolName("s", "read_file", new Set([first.name]));
    expect(second.name).not.toBe(first.name);
    expect(second.name.length).toBeLessThanOrEqual(64);
    expect(second.name).toMatch(/_[0-9a-f]{8}$/);
    expect(second.originalToolName).toBe("read_file");
  });
});

describe("serverNamesConflict", () => {
  it("treats dash and underscore as the same server", () => {
    expect(serverNamesConflict("dev-radius", "dev_radius")).toBe(true);
    expect(serverNamesConflict("dev-radius", "other")).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/naming.test.ts`

预期：FAIL，找不到模块。

- [ ] **步骤 3：编写最少实现代码**

`sanitize` 继续用 `config.ts` 里的实现。注册名 `` `mcp__${sanitize(server)}__${sanitize(tool)}` ``。长度大于 64，或 `taken` 里已有这个名字：基础名截到 55 字符，再加 `_` 和 `sha256(server + "\0" + tool)` 的前 8 位十六进制，总长不超过 64。返回 `{ name, originalToolName: tool }`。

`serverNamesConflict`：两边 `replace(/-/g, "_")` 后相等则为冲突。同一字符串比较也返回 true，调用方不要拿一个名字和自己比。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/naming.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/naming.ts extensions/mcp/naming.test.ts
git commit -m "feat: hash colliding MCP tool names"
```

---

### 任务 6：调用结果的形状

**文件：**
- 创建：`extensions/mcp/resultShape.ts`
- 测试：`extensions/mcp/resultShape.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { shapeMcpResult } from "./resultShape.js";

describe("shapeMcpResult", () => {
  it("passes isError and keeps the full text in structuredContent", () => {
    const full = "x".repeat(30000);
    const shaped = shapeMcpResult({ content: [{ type: "text", text: full }], isError: true });
    expect(shaped.isError).toBe(true);
    expect(shaped.structuredContent).toMatchObject({ isError: true });
    expect(JSON.stringify(shaped.structuredContent)).toContain(full);
    const modelText = shaped.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    expect(Buffer.byteLength(modelText, "utf8")).toBeLessThan(Buffer.byteLength(full, "utf8"));
    expect(modelText).toContain("截掉");
  });

  it("uses an empty string when there is no text", () => {
    const shaped = shapeMcpResult({ content: [] });
    expect(shaped.content).toEqual([{ type: "text", text: "" }]);
    expect(shaped.isError).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/resultShape.test.ts`

预期：FAIL，找不到模块。

- [ ] **步骤 3：编写最少实现代码**

`shapeMcpResult(raw)`：`structuredContent` 为 `{ content, isError: raw.isError === true, structuredContent: raw.structuredContent }`。模型文本是所有 `type === "text"` 的 `text` 用 `\n` 拼起来，没有则为 `""`。UTF-8 超过 20480 字节时保留开头 8000 字节和结尾 8000 字节的合法 UTF-8，中间插入 `` `…截掉 N 字节…` ``，`N` 是被去掉的字节数。全文写入 `os.tmpdir()` 下一个 `mcp-result-` 前缀的文件，路径追加到模型文本末尾一行 `` `全文: ${path}` ``。图片块原样留在 `content`。`isError` 只在 `raw.isError === true` 时为 true。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/resultShape.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/resultShape.ts extensions/mcp/resultShape.test.ts
git commit -m "feat: truncate MCP text for the model and keep the full result"
```

---

### 任务 7：按 exposure 注册，codemode 工具不进激活集

**文件：**
- 修改：`extensions/mcp/index.ts`
- 测试：`extensions/mcp/index.test.ts`
- 修改：`extensions/mcp/manager.ts` 的 `callTool`，改为返回原始 MCP 结果再交给 `shapeMcpResult`

- [ ] **步骤 1：改失败中的现有测试并补新测试**

把 `index.test.ts` 里「registers connected tools and activates them」改成：已连接且未写 exposure 的工具会注册 `mcp__a__x`，激活集里保留 `read` 和 `codemode`，不包含 `mcp__a__x`。`mcp__old__gone` 仍被去掉。

追加：

- exposure 为 `direct` 的工具进入激活集，并且不因此要求 `codemode`。
- 服务器 `exposure: "deferred"` 时激活集包含 `tool_search`，不包含该 MCP 工具。
- `autoEnableCodemode: false` 且只有 codemode 服务器时，激活集不包含 `codemode`。
- 权限拒绝的 `execute` 返回 `isError: true`，且不调用 `callTool`。
- `execute` 把管理器返回的 `isError: true` 传到结果上。

`summary()` 的返回增加 `exposure`（缺省 `"codemode"`）和 `auth`（`"none" | "oauth" | "provider"`）。更新现有 summary 测试的期望对象。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/index.test.ts`

预期：FAIL，激活集仍包含 `mcp__a__x`。

- [ ] **步骤 3：编写最少实现代码**

`project()` 用 `registerToolName` 生成名字，保存 `originalToolName`。`registerTool` 的对象加上 `exposure`、`namespace: { name: "mcp__" + server.replace(/-/g, "_"), description }`、`outputSchema`（对象含 `content`、`isError`、`structuredContent`）。`execute` 在授权失败时返回 `{ content: [{ type: "text", text: 现有拒绝文案 }], details, isError: true }`。授权通过后 `callTool` 的原始结果交给 `shapeMcpResult`。

激活集：先去掉不在本次连接里的 `mcp__*`，再按 exposure 只把 `direct` 工具推进去。快照里存在 codemode 服务器且 `autoEnableCodemode !== false` 时保证 `"codemode"` 在列。存在 deferred 服务器时保证 `"tool_search"` 在列。

`manager.callTool` 返回 SDK 的原始结果（含 `content`、`isError`、`structuredContent`），不再只拼文本。连接尚未完成时返回现有的 not connected 错误，任务 8 再改成等待。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/index.test.ts mcp/manager.test.ts`

预期：PASS。`manager.test.ts` 里断言 `{ text: "hi" }` 的用例改成断言原始 content 里的文本，因为返回形状变了。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/index.ts extensions/mcp/index.test.ts extensions/mcp/manager.ts extensions/mcp/manager.test.ts
git commit -m "feat: leave codemode MCP tools out of the active set"
```

---

### 任务 8：direct 服务器最多等 10 秒

**文件：**
- 创建：`extensions/mcp/wait.ts`
- 测试：`extensions/mcp/wait.test.ts`
- 修改：`extensions/mcp/index.ts` 的 `bind`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { waitForDirect } from "./wait.js";

describe("waitForDirect", () => {
  it("resolves when every direct server settles", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((r) => { release = r; });
    const done = waitForDirect([pending], 1000);
    release();
    await expect(done).resolves.toBe("ready");
  });

  it("resolves with timeout when the budget elapses", async () => {
    await expect(waitForDirect([new Promise(() => {})], 5)).resolves.toBe("timeout");
  });

  it("does not wait when the list is empty", async () => {
    await expect(waitForDirect([], 1000)).resolves.toBe("ready");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/wait.test.ts`

预期：FAIL，找不到模块。

- [ ] **步骤 3：编写最少实现代码**

`waitForDirect(pendings, budgetMs)`：`pendings` 为空时立刻返回 `"ready"`。否则 `Promise.race`：全部 settle 则 `"ready"`，`budgetMs` 到时则 `"timeout"`。超时后不取消连接。

`bind()` 在 `before_agent_start` 里对 exposure 解析后含 direct 工具的服务器调用 `waitForDirect(..., 10_000)`。不含 direct 的服务器不放进这个列表。

同一次 `before_agent_start` 比较本轮服务器摘要（名字、exposure、一行 description）和上次已写入会话的摘要。有变化时 `appendMessage` 一条 `display: false` 的自定义消息，正文一行一个服务器。摘要相同则不写。自定义类型用 `mcp-servers`。

`execute` 点名的服务器若仍在连接，等待那一次 connect 的 Promise。状态已是 `failed` 则立刻返回 `isError: true`，文本用服务器的 `error`，不调用传输。

管理器发出工具调用时，若 SDK 客户端收到 progress 通知，把这一次调用的截止时间改成「现在 + timeout 秒」。`timeout` 缺省 60。单测里不连真服务器：给 `callTool` 注入一个 `onProgress` 假客户端，断言第二次进度把第一次已经到期的计时器清掉后，调用仍能返回。这个断言放在 `manager.test.ts`。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/wait.test.ts mcp/index.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/wait.ts extensions/mcp/wait.test.ts extensions/mcp/index.ts
git commit -m "feat: wait at most 10s for MCP servers that have direct tools"
```

---

### 任务 9：挂上官方 codemode 和 tool_search

**文件：**
- 修改：`cli/src/gren-runtime.ts`
- 测试：`cli/src/gren-runtime.test.ts`
- 修改：`cli/src/runtime.ts`、`cli/src/pi-worker.ts`

- [ ] **步骤 1：编写失败的测试**

在 `gren-runtime.test.ts` 增加：`PI_SYSTEM_WORKER` 不是 `"1"` 时，`extensionFactories` 的长度等于过滤后的清单长度加 2。`getConfig` 对 `PI_SYSTEM_WORKER` 返回 `"1"` 时，长度为 0。

测试用的 deps 增加 `extraFactories: [() => {}, () => {}]`，生产默认值才是 `createCodemodeExtension()` 和 `createToolSearchExtension()`，避免单测加载 wasm。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd cli && node --import tsx --test src/gren-runtime.test.ts`

预期：FAIL，长度仍是 2。

- [ ] **步骤 3：编写最少实现代码**

`makeGrenRuntimeFactory` 在 `PI_SYSTEM_WORKER !== "1"` 时，把 `extraFactories` 接在 `filterManagedExtensions(...)` 的结果后面。是 `"1"` 时保持 `[]`，不要把 extra 也接上去。

`runtime.ts` 和 `pi-worker.ts` 在调用 `main` 之前，若 `process.argv` 里还没有 `-builtin:mcp`，则追加参数，使内置 MCP 不加载。不要追加第二个 codemode 工厂。

具体做法：构造传给 `main` 的 argv 副本，在 `--` 之前插入 `"--extension"` 不受影响的设置。Pi 1.0.2 用设置项而不是未知 CLI 时，在 `main` 的资源加载前设置环境变量不可靠。改为在 argv 里追加：

```ts
const argv = process.argv.slice(2);
const withMcpOff = argv.some((a) => a === "-builtin:mcp" || a.includes("-builtin:mcp"))
  ? argv
  : [...argv, "--extensions", "-builtin:mcp"];
await main(withMcpOff, { extensionFactories: allExtensions });
```

若 1.0.2 的 `main` 没有 `--extensions` 这个参数（用 `pi --help` 核对），就改成文档里的设置合并方式：读取将要使用的 settings，并在 `MainOptions` 里传入已包含 `"-builtin:mcp"` 的 extensions 列表。以 `node_modules/@earendil-works/pi-coding-agent/dist` 里 `MainOptions` 的真实字段名为准，字段名写进这次提交的注释里。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd cli && node --import tsx --test src/gren-runtime.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/gren-runtime.ts cli/src/gren-runtime.test.ts cli/src/runtime.ts cli/src/pi-worker.ts
git commit -m "feat: load official codemode and tool_search without the built-in MCP client"
```

---

### 任务 10：嵌套工具卡片归到 codemode 下面

**文件：**
- 修改：`electron-agent/src/lib/pi.ts`（`tool_execution_start` / `update` / `end` 增加可选 `parentToolCallId?: string`）
- 修改：`electron-agent/src/stores/agentReducer.ts`
- 测试：`electron-agent/src/stores/agentReducer.test.ts`
- 修改：渲染工具行的组件（`TurnTimeline` / `buildTurnRows` 所在文件）

- [ ] **步骤 1：编写失败的测试**

在 `agentReducer.test.ts` 追加：一条 `tool_execution_start`，`toolCallId` 为 `parent/1`，`parentToolCallId` 为 `parent`，`toolName` 为 `mcp__a__x`。断言这条工具消息的 `parentToolCallId` 是 `parent`，并且 `buildTurnRows`（或当前把工具段排成行的函数）把它放在 `toolCallId === "parent"` 的那一行的 `children` 里，而不是顶层再占一行。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/stores/agentReducer.test.ts src/features/chat/turnRows.test.ts`

预期：FAIL，消息上没有 `parentToolCallId`。

- [ ] **步骤 3：编写最少实现代码**

reducer 在三类 `tool_execution_*` 上，若事件有 `parentToolCallId`，写到工具消息上。`buildTurnRows` 把带 `parentToolCallId` 的工具段从顶层摘下，挂到父段的 `children`。父段不存在时仍留在顶层，避免调用记录丢失。

工具卡片渲染父段时，在自己的输出下面按顺序渲染 `children`，每张仍用现有的 `ToolExecution`。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/stores/agentReducer.test.ts src/features/chat/turnRows.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/lib/pi.ts electron-agent/src/stores/agentReducer.ts electron-agent/src/stores/agentReducer.test.ts electron-agent/src/features/chat
git commit -m "feat: nest MCP calls under the codemode tool card"
```

只提交本步改过的 chat 文件。

---

### 任务 11：OAuth 规则与凭据键

**文件：**
- 创建：`extensions/mcp/oauthRules.ts`
- 测试：`extensions/mcp/oauthRules.test.ts`
- 修改：`extensions/mcp/transport.ts`、`extensions/mcp/manager.ts`

- [ ] **步骤 1：编写失败的测试**

覆盖规格第 11 节的纯规则：

- `callbackUrl` 为 `http://127.0.0.1:9/callback` 通过；带 query、或主机不是 `localhost` / `127.0.0.1` / `[::1]`、或不是 http，返回错误字符串。
- `authorizationIssMatches(expected, actual)`：两者都有且不同返回 false；`actual` 为空返回 true。
- `mergeStepUpScope("a b", "b c")` 返回 `"a b c"`，已有 scope 都在。
- `normalizeOAuthTokenFields({ scope: "", expires_in: null })` 不抛错，结果里没有空的 `scope`。
- `clientRegistration === "cimd"` 且没有 `clientMetadataUrl` 时 `oauthConfigError` 返回非空字符串。有 `clientMetadataUrl` 时返回 `undefined`。
- `credentialKey("srv", "https://x/mcp")` 同时包含服务器名和 URL。两个同 URL 不同名的键不相等。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/oauthRules.test.ts`

预期：FAIL，找不到模块。

- [ ] **步骤 3：编写最少实现代码**

按测试实现上述函数。`oauthConfigError` 还检查：`authServerMetadataUrl` 若存在，必须是 https，除非主机是回环。`clientName` 缺省不写进错误；调用方在动态注册时用 `"GrenAgent"`。

管理器在 HTTP/SSE 且配置了 `oauth` 时，用 MCP SDK 的 OAuth 客户端（`@modelcontextprotocol/sdk` 里导出的 auth 助手；以 安装后的 `client/auth.d.ts` 为准）。交换 code 之前调用 `authorizationIssMatches`，不匹配则服务器状态改为 `failed`，错误文本为 `授权服务器 iss 不匹配`，不发送 token 请求。凭据读写 `~/.pi/agent/mcp-auth.json`，键用 `credentialKey`。

面板要的登录 URL 由管理器在状态里增加 `loginUrl?: string`。打开浏览器失败时只把 URL 留在状态里，不把服务器标成成功。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/oauthRules.test.ts mcp/manager.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/oauthRules.ts extensions/mcp/oauthRules.test.ts extensions/mcp/transport.ts extensions/mcp/manager.ts extensions/mcp/manager.test.ts
git commit -m "feat: store MCP OAuth credentials per server name and URL"
```

---

### 任务 12：auth.provider

**文件：**
- 修改：`extensions/mcp/oauthRules.ts`
- 测试：`extensions/mcp/oauthRules.test.ts`
- 修改：`extensions/mcp/manager.ts`、`extensions/mcp/index.ts`

- [ ] **步骤 1：在现有测试文件追加失败用例**

```ts
it("rejects auth.provider from a project file and from plain http", () => {
  expect(authProviderError({ source: "project", provider: "openai", url: "https://x/mcp" })).toMatch(/项目/);
  expect(authProviderError({ source: "global", provider: "openai", url: "http://example.com/mcp" })).toMatch(/https/);
  expect(authProviderError({ source: "global", provider: "openai", url: "http://127.0.0.1/mcp" })).toBeUndefined();
  expect(authProviderError({ source: "desktop", provider: "openai", url: "https://x/mcp" })).toBeUndefined();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/oauthRules.test.ts`

预期：FAIL，`authProviderError` 不存在。

- [ ] **步骤 3：编写最少实现代码**

`source` 为 `"project"` 时返回 `项目级 mcp.json 不能使用 auth.provider`。URL 不是 https 且主机不是 `localhost`、`127.0.0.1`、`[::1]` 时返回 `auth.provider 需要 https，或本机回环上的 http`。`global`、`desktop`、`extension` 且 URL 合法时返回 `undefined`。

合并配置时给每个服务器标上 `source`。`authProviderError` 非空的服务器进入 `errors`，不连接。

传输层每次建请求调用注入的 `getProviderToken(provider)`。管理器字段 `getProviderToken` 由 `bind()` 设成读取进程内那一份 `ModelRuntime` 的当前 token。后来的 `session_start` 若拿到的是同一运行时，不替换回调。token 缺失则该服务器 `failed`，错误文本 `没有供应商登录态`。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/oauthRules.test.ts mcp/merge.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/oauthRules.ts extensions/mcp/oauthRules.test.ts extensions/mcp/merge.ts extensions/mcp/manager.ts extensions/mcp/index.ts
git commit -m "feat: send the provider login token as the MCP bearer token"
```

---

### 任务 13：面板上的登录和字段保留

**文件：**
- 修改：`electron-agent/src/features/extensions/McpServerCard.tsx`
- 修改：`electron-agent/src/features/extensions/AddMcpModal.tsx` 及其序列化函数（`serializeForm` / `configToForm` 所在文件）
- 测试：`electron-agent/src/features/extensions/McpServerCard` 的现有测试，以及表单序列化测试

- [ ] **步骤 1：编写失败的测试**

- 卡片 `runtimeStatus === "needs-login"` 且带 `loginUrl` 时，可见按钮「登录」，以及该 URL 的文本。
- `serializeForm` 在原始配置含 `oauth` 和 `exposure` 时，输出仍包含这两块。快速配置只改命令时，不把它们删掉。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/extensions`

预期：FAIL，没有「登录」或序列化丢了 `oauth`。

- [ ] **步骤 3：编写最少实现代码**

`runtimeStatus` 增加 `"needs-login"`。该状态下状态文案为「需要登录」，主按钮调用现有的打开外部 URL 的通道；通道失败时 URL 仍显示在卡片上，并有「复制」。卡片上显示 `exposure`。`auth === "oauth" | "provider"` 时显示对应短标签「OAuth」或「供应商登录」。

`configToForm` 把未知字段存进 `extra`。`serializeForm` 把 `extra` 合并回写出的对象，表单编辑过的 command、args、url、headers、env、cwd 覆盖同名字段。

状态推送 `mcp.state.publish` 的服务器对象增加 `exposure` 和 `auth`。`summary()` 已经返回这两个字段，面板读取它们。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/extensions`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/extensions extensions/mcp/index.ts
git commit -m "feat: show MCP login on the server card and keep oauth fields"
```

---

### 任务 14：资源工具和扩展登记的服务器

**文件：**
- 修改：`extensions/mcp/index.ts`
- 测试：`extensions/mcp/index.test.ts`
- 修改：`extensions/mcp/manager.ts`（列出 resources，并接收来源为 extension 的配置）

- [ ] **步骤 1：编写失败的测试**

- 一台 connected 服务器的快照带 `resources: true`、exposure `codemode`，另一台 `resources: true`、exposure `direct`。`project()` 注册 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`，且这三个工具的 exposure 为 `direct`。
- 全部提供资源的服务器都是 `hidden` 时，这三个名字不注册。
- `bind()` 处理 `mcp_servers_change`：事件里的服务器被交给管理器；同名已经在文件合并结果里时，不覆盖文件那条，`summary` 或错误列表含该名字。
- 只差 `-` / `_` 的扩展服务器名被拒绝，不进入连接列表。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/index.test.ts`

预期：FAIL，没有注册 `list_mcp_resources`。

- [ ] **步骤 3：编写最少实现代码**

快照上的服务器增加 `hasResources: boolean`。管理器在 `listTools` 之后，若客户端能 `listResources` 且返回至少一项，或有 resource templates，则 `hasResources` 为 true。失败按没有资源处理，不把整台服务器标失败。

三个资源工具的 exposure 取有资源的服务器里最宽的一档：有 `direct` 用 `direct`，否则有 `codemode` 用 `codemode`，否则有 `deferred` 用 `deferred`。全是 `hidden` 不注册。`execute` 按工具名调用 SDK 的 `listResources` / `listResourceTemplates` / `readResource`，结果走 `shapeMcpResult`。

`bind()` 注册 `session_start` 时读取 `pi.getMcpServers()`，并 `pi.on("mcp_servers_change", ...)`。这些配置 `source: "extension"`。文件合并结果里已有的同名服务器跳过扩展那条，错误文本 `` `扩展登记的服务器 ${name} 被配置文件盖住` ``。冲突名用 `serverNamesConflict`。扩展服务器卸载时 `disconnectServer` 并重新 `project()`。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/index.test.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/index.ts extensions/mcp/index.test.ts extensions/mcp/manager.ts
git commit -m "feat: expose MCP resources and connect extension-registered servers"
```

---

### 任务 15：日志轮转和恢复 deferred 工具名

**文件：**
- 创建：`extensions/mcp/logRotate.ts`
- 测试：`extensions/mcp/logRotate.test.ts`
- 修改：`extensions/mcp/manager.ts`、`extensions/mcp/index.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { mkdtempSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendCappedLog } from "./logRotate.js";

describe("appendCappedLog", () => {
  it("renames the file to .1 when the next write would pass 5MB", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-log-"));
    const path = join(dir, "mcp.log");
    writeFileSync(path, "x".repeat(5 * 1024 * 1024));
    appendCappedLog(path, "next\n");
    expect(readFileSync(join(dir, "mcp.log"), "utf8")).toBe("next\n");
    expect(statSync(join(dir, "mcp.log.1")).size).toBe(5 * 1024 * 1024);
  });
});
```

另在 `index.test.ts` 追加：`retainDeferredNames(["mcp__a__search"], ["read"])` 返回的激活集同时含 `read` 和 `mcp__a__search`。当前注册表里还没有 `mcp__a__search` 时也不删掉它。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/logRotate.test.ts mcp/index.test.ts`

预期：FAIL，找不到 `appendCappedLog` 或 `retainDeferredNames`。

- [ ] **步骤 3：编写最少实现代码**

`appendCappedLog(path, line)`：文件存在且当前大小加 `line` 的字节数大于 `5 * 1024 * 1024` 时，先 `rename` 到 `path + ".1"`（已有 `.1` 则覆盖），再把 `line` 写入新的 `path`。未超限则追加。管理器的连接、登录、失败日志都走这个函数，路径为 `join(homedir(), ".pi", "agent", "mcp.log")`。

`retainDeferredNames(savedMcpNames, active)`：对 `savedMcpNames` 里每个还不在 `active` 的名字 `push` 进去。`reload` 和会话恢复后调用它，名字来自恢复出来的激活集里、本次还没 `registerTool` 的 `mcp__*`。工具列表到达后正常 `project()`，这些名字已经注册则不再特殊处理。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/logRotate.test.ts mcp/index.test.ts mcp`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/mcp/logRotate.ts extensions/mcp/logRotate.test.ts extensions/mcp/manager.ts extensions/mcp/index.ts extensions/mcp/index.test.ts
git commit -m "feat: rotate MCP logs and keep deferred tool names across reload"
```

---

## 规格覆盖

| 规格 | 任务 |
|---|---|
| 4 SDK 升级与宿主调用 | 1、2、3 |
| 5 扩展加载 | 9 |
| 6 配置合并 | 4 |
| 7 注册名、exposure、toolExposure、结果、变更摘要 | 5、6、7、8、13 |
| 8 等待与恢复 | 8、15 |
| 9 调用链与嵌套卡片 | 6、7、10 |
| 10 扩展登记 | 14 |
| 11 OAuth 与 auth.provider | 11、12 |
| 12 日志与面板 | 13、15 |
| 非目标：不加载官方 MCP 客户端、不做 /mcp 与 Radius、不加 project trust | 9，且没有对应任务 |
