# 在 Pi 进程内接入 Cursor 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 omp 的 Cursor 客户端放进 GrenAgent 的 sidecar，让 `cursor-agent` 走 Cursor 的 HTTP/2 双向流，工具在同一条流里执行，性能与 omp 自己用 Cursor 时一致。

**架构：** `cli/src/cursor/` 持有复制来的客户端、OAuth 和档位映射。启动时同时 `registerApiProvider` 和 `ModelRuntime.registerNativeProvider`，因为 Electron 实际调用的是 `ModelRuntime.streamSimple`。`pi-agent-core` 与 `pi-coding-agent` 的已安装 `dist` 用 postinstall 打补丁：把 `cursorExecHandlers` 传进 `streamFn`，跳过带 `kCursorExecResolved` 的工具调用，并把供应商已经写回的工具结果放进会话。

**技术栈：** Node 22、`cli` 的 `node --import tsx --test`、`electron-agent` 的 Vitest、已安装的 `@earendil-works/pi-ai` 与 `pi-agent-core`、omp worktree 里的 Cursor 客户端源码。

**规格：** `docs/superpowers/specs/2026-10-06-cursor-native-embed-design.md`

**提交范围：** 每个任务只 `git add` 该任务列出的文件。当前工作区在 `feat/bash-sandbox-facts` 上还有大量无关改动，禁止 `git add -A`。

---

## 文件结构

- `cli/src/cursor/install.ts` — 注册供应商、挂上全局符号和准备函数。启动时调用。
- `cli/src/cursor/provider.ts` — `cursor-agent` 的 `streamSimple`。未知模型在开流前抛错。把档位换成线上 id。
- `cli/src/cursor/resume.ts` — `user-turn` 不带 `resume`，`in-stream-retry` 才带。
- `cli/src/cursor/h2-pool.ts` — 从复制来的客户端抽出的直连会话池。代理隧道不进池。
- `cli/src/cursor/oauth.ts` — 令牌文件、刷新、登录 URL。
- `cli/src/cursor/open-url.ts` — Windows 用 `rundll32` 打开完整 URL。
- `cli/src/cursor/exec-handlers.ts` — 用会话里已有工具执行 Cursor exec。
- `cli/src/cursor/vendor/` — 从 omp worktree 复制的客户端、protobuf、目录规则和思考映射。运行时不引用 omp 目录。
- `cli/scripts/patch-pi-cursor-loop.mjs` — 给已安装的 `pi-agent-core` 和 `pi-coding-agent` 打补丁。
- `cli/src/main.ts` — 启动时调用 `installCursorProvider`。
- `electron-agent/src/features/settings/providerPresets.ts` — 增加 Cursor 供应商。
- `electron-agent/src/features/settings/providerConfigAdapter.ts` — `cursor-agent` 使用目录阶梯，不用 OpenAI 四档。
- `electron-agent/src/features/chat/input/thinkingLevels.ts` — `SAFE_LADDER` 增加 `cursor-agent`。

omp 源码根（只读，复制来源）：

`D:\System Dir\Downloads\oh-my-pi\.worktrees\cursor-responses-proxy`

复制时用这份工作区里的 `packages/ai/src/providers/cursor.ts`（含 HTTP/2 会话池），不要用尚未包含会话池的旧树。

---

### 任务 1：档位映射与 resume 语义

**文件：**

- 创建：`cli/src/cursor/resume.ts`
- 创建：`cli/src/cursor/wire-model.ts`
- 测试：`cli/src/cursor/wire-model.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { cursorRequestResumes } from "./resume.ts";
import { resolveCursorWireModelId } from "./wire-model.ts";

test("下一条用户消息不使用 resume，流中途重试才使用", () => {
  assert.equal(cursorRequestResumes("user-turn"), false);
  assert.equal(cursorRequestResumes("in-stream-retry"), true);
});

test("显式档位覆盖 id 后缀，关闭思考不带 effort", () => {
  const model = {
    id: "gpt-5.4",
    requestModelId: "gpt-5.4",
    thinking: {
      efforts: ["low", "medium", "high", "xhigh"],
      effortRouting: {
        off: "gpt-5.4",
        low: "gpt-5.4-low",
        medium: "gpt-5.4",
        high: "gpt-5.4-high",
        xhigh: "gpt-5.4-xhigh",
      },
    },
  };
  assert.equal(resolveCursorWireModelId(model, "high"), "gpt-5.4-high");
  assert.equal(resolveCursorWireModelId(model, "low", "gpt-5.4-high"), "gpt-5.4-low");
  assert.equal(resolveCursorWireModelId(model, "off"), "gpt-5.4");
});

test("超出阶梯的档位夹到该模型最高档", () => {
  const model = {
    id: "gpt-5.4",
    requestModelId: "gpt-5.4",
    thinking: {
      efforts: ["low", "medium", "high", "xhigh"],
      effortRouting: { off: "gpt-5.4", high: "gpt-5.4-high", xhigh: "gpt-5.4-xhigh" },
    },
  };
  assert.equal(resolveCursorWireModelId(model, "max"), "gpt-5.4-xhigh");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test src/cursor/wire-model.test.ts`

