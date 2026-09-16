# 子项目 D.1：跨会话历史检索（session-search）实现计划

> **面向 AI 代理的工作者：** 必需子技能：superpowers:executing-plans。步骤用复选框跟踪。

**目标：** 新增纯扩展 `extensions/session-search/`：`history_search` 工具 + `/history` 命令，对本项目历史会话做关键词检索。

**架构（实地核验后简化）：** 运行时 `SessionManager.list(cwd)` 已返回 `SessionInfo[]`，每项含 `allMessagesText`/`firstMessage`/`modified`/`id`。故 MVP **不需手动解析 JSONL、不需 SQLite/FTS 索引**，直接对 `allMessagesText` 做纯函数关键词排序。SQLite/FTS 索引留作大规模历史的增强。

**技术栈：** TypeScript（Pi 扩展，ESM `.js`）、typebox、Vitest。

**规格依据：** `docs/superpowers/specs/2026-06-16-session-search-design.md`（MVP 简化见下）

---

## 与规格的偏差（实地核验驱动，已确认更优）

规格 §3 设计 SQLite 表 + FTS5/关键词双模式 + 增量索引。核验发现 `SessionInfo`（`session-manager.d.ts:121-135`）**已含 `allMessagesText: string`**，`SessionManager.list(cwd)`（`:324`）直接返回每个会话的全文。因此：
- MVP 改为 `SessionManager.list` + 纯函数 `rankSessions`（关键词计数排序 + 片段），零索引、零 FTS 风险、纯逻辑可单测。
- 规格的 SQLite/FTS（`_shared/sqlite` 的 `DatabaseSync` 已就绪）降级为**增强**：历史极多、`list` 变慢时再加缓存索引。
- 成功标准（§1.2「搜关键词返回命中会话+片段」「空命中返回空+提示」）由本 MVP 满足。

## 关键约束

1. 零核心改动；纯扩展。`SessionManager` 与 `Type` 为值导入（`import { SessionManager } from "@earendil-works/pi-coding-agent"`；`import { Type } from "typebox"`，现网 `long-term-memory/index.ts:16`）。
2. 工具签名：`registerTool({ name,label,description,parameters:Type.Object({...}), execute(id,params,signal,onUpdate,ctx) })` 返回 `{ content:[{type:"text",text}], details }`（现网 `web-fetch/index.ts:102-144`）。
3. `ctx.cwd`（`types.d.ts:216`）；`SessionManager.list(cwd): Promise<SessionInfo[]>`。
4. 测试 `cd extensions && bunx vitest run session-search/<file>`；禁 emoji；提交 `git commit -- extensions/session-search extensions/index.ts`。

## 文件结构

| 文件 | 职责 |
|---|---|
| `extensions/session-search/package.json` | Pi 包清单 |
| `extensions/session-search/rank.ts` | `rankSessions`（纯函数：关键词计数 + 片段） |
| `extensions/session-search/index.ts` | 工厂：`history_search` 工具 + `/history` 命令 |
| `*.test.ts` | 单测 |
| 修改 `extensions/index.ts` | 接入 `sessionSearch` |

---

## 任务 1：脚手架 + rank

**文件：** `package.json`、`rank.ts`、`rank.test.ts`

- [ ] **步骤 1：package.json**（name `pi-session-search`；devDeps pi-coding-agent/pi-ai/pi-agent-core/typebox/vitest；`pi.extensions:["./index.ts"]`；`scripts.test:"vitest run"`）

```json
{
  "name": "pi-session-search",
  "version": "0.1.0",
  "description": "Cross-session history keyword search for the Pi coding agent.",
  "private": true,
  "type": "module",
  "keywords": ["pi-package", "pi-extension", "history"],
  "license": "MIT",
  "pi": { "extensions": ["./index.ts"] },
  "scripts": { "test": "vitest run" },
  "peerDependencies": { "typebox": "*" },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "typebox": "*",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **步骤 2：rank.ts**

```ts
export interface SessionInfoLike {
  id: string;
  modified?: Date | string | number;
  firstMessage?: string;
  allMessagesText?: string;
}

export interface SessionHit {
  id: string;
  modified: string;
  score: number;
  snippet: string;
}

function makeSnippet(text: string, lower: string, term: string, n: number): string {
  const i = lower.indexOf(term);
  if (i < 0) return text.slice(0, n).replace(/\s+/g, " ").trim();
  const start = Math.max(0, i - Math.floor(n / 4));
  return (start > 0 ? "…" : "") + text.slice(start, start + n).replace(/\s+/g, " ").trim();
}

/** Rank sessions by keyword occurrence count in their full text; return topK with snippets. */
export function rankSessions(
  infos: SessionInfoLike[],
  query: string,
  topK: number,
  snippetChars: number,
): SessionHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored = infos
    .map((info) => {
      const text = info.allMessagesText ?? info.firstMessage ?? "";
      const lower = text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        let idx = lower.indexOf(t);
        while (idx >= 0) {
          score++;
          idx = lower.indexOf(t, idx + t.length);
        }
      }
      return { info, text, lower, score };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => ({
    id: s.info.id,
    modified: s.info.modified ? new Date(s.info.modified).toISOString() : "",
    score: s.score,
    snippet: makeSnippet(s.text, s.lower, terms[0], snippetChars),
  }));
}
```

- [ ] **步骤 3：rank.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { rankSessions } from "./rank.js";

const infos = [
  { id: "s1", allMessagesText: "we fixed the auth bug in login" },
  { id: "s2", allMessagesText: "discussion about auth auth auth tokens" },
  { id: "s3", allMessagesText: "unrelated css tweaks" },
];

describe("rankSessions", () => {
  it("ranks by keyword occurrence and returns snippets", () => {
    const hits = rankSessions(infos, "auth", 5, 40);
    expect(hits.map((h) => h.id)).toEqual(["s2", "s1"]);
    expect(hits[0].score).toBe(3);
    expect(hits[0].snippet).toMatch(/auth/);
  });
  it("respects topK", () => {
    expect(rankSessions(infos, "auth", 1, 40).map((h) => h.id)).toEqual(["s2"]);
  });
  it("empty query or no match → []", () => {
    expect(rankSessions(infos, "   ", 5, 40)).toEqual([]);
    expect(rankSessions(infos, "nonexistent", 5, 40)).toEqual([]);
  });
});
```