工作目录：`cli`

预期：FAIL，找不到 `./resume.ts`。

- [ ] **步骤 3：编写最少实现代码**

`cli/src/cursor/resume.ts`：

```ts
export type CursorResumeKind = "user-turn" | "in-stream-retry";

export function cursorRequestResumes(kind: CursorResumeKind): boolean {
  return kind === "in-stream-retry";
}
```

`cli/src/cursor/wire-model.ts`：

```ts
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_ORDER)[number];

export interface CursorWireModel {
  id: string;
  requestModelId?: string;
  thinking?: {
    efforts?: readonly string[];
    effortRouting?: Partial<Record<Effort | "off", string>>;
  };
}

export function resolveCursorWireModelId(
  model: CursorWireModel,
  effort: Effort | "off",
  requestedId = model.id,
): string {
  const suffix = requestedId.slice(model.id.length);
  const fromSuffix = suffix.startsWith("-") ? suffix.slice(1) : undefined;
  const explicit = effort === "off" ? "off" : effort;
  const chosen = explicit !== "off" ? explicit : fromSuffix === "off" || fromSuffix === undefined ? "off" : fromSuffix;
  const clamped = clampEffort(model, chosen);
  return model.thinking?.effortRouting?.[clamped] ?? model.requestModelId ?? model.id;
}

function clampEffort(model: CursorWireModel, effort: Effort | "off"): Effort | "off" {
  if (effort === "off") return "off";
  const efforts = model.thinking?.efforts ?? [];
  if (efforts.includes(effort)) return effort;
  const index = EFFORT_ORDER.indexOf(effort);
  for (let i = index - 1; i >= 0; i--) {
    const lower = EFFORT_ORDER[i];
    if (lower && efforts.includes(lower)) return lower;
  }
  return "off";
}
```

显式档位优先：`effort !== "off"` 时忽略 `requestedId` 后缀。`off` 走 `effortRouting.off`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test src/cursor/wire-model.test.ts`

工作目录：`cli`

预期：PASS，3 个测试。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/cursor/resume.ts cli/src/cursor/wire-model.ts cli/src/cursor/wire-model.test.ts
git commit -m "feat(cursor): clamp thinking effort before choosing the wire model id"
```

工作目录：Pi 仓库根目录。

---

### 任务 2：复制 Cursor 客户端

**文件：**

- 创建：`cli/src/cursor/vendor/**`
- 修改：`cli/src/cursor/vendor/providers/cursor.ts`（只改 `resume` 的取值来源）
- 测试：`cli/src/cursor/vendor-load.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";

test("复制来的客户端导出开流函数，并且 composer-2.5 带 fast=false", async () => {
  const cursor = await import("./vendor/providers/cursor.ts");
  assert.equal(typeof cursor.streamCursor, "function");
  const { cursorModelParameters } = await import("./vendor/catalog/compat/behavior.ts");
  const parameters = cursorModelParameters("composer-2.5");
  assert.deepEqual(parameters, [{ id: "fast", value: "false" }]);
  const fast = cursorModelParameters("composer-2.5-fast");
  assert.deepEqual(fast, []);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test src/cursor/vendor-load.test.ts`

工作目录：`cli`

预期：FAIL，找不到 `./vendor/providers/cursor.ts`。

- [ ] **步骤 3：复制并改写导入**

从 omp worktree 复制这些路径到 `cli/src/cursor/vendor/`，去掉 `packages/*/src/` 前缀：

- `packages/ai/src/providers/cursor.ts`
- `packages/ai/src/providers/cursor/`
- `packages/ai/src/providers/connect-error-detail.ts`
- `packages/ai/src/providers/cursor-external-tool-handoff.md`
- `packages/ai/src/utils/block-symbols.ts`
- `packages/ai/src/utils/proxy.ts`
- `packages/ai/src/utils/schema.ts`
- `packages/ai/src/utils/tool-call-arguments.ts`
- `packages/ai/src/utils/deterministic-id.ts`
- `packages/ai/src/utils/event-stream.ts`
- `packages/ai/src/registry/oauth/cursor.ts`
- `packages/ai/src/registry/oauth/pkce.ts`
- `packages/catalog/src/model-thinking.ts`
- `packages/catalog/src/wire/cursor.ts`
- `packages/catalog/src/discovery/cursor-proto.ts`（以及它引用的 protobuf 运行时）
- `packages/catalog/src/compat/behavior.ts` 里 `cursorModelParameters` 所在的模块；若该文件还依赖 `rules.json`，把 `rules.json` 一并复制

然后循环：在 `cli` 执行 `node --import tsx --test src/cursor/vendor-load.test.ts`，按报错的缺失模块从 omp 的 `packages/ai`、`packages/catalog`、`packages/utils` 继续复制。把 `@oh-my-pi/pi-catalog/...`、`@oh-my-pi/pi-ai/...`、`@oh-my-pi/pi-utils/...` 改成 `cli/src/cursor/vendor/` 下的相对路径。停止条件是这个测试通过，并且 `cli` 的 `package.json` 没有新增 `@oh-my-pi/*` 依赖。

在复制来的 `providers/cursor.ts` 里，发起新一轮用户消息时 `resume` 使用 `cursorRequestResumes("user-turn")`；只有流中途重试使用 `cursorRequestResumes("in-stream-retry")`。上游报告模型不存在时的回退，以及流中途检查点重试，只关闭当前请求流，不调用 `discardCursorHttp2Session`。

把 `cli/src/cursor/wire-model.ts` 的函数体改成调用 vendor 的 `resolveWireModelId`。调用前先用 vendor 的夹紧函数把档位夹到 `model.thinking.efforts`。显式档位不是 `off` 时，先把 id 后缀去掉再路由，避免后缀盖过显式档位。`off` 传 `undefined` 给 `resolveWireModelId`。任务 1 的三个测试必须仍然通过，并且实现文件里不再自己解析模型名。

直连复用已有会话的函数保持原样。把 `acquireCursorHttp2Session` 和 `discardCursorHttp2Session` 放在 `cli/src/cursor/h2-pool.ts`，`cursor.ts` 改为调用它们。签名包含 `proxied: boolean` 和可选的 `connect`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test src/cursor/vendor-load.test.ts`

工作目录：`cli`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/cursor/vendor cli/src/cursor/h2-pool.ts cli/src/cursor/vendor-load.test.ts
git commit -m "feat(cursor): vendor the Cursor agent client into the sidecar"
```

---

### 任务 3：HTTP/2 会话复用

**文件：**

- 修改：`cli/src/cursor/h2-pool.ts`
- 测试：`cli/src/cursor/h2-pool.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import assert from "node:assert/strict";
import http2 from "node:http2";
import test from "node:test";
import { acquireCursorHttp2Session, discardCursorHttp2Session } from "./h2-pool.ts";

test("同一源站的第二轮复用会话，GOAWAY 之后重新连接", async () => {
  const connects: string[] = [];
  const original = http2.connect;
  http2.connect = ((authority: string) => {
    connects.push(authority);
    const session = original.call(http2, authority);
    return session;
  }) as typeof http2.connect;
  try {
    const first = await acquireCursorHttp2Session("https://api2.cursor.sh", { proxied: false });
    const second = await acquireCursorHttp2Session("https://api2.cursor.sh", { proxied: false });
    assert.equal(first, second);
    assert.equal(connects.length, 1);
    discardCursorHttp2Session(first, "goaway");
    const third = await acquireCursorHttp2Session("https://api2.cursor.sh", { proxied: false });
    assert.notEqual(third, first);
    assert.equal(connects.length, 2);
    discardCursorHttp2Session(third, "test-done");
  } finally {
    http2.connect = original;
  }
});

test("代理隧道不进池", async () => {
  let calls = 0;
  const factory = () => {
    calls += 1;
    return { closed: false, destroyed: false, close() {} };
  };
  const first = await acquireCursorHttp2Session("https://api2.cursor.sh", { proxied: true, connect: factory });
  const second = await acquireCursorHttp2Session("https://api2.cursor.sh", { proxied: true, connect: factory });
  assert.notEqual(first, second);
  assert.equal(calls, 2);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test src/cursor/h2-pool.test.ts`

工作目录：`cli`

预期：FAIL，签名对不上或第二轮没有复用。

- [ ] **步骤 3：编写最少实现代码**

`acquireCursorHttp2Session` 对同一 `authority` 且 `proxied: false` 返回未关闭、未销毁的会话。`discardCursorHttp2Session` 从池中删除并 `close()`。`proxied: true` 每次调用 `connect`，不写入池。出错和 `GOAWAY` 的监听里调用 `discardCursorHttp2Session`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test src/cursor/h2-pool.test.ts`

工作目录：`cli`

预期：PASS。测试结束时没有遗留到 `api2.cursor.sh` 的连接（`discard` 已关闭）。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/cursor/h2-pool.ts cli/src/cursor/h2-pool.test.ts cli/src/cursor/vendor/providers/cursor.ts
git commit -m "feat(cursor): reuse one HTTP/2 session per Cursor origin"
```