- [ ] **步骤 4：运行** `cd extensions && bunx vitest run session-search/rank.test.ts` → 3 PASS。

---

## 任务 2：工厂（index.ts）

**文件：** `index.ts`、`index.test.ts`

- [ ] **步骤 1：index.ts**

```ts
// session-search: keyword search over past project sessions via SessionManager.list,
// which already exposes allMessagesText per session (no manual index needed for MVP).
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfig } from "../_shared/runtime-config.js";
import { rankSessions } from "./rank.js";

const enabled = () => (getConfig("HISTORY_SEARCH_ENABLED") ?? "1") !== "0";
const snippetChars = () => Number(getConfig("HISTORY_SEARCH_MAX_CHARS") ?? "300") || 300;

export default function (pi: ExtensionAPI) {
  if (!enabled()) return;

  pi.registerTool({
    name: "history_search",
    label: "Search History",
    description:
      "Search past conversation sessions in this project for a keyword. Returns matching sessions with snippets. " +
      "Use to recall what was done before in this repo.",
    parameters: Type.Object({
      query: Type.String({ description: "Keyword(s) to search for in past sessions" }),
      topK: Type.Optional(Type.Number({ description: "Max sessions to return (default 5)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const infos = await SessionManager.list(ctx.cwd).catch(() => []);
      const hits = rankSessions(infos, params.query ?? "", params.topK ?? 5, snippetChars());
      if (!hits.length) {
        return { content: [{ type: "text", text: "No matching sessions." }], details: { hits: [] } };
      }
      const body = hits.map((h, i) => `${i + 1}. [${h.id}] (${h.modified}) ${h.snippet}`).join("\n");
      return {
        content: [{ type: "text", text: `Found ${hits.length} session(s):\n${body}` }],
        details: { hits },
      };
    },
  });

  pi.registerCommand("history", {
    description: "搜索/列出历史会话：/history [关键词]",
    handler: async (args, ctx) => {
      const infos = await SessionManager.list(ctx.cwd).catch(() => []);
      const q = args.trim();
      if (!q) {
        const recent = [...infos]
          .sort((a, b) => +new Date(b.modified) - +new Date(a.modified))
          .slice(0, 10);
        ctx.ui.notify(
          recent.length
            ? recent.map((i) => `[${i.id}] ${(i.firstMessage ?? "").slice(0, 60)}`).join("\n")
            : "无历史会话。",
          "info",
        );
        return;
      }
      const hits = rankSessions(infos, q, 10, snippetChars());
      ctx.ui.notify(
        hits.length ? hits.map((h, i) => `${i + 1}. [${h.id}] ${h.snippet}`).join("\n") : "无匹配会话。",
        "info",
      );
    },
  });
}
```

- [ ] **步骤 2：index.test.ts**

```ts
import { describe, expect, it } from "vitest";
import factory from "./index.js";

describe("session-search factory", () => {
  it("registers history_search tool and /history command", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    factory({
      registerTool: (t: { name: string }) => tools.push(t.name),
      registerCommand: (n: string) => commands.push(n),
      on: () => {},
    } as never);
    expect(tools).toContain("history_search");
    expect(commands).toContain("history");
  });
});
```

- [ ] **步骤 3：运行全量** `cd extensions && bunx vitest run session-search` → 2 文件全 PASS。

---

## 任务 3：接入 + 验证 + 提交

- [ ] **步骤 1：extensions/index.ts** 加 `import sessionSearch from "./session-search/index.js";`；在 export 块与 allExtensions 的 `webSearch,` 之后加 `sessionSearch,`（两处）。

- [ ] **步骤 2：导入冒烟** `cd extensions && bun -e "const m = await import('./index.ts'); console.log(m.allExtensions.length, m.allExtensions.includes(m.sessionSearch));"` → 预期 `21 true`。

- [ ] **步骤 3：lint** ReadLints `extensions/session-search` + `extensions/index.ts`。

- [ ] **步骤 4：提交**

```bash
git add extensions/session-search extensions/index.ts
git commit -m "feat(session-search): cross-session keyword history search" -- extensions/session-search extensions/index.ts
```

---

## 自检

**规格覆盖度：** §1.1 history_search 工具 + /history → 任务 2；§1.2 成功标准（关键词命中/空命中提示）→ rank + index；§6 fail-soft（`SessionManager.list().catch(()=>[])` + 空提示）→ index。SQLite/FTS（§3/§5）按「偏差」降级为增强。

**占位符扫描：** 无 TODO；全步骤含完整代码与命令。

**类型一致性：** `SessionInfoLike`/`SessionHit`/`rankSessions`（rank.ts，index.ts 复用）；`SessionManager.list` 返回的 `SessionInfo` 结构满足 `SessionInfoLike`（id/modified/firstMessage/allMessagesText 均在 `session-manager.d.ts:121-135`）。