---

### 任务 4：登录、刷新和打开 URL

**文件：**

- 创建：`cli/src/cursor/oauth.ts`
- 创建：`cli/src/cursor/open-url.ts`
- 测试：`cli/src/cursor/oauth.test.ts`

令牌文件：`join(agentDir, "cursor-credentials.json")`。`agentDir` 由调用方传入，生产环境用 `getAgentDir()`。文件内容是 `{ access, refresh, expires }`。不要写 `~/.omp/cursor-proxy-credentials.json`。

- [ ] **步骤 1：编写失败的测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLoginUrl, resolveCursorAccessToken } from "./oauth.ts";

test("有效令牌直接使用，快过期先刷新，刷新失败不发上游请求", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-auth-"));
  const later = Math.floor(Date.now() / 1000) + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const fresh = `${header}.${Buffer.from(JSON.stringify({ exp: later })).toString("base64url")}.x`;
  await Bun.write(join(dir, "cursor-credentials.json"), JSON.stringify({ access: fresh, refresh: "r", expires: later * 1000 }));
  const used = await resolveCursorAccessToken(dir, { fetch: async () => { throw new Error("no network"); } });
  assert.equal(used, fresh);

  const soon = Math.floor(Date.now() / 1000) + 60;
  const expiring = `${header}.${Buffer.from(JSON.stringify({ exp: soon })).toString("base64url")}.x`;
  await Bun.write(join(dir, "cursor-credentials.json"), JSON.stringify({ access: expiring, refresh: "r", expires: soon * 1000 }));
  let posts = 0;
  const refreshed = await resolveCursorAccessToken(dir, {
    fetch: async () => {
      posts += 1;
      const access = `${header}.${Buffer.from(JSON.stringify({ exp: later })).toString("base64url")}.y`;
      return new Response(JSON.stringify({ accessToken: access, refreshToken: "r2" }), { status: 200 });
    },
  });
  assert.equal(posts, 1);
  assert.notEqual(refreshed, expiring);

  await Bun.write(join(dir, "cursor-credentials.json"), JSON.stringify({ access: expiring, refresh: "r", expires: soon * 1000 }));
  await assert.rejects(() => resolveCursorAccessToken(dir, {
    fetch: async () => new Response("no", { status: 401 }),
    login: async () => { throw new Error("login-required"); },
  }), /login-required/);
});

test("Windows 打开的登录 URL 同时带 challenge 和 uuid", async () => {
  const commands: string[][] = [];
  await openLoginUrl("https://cursor.com/loginDeepControl?challenge=abc&uuid=0932cd43-ee6b-4905-a016-268f839c0b23", {
    platform: "win32",
    spawn: (cmd) => { commands.push(cmd); },
  });
  assert.deepEqual(commands[0]?.slice(0, 2), ["rundll32", "url.dll,FileProtocolHandler"]);
  assert.match(commands[0]?.[2] ?? "", /challenge=abc/);
  assert.match(commands[0]?.[2] ?? "", /uuid=0932cd43-ee6b-4905-a016-268f839c0b23/);
});
```

`cli` 没有 Bun 类型时，把 `Bun.write` 换成 `node:fs/promises` 的 `writeFile`。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test src/cursor/oauth.test.ts`

工作目录：`cli`

预期：FAIL，找不到模块。

- [ ] **步骤 3：编写最少实现代码**

`isCursorTokenExpiringSoon` 使用复制来的实现：默认阈值 300 秒，JWT 解析失败视为即将过期。刷新成功后把新的 `access`、`refresh`、`expires` 写回同一文件。刷新失败时调用 `login`，不返回旧令牌。

`openLoginUrl` 在 `win32` 上 spawn `["rundll32", "url.dll,FileProtocolHandler", url]`。其它平台 spawn `["open", url]`（darwin）或 `["xdg-open", url]`。URL 原样作为单个参数。

登录 URL 由 vendor 的 `generateCursorAuthParams` 生成。在 `oauth.test.ts` 里再断言：返回的 URL 以 `https://cursor.com/loginDeepControl?` 开头，查询串同时含 `challenge` 和 `uuid`，轮询地址是 `https://api2.cursor.sh/auth/poll`。用测试替身替换 `fetch`，不要真的打开浏览器。

日志和抛出的 Error 消息里不拼接令牌。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test src/cursor/oauth.test.ts`

工作目录：`cli`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/cursor/oauth.ts cli/src/cursor/open-url.ts cli/src/cursor/oauth.test.ts
git commit -m "feat(cursor): log in with Cursor OAuth and keep the login URL intact"
```

---

### 任务 5：注册 cursor-agent

**文件：**

- 创建：`cli/src/cursor/provider.ts`
- 创建：`cli/src/cursor/install.ts`
- 修改：`cli/src/main.ts`
- 测试：`cli/src/cursor/provider.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { resetApiProviders, streamSimple } from "@earendil-works/pi-ai/compat";
import { installCursorProvider } from "./install.ts";

test("cursor-agent 走到本地流，未知模型在开流前失败", async () => {
  resetApiProviders();
  let opened = 0;
  installCursorProvider({
    streamCursor: () => { opened += 1; throw new Error("should not open"); },
    registerNativeProvider: () => {},
  });
  const model = { id: "missing", provider: "cursor", api: "cursor-agent", baseUrl: "https://api2.cursor.sh" };
  await assert.rejects(() => streamSimple(model as never, { messages: [] } as never).result(), /unknown model/i);
  assert.equal(opened, 0);
});

test("openai-responses 的实现不换成 Cursor", async () => {
  resetApiProviders();
  const { getApiProvider, registerBuiltInApiProviders } = await import("@earendil-works/pi-ai/compat");
  registerBuiltInApiProviders();
  const before = getApiProvider("openai-responses")?.streamSimple;
  installCursorProvider({
    streamCursor: () => { throw new Error("cursor"); },
    registerNativeProvider: () => {},
  });
  assert.equal(getApiProvider("openai-responses")?.streamSimple, before);
  assert.equal(typeof getApiProvider("cursor-agent")?.streamSimple, "function");
  assert.notEqual(getApiProvider("cursor-agent")?.streamSimple, before);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test src/cursor/provider.test.ts`

工作目录：`cli`

预期：FAIL，找不到 `./install.ts`。

- [ ] **步骤 3：编写最少实现代码**

`installCursorProvider`：

1. `globalThis.__grenCursorExecResolved` 设为 vendor `block-symbols.ts` 的 `kCursorExecResolved`。
2. `registerApiProvider({ api: "cursor-agent", stream, streamSimple })`。`streamSimple` 调用 `provider.ts`。
3. 调用传入的 `registerNativeProvider`，供应商 id 为 `cursor`，`streamSimple` 与上面是同一个函数。生产启动时对共享的 `ModelRuntime` 调用 `registerNativeProvider`。
4. `cli/src/main.ts` 在 `bootstrapSidecar` 之前调用不带测试替身的 `installCursorProvider()`。

`provider.ts` 的 `streamSimple`：模型 id 不在复制来的 Cursor 聊天模型列表里时抛 `Error("unknown model: ...")`，不调用 `streamCursor`。在列表里时用 `resolveCursorWireModelId` 得到线上 id，再调用 `streamCursor`。`signal` 原样传入。`cursorExecHandlers` 和 `cursorOnToolResult` 从选项原样传入。

`registerNativeProvider` 的供应商带上这份聊天模型列表，至少包含 `composer-2.5` 和 `composer-2.5-fast`。现有设置页按供应商读模型表，因此选中 Cursor 后列表里出现这两条，不另做一张模型表页面。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test src/cursor/provider.test.ts`

工作目录：`cli`

预期：PASS。`openai-responses` 的 provider 函数与注册前相同。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/cursor/provider.ts cli/src/cursor/install.ts cli/src/cursor/provider.test.ts cli/src/main.ts
git commit -m "feat(cursor): register the Cursor provider on the Pi model runtime"
```

---

### 任务 6：已执行的工具不再跑第二次

**文件：**

- 创建：`cli/scripts/patch-pi-cursor-loop.mjs`
- 修改：`cli/package.json` 的 `postinstall`
- 测试：`cli/src/cursor/loop-patch.test.ts`

补丁打两份可能被加载的包：

- `cli/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`
- `cli/node_modules/@earendil-works/pi-agent-core/dist/agent.js`
- `cli/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js`

若 `extensions` 下另有一份 `pi-agent-core/dist/agent-loop.js`，同一脚本同样打上。文件里已有 `__grenCursorExecResolved` 则跳过。

- [ ] **步骤 1：编写失败的测试**

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("带标记的 toolCall 被滤掉，成对结果按 toolCallId 取回", async () => {
  const { unresolvedToolCalls, takePairedResults, patchAgentLoopSource } = await import("../../scripts/patch-pi-cursor-loop.mjs");
  const symbol = Symbol("provider.block.cursorExecResolved");
  globalThis.__grenCursorExecResolved = symbol;
  const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false };
  const content = [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" }, [symbol]: true }];
  assert.deepEqual(unresolvedToolCalls(content), []);
  assert.deepEqual(takePairedResults([toolResult], new Set(["call-1"])), [toolResult]);
  const source = await readFile(new URL("../../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js", import.meta.url), "utf8");
  const patched = patchAgentLoopSource(source);
  assert.match(patched, /unresolvedToolCalls/);
  assert.match(patched, /takePairedResults/);
});
```

完整行为测试用子进程，避免当前进程已经加载未打补丁的 `agent-loop.js`：

```ts
test("agent 循环不再执行已标记的 bash", async () => {
  const script = `
    import { runAgentLoop } from "@earendil-works/pi-agent-core";
    const symbol = Symbol("provider.block.cursorExecResolved");
    globalThis.__grenCursorExecResolved = symbol;
    let executed = 0;
    const result = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "from-stream" }], isError: false, timestamp: 1 };
    const messages = await runAgentLoop(
      [{ role: "user", content: "hi", timestamp: 1 }],
      { messages: [], tools: [{ name: "bash", description: "", parameters: {}, execute: async () => { executed += 1; return { content: [], details: {} }; } }] },
      { model: { id: "composer-2.5", provider: "cursor", api: "cursor-agent" }, cursorToolResultBuffer: [result], convertToLlm: (m) => m.filter((x) => x.role !== "system") },
      () => {},
      undefined,
      async () => ({
        async *[Symbol.asyncIterator]() {},
        result: async () => ({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {}, [symbol]: true }], stopReason: "stop", api: "cursor-agent", provider: "cursor", model: "composer-2.5", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
      }),
    );
    if (executed !== 0) throw new Error("executed " + executed);
    if (!messages.some((m) => m.role === "toolResult" && m.toolCallId === "call-1")) throw new Error("missing pair");
  `;
  // 写入临时 mjs，node --import tsx 运行。退出码 0 才算通过。
});
```

子进程必须先执行补丁脚本，再 import `@earendil-works/pi-agent-core`。未打补丁时 `executed` 为 1，测试失败。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test src/cursor/loop-patch.test.ts`

工作目录：`cli`

预期：FAIL，未打补丁时工具被执行一次。

- [ ] **步骤 3：编写补丁**

`patchAgentLoopSource` 替换 `agent-loop.js` 里两处：

```js
const toolCalls = message.content.filter((c) => c.type === "toolCall");
```

和 `executeToolCalls` 里的同形过滤。替换为：

```js
const cursorResolved = globalThis.__grenCursorExecResolved;
const toolCalls = message.content.filter((c) => c.type === "toolCall" && !(cursorResolved && c[cursorResolved] === true));
```

在 `streamAssistantResponse` 返回之后、执行工具之前，把 `config.cursorToolResultBuffer` 里 `toolCallId` 属于已标记调用的结果 `push` 到 `currentContext.messages` 和 `newMessages`，并对每条 `emit({ type: "message_end", message: result })`。缓冲数组 `splice(0)`，避免下一轮重复写入。

`agent.js` 的 `createLoopConfig` 增加：

```js
cursorExecHandlers: this.cursorExecHandlers,
cursorOnToolResult: (message) => {
  this.cursorToolResultBuffer.push(message);
  return message;
},
cursorToolResultBuffer: this.cursorToolResultBuffer,
```

构造函数里初始化 `this.cursorToolResultBuffer = []`，`runWithLifecycle` 开始时清空它。`streamAssistantResponse` 已经把整个 `config` 展开进 `streamFunction` 的选项，因此 `cursorExecHandlers` 和 `cursorOnToolResult` 会到达 `streamCursor`。

`sdk.js` 的 `new Agent({...})` 增加 `cursorExecHandlers`。在 `streamFn` 里、调用 `modelRuntime.streamSimple` 之前：

```js
if (model.api === "cursor-agent" && globalThis.__grenCursorPrepare) {
  Object.assign(requestOptions, globalThis.__grenCursorPrepare(requestOptions));
}
```

`postinstall` 改为：

```json
"postinstall": "node scripts/patch-pi-shell.mjs && node scripts/patch-pi-edit-preview.mjs && node scripts/patch-pi-cursor-loop.mjs"
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node scripts/patch-pi-cursor-loop.mjs && node --import tsx --test src/cursor/loop-patch.test.ts`

工作目录：`cli`

预期：PASS。未标记的 `toolCall` 仍然执行（在同一测试文件里加一条对照：没有符号时 `executed === 1`）。

- [ ] **步骤 5：Commit**

```bash
git add cli/scripts/patch-pi-cursor-loop.mjs cli/package.json cli/src/cursor/loop-patch.test.ts
git commit -m "fix(cursor): keep stream-executed tool calls from running twice"
```

---

### 任务 7：用现有工具执行 Cursor exec

**文件：**

- 创建：`cli/src/cursor/exec-handlers.ts`
- 修改：`cli/src/cursor/install.ts`
- 测试：`cli/src/cursor/exec-handlers.test.ts`

从 omp 的 `packages/coding-agent/src/cursor.ts` 复制 `CursorExecHandlers`。导入改为 `@earendil-works/pi-coding-agent` 里实际导出的工具类型。会话工具的 `execute` 仍是原来的函数。

- [ ] **步骤 1：编写失败的测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createCursorExecHandlers } from "./exec-handlers.ts";

test("shell 帧调用会话里的 bash，失败结果成对返回", async () => {
  let seen = "";
  const handlers = createCursorExecHandlers({
    cwd: "D:/work",
    getTools: () => [{
      name: "bash",
      execute: async (_id: string, args: { command: string }) => {
        seen = args.command;
        return { content: [{ type: "text", text: "ran" }], details: {} };
      },
    }],
  });
  const ok = await handlers.shell({ command: "echo hi", workingDirectory: "D:/work" });
  assert.equal(seen, "echo hi");
  assert.match(JSON.stringify(ok), /ran/);

  const failing = createCursorExecHandlers({
    cwd: "D:/work",
    getTools: () => [{ name: "bash", execute: async () => { throw new Error("disk full"); } }],
  });
  const err = await failing.shell({ command: "rm x" });
  assert.match(JSON.stringify(err), /disk full/);
});

test("没有 handler 的内置 exec 返回失败而不是抛出", async () => {
  const handlers = createCursorExecHandlers({ cwd: "D:/work", getTools: () => [] });
  const err = await handlers.read({ path: "missing.txt" });
  assert.match(JSON.stringify(err), /no handler|not available/i);
});
```

断言匹配复制来的 handler 实际返回的字段名（`stdout`、`error` 或 protobuf 结果对象）。失败必须是返回值，不能是未捕获异常。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test src/cursor/exec-handlers.test.ts`

工作目录：`cli`

预期：FAIL，找不到模块。

- [ ] **步骤 3：编写最少实现代码**

`createCursorExecHandlers` 在调用时读取 `getTools()`。`shell` 找名为 `bash` 的工具，`read` / `grep` / `write` 找同名工具。工具抛错时返回失败结果，不向外抛。工具不存在时同样返回失败结果。

`install.ts` 设置：

```ts
globalThis.__grenCursorPrepare = (options: { cursorExecHandlers?: unknown }) => ({
  ...options,
  cursorExecHandlers: options.cursorExecHandlers ?? globalThis.__grenCursorExecHandlers?.(),
});
```

在 `cli/src/gren-runtime.ts` 的 `createAgentSessionFromServices` 返回会话之后：

```ts
const session = result.session;
globalThis.__grenCursorExecHandlers = () => createCursorExecHandlers({
  cwd: session.sessionManager.getCwd(),
  getTools: () => session.agent.state.tools,
});
```

`getTools` 每次 exec 帧都重新读 `session.agent.state.tools`，用的是这一轮已经启用的工具。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test src/cursor/exec-handlers.test.ts`

工作目录：`cli`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/cursor/exec-handlers.ts cli/src/cursor/exec-handlers.test.ts cli/src/cursor/install.ts cli/src/gren-runtime.ts
git commit -m "feat(cursor): execute Cursor exec frames with the session tools"
```

---

### 任务 8：设置里的供应商和思考档位

**文件：**

- 修改：`electron-agent/src/features/settings/providerPresets.ts`
- 修改：`electron-agent/src/features/settings/providerConfigAdapter.ts`
- 修改：`electron-agent/src/features/chat/input/thinkingLevels.ts`
- 测试：`electron-agent/src/features/settings/providerConfigAdapter.test.ts`（在现有文件加用例）

- [ ] **步骤 1：编写失败的测试**

在 `providerConfigAdapter.test.ts` 增加：

```ts
it("cursor-agent 使用目录阶梯，不用 openai-responses 的四档", () => {
  expect(PROVIDER_PRESETS.some((preset) => preset.id === "cursor" && preset.api === "cursor-agent")).toBe(true);
  const cursor = defaultThinkingLevelMap("cursor-agent");
  const openai = defaultThinkingLevelMap("openai-responses");
  expect(cursor).not.toEqual(openai);
  expect(cursor?.high).toBe("high");
  expect(cursor && "xhigh" in cursor).toBe(true);
});
```

`ApiType` 增加 `"cursor-agent"`。`SAFE_LADDER["cursor-agent"]` 含 `xhigh`，不能只有 minimal/low/medium/high。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/features/settings/providerConfigAdapter.test.ts`

工作目录：`electron-agent`

预期：FAIL，预设里没有 `cursor`。

- [ ] **步骤 3：编写最少实现代码**

`PROVIDER_PRESETS` 增加 `{ id: "cursor", name: "Cursor", api: "cursor-agent" }`。

`defaultThinkingLevelMap` 对 `cursor-agent` 返回目录阶梯。阶梯键与 `cli/src/cursor/wire-model.ts` 的 `EFFORT_ORDER` 一致，并包含 `off` 不在映射值里这一条：每个可选档位的值就是该档位本身（`high` → `high`），由 sidecar 再夹紧并做 `effortRouting`。不要返回 `OPENAI_THINKING_MAP`。

`thinkingLevels.ts` 的 `SAFE_LADDER` 为 `cursor-agent` 增加含 `xhigh` 的条目。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/features/settings/providerConfigAdapter.test.ts`

工作目录：`electron-agent`

预期：PASS，含原有用例。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/settings/providerPresets.ts electron-agent/src/features/settings/providerConfigAdapter.ts electron-agent/src/features/settings/providerConfigAdapter.test.ts electron-agent/src/features/chat/input/thinkingLevels.ts
git commit -m "feat(cursor): add a Cursor provider preset and its thinking ladder"
```

---

### 任务 9：中止与用户消息不重连

**文件：**

- 测试：`cli/src/cursor/provider.test.ts`（追加）
- 修改：`cli/src/cursor/provider.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
test("用户中止会取消这一轮并且没有第二轮", async () => {
  const signals: AbortSignal[] = [];
  installCursorProvider({
    streamCursor: (_model, _context, options) => {
      signals.push(options.signal);
      return fakeStream(options.signal);
    },
    registerNativeProvider: () => {},
    models: ["composer-2.5"],
  });
  const controller = new AbortController();
  const stream = streamSimple(cursorModel("composer-2.5"), { messages: [] } as never, { signal: controller.signal });
  controller.abort();
  const message = await stream.result();
  assert.equal(message.stopReason, "aborted");
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
});
```

`fakeStream` 在 `signal` abort 时让 `result()` 返回 `stopReason: "aborted"`。

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test src/cursor/provider.test.ts`

工作目录：`cli`

预期：FAIL，中止后仍打开第二轮，或 `stopReason` 不是 `aborted`。

- [ ] **步骤 3：编写最少实现代码**

`streamSimple` 把调用方的 `signal` 传给 `streamCursor`，不要在 abort 之后再次调用 `streamCursor`。`signal` 已 abort 时直接返回 `stopReason: "aborted"` 的助手消息。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test src/cursor/provider.test.ts src/cursor/wire-model.test.ts src/cursor/h2-pool.test.ts src/cursor/oauth.test.ts src/cursor/loop-patch.test.ts src/cursor/exec-handlers.test.ts`

工作目录：`cli`

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add cli/src/cursor/provider.ts cli/src/cursor/provider.test.ts
git commit -m "fix(cursor): abort one Cursor run without starting another"
```

---

### 任务 10：设置页登录入口

**文件：**

- 创建：`electron-agent/electron/agent/cursorLogin.ts`
- 修改：`electron-agent/src/features/settings/SettingsPanel.tsx`
- 测试：`electron-agent/electron/agent/cursorLogin.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { startCursorLogin } from "./cursorLogin";

describe("startCursorLogin", () => {
  it("把带 challenge 和 uuid 的登录 URL 交给打开函数，不自己请求模型", async () => {
    const opened: string[] = [];
    const fetches: string[] = [];
    await startCursorLogin({
      agentDir: "C:/tmp/agent",
      openLoginUrl: async (url) => { opened.push(url); },
      fetch: async (input) => {
        fetches.push(String(input));
        return new Response(JSON.stringify({ accessToken: "a", refreshToken: "r" }), { status: 200 });
      },
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("https://cursor.com/loginDeepControl?");
    expect(opened[0]).toContain("challenge=");
    expect(opened[0]).toContain("uuid=");
    expect(fetches.some((url) => url.includes("api2.cursor.sh") && !url.includes("/auth/poll"))).toBe(false);
  });
});
```

轮询 `https://api2.cursor.sh/auth/poll` 是登录本身的一部分，测试里的 `fetch` 替身可以应答它。断言禁止的是除此之外发往 Cursor 模型接口的请求。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run electron/agent/cursorLogin.test.ts`

工作目录：`electron-agent`

预期：FAIL，找不到 `./cursorLogin`。

- [ ] **步骤 3：编写最少实现代码**

`startCursorLogin` 调用 `cli/src/cursor/oauth.ts` 的登录函数，并把 URL 交给 `openLoginUrl`。设置页在 Cursor 供应商那一栏放一个「登录 Cursor」按钮，点击后调用这个函数。按钮不收集访问令牌文本。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run electron/agent/cursorLogin.test.ts src/features/settings/providerConfigAdapter.test.ts`

工作目录：`electron-agent`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/agent/cursorLogin.ts electron-agent/electron/agent/cursorLogin.test.ts electron-agent/src/features/settings/SettingsPanel.tsx
git commit -m "feat(cursor): add a Cursor login action in settings"
```
