# 命令与规则系统 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 全局命令（Pi prompt template，正文用 `{参数}` 留空），在输入框渲染成可编辑的命令胶囊，发送后气泡里显示只读胶囊；全局加项目两级的规则列表，每条可开关，启用的规则每轮注入上下文。

**架构：**
- 两个新 Pi 扩展。`prompt-commands` 在 `input` 钩子里把 `/名 "参数"` 展开成 `<command>` 块；`context-rules` 在 `before_agent_start` 里把启用的规则追加到 `systemPromptOptions.contextFiles`。
- 主进程的 `PromptLibraryService` 负责读写 `<agentDir>/prompts/*.md`、`<agentDir>/rules/*.md`、`<工作区>/.pi/rules/*.md`。
- 渲染层新增 Lexical `CommandPillNode`（DecoratorNode，内嵌原生 `<input>`），以及气泡解析和扩展面板里的两个页签。
- 语法模块 `extensions/prompt-commands/syntax.ts` 是纯函数，扩展、主进程、渲染层三处共用这一份。

**技术栈：** TypeScript、Pi 扩展 API（`@earendil-works/pi-coding-agent`）、Electron IPC、React 19、Lexical 0.42 + `@lobehub/editor`、antd v6 + antd-style、vitest、`electron-agent/ui-harness`。

**规格：** `docs/superpowers/specs/2026-10-08-commands-and-rules-design.md`

---

## 开工前

- 先从 `master` 拉出分支 `feat/commands-and-rules`。工作区里有和本需求无关的未提交改动（cursor 相关），所以每次提交只 `git add` 本任务列出的文件，不要用 `git add -A`。
- 照仓库约定，先 grep `docs/decisions/` 确认没有已否决的方案：`grep -rln "prompt template\|contextFiles\|command 块" docs/decisions`。
- 测试命令：
  - 扩展：`cd extensions && npx vitest run <文件>`
  - electron-agent：`cd electron-agent && npx vitest run <文件>`。主进程测试在 node 环境跑；渲染层测试文件第一行必须写 `// @vitest-environment jsdom`。
  - cli：`cd cli && npx vitest run <文件>`

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `extensions/prompt-commands/syntax.ts` | 新建 | 纯函数：占位符、参数转义、调用文本、`<command>` 块 |
| `extensions/prompt-commands/syntax.test.ts` | 新建 | 语法单测 |
| `extensions/prompt-commands/templates.ts` | 新建 | 读写模板文件需要的路径和解析（用到 fs） |
| `extensions/prompt-commands/expand.ts` | 新建 | 纯函数：调用文本 → 展开结果 |
| `extensions/prompt-commands/expand.test.ts` | 新建 | 展开单测 |
| `extensions/prompt-commands/index.ts` | 新建 | `input` 钩子 |
| `extensions/prompt-commands/index.test.ts` | 新建 | 钩子单测 |
| `extensions/context-rules/rules.ts` | 新建 | 规则文件解析、目录列举、mtime 缓存 |
| `extensions/context-rules/rules.test.ts` | 新建 | 规则单测 |
| `extensions/context-rules/index.ts` | 新建 | `before_agent_start` 钩子 |
| `extensions/context-rules/index.test.ts` | 新建 | 钩子单测 |
| `extensions/index.ts` | 修改 | 注册两个扩展 |
| `cli/src/extension-profile.ts` | 修改 | 把两个扩展加入 `CORE_ALWAYS_ON` |
| `extensions/multi-agent/embedded-runner.ts` | 修改 | 同上（子代理） |
| `electron-agent/electron/app/promptLibraryService.ts` | 新建 | 命令和规则的增删改查 |
| `electron-agent/electron/app/promptLibraryService.test.ts` | 新建 | 服务单测 |
| `electron-agent/electron/ipc/register.ts` | 修改 | 注册 7 个 IPC 命令 |
| `electron-agent/electron/main.ts` | 修改 | 创建服务实例 |
| `electron-agent/src/lib/promptLibraryIo.ts` | 新建 | 渲染层 IPC 封装 |
| `electron-agent/src/features/chat/input/editor/promptCommandCache.ts` | 新建 | 模板列表缓存（10 秒 TTL） |
| `electron-agent/src/features/chat/input/editor/CommandPill/commandPillStyles.ts` | 新建 | 胶囊样式（输入框和气泡共用） |
| `electron-agent/src/features/chat/input/editor/CommandPill/CommandPillView.tsx` | 新建 | 只读胶囊 |
| `electron-agent/src/features/chat/input/editor/CommandPill/CommandPillView.test.tsx` | 新建 | 只读胶囊单测 |
| `electron-agent/src/features/chat/input/editor/CommandPill/pillKeys.ts` | 新建 | 纯函数：按键 → 动作 |
| `electron-agent/src/features/chat/input/editor/CommandPill/pillKeys.test.ts` | 新建 | 按键单测 |
| `electron-agent/src/features/chat/input/editor/CommandPill/CommandPillNode.ts` | 新建 | Lexical 节点 |
| `electron-agent/src/features/chat/input/editor/CommandPill/commands.ts` | 新建 | 插入和聚焦命令、插入后待聚焦表 |
| `electron-agent/src/features/chat/input/editor/CommandPill/CommandPillPlugin.ts` | 新建 | 节点、装饰器、markdown 写出 |
| `electron-agent/src/features/chat/input/editor/CommandPill/CommandPillEditor.tsx` | 新建 | 可编辑胶囊 |
| `electron-agent/src/features/chat/input/editor/CommandPill/ReactCommandPillPlugin.tsx` | 新建 | 挂进 `<Editor plugins>` |
| `electron-agent/src/features/chat/input/editor/CommandPill/hostContext.ts` | 新建 | `submit` 回调上下文 |
| `electron-agent/src/features/chat/input/editor/CommandPill/composerText.ts` | 新建 | 读草稿文本、发送前检查必填参数、判断光标是否在文首 |
| `electron-agent/src/features/chat/input/editor/CommandPill/composerText.test.ts` | 新建 | 单测 |
| `electron-agent/src/features/chat/ChatInput.tsx` | 修改 | 读草稿、发送前检查 |
| `electron-agent/src/features/chat/MessageEditBox.tsx` | 修改 | 同上，并挂插件 |
| `electron-agent/src/features/chat/input/editor/MessageEditor.tsx` | 修改 | 挂插件和宿主上下文 |
| `electron-agent/src/features/chat/input/editor/usePasteCapture.ts` | 修改 | 胶囊内部的粘贴不拦截 |
| `electron-agent/src/features/chat/input/editor/useSlashOptions.ts` | 修改 | 带参数模板插入胶囊；不在文首时隐藏这些模板 |
| `electron-agent/src/features/chat/input/editor/slashPromptOptions.ts` | 新建 | 纯函数：菜单过滤和参数提示 |
| `electron-agent/src/features/chat/input/editor/slashPromptOptions.test.ts` | 新建 | 单测 |
| `electron-agent/src/features/chat/input/editor/commandPaste.ts` | 修改 | 粘贴带参数模板 → 胶囊数据 |
| `electron-agent/src/features/chat/input/editor/commandPaste.test.ts` | 修改 | 补用例 |
| `electron-agent/src/features/chat/input/editor/useCommandPaste.ts` | 修改 | 插入胶囊 |
| `electron-agent/src/features/chat/messageTags.tsx` | 修改 | `command` 段 |
| `electron-agent/src/features/chat/messageTags.command.test.tsx` | 新建 | 单测 |
| `electron-agent/src/features/extensions/commandDraft.ts` | 新建 | 命令表单校验 |
| `electron-agent/src/features/extensions/commandDraft.test.ts` | 新建 | 单测 |
| `electron-agent/src/features/extensions/PromptBodyEditor.tsx` | 新建 | 高亮占位符的文本框 |
| `electron-agent/src/features/extensions/libraryStyles.ts` | 新建 | 两个页签共用的左右分栏样式 |
| `electron-agent/src/features/extensions/CommandsPanel.tsx` | 新建 | 命令页签 |
| `electron-agent/src/features/extensions/CommandsPanel.test.tsx` | 新建 | 单测 |
| `electron-agent/src/features/extensions/RulesPanel.tsx` | 新建 | 规则页签 |
| `electron-agent/src/features/extensions/RulesPanel.test.tsx` | 新建 | 单测 |
| `electron-agent/src/features/extensions/ExtensionsPanel.tsx` | 修改 | 加两个页签 |
| `electron-agent/ui-harness/scenarios/command-pill.tsx` + `probes/command-pill.mjs` | 新建 | 胶囊场景 |
| `electron-agent/ui-harness/scenarios/prompt-library-panel.tsx` + `probes/prompt-library-panel.mjs` | 新建 | 面板场景 |
| `AGENTS.md` | 修改 | 场景清单加两个 |
| `docs/architecture.md` | 修改 | 追加事实描述 |
| `docs/decisions/extensions/2026-10-08-command-block-and-context-rules.md` | 新建 | 决策笔记 |

---

### 任务 1：语法模块

**文件：**
- 创建：`extensions/prompt-commands/syntax.ts`
- 测试：`extensions/prompt-commands/syntax.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import {
  argumentHint,
  buildCommandBlock,
  COMMAND_NAME_RE,
  decodeCommandBlock,
  findCommandBlocks,
  formatInvocation,
  parseInvocation,
  parsePromptParams,
  renderPromptBody,
  resolveArgs,
  splitArgs,
  tokenizePromptBody,
} from "./syntax.js";

describe("parsePromptParams", () => {
  it("按首次出现顺序列出参数，同名合并，第一个默认值生效", () => {
    expect(parsePromptParams("把 {file} 改成 {style=functional}，再看 {file} 和 {style=oop}")).toEqual([
      { name: "file" },
      { name: "style", defaultValue: "functional" },
    ]);
  });

  it("后出现的默认值补给先出现的无默认参数", () => {
    expect(parsePromptParams("{a} 然后 {a=1}")).toEqual([{ name: "a", defaultValue: "1" }]);
  });

  it("支持中文参数名，空默认值也算默认值", () => {
    expect(parsePromptParams("{文件} {备注=}")).toEqual([{ name: "文件" }, { name: "备注", defaultValue: "" }]);
  });

  it("不把 JSON、空花括号、数字开头和转义当参数", () => {
    expect(parsePromptParams('{"a":1} { } {1x} {{file}} {a b}')).toEqual([]);
  });
});

describe("renderPromptBody", () => {
  it("代入参数并把 {{ }} 还原成字面量", () => {
    expect(renderPromptBody("{{file}} = {file}，风格 {style=x}", { file: "a.ts", style: "fp" })).toBe(
      "{file} = a.ts，风格 fp",
    );
  });

  it("值里的 $& 之类原样输出", () => {
    expect(renderPromptBody("{a}", { a: "$&$1" })).toBe("$&$1");
  });

  it("没有提供值的占位符保持原样", () => {
    expect(renderPromptBody("{a}", {})).toBe("{a}");
  });
});

describe("tokenizePromptBody", () => {
  it("切出占位符段", () => {
    expect(tokenizePromptBody("把 {file} 改成 {style=fp}")).toEqual([
      { text: "把 " },
      { text: "{file}", param: "file" },
      { text: " 改成 " },
      { text: "{style=fp}", param: "style" },
    ]);
  });
});

describe("argumentHint / resolveArgs", () => {
  const params = [{ name: "file" }, { name: "style", defaultValue: "fp" }];

  it("必填写 <>，有默认写 []", () => {
    expect(argumentHint(params)).toBe("<file> [style]");
  });

  it("空串用默认值，缺必填列出来", () => {
    expect(resolveArgs(params, ["", ""])).toEqual({ values: { style: "fp" }, missing: ["file"] });
    expect(resolveArgs(params, ["a.ts"])).toEqual({ values: { file: "a.ts", style: "fp" }, missing: [] });
  });
});

describe("调用文本", () => {
  it("formatInvocation 加引号并转义，splitArgs 能还原", () => {
    const values = ['a "b"', "c\\d", "", "中文 空格"];
    const text = formatInvocation("cmd", values);
    expect(text).toBe('/cmd "a \\"b\\"" "c\\\\d" "" "中文 空格"');
    const parsed = parseInvocation(text);
    expect(parsed?.name).toBe("cmd");
    expect(splitArgs(parsed!.argsText, values.length)).toEqual({ args: values, rest: "" });
  });

  it("splitArgs 只取 count 个参数，剩下的是补充正文", () => {
    expect(splitArgs('"a" b 顺便看看\n第二行', 2)).toEqual({ args: ["a", "b"], rest: "顺便看看\n第二行" });
  });

  it("单引号内不转义，缺收尾引号读到结尾", () => {
    expect(splitArgs("'a\\b' \"open", 2)).toEqual({ args: ["a\\b", "open"], rest: "" });
  });

  it("parseInvocation 要求 / 在开头且命令名后是空白或结尾", () => {
    expect(parseInvocation("/review")).toEqual({ name: "review", argsText: "" });
    expect(parseInvocation("/usr/bin")).toBeNull();
    expect(parseInvocation(" /review")).toBeNull();
    expect(parseInvocation("看 /review")).toBeNull();
  });

  it("COMMAND_NAME_RE 接受中文、- 和 _，拒绝路径字符", () => {
    expect(COMMAND_NAME_RE.test("重构-a_b")).toBe(true);
    expect(COMMAND_NAME_RE.test("../x")).toBe(false);
    expect(COMMAND_NAME_RE.test("-x")).toBe(false);
    expect(COMMAND_NAME_RE.test("a".repeat(65))).toBe(false);
  });
});

describe("<command> 块", () => {
  const args = [
    { name: "file", value: 'a "<b>" & c' },
    { name: "style", value: "fp" },
  ];

  it("构造后能找回名字和参数，参数顺序不变", () => {
    const text = `前文\n${buildCommandBlock("refactor", args, "正文")}\n\n补充`;
    const [hit] = findCommandBlocks(text);
    expect(hit.block).toEqual({ name: "refactor", args });
    expect(text.slice(hit.start, hit.end)).toBe(buildCommandBlock("refactor", args, "正文"));
  });

  it("正文里的 </command> 被转义，块不会提前截断", () => {
    const text = buildCommandBlock("x", [], "a\n</command>\nb");
    expect(text).toContain("<\\/command>");
    const [hit] = findCommandBlocks(text);
    expect(hit.end).toBe(text.length);
  });

  it("空正文也能匹配", () => {
    expect(findCommandBlocks(buildCommandBlock("x", [], ""))).toHaveLength(1);
  });

  it("args 坏掉时 block 为 null", () => {
    expect(decodeCommandBlock("x", "not json")).toBeNull();
    expect(decodeCommandBlock("x", "[1]")).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run prompt-commands/syntax.test.ts`
预期：FAIL，报错 `Failed to resolve import "./syntax.js"`

- [ ] **步骤 3：编写实现**

```ts
// 命令模板语法。纯函数，扩展、主进程、渲染层共用，不能引入 node 模块。
//   占位符：{名} / {名=默认值}；{{ 和 }} 输出字面量花括号。
//   调用文本：/名 "参数" …，双引号内用 \" 和 \\ 转义。
//   展开结果：<command name=… args=…>正文</command>，气泡据此还原成命令胶囊。

export interface PromptParam {
  name: string;
  defaultValue?: string;
}

export interface CommandArg {
  name: string;
  value: string;
}

export interface CommandBlock {
  name: string;
  args: CommandArg[];
}

export interface PromptSegment {
  text: string;
  /** 这一段是占位符时为参数名。 */
  param?: string;
}

export interface CommandBlockHit {
  start: number;
  end: number;
  /** args 解析失败时为 null，调用方按普通文本显示。 */
  block: CommandBlock | null;
}

export const COMMAND_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;

const TOKEN_RE = /\{\{|\}\}|\{([\p{L}_][\p{L}\p{N}_-]*)(?:=([^}\n]*))?\}/gu;
const INVOCATION_RE = /^\/([\p{L}\p{N}][\p{L}\p{N}_-]{0,63})(?=\s|$)/u;
const COMMAND_BLOCK_RE = /<command name="([^"]*)" args="([^"]*)">\n[\s\S]*?\n<\/command>/g;

export function parsePromptParams(body: string): PromptParam[] {
  const params: PromptParam[] = [];
  for (const match of body.matchAll(TOKEN_RE)) {
    const name = match[1];
    if (!name) continue;
    const defaultValue = match[2];
    const index = params.findIndex((param) => param.name === name);
    if (index === -1) {
      params.push(defaultValue === undefined ? { name } : { name, defaultValue });
    } else if (params[index].defaultValue === undefined && defaultValue !== undefined) {
      params[index] = { name, defaultValue };
    }
  }
  return params;
}

export function tokenizePromptBody(body: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(TOKEN_RE)) {
    const name = match[1];
    if (!name) continue;
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: body.slice(last, start) });
    segments.push({ text: match[0], param: name });
    last = start + match[0].length;
  }
  if (last < body.length) segments.push({ text: body.slice(last) });
  return segments;
}

export function renderPromptBody(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(TOKEN_RE, (token: string, name: string | undefined) => {
    if (token === "{{") return "{";
    if (token === "}}") return "}";
    return name !== undefined && Object.hasOwn(values, name) ? values[name] : token;
  });
}

export function argumentHint(params: readonly PromptParam[]): string {
  return params.map((param) => (param.defaultValue === undefined ? `<${param.name}>` : `[${param.name}]`)).join(" ");
}

export function resolveArgs(
  params: readonly PromptParam[],
  raw: readonly string[],
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  params.forEach((param, index) => {
    const given = raw[index] ?? "";
    if (given !== "") values[param.name] = given;
    else if (param.defaultValue !== undefined) values[param.name] = param.defaultValue;
    else missing.push(param.name);
  });
  return { values, missing };
}

export function quoteArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatInvocation(name: string, values: readonly string[]): string {
  return [`/${name}`, ...values.map(quoteArg)].join(" ");
}

export function parseInvocation(text: string): { name: string; argsText: string } | null {
  const match = INVOCATION_RE.exec(text);
  if (!match) return null;
  return { name: match[1], argsText: text.slice(match[0].length) };
}

/** 按顺序取 count 个参数：双引号内支持 \ 转义，单引号原样，其余按空白切。剩下的原文是补充正文。 */
export function splitArgs(text: string, count: number): { args: string[]; rest: string } {
  const args: string[] = [];
  let i = 0;
  while (args.length < count) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const quote = text[i];
    let value = "";
    if (quote === '"' || quote === "'") {
      i++;
      while (i < text.length && text[i] !== quote) {
        if (quote === '"' && text[i] === "\\" && i + 1 < text.length) i++;
        value += text[i];
        i++;
      }
      i++;
    } else {
      while (i < text.length && !/\s/.test(text[i])) {
        value += text[i];
        i++;
      }
    }
    args.push(value);
  }
  return { args, rest: text.slice(Math.min(i, text.length)).trim() };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function buildCommandBlock(name: string, args: readonly CommandArg[], body: string): string {
  const json = JSON.stringify(Object.fromEntries(args.map((arg) => [arg.name, arg.value])));
  const safeBody = body.replace(/<\/command>/g, "<\\/command>");
  return `<command name="${escapeAttr(name)}" args="${escapeAttr(json)}">\n${safeBody}\n</command>`;
}

export function decodeCommandBlock(nameAttr: string, argsAttr: string): CommandBlock | null {
  try {
    const parsed: unknown = JSON.parse(unescapeAttr(argsAttr));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const args = Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({
      name,
      value: String(value),
    }));
    return { name: unescapeAttr(nameAttr), args };
  } catch {
    return null;
  }
}

export function findCommandBlocks(text: string): CommandBlockHit[] {
  return Array.from(text.matchAll(COMMAND_BLOCK_RE), (match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    block: decodeCommandBlock(match[1], match[2]),
  }));
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run prompt-commands/syntax.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add extensions/prompt-commands/syntax.ts extensions/prompt-commands/syntax.test.ts
git commit -m "feat(prompt-commands): 命令模板语法模块"
```

---

### 任务 2：prompt-commands 扩展

**文件：**
- 创建：`extensions/prompt-commands/templates.ts`、`expand.ts`、`index.ts`
- 测试：`extensions/prompt-commands/expand.test.ts`、`index.test.ts`

- [ ] **步骤 1：编写失败的测试 `expand.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { expandInvocation } from "./expand.js";
import { parseTemplate } from "./templates.js";

const refactor = parseTemplate("refactor", "---\ndescription: 重构\n---\n请把 {file} 重构成 {style=functional} 风格。");
const plain = parseTemplate("plain", "没有参数，$1 交给 Pi");
const lookup = (name: string) => (name === "refactor" ? refactor : name === "plain" ? plain : null);

describe("expandInvocation", () => {
  it("代入参数并包成 <command> 块，补充正文接在块后", () => {
    const result = expandInvocation('/refactor "src/a.ts" "" 顺便加测试', lookup);
    expect(result).toEqual({
      kind: "expanded",
      text:
        '<command name="refactor" args="{&quot;file&quot;:&quot;src/a.ts&quot;,&quot;style&quot;:&quot;functional&quot;}">\n' +
        "请把 src/a.ts 重构成 functional 风格。\n</command>\n\n顺便加测试",
    });
  });

  it("缺必填参数时报出缺哪几个", () => {
    expect(expandInvocation("/refactor", lookup)).toEqual({ kind: "missing", name: "refactor", missing: ["file"] });
  });

  it("不是命令、找不到模板、模板没有占位符都交回 Pi", () => {
    expect(expandInvocation("你好", lookup)).toEqual({ kind: "pass" });
    expect(expandInvocation("/unknown a", lookup)).toEqual({ kind: "pass" });
    expect(expandInvocation("/plain a", lookup)).toEqual({ kind: "pass" });
  });
});

describe("parseTemplate", () => {
  it("读出描述和参数", () => {
    expect(refactor.description).toBe("重构");
    expect(refactor.params).toEqual([{ name: "file" }, { name: "style", defaultValue: "functional" }]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run prompt-commands/expand.test.ts`
预期：FAIL，报错 `Failed to resolve import "./expand.js"`

- [ ] **步骤 3：实现 `templates.ts` 和 `expand.ts`**

`extensions/prompt-commands/templates.ts`：

```ts
// 命令模板文件：<agentDir>/prompts/<名>.md，即 Pi 原生 prompt template。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parsePromptParams, type PromptParam } from "./syntax.js";

export interface PromptTemplate {
  name: string;
  description: string;
  body: string;
  params: PromptParam[];
}

export function promptsDir(agentDir: string): string {
  return join(agentDir, "prompts");
}

/** 文件名主干不能带路径分隔符，也不能是 . 或 ..，防止越出目录。 */
export function isSafeFileStem(stem: string): boolean {
  return stem.length > 0 && stem !== "." && stem !== ".." && !/[\\/]/.test(stem);
}

export function parseTemplate(name: string, content: string): PromptTemplate {
  const { frontmatter, body } = parseFrontmatter<{ description?: unknown }>(content);
  return {
    name,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    body,
    params: parsePromptParams(body),
  };
}

export function loadTemplate(agentDir: string, name: string): PromptTemplate | null {
  if (!isSafeFileStem(name)) return null;
  try {
    return parseTemplate(name, readFileSync(join(promptsDir(agentDir), `${name}.md`), "utf8"));
  } catch {
    return null;
  }
}
```

`extensions/prompt-commands/expand.ts`：

```ts
import { buildCommandBlock, parseInvocation, renderPromptBody, resolveArgs, splitArgs } from "./syntax.js";
import type { PromptTemplate } from "./templates.js";

export type ExpandResult =
  | { kind: "pass" }
  | { kind: "missing"; name: string; missing: string[] }
  | { kind: "expanded"; text: string };

/** 只接管正文里有 {参数} 的模板；其余（包括 $1 写法）交回 Pi 原生展开。 */
export function expandInvocation(text: string, lookup: (name: string) => PromptTemplate | null): ExpandResult {
  const invocation = parseInvocation(text);
  if (!invocation) return { kind: "pass" };
  const template = lookup(invocation.name);
  if (!template || template.params.length === 0) return { kind: "pass" };
  const { args, rest } = splitArgs(invocation.argsText, template.params.length);
  const { values, missing } = resolveArgs(template.params, args);
  if (missing.length > 0) return { kind: "missing", name: invocation.name, missing };
  const block = buildCommandBlock(
    invocation.name,
    template.params.map((param) => ({ name: param.name, value: values[param.name] })),
    renderPromptBody(template.body, values),
  );
  return { kind: "expanded", text: rest ? `${block}\n\n${rest}` : block };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run prompt-commands/expand.test.ts`
预期：PASS

- [ ] **步骤 5：编写失败的测试 `index.test.ts`**

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: vi.fn(),
}));

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import promptCommands from "./index.js";

type InputHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function setup(): InputHandler {
  const handlers = new Map<string, InputHandler>();
  promptCommands({ on: (event: string, handler: InputHandler) => handlers.set(event, handler) } as never);
  return handlers.get("input")!;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-commands-"));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts", "refactor.md"), "---\ndescription: x\n---\n改 {file}");
  vi.mocked(getAgentDir).mockReturnValue(dir);
});

describe("prompt-commands input 钩子", () => {
  it("展开带参数的模板，图片原样带上", async () => {
    const images = [{ type: "image", data: "x", mimeType: "image/png" }];
    const result = await setup()({ type: "input", text: '/refactor "a.ts"', images, source: "rpc" }, { ui: { notify: vi.fn() } });
    expect(result).toEqual({
      action: "transform",
      text: '<command name="refactor" args="{&quot;file&quot;:&quot;a.ts&quot;}">\n改 a.ts\n</command>',
      images,
    });
  });

  it("缺参数时提示并拦下", async () => {
    const notify = vi.fn();
    const result = await setup()({ type: "input", text: "/refactor", source: "rpc" }, { ui: { notify } });
    expect(result).toEqual({ action: "handled" });
    expect(notify).toHaveBeenCalledWith("命令 /refactor 缺少参数：file", "error");
  });

  it("其他输入放行", async () => {
    expect(await setup()({ type: "input", text: "你好", source: "rpc" }, { ui: { notify: vi.fn() } })).toEqual({
      action: "continue",
    });
  });
});
```

- [ ] **步骤 6：运行测试验证失败**

运行：`cd extensions && npx vitest run prompt-commands/index.test.ts`
预期：FAIL，报错 `Failed to resolve import "./index.js"`

- [ ] **步骤 7：实现 `index.ts`**

```ts
// prompt-commands：把 `/名 "参数"…` 展开成 <command> 块。只接管正文里写了 {参数} 的模板，
// 其余交回 Pi 原生的 prompt template 展开。气泡靠 <command> 块还原成命令胶囊。
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandInvocation } from "./expand.js";
import { loadTemplate } from "./templates.js";

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    const result = expandInvocation(event.text, (name) => loadTemplate(getAgentDir(), name));
    if (result.kind === "pass") return { action: "continue" };
    if (result.kind === "missing") {
      ctx.ui.notify(`命令 /${result.name} 缺少参数：${result.missing.join("、")}`, "error");
      return { action: "handled" };
    }
    return { action: "transform", text: result.text, images: event.images };
  });
}
```

- [ ] **步骤 8：运行测试验证通过**

运行：`cd extensions && npx vitest run prompt-commands/`
预期：PASS（syntax、expand、index 三个文件）

- [ ] **步骤 9：Commit**

```bash
git add extensions/prompt-commands/templates.ts extensions/prompt-commands/expand.ts extensions/prompt-commands/expand.test.ts extensions/prompt-commands/index.ts extensions/prompt-commands/index.test.ts
git commit -m "feat(prompt-commands): input 钩子把带参数的命令展开成 command 块"
```

---

### 任务 3：context-rules 扩展

**文件：**
- 创建：`extensions/context-rules/rules.ts`、`index.ts`
- 测试：`extensions/context-rules/rules.test.ts`、`index.test.ts`

- [ ] **步骤 1：编写失败的测试 `rules.test.ts`**

```ts
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { activeRuleContextFiles, createRuleCache, listRuleIds, parseRule } from "./rules.js";

function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "context-rules-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("parseRule", () => {
  it("读标题和开关，缺 enabled 视为启用，缺 title 用 id", () => {
    expect(parseRule("zh", "global", "/r/zh.md", "---\ntitle: 中文回答\n---\n- 中文")).toEqual({
      id: "zh", scope: "global", path: "/r/zh.md", title: "中文回答", enabled: true, body: "- 中文",
    });
    expect(parseRule("x", "project", "/r/x.md", "---\nenabled: false\n---\nbody").title).toBe("x");
    expect(parseRule("x", "project", "/r/x.md", "---\nenabled: false\n---\nbody").enabled).toBe(false);
  });

  it("frontmatter 坏掉时带 error，并视为未启用", () => {
    const rule = parseRule("bad", "global", "/r/bad.md", "---\ntitle: [\n---\nbody");
    expect(rule.enabled).toBe(false);
    expect(rule.error).toBeTruthy();
  });
});

describe("listRuleIds", () => {
  it("只列 .md 并按文件名排序，目录不存在返回空", () => {
    const dir = dirWith({ "b.md": "", "a.md": "", "c.txt": "" });
    expect(listRuleIds(dir)).toEqual(["a", "b"]);
    expect(listRuleIds(join(dir, "missing"))).toEqual([]);
  });
});

describe("createRuleCache", () => {
  it("全局在前、项目在后；文件 mtime 不变时不重新解析", () => {
    const globalDir = dirWith({ "g.md": "---\ntitle: G\n---\ng" });
    const projectDir = dirWith({ "p.md": "---\ntitle: P\n---\np" });
    const onError = vi.fn();
    const cache = createRuleCache(onError);
    const dirs = [
      { dir: globalDir, scope: "global" as const },
      { dir: projectDir, scope: "project" as const },
    ];
    const first = cache.load(dirs);
    expect(first.map((rule) => rule.id)).toEqual(["g", "p"]);
    expect(cache.load(dirs)[0]).toBe(first[0]);

    writeFileSync(join(globalDir, "g.md"), "---\ntitle: G2\n---\ng");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(globalDir, "g.md"), later, later);
    expect(cache.load(dirs)[0].title).toBe("G2");
  });

  it("坏文件只在解析时报一次", () => {
    const dir = dirWith({ "bad.md": "---\ntitle: [\n---\nx" });
    const onError = vi.fn();
    const cache = createRuleCache(onError);
    cache.load([{ dir, scope: "global" }]);
    cache.load([{ dir, scope: "global" }]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("activeRuleContextFiles", () => {
  it("只要启用、无错误、正文非空的规则", () => {
    const base = { scope: "global" as const, title: "t" };
    expect(
      activeRuleContextFiles([
        { ...base, id: "a", path: "/a.md", enabled: true, body: "A" },
        { ...base, id: "b", path: "/b.md", enabled: false, body: "B" },
        { ...base, id: "c", path: "/c.md", enabled: true, body: "  " },
        { ...base, id: "d", path: "/d.md", enabled: true, body: "D", error: "x" },
      ]),
    ).toEqual([{ path: "/a.md", content: "A" }]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run context-rules/rules.test.ts`
预期：FAIL，报错 `Failed to resolve import "./rules.js"`

- [ ] **步骤 3：实现 `rules.ts`**

```ts
// 规则文件：全局 <agentDir>/rules/*.md，项目 <cwd>/.pi/rules/*.md。一条一个文件，frontmatter 有 title 和 enabled。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type RuleScope = "global" | "project";

export interface RuleFile {
  id: string;
  scope: RuleScope;
  path: string;
  title: string;
  enabled: boolean;
  body: string;
  error?: string;
}

export function globalRulesDir(agentDir: string): string {
  return join(agentDir, "rules");
}

export function projectRulesDir(cwd: string): string {
  return join(cwd, ".pi", "rules");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseRule(id: string, scope: RuleScope, path: string, content: string): RuleFile {
  try {
    const { frontmatter, body } = parseFrontmatter<{ title?: unknown; enabled?: unknown }>(content);
    const title = typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : id;
    return { id, scope, path, title, enabled: frontmatter.enabled !== false, body };
  } catch (error) {
    return { id, scope, path, title: id, enabled: false, body: "", error: errorText(error) };
  }
}

export function listRuleIds(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export function createRuleCache(onError: (rule: RuleFile) => void = () => {}) {
  const cache = new Map<string, { mtimeMs: number; rule: RuleFile }>();
  return {
    load(dirs: ReadonlyArray<{ dir: string; scope: RuleScope }>): RuleFile[] {
      const out: RuleFile[] = [];
      for (const { dir, scope } of dirs) {
        for (const id of listRuleIds(dir)) {
          const path = join(dir, `${id}.md`);
          let mtimeMs: number;
          try {
            mtimeMs = statSync(path).mtimeMs;
          } catch {
            continue;
          }
          const hit = cache.get(path);
          if (hit && hit.mtimeMs === mtimeMs) {
            out.push(hit.rule);
            continue;
          }
          let rule: RuleFile;
          try {
            rule = parseRule(id, scope, path, readFileSync(path, "utf8"));
          } catch (error) {
            rule = { id, scope, path, title: id, enabled: false, body: "", error: errorText(error) };
          }
          if (rule.error) onError(rule);
          cache.set(path, { mtimeMs, rule });
          out.push(rule);
        }
      }
      return out;
    },
  };
}

export function activeRuleContextFiles(rules: readonly RuleFile[]): Array<{ path: string; content: string }> {
  return rules
    .filter((rule) => rule.enabled && !rule.error && rule.body.trim())
    .map((rule) => ({ path: rule.path, content: rule.body }));
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run context-rules/rules.test.ts`
预期：PASS

- [ ] **步骤 5：编写失败的测试 `index.test.ts`**

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: vi.fn(),
}));

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import contextRules from "./index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
let agentDir = "";
let cwd = "";

function setup(): Handler {
  const handlers = new Map<string, Handler>();
  contextRules({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);
  return handlers.get("before_agent_start")!;
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "rules-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "rules-ws-"));
  mkdirSync(join(agentDir, "rules"));
  mkdirSync(join(cwd, ".pi", "rules"), { recursive: true });
  writeFileSync(join(agentDir, "rules", "zh.md"), "---\ntitle: 中文\n---\n用中文");
  writeFileSync(join(cwd, ".pi", "rules", "pnpm.md"), "---\ntitle: pnpm\nenabled: false\n---\n用 pnpm");
  vi.mocked(getAgentDir).mockReturnValue(agentDir);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("context-rules before_agent_start", () => {
  it("把启用的规则追加到 contextFiles，原有条目保留", async () => {
    const event = { systemPromptOptions: { cwd, contextFiles: [{ path: "/AGENTS.md", content: "a" }] } };
    expect(await setup()(event, { cwd })).toBeUndefined();
    expect(event.systemPromptOptions.contextFiles).toEqual([
      { path: "/AGENTS.md", content: "a" },
      { path: join(agentDir, "rules", "zh.md"), content: "用中文" },
    ]);
  });

  it("没有启用的规则时不动 contextFiles", async () => {
    writeFileSync(join(agentDir, "rules", "zh.md"), "---\nenabled: false\n---\n用中文");
    const contextFiles = [{ path: "/AGENTS.md", content: "a" }];
    const event = { systemPromptOptions: { cwd, contextFiles } };
    await setup()(event, { cwd });
    expect(event.systemPromptOptions.contextFiles).toBe(contextFiles);
  });
});
```

- [ ] **步骤 6：运行测试验证失败**

运行：`cd extensions && npx vitest run context-rules/index.test.ts`
预期：FAIL，报错 `Failed to resolve import "./index.js"`

- [ ] **步骤 7：实现 `index.ts`**

```ts
// context-rules：每轮把启用的规则文件追加到 systemPromptOptions.contextFiles，和 AGENTS.md 同一段。
// 规则不变时系统提示也不变，不打掉前缀缓存。和 rulebook（工具拦截 / 跑偏纠正）是两回事。
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeRuleContextFiles, createRuleCache, globalRulesDir, projectRulesDir } from "./rules.js";

export default function (pi: ExtensionAPI) {
  const cache = createRuleCache((rule) => console.error(`[context-rules] 跳过 ${rule.path}：${rule.error}`));

  pi.on("before_agent_start", async (event, ctx) => {
    const files = activeRuleContextFiles(
      cache.load([
        { dir: globalRulesDir(getAgentDir()), scope: "global" },
        { dir: projectRulesDir(ctx.cwd), scope: "project" },
      ]),
    );
    if (files.length === 0) return;
    const options = event.systemPromptOptions;
    options.contextFiles = [...(options.contextFiles ?? []), ...files];
  });
}
```

- [ ] **步骤 8：运行测试验证通过**

运行：`cd extensions && npx vitest run context-rules/`
预期：PASS

- [ ] **步骤 9：Commit**

```bash
git add extensions/context-rules/
git commit -m "feat(context-rules): 启用的规则每轮注入 contextFiles"
```

---

### 任务 4：注册两个扩展

**文件：**
- 修改：`extensions/index.ts`
- 修改：`cli/src/extension-profile.ts:19-44`
- 修改：`extensions/multi-agent/embedded-runner.ts`（`CORE_ALWAYS_ON` 集合）

- [ ] **步骤 1：先跑注册约束测试，确认它会拦住遗漏**

`cli/src/agent-data-plugins.test.ts` 会要求每个没有 manifest 的扩展必须在 `CORE_ALWAYS_ON` 或 `CHAT_EXCLUDED` 里。先只改 `extensions/index.ts`，在 `import rulebook from "./rulebook/index.js";` 后加：

```ts
import promptCommands from "./prompt-commands/index.js";
import contextRules from "./context-rules/index.js";
```

再在 `export { … }` 列表、`allExtensions` 数组里紧跟 `rulebook,` 各加一行 `promptCommands,` 和 `contextRules,`；在 `namedExtensions` 里紧跟 `{ name: "rulebook", factory: rulebook },` 加：

```ts
  { name: "prompt-commands", factory: promptCommands },
  { name: "context-rules", factory: contextRules },
```

运行：`cd cli && npx vitest run src/agent-data-plugins.test.ts`
预期：FAIL，报错信息含 `prompt-commands has no manifest and is neither CORE_ALWAYS_ON nor CHAT_EXCLUDED`

- [ ] **步骤 2：加入常驻集合**

`cli/src/extension-profile.ts` 的 `CORE_ALWAYS_ON` 里，在 `"rulebook",` 后加：

```ts
  "prompt-commands",
  "context-rules",
```

`extensions/multi-agent/embedded-runner.ts` 的 `CORE_ALWAYS_ON` 里，在 `"rulebook",` 后加同样两行（子代理也要注入规则）。

- [ ] **步骤 3：运行测试验证通过**

运行：`cd cli && npx vitest run src/agent-data-plugins.test.ts src/extension-profile.test.ts`
预期：PASS

运行：`cd extensions && npx vitest run index.test.ts prompt-metadata.test.ts`
预期：PASS（新扩展不注册工具，不影响 prompt-metadata）

- [ ] **步骤 4：Commit**

```bash
git add extensions/index.ts cli/src/extension-profile.ts extensions/multi-agent/embedded-runner.ts
git commit -m "feat(extensions): 注册 prompt-commands 和 context-rules"
```

---

### 任务 5：主进程 PromptLibraryService

**文件：**
- 创建：`electron-agent/electron/app/promptLibraryService.ts`
- 测试：`electron-agent/electron/app/promptLibraryService.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PromptLibraryService, ruleIdFromTitle } from './promptLibraryService';

let agentDir = '';
let workspace = '';
let service: PromptLibraryService;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'library-agent-'));
  workspace = await mkdtemp(join(tmpdir(), 'library-ws-'));
  service = new PromptLibraryService(agentDir);
});

describe('命令', () => {
  it('保存时写 description 和自动生成的 argument-hint，列表能读回参数', async () => {
    await service.saveCommand({ name: 'refactor', description: '重构', body: '改 {file} 为 {style=fp}\n', reserved: [] });
    expect(await readFile(join(agentDir, 'prompts', 'refactor.md'), 'utf8')).toBe(
      '---\ndescription: "重构"\nargument-hint: "<file> [style]"\n---\n改 {file} 为 {style=fp}\n',
    );
    const [command] = await service.listCommands();
    expect(command).toMatchObject({ name: 'refactor', description: '重构', params: [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }] });
  });

  it('没有参数时不写 argument-hint', async () => {
    await service.saveCommand({ name: 'review', description: '', body: '看看', reserved: [] });
    expect(await readFile(join(agentDir, 'prompts', 'review.md'), 'utf8')).toBe('---\ndescription: ""\n---\n看看\n');
  });

  it('拒绝非法名、保留名、重名和空正文', async () => {
    await expect(service.saveCommand({ name: '../x', description: '', body: 'a', reserved: [] })).rejects.toThrow('命令名只能用');
    await expect(service.saveCommand({ name: 'compact', description: '', body: 'a', reserved: ['compact'] })).rejects.toThrow('重名');
    await expect(service.saveCommand({ name: 'a', description: '', body: ' ', reserved: [] })).rejects.toThrow('提示词不能为空');
    await service.saveCommand({ name: 'a', description: '', body: 'x', reserved: [] });
    await expect(service.saveCommand({ name: 'a', description: '', body: 'y', reserved: [] })).rejects.toThrow('已存在');
  });

  it('改名时写新文件并删掉旧文件；同名覆盖允许', async () => {
    await service.saveCommand({ name: 'a', description: '', body: 'x', reserved: [] });
    await service.saveCommand({ originalName: 'a', name: 'a', description: '新', body: 'x2', reserved: [] });
    await service.saveCommand({ originalName: 'a', name: 'b', description: '', body: 'x3', reserved: [] });
    expect(existsSync(join(agentDir, 'prompts', 'a.md'))).toBe(false);
    expect((await service.listCommands()).map((command) => command.name)).toEqual(['b']);
  });

  it('删除拒绝带路径的名字', async () => {
    await expect(service.deleteCommand('../x')).rejects.toThrow('命令名无效');
  });

  it('列表里坏掉的模板带 error', async () => {
    await mkdir(join(agentDir, 'prompts'), { recursive: true });
    await writeFile(join(agentDir, 'prompts', 'bad.md'), '---\ndescription: [\n---\nx');
    const [command] = await service.listCommands();
    expect(command.error).toBeTruthy();
  });
});

describe('规则', () => {
  it('新建全局和项目规则，列表全局在前', async () => {
    await service.saveRule({ workspace, scope: 'project', title: '用 pnpm', enabled: true, body: '- pnpm' });
    await service.saveRule({ workspace, scope: 'global', title: '中文回答', enabled: false, body: '- 中文' });
    expect(await readFile(join(agentDir, 'rules', '中文回答.md'), 'utf8')).toBe('---\ntitle: "中文回答"\nenabled: false\n---\n- 中文\n');
    const rules = await service.listRules(workspace);
    expect(rules.map((rule) => [rule.scope, rule.id, rule.enabled])).toEqual([
      ['global', '中文回答', false],
      ['project', '用-pnpm', true],
    ]);
  });

  it('没有工作区时只列全局，保存项目规则报错', async () => {
    expect(await service.listRules('')).toEqual([]);
    await expect(service.saveRule({ workspace: '', scope: 'project', title: 'x', enabled: true, body: 'x' })).rejects.toThrow('项目规则需要先打开工作区');
  });

  it('改标题保留文件名；换范围时搬文件', async () => {
    const created = await service.saveRule({ workspace, scope: 'global', title: 'A', enabled: true, body: 'a' });
    const renamed = await service.saveRule({ workspace, scope: 'global', original: { scope: 'global', id: created.id }, title: 'B', enabled: true, body: 'b' });
    expect(renamed.id).toBe('A');
    const moved = await service.saveRule({ workspace, scope: 'project', original: { scope: 'global', id: 'A' }, title: 'B', enabled: true, body: 'b' });
    expect(moved.scope).toBe('project');
    expect(existsSync(join(agentDir, 'rules', 'A.md'))).toBe(false);
    expect(existsSync(join(workspace, '.pi', 'rules', 'B.md'))).toBe(true);
  });

  it('开关只改 enabled，保留标题和正文', async () => {
    const rule = await service.saveRule({ workspace, scope: 'global', title: 'T', enabled: true, body: 'body' });
    await service.setRuleEnabled({ scope: 'global', id: rule.id }, false, workspace);
    expect(await readFile(rule.path, 'utf8')).toBe('---\ntitle: "T"\nenabled: false\n---\nbody\n');
  });

  it('删除和开关拒绝带路径的 id', async () => {
    await expect(service.deleteRule({ scope: 'global', id: '../x' }, workspace)).rejects.toThrow('规则标识无效');
    await expect(service.setRuleEnabled({ scope: 'global', id: 'a/b' }, true, workspace)).rejects.toThrow('规则标识无效');
  });
});

describe('ruleIdFromTitle', () => {
  it('清掉不合法字符并避开已有 id', () => {
    expect(ruleIdFromTitle('提交 前/跑测试!', new Set())).toBe('提交-前-跑测试');
    expect(ruleIdFromTitle('a', new Set(['a', 'a-2']))).toBe('a-3');
    expect(ruleIdFromTitle('!!!', new Set())).toBe('rule');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run electron/app/promptLibraryService.test.ts`
预期：FAIL，报错 `Failed to resolve import "./promptLibraryService"`

- [ ] **步骤 3：编写实现**

```ts
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { argumentHint, COMMAND_NAME_RE, parsePromptParams, type PromptParam } from '../../../extensions/prompt-commands/syntax.js';
import { isSafeFileStem, parseTemplate, promptsDir } from '../../../extensions/prompt-commands/templates.js';
import {
  globalRulesDir,
  listRuleIds,
  parseRule,
  projectRulesDir,
  type RuleFile,
  type RuleScope,
} from '../../../extensions/context-rules/rules.js';

export interface PromptCommandInfo {
  name: string;
  description: string;
  body: string;
  params: PromptParam[];
  path: string;
  error?: string;
}

export interface SaveCommandInput {
  originalName?: string;
  name: string;
  description: string;
  body: string;
  /** 内置、扩展、技能命令名：渲染层从 agent_get_commands 取，不能和它们重名。 */
  reserved: readonly string[];
}

export interface RuleRef {
  scope: RuleScope;
  id: string;
}

export interface SaveRuleInput {
  workspace?: string;
  scope: RuleScope;
  original?: RuleRef;
  title: string;
  enabled: boolean;
  body: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim();
}

function commandMarkdown(description: string, body: string): string {
  const params = parsePromptParams(body);
  const lines = ['---', `description: ${JSON.stringify(description.trim())}`];
  if (params.length > 0) lines.push(`argument-hint: ${JSON.stringify(argumentHint(params))}`);
  lines.push('---', body, '');
  return lines.join('\n');
}

function ruleMarkdown(title: string, enabled: boolean, body: string): string {
  return ['---', `title: ${JSON.stringify(title)}`, `enabled: ${enabled}`, '---', body, ''].join('\n');
}

export function ruleIdFromTitle(title: string, taken: ReadonlySet<string>): string {
  const base = title.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'rule';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export class PromptLibraryService {
  constructor(private readonly agentDir: string) {}

  async listCommands(): Promise<PromptCommandInfo[]> {
    const dir = promptsDir(this.agentDir);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -3));
    } catch {
      return [];
    }
    const commands = await Promise.all(
      names.map(async (name): Promise<PromptCommandInfo> => {
        const path = join(dir, `${name}.md`);
        try {
          return { ...parseTemplate(name, await readFile(path, 'utf8')), path };
        } catch (error) {
          return { name, description: '', body: '', params: [], path, error: errorText(error) };
        }
      }),
    );
    return commands.sort((left, right) => left.name.localeCompare(right.name));
  }

  async saveCommand(input: SaveCommandInput): Promise<PromptCommandInfo> {
    const name = input.name.trim();
    const body = normalizeBody(input.body);
    if (!COMMAND_NAME_RE.test(name)) throw new Error('命令名只能用字母、数字、中文、- 和 _，最长 64 个字符');
    if (input.reserved.includes(name)) throw new Error(`/${name} 和已有的内置、扩展或技能命令重名`);
    if (!body) throw new Error('提示词不能为空');
    if (input.originalName !== undefined && !isSafeFileStem(input.originalName)) throw new Error('命令名无效');
    const dir = promptsDir(this.agentDir);
    const path = join(dir, `${name}.md`);
    const isNewName = input.originalName !== name;
    if (isNewName && (await exists(path))) throw new Error(`命令 /${name} 已存在`);
    await mkdir(dir, { recursive: true });
    await writeAtomic(path, commandMarkdown(input.description, body));
    if (input.originalName !== undefined && isNewName) await rm(join(dir, `${input.originalName}.md`), { force: true });
    return { name, description: input.description.trim(), body, params: parsePromptParams(body), path };
  }

  async deleteCommand(name: string): Promise<void> {
    if (!isSafeFileStem(name)) throw new Error('命令名无效');
    await rm(join(promptsDir(this.agentDir), `${name}.md`), { force: true });
  }

  async listRules(workspace?: string): Promise<RuleFile[]> {
    const scopes: Array<{ scope: RuleScope; dir: string }> = [{ scope: 'global', dir: globalRulesDir(this.agentDir) }];
    if (workspace) scopes.push({ scope: 'project', dir: projectRulesDir(workspace) });
    const rules: RuleFile[] = [];
    for (const { scope, dir } of scopes) {
      for (const id of listRuleIds(dir)) {
        const path = join(dir, `${id}.md`);
        try {
          rules.push(parseRule(id, scope, path, await readFile(path, 'utf8')));
        } catch (error) {
          rules.push({ id, scope, path, title: id, enabled: false, body: '', error: errorText(error) });
        }
      }
    }
    return rules;
  }

  async saveRule(input: SaveRuleInput): Promise<RuleFile> {
    const title = input.title.trim();
    const body = normalizeBody(input.body);
    if (!title) throw new Error('规则名称不能为空');
    if (!body) throw new Error('规则内容不能为空');
    if (input.original && !isSafeFileStem(input.original.id)) throw new Error('规则标识无效');
    const dir = this.rulesDir(input.scope, input.workspace);
    const keepId = input.original !== undefined && input.original.scope === input.scope;
    const id = keepId ? input.original!.id : ruleIdFromTitle(title, new Set(listRuleIds(dir)));
    const path = join(dir, `${id}.md`);
    await mkdir(dir, { recursive: true });
    await writeAtomic(path, ruleMarkdown(title, input.enabled, body));
    if (input.original && !keepId) {
      await rm(join(this.rulesDir(input.original.scope, input.workspace), `${input.original.id}.md`), { force: true });
    }
    return { id, scope: input.scope, path, title, enabled: input.enabled, body };
  }

  async setRuleEnabled(ref: RuleRef, enabled: boolean, workspace?: string): Promise<void> {
    const path = this.rulePath(ref, workspace);
    const rule = parseRule(ref.id, ref.scope, path, await readFile(path, 'utf8'));
    if (rule.error) throw new Error(`规则文件解析失败：${rule.error}`);
    await writeAtomic(path, ruleMarkdown(rule.title, enabled, rule.body));
  }

  async deleteRule(ref: RuleRef, workspace?: string): Promise<void> {
    await rm(this.rulePath(ref, workspace), { force: true });
  }

  private rulePath(ref: RuleRef, workspace?: string): string {
    if (!isSafeFileStem(ref.id)) throw new Error('规则标识无效');
    return join(this.rulesDir(ref.scope, workspace), `${ref.id}.md`);
  }

  private rulesDir(scope: RuleScope, workspace?: string): string {
    if (scope === 'global') return globalRulesDir(this.agentDir);
    if (!workspace) throw new Error('项目规则需要先打开工作区');
    return projectRulesDir(workspace);
  }
}
```

注意 `listRules('')` 要返回空数组：测试里全局目录本来就是空的，所以只要空字符串不进项目分支就行（上面 `if (workspace)` 已经满足）。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run electron/app/promptLibraryService.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/electron/app/promptLibraryService.ts electron-agent/electron/app/promptLibraryService.test.ts
git commit -m "feat(electron): 命令与规则的文件读写服务"
```

---

### 任务 6：IPC 注册和主进程接线

**文件：**
- 修改：`electron-agent/electron/ipc/register.ts`
- 修改：`electron-agent/electron/main.ts:259-266`

- [ ] **步骤 1：注册命令**

`register.ts` 顶部类型导入区加：

```ts
import type { PromptLibraryService } from '../app/promptLibraryService';
```

`IpcServices` 接口里 `skills?: SkillService;` 后加：

```ts
  promptLibrary?: PromptLibraryService;
```

`if (services.skills) registerSkillCommands(services.skills);` 后加：

```ts
  if (services.promptLibrary) registerPromptLibraryCommands(services.promptLibrary);
```

在 `registerSkillCommands` 函数后加：

```ts
function readRuleScope(args: Record<string, unknown>, key: string): 'global' | 'project' {
  const value = args[key];
  if (value !== 'global' && value !== 'project') throw new Error(`${key} must be "global" or "project"`);
  return value;
}

function registerPromptLibraryCommands(service: PromptLibraryService): void {
  registerCommand('list_prompt_commands', () => service.listCommands());
  registerCommand('save_prompt_command', (_event, args) => service.saveCommand({
    originalName: typeof args.originalName === 'string' && args.originalName ? args.originalName : undefined,
    name: readString(args, 'name'),
    description: readText(args, 'description'),
    body: readText(args, 'body'),
    reserved: Array.isArray(args.reserved) ? args.reserved.filter((item): item is string => typeof item === 'string') : [],
  }));
  registerCommand('delete_prompt_command', (_event, args) => service.deleteCommand(readString(args, 'name')));
  registerCommand('list_context_rules', (_event, args) => service.listRules(readOptionalWorkspace(args)));
  registerCommand('save_context_rule', (_event, args) => {
    const original = args.original && typeof args.original === 'object' ? (args.original as Record<string, unknown>) : undefined;
    return service.saveRule({
      workspace: readOptionalWorkspace(args),
      scope: readRuleScope(args, 'scope'),
      original: original ? { scope: readRuleScope(original, 'scope'), id: readString(original, 'id') } : undefined,
      title: readText(args, 'title'),
      enabled: readBoolean(args, 'enabled'),
      body: readText(args, 'body'),
    });
  });
  registerCommand('set_context_rule_enabled', (_event, args) => service.setRuleEnabled(
    { scope: readRuleScope(args, 'scope'), id: readString(args, 'id') },
    readBoolean(args, 'enabled'),
    readOptionalWorkspace(args),
  ));
  registerCommand('delete_context_rule', (_event, args) => service.deleteRule(
    { scope: readRuleScope(args, 'scope'), id: readString(args, 'id') },
    readOptionalWorkspace(args),
  ));
}
```

- [ ] **步骤 2：主进程创建实例**

`main.ts` 顶部导入区，在 `import { SkillService } from "./app/skillService";` 后加：

```ts
import { PromptLibraryService } from "./app/promptLibraryService";
```

`registerIpcHandlers({ … })` 里 `skills: new SkillService(app.getPath('home')),` 后加：

```ts
      promptLibrary: new PromptLibraryService(agentDir),
```

`agentDir` 在同一个函数里定义（`const agentDir = process.env.PI_CODING_AGENT_DIR || join(app.getPath('home'), '.pi', 'agent');`），这个调用点已经在用它，不需要再定义。

- [ ] **步骤 3：跑主进程相关测试和构建**

运行：`cd electron-agent && npx vitest run electron/ipc electron/app/promptLibraryService.test.ts`
预期：PASS

运行：`cd electron-agent && npx electron-vite build`
预期：构建成功，没有 `Could not resolve "../../../extensions/prompt-commands/syntax.js"` 之类的错误

- [ ] **步骤 4：Commit**

```bash
git add electron-agent/electron/ipc/register.ts electron-agent/electron/main.ts
git commit -m "feat(electron): 注册命令与规则的 IPC"
```

---

### 任务 7：渲染层 IO 和模板缓存

**文件：**
- 创建：`electron-agent/src/lib/promptLibraryIo.ts`
- 创建：`electron-agent/src/features/chat/input/editor/promptCommandCache.ts`
- 测试：`electron-agent/src/features/chat/input/editor/promptCommandCache.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listPromptCommands } = vi.hoisted(() => ({ listPromptCommands: vi.fn() }));
vi.mock('../../../../lib/promptLibraryIo', () => ({ listPromptCommands }));

import { findParamTemplate, getCachedPromptCommands, invalidatePromptCommands, loadPromptCommands } from './promptCommandCache';

const refactor = { name: 'refactor', description: '', body: '{file}', params: [{ name: 'file' }], path: '/p/refactor.md' };
const review = { name: 'review', description: '', body: 'x', params: [], path: '/p/review.md' };

beforeEach(() => {
  invalidatePromptCommands();
  listPromptCommands.mockReset();
});

describe('promptCommandCache', () => {
  it('并发只请求一次，加载后同步可读', async () => {
    listPromptCommands.mockResolvedValue([refactor, review]);
    await Promise.all([loadPromptCommands(), loadPromptCommands()]);
    expect(listPromptCommands).toHaveBeenCalledTimes(1);
    expect(getCachedPromptCommands()).toHaveLength(2);
    expect(findParamTemplate('refactor')).toBe(refactor);
    expect(findParamTemplate('review')).toBeUndefined();
  });

  it('请求失败返回空列表，不抛错', async () => {
    listPromptCommands.mockRejectedValue(new Error('boom'));
    expect(await loadPromptCommands()).toEqual([]);
  });

  it('invalidate 后重新请求', async () => {
    listPromptCommands.mockResolvedValue([review]);
    await loadPromptCommands();
    invalidatePromptCommands();
    await loadPromptCommands();
    expect(listPromptCommands).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/promptCommandCache.test.ts`
预期：FAIL，报错 `Failed to resolve import "./promptCommandCache"`

- [ ] **步骤 3：实现**

`src/lib/promptLibraryIo.ts`：

```ts
import { invoke } from '../platform/runtime';
import type { PromptParam } from '@extensions/prompt-commands/syntax';

export interface PromptCommandInfo {
  name: string;
  description: string;
  body: string;
  params: PromptParam[];
  path: string;
  error?: string;
}

export type RuleScope = 'global' | 'project';

export interface RuleInfo {
  id: string;
  scope: RuleScope;
  path: string;
  title: string;
  enabled: boolean;
  body: string;
  error?: string;
}

export interface RuleRef {
  scope: RuleScope;
  id: string;
}

export function listPromptCommands(): Promise<PromptCommandInfo[]> {
  return invoke<PromptCommandInfo[]>('list_prompt_commands');
}

export function savePromptCommand(input: {
  originalName?: string;
  name: string;
  description: string;
  body: string;
  reserved: string[];
}): Promise<PromptCommandInfo> {
  return invoke<PromptCommandInfo>('save_prompt_command', input);
}

export function deletePromptCommand(name: string): Promise<void> {
  return invoke<void>('delete_prompt_command', { name });
}

export function listContextRules(workspace: string): Promise<RuleInfo[]> {
  return invoke<RuleInfo[]>('list_context_rules', { workspace });
}

export function saveContextRule(input: {
  workspace: string;
  scope: RuleScope;
  original?: RuleRef;
  title: string;
  enabled: boolean;
  body: string;
}): Promise<RuleInfo> {
  return invoke<RuleInfo>('save_context_rule', input);
}

export function setContextRuleEnabled(workspace: string, ref: RuleRef, enabled: boolean): Promise<void> {
  return invoke<void>('set_context_rule_enabled', { workspace, ...ref, enabled });
}

export function deleteContextRule(workspace: string, ref: RuleRef): Promise<void> {
  return invoke<void>('delete_context_rule', { workspace, ...ref });
}
```

`src/features/chat/input/editor/promptCommandCache.ts`：

```ts
import { listPromptCommands, type PromptCommandInfo } from '../../../../lib/promptLibraryIo';

/**
 * 命令模板列表（全局，和工作区无关）。斜杠菜单、粘贴识别、气泡还原共用；
 * 气泡渲染是同步的，所以另给一个只读缓存的 getCachedPromptCommands。
 */
const TTL_MS = 10_000;

let cache: { data: PromptCommandInfo[]; expiresAt: number } | null = null;
let inflight: Promise<PromptCommandInfo[]> | null = null;

export function getCachedPromptCommands(): PromptCommandInfo[] {
  return cache?.data ?? [];
}

/** 带 {参数} 的模板；没有参数的模板仍走 ChatTag。 */
export function findParamTemplate(name: string): PromptCommandInfo | undefined {
  return getCachedPromptCommands().find((command) => command.name === name && command.params.length > 0);
}

export function loadPromptCommands(): Promise<PromptCommandInfo[]> {
  if (cache && cache.expiresAt > Date.now()) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = listPromptCommands()
    .then((data) => {
      cache = { data, expiresAt: Date.now() + TTL_MS };
      return data;
    })
    .catch(() => [] as PromptCommandInfo[])
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function invalidatePromptCommands(): void {
  cache = null;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/promptCommandCache.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/lib/promptLibraryIo.ts electron-agent/src/features/chat/input/editor/promptCommandCache.ts electron-agent/src/features/chat/input/editor/promptCommandCache.test.ts
git commit -m "feat(chat): 命令模板的 IPC 封装与缓存"
```

---

### 任务 8：只读胶囊 CommandPillView

**文件：**
- 创建：`electron-agent/src/features/chat/input/editor/CommandPill/commandPillStyles.ts`
- 创建：`electron-agent/src/features/chat/input/editor/CommandPill/CommandPillView.tsx`
- 测试：`electron-agent/src/features/chat/input/editor/CommandPill/CommandPillView.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CommandPillView } from './CommandPillView';

describe('CommandPillView', () => {
  it('显示命令名和每个参数的名字与值', () => {
    render(<CommandPillView name="refactor" args={[{ name: 'file', value: 'src/a.ts' }, { name: 'style', value: 'fp' }]} />);
    const pill = screen.getByTestId('command-pill');
    expect(pill).toHaveAttribute('data-command', 'refactor');
    expect(pill).toHaveTextContent('refactor');
    const args = screen.getAllByTestId('command-pill-arg');
    expect(args.map((arg) => arg.textContent)).toEqual(['filesrc/a.ts', 'stylefp']);
  });

  it('超过 32 个字符的值截断，悬停显示完整值', () => {
    const long = 'x'.repeat(40);
    render(<CommandPillView name="a" args={[{ name: 'v', value: long }]} />);
    const arg = screen.getByTestId('command-pill-arg');
    expect(arg).toHaveAttribute('title', long);
    expect(arg.textContent).toBe(`v${'x'.repeat(31)}…`);
  });

  it('没有参数时只有命令名', () => {
    render(<CommandPillView name="review" args={[]} />);
    expect(screen.queryByTestId('command-pill-arg')).not.toBeInTheDocument();
    expect(screen.getByTestId('command-pill')).toHaveAttribute('data-noarg', 'true');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/CommandPill/CommandPillView.test.tsx`
预期：FAIL，报错 `Failed to resolve import "./CommandPillView"`

- [ ] **步骤 3：实现样式和视图**

`commandPillStyles.ts`（数值来自规格「视觉规格」一节）：

```ts
import { createStaticStyles, cssVar, keyframes } from 'antd-style';

const shake = keyframes`
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-3px); }
  75% { transform: translateX(3px); }
`;

/** 命令胶囊：外层 7px 圆角矩形铺满命令底色，只有参数是 4px 圆角矩形。输入框和气泡共用。 */
export const pillStyles = createStaticStyles(({ css }) => ({
  pill: css`
    display: inline-flex;
    gap: 4px;
    align-items: center;
    vertical-align: -4px;

    padding: 3px 3px 3px 9px;
    border-radius: 7px;

    line-height: 1.6;
    white-space: nowrap;

    background: color-mix(in srgb, ${cssVar.purple} 22%, transparent);

    &[data-noarg='true'] {
      padding-inline-end: 9px;
    }
  `,
  command: css`
    display: inline-flex;
    gap: 3px;
    align-items: center;
    margin-inline-end: 2px;

    font-weight: 600;
    color: ${cssVar.purple};
  `,
  arg: css`
    display: inline-flex;
    gap: 5px;
    align-items: center;

    padding: 0 7px;
    border-radius: 4px;

    color: ${cssVar.colorText};

    background: color-mix(in srgb, ${cssVar.colorBgLayout} 55%, transparent);
  `,
  argFocus: css`
    box-shadow: 0 0 0 1px ${cssVar.colorPrimary};
    background: color-mix(in srgb, ${cssVar.colorPrimary} 14%, transparent);
  `,
  argInvalid: css`
    box-shadow: 0 0 0 1px ${cssVar.colorError};
    animation: ${shake} 0.3s ease-in-out 2;
  `,
  key: css`
    font-size: 11px;
    color: color-mix(in srgb, ${cssVar.purple} 75%, ${cssVar.colorTextSecondary});
  `,
  input: css`
    field-sizing: content;
    min-width: 2ch;
    max-width: 320px;
    padding: 0;
    border: 0;
    outline: none;

    font: inherit;
    color: inherit;

    background: transparent;

    &::placeholder {
      font-style: italic;
      color: ${cssVar.colorTextQuaternary};
    }
  `,
}));
```

`CommandPillView.tsx`：

```tsx
import { Icon } from '@lobehub/ui';
import { SquareSlash } from 'lucide-react';
import { pillStyles } from './commandPillStyles';

const MAX_VALUE_CHARS = 32;

function clampValue(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS - 1)}…` : value;
}

/** 只读命令胶囊：发出去的气泡里用。 */
export function CommandPillView({ name, args }: { name: string; args: ReadonlyArray<{ name: string; value: string }> }) {
  return (
    <span className={pillStyles.pill} data-testid="command-pill" data-command={name} data-noarg={args.length === 0}>
      <span className={pillStyles.command}>
        <Icon icon={SquareSlash} size={13} />
        {name}
      </span>
      {args.map((arg) => (
        <span
          key={arg.name}
          className={pillStyles.arg}
          data-testid="command-pill-arg"
          title={arg.value.length > MAX_VALUE_CHARS ? arg.value : undefined}
        >
          <span className={pillStyles.key}>{arg.name}</span>
          <span>{clampValue(arg.value)}</span>
        </span>
      ))}
    </span>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/CommandPill/CommandPillView.test.tsx`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/input/editor/CommandPill/commandPillStyles.ts electron-agent/src/features/chat/input/editor/CommandPill/CommandPillView.tsx electron-agent/src/features/chat/input/editor/CommandPill/CommandPillView.test.tsx
git commit -m "feat(chat): 只读命令胶囊"
```

---

### 任务 9：胶囊按键规则 pillKeys

**文件：**
- 创建：`electron-agent/src/features/chat/input/editor/CommandPill/pillKeys.ts`
- 测试：`electron-agent/src/features/chat/input/editor/CommandPill/pillKeys.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { pillKeyAction, type PillKeyInput } from './pillKeys';

const base: PillKeyInput = { key: 'a', shift: false, composing: false, value: 'abc', selectionStart: 1, selectionEnd: 1, index: 0, count: 2 };
const at = (patch: Partial<PillKeyInput>) => pillKeyAction({ ...base, ...patch });

describe('pillKeyAction', () => {
  it('Tab 前进，最后一个参数跳出到胶囊后', () => {
    expect(at({ key: 'Tab' })).toEqual({ type: 'focus', index: 1, caret: 'end' });
    expect(at({ key: 'Tab', index: 1 })).toEqual({ type: 'exit', where: 'after' });
  });

  it('Shift+Tab 后退，第一个参数跳出到胶囊前', () => {
    expect(at({ key: 'Tab', shift: true, index: 1 })).toEqual({ type: 'focus', index: 0, caret: 'end' });
    expect(at({ key: 'Tab', shift: true })).toEqual({ type: 'exit', where: 'before' });
  });

  it('Enter 提交，Shift+Enter 和输入法组字中不处理', () => {
    expect(at({ key: 'Enter' })).toEqual({ type: 'submit' });
    expect(at({ key: 'Enter', shift: true })).toEqual({ type: 'none' });
    expect(at({ key: 'Enter', composing: true })).toEqual({ type: 'none' });
  });

  it('空参数 Backspace 回退，第一个参数为空时删除胶囊，有内容时交给输入框', () => {
    expect(at({ key: 'Backspace', value: '', index: 1 })).toEqual({ type: 'focus', index: 0, caret: 'end' });
    expect(at({ key: 'Backspace', value: '' })).toEqual({ type: 'remove' });
    expect(at({ key: 'Backspace' })).toEqual({ type: 'none' });
  });

  it('方向键只在边界处跨参数或跳出', () => {
    expect(at({ key: 'ArrowLeft', selectionStart: 0, selectionEnd: 0, index: 1 })).toEqual({ type: 'focus', index: 0, caret: 'end' });
    expect(at({ key: 'ArrowLeft', selectionStart: 0, selectionEnd: 0 })).toEqual({ type: 'exit', where: 'before' });
    expect(at({ key: 'ArrowLeft' })).toEqual({ type: 'none' });
    expect(at({ key: 'ArrowRight', selectionStart: 3, selectionEnd: 3 })).toEqual({ type: 'focus', index: 1, caret: 'start' });
    expect(at({ key: 'ArrowRight', selectionStart: 3, selectionEnd: 3, index: 1 })).toEqual({ type: 'exit', where: 'after' });
  });

  it('Esc 跳出到胶囊后，其他键不处理', () => {
    expect(at({ key: 'Escape' })).toEqual({ type: 'exit', where: 'after' });
    expect(at({ key: 'x' })).toEqual({ type: 'none' });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/CommandPill/pillKeys.test.ts`
预期：FAIL，报错 `Failed to resolve import "./pillKeys"`

- [ ] **步骤 3：实现**

```ts
export interface PillKeyInput {
  key: string;
  shift: boolean;
  composing: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  index: number;
  count: number;
}

export type PillKeyAction =
  | { type: 'none' }
  | { type: 'focus'; index: number; caret: 'start' | 'end' }
  | { type: 'exit'; where: 'before' | 'after' }
  | { type: 'remove' }
  | { type: 'submit' };

const NONE: PillKeyAction = { type: 'none' };

function previous(input: PillKeyInput): PillKeyAction {
  return input.index > 0 ? { type: 'focus', index: input.index - 1, caret: 'end' } : { type: 'exit', where: 'before' };
}

function next(input: PillKeyInput, caret: 'start' | 'end'): PillKeyAction {
  return input.index < input.count - 1 ? { type: 'focus', index: input.index + 1, caret } : { type: 'exit', where: 'after' };
}

/** 胶囊参数输入框里的按键 → 动作。纯函数，规格「输入框」一节的按键表。 */
export function pillKeyAction(input: PillKeyInput): PillKeyAction {
  if (input.composing) return NONE;
  const collapsed = input.selectionStart === input.selectionEnd;
  switch (input.key) {
    case 'Tab':
      return input.shift ? previous(input) : next(input, 'end');
    case 'Enter':
      return input.shift ? NONE : { type: 'submit' };
    case 'Backspace':
      if (input.value !== '') return NONE;
      return input.index > 0 ? previous(input) : { type: 'remove' };
    case 'ArrowLeft':
      return collapsed && input.selectionStart === 0 ? previous(input) : NONE;
    case 'ArrowRight':
      return collapsed && input.selectionEnd === input.value.length ? next(input, 'start') : NONE;
    case 'Escape':
      return { type: 'exit', where: 'after' };
    default:
      return NONE;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/CommandPill/pillKeys.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/input/editor/CommandPill/pillKeys.ts electron-agent/src/features/chat/input/editor/CommandPill/pillKeys.test.ts
git commit -m "feat(chat): 命令胶囊按键规则"
```

---

### 任务 10：CommandPillNode、插件和可编辑胶囊

这一组是 Lexical 胶囊的实体。键盘、焦点、IME 这些行为 jsdom 测不准，由任务 18 的 ui-harness 场景验证；这里只单测节点的序列化。

**关键约束（读完再写代码）：**
- 胶囊里 `<input>` 的事件会冒泡到 Lexical 的 contenteditable 根节点。根节点上的 keydown 会触发 `KEY_ENTER_COMMAND`，lobehub 的 `onPressEnter` 会直接发送；paste 会被 Lexical 粘进编辑器。所以胶囊根 `<span>` 上要用**原生**监听器处理 keydown、input、paste，并对下面这些事件一律 `stopPropagation()`：keydown、keyup、keypress、beforeinput、input、compositionstart、compositionupdate、compositionend、paste、cut、copy、drop、dragstart、mousedown、click。
- 因为在 span 上就停止了冒泡，事件到不了 React 根节点，**不能用 React 的 `onChange` / `onKeyDown`**。输入框用非受控的 `defaultValue`，值通过原生 `input` 事件写回节点。
- `MessageEditor` 的 draftRef 上还有一个原生 keydown 回车兜底，它在 span 外层；事件在 span 上停止冒泡，到不了它。它本身也会跳过 `HTMLInputElement` 目标。

**文件：**
- 创建：`CommandPill/CommandPillNode.ts`、`CommandPill/commands.ts`、`CommandPill/hostContext.ts`、`CommandPill/CommandPillPlugin.ts`、`CommandPill/CommandPillEditor.tsx`、`CommandPill/ReactCommandPillPlugin.tsx`（都在 `electron-agent/src/features/chat/input/editor/` 下）
- 测试：`CommandPill/CommandPillNode.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// @vitest-environment jsdom
import { createEditor, $getRoot, $createParagraphNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import { $createCommandPillNode, CommandPillNode, PILL_MARKER } from './CommandPillNode';

const params = [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }];

function withEditor<T>(fn: () => T): T {
  const editor = createEditor({ nodes: [CommandPillNode], onError: (error) => { throw error; } });
  let result!: T;
  editor.update(() => { result = fn(); }, { discrete: true });
  return result;
}

describe('CommandPillNode', () => {
  it('values 补齐到参数个数，getTextContent 是调用文本', () => {
    const text = withEditor(() => {
      const node = $createCommandPillNode('refactor', params, ['a "b"']);
      $getRoot().append($createParagraphNode().append(node));
      return node.getTextContent();
    });
    expect(text).toBe('/refactor "a \\"b\\"" ""');
  });

  it('setValue 生成新值数组，不改原数组', () => {
    const [before, after] = withEditor(() => {
      const node = $createCommandPillNode('refactor', params, []);
      $getRoot().append($createParagraphNode().append(node));
      const original = node.values;
      return [original, node.setValue(1, 'oop').values];
    });
    expect(before).toEqual(['', '']);
    expect(after).toEqual(['', 'oop']);
  });

  it('exportJSON / importJSON 往返', () => {
    const json = withEditor(() => {
      const node = $createCommandPillNode('refactor', params, ['x', '']);
      $getRoot().append($createParagraphNode().append(node));
      return node.exportJSON();
    });
    expect(json).toMatchObject({ type: 'command-pill', name: 'refactor', params, values: ['x', ''] });
    const back = withEditor(() => CommandPillNode.importJSON(json).values);
    expect(back).toEqual(['x', '']);
  });

  it('标记字符是私用区字符，remark 不会转义', () => {
    expect(PILL_MARKER).toBe(String.fromCharCode(0xe000));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/CommandPill/CommandPillNode.test.ts`
预期：FAIL，报错 `Failed to resolve import "./CommandPillNode"`

- [ ] **步骤 3：实现 `CommandPillNode.ts`**

```ts
import { getKernelFromEditor } from '@lobehub/editor';
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { formatInvocation, type PromptParam } from '@extensions/prompt-commands/syntax';

/**
 * markdown 写出时胶囊位置放这个私用区字符，发送和存草稿前再换成调用文本。
 * 不直接写调用文本：getDocument('markdown') 会过一遍 remark，参数里的 \ * _ [ 会被转义。
 */
export const PILL_MARKER = String.fromCharCode(0xe000);

export type SerializedCommandPillNode = Spread<
  { name: string; params: PromptParam[]; values: string[] },
  SerializedLexicalNode
>;

/** 输入框里的命令胶囊：命令名 + 每个参数的当前值。渲染交给注册的 decorator。 */
export class CommandPillNode extends DecoratorNode<unknown> {
  __name: string;
  __params: PromptParam[];
  __values: string[];

  static getType(): string {
    return 'command-pill';
  }

  static clone(node: CommandPillNode): CommandPillNode {
    return new CommandPillNode(node.__name, node.__params, node.__values, node.__key);
  }

  static importJSON(serialized: SerializedCommandPillNode): CommandPillNode {
    return $createCommandPillNode(serialized.name, serialized.params, serialized.values).updateFromJSON(serialized);
  }

  static importDOM(): null {
    return null;
  }

  constructor(name: string, params: PromptParam[], values: readonly string[], key?: string) {
    super(key);
    this.__name = name;
    this.__params = params;
    this.__values = params.map((_, index) => values[index] ?? '');
  }

  get name(): string {
    return this.__name;
  }

  get params(): PromptParam[] {
    return this.__params;
  }

  get values(): string[] {
    return this.__values;
  }

  setValue(index: number, value: string): this {
    const writable = this.getWritable();
    writable.__values = writable.__values.map((current, i) => (i === index ? value : current));
    return writable;
  }

  invocation(): string {
    return formatInvocation(this.__name, this.__values);
  }

  getTextContent(): string {
    return this.invocation();
  }

  exportDOM(): DOMExportOutput {
    return { element: document.createElement('span') };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    return document.createElement('span');
  }

  isInline(): true {
    return true;
  }

  updateDOM(): boolean {
    return false;
  }

  exportJSON(): SerializedCommandPillNode {
    return { ...super.exportJSON(), name: this.__name, params: this.__params, values: this.__values };
  }

  updateFromJSON(serialized: LexicalUpdateJSON<SerializedCommandPillNode>): this {
    return super.updateFromJSON(serialized);
  }

  decorate(editor: LexicalEditor): unknown {
    const decorator = getKernelFromEditor(editor)?.getDecorator(CommandPillNode.getType());
    if (!decorator) return null;
    if (typeof decorator === 'function') return decorator(this, editor);
    return { queryDOM: decorator.queryDOM, render: decorator.render(this, editor) };
  }
}

export function $createCommandPillNode(name: string, params: PromptParam[], values: readonly string[]): CommandPillNode {
  return $applyNodeReplacement(new CommandPillNode(name, params, values));
}

export function $isCommandPillNode(node: LexicalNode | null | undefined): node is CommandPillNode {
  return node?.getType() === CommandPillNode.getType();
}
```

注意：jsdom 测试里没有 lobehub kernel，`decorate` 返回 null 不影响断言。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/CommandPill/CommandPillNode.test.ts`
预期：PASS

- [ ] **步骤 5：实现 `commands.ts`、`hostContext.ts`、`CommandPillPlugin.ts`**

`commands.ts`：

```ts
import { $wrapNodeInElement } from '@lexical/utils';
import {
  $createParagraphNode,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_HIGH,
  createCommand,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';
import type { PromptParam } from '@extensions/prompt-commands/syntax';
import { $createCommandPillNode } from './CommandPillNode';

export interface InsertCommandPillPayload {
  name: string;
  params: PromptParam[];
  /** 粘贴时已经解析出的参数值。 */
  values?: string[];
  /** 粘贴时参数之后的补充正文，接在胶囊后面。 */
  trailingText?: string;
}

export interface FocusPillArgPayload {
  key: string;
  index: number;
  /** 发送被拦下时为 true：参数段描边变红并抖一下。 */
  invalid: boolean;
}

export const INSERT_COMMAND_PILL_COMMAND: LexicalCommand<InsertCommandPillPayload> = createCommand('INSERT_COMMAND_PILL_COMMAND');
export const FOCUS_PILL_ARG_COMMAND: LexicalCommand<FocusPillArgPayload> = createCommand('FOCUS_PILL_ARG_COMMAND');

/** 刚插入的胶囊要聚焦哪个参数。节点挂载时由 CommandPillEditor 取走。 */
const pendingFocus = new Map<string, number>();

export function takePillFocus(key: string): number | undefined {
  const index = pendingFocus.get(key);
  pendingFocus.delete(key);
  return index;
}

export function registerCommandPillCommands(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    INSERT_COMMAND_PILL_COMMAND,
    (payload) => {
      editor.update(() => {
        const node = $createCommandPillNode(payload.name, payload.params, payload.values ?? []);
        $insertNodes([node]);
        if ($isRootOrShadowRoot(node.getParentOrThrow())) {
          $wrapNodeInElement(node, $createParagraphNode).selectEnd();
        }
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText(payload.trailingText ? ` ${payload.trailingText}` : ' ');
        }
        const firstEmpty = node.values.findIndex((value) => value === '');
        if (firstEmpty !== -1) pendingFocus.set(node.getKey(), firstEmpty);
      });
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}
```

`hostContext.ts`：

```ts
import { createContext } from 'react';

/** 胶囊里按 Enter 时要走的发送逻辑。输入框和消息编辑框各自提供。 */
export interface CommandPillHost {
  submit: () => void;
}

export const CommandPillHostContext = createContext<CommandPillHost | null>(null);
```

`CommandPillPlugin.ts`：

```ts
import { getKernelFromEditor, IMarkdownShortCutService } from '@lobehub/editor';
import type { LexicalEditor, LexicalNode } from 'lexical';
import { $isCommandPillNode, CommandPillNode, PILL_MARKER } from './CommandPillNode';
import { registerCommandPillCommands } from './commands';

type EditorKernel = NonNullable<ReturnType<typeof getKernelFromEditor>>;

export interface CommandPillPluginOptions {
  decorator: (node: CommandPillNode, editor: LexicalEditor) => unknown;
}

/** 注册 CommandPillNode、它的 React decorator，以及 markdown 写出（写占位标记，见 PILL_MARKER）。 */
export class CommandPillPlugin {
  static pluginName = 'CommandPillPlugin';

  config?: CommandPillPluginOptions;
  private kernel: EditorKernel;
  private clears: Array<() => void> = [];

  constructor(kernel: EditorKernel, config?: CommandPillPluginOptions) {
    this.kernel = kernel;
    this.config = config;
    kernel.registerNodes([CommandPillNode]);
    kernel.registerDecorator(CommandPillNode.getType(), (node: LexicalNode, editor: LexicalEditor) =>
      this.config?.decorator ? this.config.decorator(node as CommandPillNode, editor) : null,
    );
  }

  onInit(editor: LexicalEditor): void {
    this.clears.push(registerCommandPillCommands(editor));
    const markdown = this.kernel.requireService(IMarkdownShortCutService);
    markdown?.registerMarkdownWriter(
      CommandPillNode.getType(),
      (ctx: { appendLine: (line: string) => void }, node: LexicalNode) => {
        if ($isCommandPillNode(node)) ctx.appendLine(PILL_MARKER);
      },
    );
  }

  destroy(): void {
    this.clears.forEach((clear) => clear());
    this.clears = [];
    this.kernel.unregisterDecorator?.(CommandPillNode.getType());
  }
}
```

- [ ] **步骤 6：实现 `CommandPillEditor.tsx` 和 `ReactCommandPillPlugin.tsx`**

`CommandPillEditor.tsx`：

```tsx
import { Icon } from '@lobehub/ui';
import { cx } from 'antd-style';
import { $getNodeByKey, COMMAND_PRIORITY_LOW, type LexicalEditor } from 'lexical';
import { SquareSlash } from 'lucide-react';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PromptParam } from '@extensions/prompt-commands/syntax';
import { $isCommandPillNode, type CommandPillNode } from './CommandPillNode';
import { FOCUS_PILL_ARG_COMMAND, takePillFocus } from './commands';
import { CommandPillHostContext } from './hostContext';
import { pillStyles } from './commandPillStyles';
import { pillKeyAction } from './pillKeys';

const INVALID_FLASH_MS = 900;

/** 在胶囊上就截住，不让 Lexical 根节点和 React 根节点处理（见计划任务 10 的约束）。 */
const SWALLOWED_EVENTS = [
  'keyup', 'keypress', 'beforeinput', 'compositionstart', 'compositionupdate', 'compositionend',
  'cut', 'copy', 'drop', 'dragstart', 'mousedown', 'click',
] as const;

interface CommandPillEditorProps {
  editor: LexicalEditor;
  nodeKey: string;
  name: string;
  params: PromptParam[];
  values: string[];
}

function argIndexOf(target: EventTarget | null): number | null {
  if (!(target instanceof HTMLInputElement)) return null;
  const index = Number(target.dataset.argIndex);
  return Number.isInteger(index) ? index : null;
}

/** 输入框里的可编辑命令胶囊。参数是非受控原生 input，值通过原生 input 事件写回节点。 */
export function CommandPillEditor({ editor, nodeKey, name, params, values }: CommandPillEditorProps) {
  const host = useContext(CommandPillHostContext);
  const hostRef = useRef(host);
  hostRef.current = host;
  const rootRef = useRef<HTMLSpanElement>(null);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const [focused, setFocused] = useState<number | null>(null);
  const [invalid, setInvalid] = useState<number | null>(null);

  const withNode = useCallback(
    (fn: (node: CommandPillNode) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isCommandPillNode(node)) fn(node);
      });
    },
    [editor, nodeKey],
  );

  const focusArg = useCallback((index: number, caret: 'start' | 'end' = 'end') => {
    const input = inputs.current[index];
    if (!input) return;
    input.focus();
    const at = caret === 'start' ? 0 : input.value.length;
    input.setSelectionRange(at, at);
  }, []);

  const exit = useCallback(
    (where: 'before' | 'after') => {
      withNode((node) => {
        if (where === 'after') node.selectNext(0, 0);
        else node.selectPrevious();
      });
      editor.focus();
    },
    [editor, withNode],
  );

  useLayoutEffect(() => {
    const index = takePillFocus(nodeKey);
    if (index !== undefined) focusArg(index);
  }, [nodeKey, focusArg]);

  useEffect(
    () =>
      editor.registerCommand(
        FOCUS_PILL_ARG_COMMAND,
        (payload) => {
          if (payload.key !== nodeKey) return false;
          focusArg(payload.index);
          if (payload.invalid) {
            setInvalid(payload.index);
            window.setTimeout(() => setInvalid(null), INVALID_FLASH_MS);
          }
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    [editor, nodeKey, focusArg],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const swallow = (event: Event) => event.stopPropagation();
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      const index = argIndexOf(event.target);
      if (index === null) return;
      const input = event.target as HTMLInputElement;
      const action = pillKeyAction({
        key: event.key,
        shift: event.shiftKey,
        composing: event.isComposing,
        value: input.value,
        selectionStart: input.selectionStart ?? 0,
        selectionEnd: input.selectionEnd ?? 0,
        index,
        count: params.length,
      });
      if (action.type === 'none') return;
      event.preventDefault();
      if (action.type === 'focus') focusArg(action.index, action.caret);
      else if (action.type === 'exit') exit(action.where);
      else if (action.type === 'remove') {
        withNode((node) => {
          node.selectPrevious();
          node.remove();
        });
        editor.focus();
      } else hostRef.current?.submit();
    };
    const onInput = (event: Event) => {
      event.stopPropagation();
      const index = argIndexOf(event.target);
      if (index === null) return;
      const value = (event.target as HTMLInputElement).value;
      withNode((node) => node.setValue(index, value));
    };
    const onPaste = (event: ClipboardEvent) => {
      event.stopPropagation();
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      const text = event.clipboardData?.getData('text/plain');
      if (text === undefined) return;
      event.preventDefault();
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.setRangeText(text.replace(/\s*\r?\n\s*/g, ' '), start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('input', onInput);
    root.addEventListener('paste', onPaste);
    SWALLOWED_EVENTS.forEach((type) => root.addEventListener(type, swallow));
    return () => {
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('input', onInput);
      root.removeEventListener('paste', onPaste);
      SWALLOWED_EVENTS.forEach((type) => root.removeEventListener(type, swallow));
    };
  }, [editor, params.length, focusArg, exit, withNode]);

  return (
    <span
      ref={rootRef}
      className={pillStyles.pill}
      data-command-pill
      data-testid="command-pill"
      data-command={name}
      data-noarg={params.length === 0}
      contentEditable={false}
    >
      <span className={pillStyles.command}>
        <Icon icon={SquareSlash} size={13} />
        {name}
      </span>
      {params.map((param, index) => (
        <span
          key={param.name}
          className={cx(pillStyles.arg, focused === index && pillStyles.argFocus, invalid === index && pillStyles.argInvalid)}
          data-testid="command-pill-arg"
          data-invalid={invalid === index}
        >
          <span className={pillStyles.key}>{param.name}</span>
          <input
            ref={(el) => {
              inputs.current[index] = el;
            }}
            className={pillStyles.input}
            data-arg-index={index}
            data-arg-name={param.name}
            defaultValue={values[index] ?? ''}
            placeholder={param.defaultValue ?? param.name}
            spellCheck={false}
            onFocus={() => setFocused(index)}
            onBlur={() => setFocused((current) => (current === index ? null : current))}
          />
        </span>
      ))}
    </span>
  );
}
```

注意：`onFocus` / `onBlur` 是 React 合成事件，靠的是 React 在根节点上的 `focusin` / `focusout` 监听。这两个事件不在 `SWALLOWED_EVENTS` 里，所以能正常到达。

`ReactCommandPillPlugin.tsx`：

```tsx
import { MarkdownPlugin, useLexicalComposerContext } from '@lobehub/editor';
import { type FC, useLayoutEffect } from 'react';
import { CommandPillEditor } from './CommandPillEditor';
import { CommandPillPlugin } from './CommandPillPlugin';

const ReactCommandPillPlugin: FC = () => {
  const [editor] = useLexicalComposerContext();

  useLayoutEffect(() => {
    editor.registerPlugin(MarkdownPlugin);
    editor.registerPlugin(CommandPillPlugin, {
      decorator: (node, lexical) => (
        <CommandPillEditor
          editor={lexical}
          nodeKey={node.getKey()}
          name={node.name}
          params={node.params}
          values={node.values}
        />
      ),
    });
  }, [editor]);

  return null;
};

ReactCommandPillPlugin.displayName = 'ReactCommandPillPlugin';

export default ReactCommandPillPlugin;
```

- [ ] **步骤 7：类型检查**

渲染层没有 tsc 工程（见 AGENTS.md「运行的坑」）。临时建 `electron-agent/tsconfig.pill.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/features/chat/input/editor/CommandPill/**/*.ts", "src/features/chat/input/editor/CommandPill/**/*.tsx"]
}
```

运行：`cd electron-agent && npx tsc -p tsconfig.pill.json 2>&1 | grep CommandPill`
预期：没有输出（`CommandPill/` 下的文件没有类型错误；其他文件的报错忽略）。跑完删掉 `tsconfig.pill.json`。

- [ ] **步骤 8：Commit**

```bash
git add electron-agent/src/features/chat/input/editor/CommandPill/
git commit -m "feat(chat): 可编辑的命令胶囊节点"
```

---

### 任务 11：发送路径接线

**文件：**
- 创建：`electron-agent/src/features/chat/input/editor/CommandPill/composerText.ts`
- 测试：`electron-agent/src/features/chat/input/editor/CommandPill/composerText.test.ts`
- 修改：`electron-agent/src/features/chat/ChatInput.tsx:86-90, 138-141`
- 修改：`electron-agent/src/features/chat/MessageEditBox.tsx:177-183, 296`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx:22, 289-335`
- 修改：`electron-agent/src/features/chat/input/editor/usePasteCapture.ts:26`

- [ ] **步骤 1：编写失败的测试**

```ts
// @vitest-environment jsdom
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { describe, expect, it, vi } from 'vitest';
import { $createCommandPillNode, CommandPillNode, PILL_MARKER } from './CommandPillNode';
import { FOCUS_PILL_ARG_COMMAND } from './commands';
import { $caretAtDocumentStart, focusMissingPillArg, readPillInvocation, substitutePillMarker } from './composerText';

const params = [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }];

function editorWith(values: string[]) {
  const editor = createEditor({ nodes: [CommandPillNode], onError: (error) => { throw error; } });
  let key = '';
  editor.update(() => {
    const node = $createCommandPillNode('refactor', params, values);
    key = node.getKey();
    $getRoot().append($createParagraphNode().append(node, $createTextNode(' 顺便')));
  }, { discrete: true });
  return { editor, key };
}

describe('substitutePillMarker', () => {
  it('把第一个标记换成调用文本，多余标记删掉', () => {
    expect(substitutePillMarker(`${PILL_MARKER} 顺便`, '/a "x"')).toBe('/a "x" 顺便');
    expect(substitutePillMarker(`${PILL_MARKER}${PILL_MARKER}`, '/a')).toBe('/a');
    expect(substitutePillMarker('无标记', '/a')).toBe('无标记');
  });
});

describe('readPillInvocation', () => {
  it('读出胶囊的调用文本，没有编辑器时为 null', () => {
    expect(readPillInvocation(editorWith(['a\\b', '']).editor)).toBe('/refactor "a\\\\b" ""');
    expect(readPillInvocation(null)).toBeNull();
  });
});

describe('focusMissingPillArg', () => {
  it('必填参数空着时派发聚焦并返回 true', () => {
    const { editor, key } = editorWith(['', '']);
    const spy = vi.fn(() => true);
    editor.registerCommand(FOCUS_PILL_ARG_COMMAND, spy, 0);
    expect(focusMissingPillArg(editor)).toBe(true);
    expect(spy).toHaveBeenCalledWith({ key, index: 0, invalid: true }, editor);
  });

  it('有默认值的参数空着不算缺', () => {
    expect(focusMissingPillArg(editorWith(['a.ts', '']).editor)).toBe(false);
    expect(focusMissingPillArg(undefined)).toBe(false);
  });
});

describe('$caretAtDocumentStart', () => {
  it('空文档、首段开头为 true，其他位置为 false', () => {
    const editor = createEditor({ nodes: [], onError: (error) => { throw error; } });
    const results: boolean[] = [];
    editor.update(() => {
      const paragraph = $createParagraphNode();
      const text = $createTextNode('abc');
      $getRoot().append(paragraph.append(text));
      paragraph.select(0, 0);
      results.push($caretAtDocumentStart());
      text.select(1, 1);
      results.push($caretAtDocumentStart());
      text.select(0, 0);
      results.push($caretAtDocumentStart());
    }, { discrete: true });
    expect(results).toEqual([true, false, true]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/CommandPill/composerText.test.ts`
预期：FAIL，报错 `Failed to resolve import "./composerText"`

- [ ] **步骤 3：实现 `composerText.ts`**

```ts
import type { IEditor } from '@lobehub/editor';
import { $dfs } from '@lexical/utils';
import { $getRoot, $getSelection, $isElementNode, $isRangeSelection, type LexicalEditor } from 'lexical';
import { unescapeComposerMarkdown } from '../../unescapeComposerMarkdown';
import { $isCommandPillNode, PILL_MARKER, type CommandPillNode } from './CommandPillNode';
import { FOCUS_PILL_ARG_COMMAND } from './commands';

function $firstPill(): CommandPillNode | null {
  for (const { node } of $dfs($getRoot())) if ($isCommandPillNode(node)) return node;
  return null;
}

export function readPillInvocation(editor: LexicalEditor | null | undefined): string | null {
  if (!editor) return null;
  return editor.getEditorState().read(() => $firstPill()?.invocation() ?? null);
}

export function substitutePillMarker(markdown: string, invocation: string | null): string {
  if (!markdown.includes(PILL_MARKER)) return markdown;
  const [head, ...tail] = markdown.split(PILL_MARKER);
  return `${head}${invocation ?? ''}${tail.join('')}`;
}

/** 输入框正文：markdown 去转义，再把胶囊标记换成调用文本。发送和存草稿都用它。 */
export function readComposerText(editor: IEditor): string {
  const markdown = unescapeComposerMarkdown(String(editor.getDocument('markdown') || ''));
  return substitutePillMarker(markdown, readPillInvocation(editor.getLexicalEditor?.()));
}

/** 发送前检查：有必填参数空着就把焦点送过去并返回 true，调用方不再发送。 */
export function focusMissingPillArg(editor: LexicalEditor | null | undefined): boolean {
  if (!editor) return false;
  const missing = editor.getEditorState().read(() => {
    const pill = $firstPill();
    if (!pill) return null;
    const index = pill.params.findIndex((param, i) => param.defaultValue === undefined && pill.values[i] === '');
    return index === -1 ? null : { key: pill.getKey(), index };
  });
  if (!missing) return false;
  editor.dispatchCommand(FOCUS_PILL_ARG_COMMAND, { ...missing, invalid: true });
  return true;
}

/** 光标在整个输入的最开头：胶囊只能放这里，扩展只认以 /名 开头的文本。 */
export function $caretAtDocumentStart(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  const first = $getRoot().getFirstChild();
  if (!first) return true;
  if (!$isElementNode(first)) return false;
  const anchor = selection.anchor;
  const node = anchor.getNode();
  if (anchor.type === 'element') return node.is(first) && anchor.offset === 0;
  const firstLeaf = first.getFirstDescendant();
  return firstLeaf !== null && node.is(firstLeaf) && anchor.offset === 0;
}

/** 斜杠菜单打开时：`/查询` 是不是整个输入的开头（前面只允许空白）。 */
export function $slashAtDocumentStart(query: string): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const first = $getRoot().getFirstChild();
  if (!first || !$isElementNode(first)) return false;
  const node = selection.anchor.getNode();
  if (!node.is(first.getFirstDescendant())) return false;
  return node.getTextContent().slice(0, selection.anchor.offset).trimStart() === `/${query}`;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/CommandPill/composerText.test.ts`
预期：PASS

- [ ] **步骤 5：接到输入框、消息编辑框和粘贴拦截**

`ChatInput.tsx`：
- 导入 `import { focusMissingPillArg, readComposerText } from './input/editor/CommandPill/composerText';`
- `readDraft` 改成：

```ts
  // 读当前编辑器正文：markdown 去转义，命令胶囊换成调用文本（见 composerText.ts）。
  const readDraft = useCallback(() => readComposerText(editor), [editor]);
```

- `send` 开头，`const interrupt = …` 之前插入：

```ts
    if (focusMissingPillArg(editor.getLexicalEditor?.())) return;
```

- 如果 `unescapeComposerMarkdown` 在 `ChatInput.tsx` 里没有别的用处，就删掉这个导入。

`MessageEditBox.tsx`：
- 同样导入两个函数，并导入 `ReactCommandPillPlugin` 和 `CommandPillHostContext`。
- `readDraft` 改成 `useCallback(() => readComposerText(editor), [editor])`。
- 它的 `send` 开头同样插入 `if (focusMissingPillArg(editor.getLexicalEditor?.())) return;`。
- `plugins={[ReactChatTagPlugin]}` 改成 `plugins={[ReactChatTagPlugin, ReactCommandPillPlugin]}`。
- 在 `<Editor …/>` 外面包一层 `<CommandPillHostContext.Provider value={pillHost}>`，并在组件里定义：

```ts
  const pillHost = useMemo(() => ({ submit: () => void send() }), [send]);
```

`MessageEditor.tsx`：
- 导入 `ReactCommandPillPlugin from './CommandPill/ReactCommandPillPlugin'` 和 `CommandPillHostContext`。
- 组件里加：

```ts
  const pillHost = useMemo(() => ({ submit: () => void send() }), [send]);
```

- `plugins={[ReactChatTagPlugin]}` 改成 `plugins={[ReactChatTagPlugin, ReactCommandPillPlugin]}`。
- 用 `<CommandPillHostContext.Provider value={pillHost}>…</CommandPillHostContext.Provider>` 包住 `<Editor …/>`。

`usePasteCapture.ts` 的 `handler` 开头，`const dt = e.clipboardData;` 之前加：

```ts
      // 胶囊参数里的粘贴由胶囊自己处理（换行压成空格），这里不转附件、不转标签。
      if (e.target instanceof Element && e.target.closest('[data-command-pill]')) return;
```

- [ ] **步骤 6：跑受影响的单测**

运行：`cd electron-agent && npx vitest run src/features/chat/ChatInput.test.tsx src/features/chat/MessageEditBox.test.tsx src/features/chat/input/editor/MessageEditor.test.tsx src/features/chat/input/editor/CommandPill/`
预期：PASS。`ChatInput.test.tsx` 里 mock 的 editor 没有 `getLexicalEditor`，`?.()` 会返回 undefined，所以 `focusMissingPillArg` 返回 false，原有用例不受影响。如果 `MessageEditBox.test.tsx` 或 `MessageEditor.test.tsx` mock 了 `@lobehub/editor`、找不到 `MarkdownPlugin` / `useLexicalComposerContext`，就在该测试文件里加一行 `vi.mock('./CommandPill/ReactCommandPillPlugin', () => ({ default: () => null }))`，路径按测试文件所在位置写。

- [ ] **步骤 7：Commit**

```bash
git add electron-agent/src/features/chat/input/editor/CommandPill/composerText.ts electron-agent/src/features/chat/input/editor/CommandPill/composerText.test.ts electron-agent/src/features/chat/ChatInput.tsx electron-agent/src/features/chat/MessageEditBox.tsx electron-agent/src/features/chat/input/editor/MessageEditor.tsx electron-agent/src/features/chat/input/editor/usePasteCapture.ts
git commit -m "feat(chat): 发送时把命令胶囊换成调用文本，缺必填参数拦下"
```

（如果步骤 6 改了测试文件里的 mock，把那些测试文件一起 `git add`。）

---

### 任务 12：斜杠菜单和粘贴

**文件：**
- 创建：`electron-agent/src/features/chat/input/editor/slashPromptOptions.ts`
- 测试：`electron-agent/src/features/chat/input/editor/slashPromptOptions.test.ts`
- 修改：`electron-agent/src/features/chat/input/editor/useSlashOptions.ts`
- 修改：`electron-agent/src/features/chat/input/editor/commandPaste.ts`、`commandPaste.test.ts`、`useCommandPaste.ts`
- 修改：`electron-agent/src/features/chat/input/editor/MessageEditor.tsx:208`、`electron-agent/src/features/chat/MessageEditBox.tsx:195`

- [ ] **步骤 1：编写失败的测试**

`slashPromptOptions.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { PiCommand } from '../commandTypes';
import { filterPromptCommands, paramHint } from './slashPromptOptions';

const templates = [
  { name: 'refactor', description: '', body: '', params: [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }], path: '' },
  { name: 'review', description: '', body: '', params: [], path: '' },
];
const commands: PiCommand[] = [
  { name: 'refactor', source: 'api', apiSource: 'prompt' },
  { name: 'review', source: 'api', apiSource: 'prompt' },
  { name: 'goal', source: 'api', apiSource: 'extension' },
];

describe('filterPromptCommands', () => {
  it('在文首时全部保留', () => {
    expect(filterPromptCommands(commands, templates, true)).toEqual(commands);
  });

  it('不在文首时去掉带参数的模板', () => {
    expect(filterPromptCommands(commands, templates, false).map((c) => c.name)).toEqual(['review', 'goal']);
  });
});

describe('paramHint', () => {
  it('带参数的模板生成 {a} {b}，其他返回 undefined', () => {
    expect(paramHint('refactor', templates)).toBe('{file} {style}');
    expect(paramHint('review', templates)).toBeUndefined();
  });
});
```

`commandPaste.test.ts` 末尾追加：

```ts
describe('resolvePromptPill', () => {
  const templates = [{ name: 'refactor', description: '', body: '', params: [{ name: 'file' }, { name: 'style' }], path: '' }];

  it('带参数模板解析出参数和补充正文', () => {
    expect(resolvePromptPill(templates, '/refactor "a b" fp 顺便')).toEqual({
      name: 'refactor',
      params: templates[0].params,
      values: ['a b', 'fp'],
      trailingText: '顺便',
    });
  });

  it('参数不够时补空串，不是带参数模板时返回 null', () => {
    expect(resolvePromptPill(templates, '/refactor')?.values).toEqual(['', '']);
    expect(resolvePromptPill(templates, '/review x')).toBeNull();
    expect(resolvePromptPill(templates, 'hello')).toBeNull();
  });
});
```

并把文件顶部的导入改成 `import { parseCommandToken, resolveCommandTag, resolvePromptPill } from './commandPaste';`（保留原有导入项）。

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/slashPromptOptions.test.ts src/features/chat/input/editor/commandPaste.test.ts`
预期：FAIL，报错 `Failed to resolve import "./slashPromptOptions"` 和 `resolvePromptPill is not a function`

- [ ] **步骤 3：实现 `slashPromptOptions.ts` 和 `resolvePromptPill`**

`slashPromptOptions.ts`：

```ts
import type { PromptCommandInfo } from '../../../../lib/promptLibraryIo';
import type { PiCommand } from '../commandTypes';

function paramTemplate(name: string, templates: readonly PromptCommandInfo[]): PromptCommandInfo | undefined {
  return templates.find((template) => template.name === name && template.params.length > 0);
}

/** 带参数的模板只能放在整个输入开头；不在开头时菜单里不列它们。 */
export function filterPromptCommands(
  commands: PiCommand[],
  templates: readonly PromptCommandInfo[],
  atStart: boolean,
): PiCommand[] {
  if (atStart) return commands;
  return commands.filter((command) => command.apiSource !== 'prompt' || !paramTemplate(command.name, templates));
}

export function paramHint(name: string, templates: readonly PromptCommandInfo[]): string | undefined {
  const template = paramTemplate(name, templates);
  return template ? template.params.map((param) => `{${param.name}}`).join(' ') : undefined;
}
```

`commandPaste.ts` 末尾追加（并在顶部加导入）：

```ts
import { parseInvocation, splitArgs } from '@extensions/prompt-commands/syntax';
import type { PromptCommandInfo } from '../../../../lib/promptLibraryIo';
import type { InsertCommandPillPayload } from './CommandPill/commands';

/** 粘贴 `/模板 参数…`：命中带参数的模板时返回胶囊数据，参数不够的位置留空串。 */
export function resolvePromptPill(templates: readonly PromptCommandInfo[], text: string): InsertCommandPillPayload | null {
  const invocation = parseInvocation(text.trim());
  if (!invocation) return null;
  const template = templates.find((item) => item.name === invocation.name && item.params.length > 0);
  if (!template) return null;
  const { args, rest } = splitArgs(invocation.argsText, template.params.length);
  return {
    name: template.name,
    params: template.params,
    values: template.params.map((_, index) => args[index] ?? ''),
    trailingText: rest || undefined,
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/slashPromptOptions.test.ts src/features/chat/input/editor/commandPaste.test.ts`
预期：PASS

- [ ] **步骤 5：接到斜杠菜单**

`useSlashOptions.ts`：
- 新增导入：

```ts
import { loadPromptCommands } from './promptCommandCache';
import { filterPromptCommands, paramHint } from './slashPromptOptions';
import { INSERT_COMMAND_PILL_COMMAND } from './CommandPill/commands';
import { $slashAtDocumentStart } from './CommandPill/composerText';
import type { PromptCommandInfo } from '../../../../lib/promptLibraryIo';
```

- `toOptions` 增加第三个参数 `templates: readonly PromptCommandInfo[]`。生成 `option` 时，`extra` 改成：

```ts
        extra: [paramHint(c.name, templates), clampDesc(c.description)].filter(Boolean).join(' · ') || undefined,
```

- hook 签名改成 `export function useSlashOptions(workspace: string, clear: () => void, editor?: IEditor)`。
- `slashItems` 改成：

```ts
  const slashItems = useCallback(
    async (search: SlashSearch): Promise<ISlashOption[]> => {
      const [rawCommands, templates] = await Promise.all([
        workspace ? loadCommands(workspace) : Promise.resolve(getFrontendCommands()),
        loadPromptCommands(),
      ]);
      const query = search?.matchingString ?? '';
      const atStart =
        editor?.getLexicalEditor()?.getEditorState().read(() => $slashAtDocumentStart(query)) ?? true;
      const scoped = isConversation ? rawCommands.filter((command) => !command.name.startsWith('mcp__')) : rawCommands;
      return toOptions(filterPromptCommands(scoped, templates, atStart), query, templates);
    },
    [workspace, isConversation, editor],
  );
```

- `onSelect` 里，在 `editor.dispatchCommand(INSERT_CHAT_TAG_COMMAND, …)` 之前插入：

```ts
      if (meta.group === 'prompt') {
        const template = templatesRef.current.find((item) => item.name === meta.name && item.params.length > 0);
        if (template) {
          editor.dispatchCommand(INSERT_COMMAND_PILL_COMMAND, { name: template.name, params: template.params });
          return;
        }
      }
```

- hook 顶部加一个模板引用，`slashItems` 拿到模板后顺手写进去：

```ts
  const templatesRef = useRef<PromptCommandInfo[]>([]);
```

在 `slashItems` 里 `const [rawCommands, templates] = …` 之后加 `templatesRef.current = templates;`；`useRef` 加进 react 导入。

`MessageEditor.tsx`：`useSlashOptions(workspace, () => editor.cleanDocument())` 改成 `useSlashOptions(workspace, () => editor.cleanDocument(), editor)`。`MessageEditBox.tsx` 的同一调用同样补上第三个参数 `editor`。

- [ ] **步骤 6：接到粘贴**

`useCommandPaste.ts`：
- 新增导入 `loadPromptCommands`、`resolvePromptPill`、`INSERT_COMMAND_PILL_COMMAND`、`$caretAtDocumentStart`，以及 `import type { PromptCommandInfo } from '../../../../lib/promptLibraryIo';`。
- 加 `const templatesRef = useRef<PromptCommandInfo[]>([]);`，在已有的 `useEffect` 里同时预加载：`void loadPromptCommands().then((templates) => { if (!cancelled) templatesRef.current = templates; });`。
- `tryCommandPaste` 改成：

```ts
  const tryCommandPaste = useCallback(
    (text: string): boolean => {
      const pill = resolvePromptPill(templatesRef.current, text);
      const atStart = editor.getLexicalEditor()?.getEditorState().read($caretAtDocumentStart) ?? false;
      if (pill && atStart) {
        editor.dispatchCommand(INSERT_COMMAND_PILL_COMMAND, pill);
        return true;
      }
      const tag = resolveCommandTag(commandsRef.current, text);
      if (!tag) return false;
      editor.dispatchCommand(INSERT_CHAT_TAG_COMMAND, tag);
      return true;
    },
    [editor],
  );
```

- [ ] **步骤 7：跑相关单测**

运行：`cd electron-agent && npx vitest run src/features/chat/input/editor/ src/features/chat/MessageEditBox.test.tsx`
预期：PASS

- [ ] **步骤 8：Commit**

```bash
git add electron-agent/src/features/chat/input/editor/slashPromptOptions.ts electron-agent/src/features/chat/input/editor/slashPromptOptions.test.ts electron-agent/src/features/chat/input/editor/useSlashOptions.ts electron-agent/src/features/chat/input/editor/commandPaste.ts electron-agent/src/features/chat/input/editor/commandPaste.test.ts electron-agent/src/features/chat/input/editor/useCommandPaste.ts electron-agent/src/features/chat/input/editor/MessageEditor.tsx electron-agent/src/features/chat/MessageEditBox.tsx
git commit -m "feat(chat): 斜杠菜单和粘贴插入命令胶囊"
```

---

### 任务 13：气泡还原命令胶囊

**文件：**
- 修改：`electron-agent/src/features/chat/messageTags.tsx`
- 测试：`electron-agent/src/features/chat/messageTags.command.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../dock/browser/openBrowserPopupTab', () => ({ openBrowserPopupTab: vi.fn() }));
vi.mock('./input/editor/promptCommandCache', () => ({
  getCachedPromptCommands: () => [
    { name: 'refactor', description: '', body: '', params: [{ name: 'file' }, { name: 'style', defaultValue: 'fp' }], path: '' },
  ],
}));

import { buildCommandBlock } from '@extensions/prompt-commands/syntax';
import { parseMessageTags, renderMessageTags } from './messageTags';

const block = buildCommandBlock('refactor', [{ name: 'file', value: 'src/a.ts' }, { name: 'style', value: 'fp' }], '请把 src/a.ts 重构');

describe('command 段', () => {
  it('<command> 块整块变成胶囊，正文不出现，补充正文照常', () => {
    render(<span>{renderMessageTags(`${block}\n\n顺便看看 @src/b.ts`)}</span>);
    expect(screen.getByTestId('command-pill')).toHaveAttribute('data-command', 'refactor');
    expect(screen.queryByText(/请把 src\/a\.ts 重构/)).not.toBeInTheDocument();
    expect(screen.getByText(/顺便看看/)).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });

  it('刚发出去的调用文本也还原成胶囊，空参数显示默认值', () => {
    expect(parseMessageTags('/refactor "src/a.ts" "" 顺便')).toEqual([
      { type: 'command', name: 'refactor', args: [{ name: 'file', value: 'src/a.ts' }, { name: 'style', value: 'fp' }] },
      { type: 'text', text: ' 顺便' },
    ]);
  });

  it('不认识的命令和 args 坏掉的块按普通文本显示', () => {
    expect(parseMessageTags('/unknown "a"')).toEqual([{ type: 'text', text: '/unknown "a"' }]);
    const broken = '<command name="x" args="oops">\nbody\n</command>';
    expect(parseMessageTags(broken)).toEqual([{ type: 'text', text: broken }]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/chat/messageTags.command.test.tsx`
预期：FAIL，`getByTestId('command-pill')` 找不到元素

- [ ] **步骤 3：实现**

`messageTags.tsx` 改动：

1. 新增导入：

```ts
import { findCommandBlocks, parseInvocation, resolveArgs, splitArgs } from '@extensions/prompt-commands/syntax';
import { CommandPillView } from './input/editor/CommandPill/CommandPillView';
import { getCachedPromptCommands } from './input/editor/promptCommandCache';
```

2. `MessageSegment` 加一种：

```ts
  | { type: 'command'; name: string; args: Array<{ name: string; value: string }> };
```

3. 原来的 `parseMessageTags` 改名为 `parseSkillAndInline`（函数体不变），然后新增：

```ts
/** 刚发出去、还没被 <command> 块替换的 `/模板 "参数"…`：用缓存的模板定义还原成胶囊。 */
function parseOptimisticCommand(text: string, segments: MessageSegment[]): string {
  const invocation = parseInvocation(text);
  if (!invocation) return text;
  const template = getCachedPromptCommands().find((item) => item.name === invocation.name && item.params.length > 0);
  if (!template) return text;
  const { args, rest } = splitArgs(invocation.argsText, template.params.length);
  const { values } = resolveArgs(template.params, args);
  segments.push({
    type: 'command',
    name: template.name,
    args: template.params.map((param) => ({ name: param.name, value: values[param.name] ?? '' })),
  });
  return rest ? ` ${rest}` : '';
}

/**
 * 把用户消息文本切成普通文本、命令胶囊（<command> 块或刚发出的调用文本）、
 * 技能段（`/skill:` 或展开后的 `<skill>` 块）与文件引用段。
 */
export function parseMessageTags(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let last = 0;
  for (const hit of findCommandBlocks(text)) {
    if (!hit.block) continue;
    if (hit.start > last) segments.push(...parseSkillAndInline(text.slice(last, hit.start)));
    segments.push({ type: 'command', name: hit.block.name, args: hit.block.args });
    last = hit.end;
  }
  const tail = text.slice(last);
  const remaining = last === 0 ? parseOptimisticCommand(tail, segments) : tail;
  if (remaining) segments.push(...parseSkillAndInline(remaining));
  return segments;
}
```

`parseSkillAndInline` 是原 `parseMessageTags`，返回 `MessageSegment[]`，保持不导出。

4. `renderMessageTags` 的 map 里，在 `if (seg.type === 'file')` 之前加：

```tsx
    if (seg.type === 'command') {
      return <CommandPillView key={i} name={seg.name} args={seg.args} />;
    }
```

5. 补充正文以 `\n\n` 开头时，气泡用 `white-space: pre-wrap` 渲染，胶囊下面会空一行。处理办法：`parseMessageTags` 在 `segments.push({ type: 'command', … })` 之后、处理下一段之前，把紧跟块后的空行去掉。具体做法是把 `last = hit.end;` 改成：

```ts
    last = hit.end;
    while (text.startsWith('\n', last)) last += 1;
    if (last < text.length && last > hit.end) segments.push({ type: 'text', text: ' ' });
```

这样胶囊和补充正文之间只隔一个空格，和输入框里一致。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/chat/messageTags.command.test.tsx src/features/chat/messageTags.render.test.tsx src/features/chat/ChatMessageItems.test.tsx`
预期：PASS。如果第一个用例因为补充正文前多了空格段而断言失败，按实际输出核对：应该是 `[command, text(' '), text('顺便看看 '), file]` 这一类结构，`getByText(/顺便看看/)` 只依赖文字存在。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/chat/messageTags.tsx electron-agent/src/features/chat/messageTags.command.test.tsx
git commit -m "feat(chat): 气泡把 command 块还原成命令胶囊"
```

---

### 任务 14：命令表单校验和正文编辑器

**文件：**
- 创建：`electron-agent/src/features/extensions/commandDraft.ts`
- 测试：`electron-agent/src/features/extensions/commandDraft.test.ts`
- 创建：`electron-agent/src/features/extensions/PromptBodyEditor.tsx`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, expect, it } from 'vitest';
import { validateCommandDraft } from './commandDraft';

const reserved = new Set(['compact', 'skill:browser']);
const existing = new Set(['review']);

describe('validateCommandDraft', () => {
  it('合法时返回 null', () => {
    expect(validateCommandDraft({ name: 'refactor', description: '', body: 'x' }, reserved, existing)).toBeNull();
  });

  it('依次报：空名、非法名、保留名、重名、空正文', () => {
    expect(validateCommandDraft({ name: ' ', description: '', body: 'x' }, reserved, existing)).toBe('命令名不能为空');
    expect(validateCommandDraft({ name: 'a/b', description: '', body: 'x' }, reserved, existing)).toBe('命令名只能用字母、数字、中文、- 和 _，最长 64 个字符');
    expect(validateCommandDraft({ name: 'compact', description: '', body: 'x' }, reserved, existing)).toBe('/compact 和已有的内置、扩展或技能命令重名');
    expect(validateCommandDraft({ name: 'review', description: '', body: 'x' }, reserved, existing)).toBe('命令 /review 已存在');
    expect(validateCommandDraft({ name: 'a', description: '', body: ' ' }, reserved, existing)).toBe('提示词不能为空');
  });

  it('编辑自己时不算重名', () => {
    expect(validateCommandDraft({ originalName: 'review', name: 'review', description: '', body: 'x' }, reserved, existing)).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/extensions/commandDraft.test.ts`
预期：FAIL，报错 `Failed to resolve import "./commandDraft"`

- [ ] **步骤 3：实现**

`commandDraft.ts`：

```ts
import { COMMAND_NAME_RE } from '@extensions/prompt-commands/syntax';

export interface CommandDraft {
  originalName?: string;
  name: string;
  description: string;
  body: string;
}

export const EMPTY_COMMAND_DRAFT: CommandDraft = { name: '', description: '', body: '' };

/** 编辑区就地报错用；主进程保存时还会再校验一遍。 */
export function validateCommandDraft(
  draft: CommandDraft,
  reserved: ReadonlySet<string>,
  existing: ReadonlySet<string>,
): string | null {
  const name = draft.name.trim();
  if (!name) return '命令名不能为空';
  if (!COMMAND_NAME_RE.test(name)) return '命令名只能用字母、数字、中文、- 和 _，最长 64 个字符';
  if (reserved.has(name)) return `/${name} 和已有的内置、扩展或技能命令重名`;
  if (name !== draft.originalName && existing.has(name)) return `命令 /${name} 已存在`;
  if (!draft.body.trim()) return '提示词不能为空';
  return null;
}
```

`PromptBodyEditor.tsx`（背景层高亮占位符，前景是透明文字的 textarea，滚动同步）：

```tsx
import { createStaticStyles, cssVar } from 'antd-style';
import { useRef } from 'react';
import { tokenizePromptBody } from '@extensions/prompt-commands/syntax';

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    position: relative;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};

    &:focus-within {
      border-color: ${cssVar.colorPrimary};
    }
  `,
  layer: css`
    margin: 0;
    padding: 8px 10px;
    min-height: 160px;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12.5px;
    line-height: 1.7;
    white-space: pre-wrap;
    word-break: break-word;
  `,
  backdrop: css`
    position: absolute;
    inset: 0;
    overflow: hidden;
    color: ${cssVar.colorText};
    pointer-events: none;
  `,
  param: css`
    border-radius: 3px;
    color: ${cssVar.colorPrimary};
    background: color-mix(in srgb, ${cssVar.colorPrimary} 14%, transparent);
  `,
  textarea: css`
    position: relative;
    display: block;
    width: 100%;
    resize: vertical;
    border: 0;
    outline: none;
    color: transparent;
    caret-color: ${cssVar.colorText};
    background: transparent;
  `,
}));

/** 提示词编辑框：{参数} 在背景层高亮，前景 textarea 负责输入。 */
export function PromptBodyEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  return (
    <div className={styles.wrap}>
      <div ref={backdropRef} className={`${styles.layer} ${styles.backdrop}`} aria-hidden>
        {tokenizePromptBody(value).map((segment, index) =>
          segment.param ? (
            <mark key={index} className={styles.param}>{segment.text}</mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
        {/* 末尾换行时补一个字符，背景层高度才和 textarea 一致 */}
        {String.fromCharCode(0x200b)}
      </div>
      <textarea
        className={`${styles.layer} ${styles.textarea}`}
        data-testid="prompt-body-input"
        value={value}
        spellCheck={false}
        placeholder="用 {参数名} 留空，{参数名=默认值} 带默认"
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (backdropRef.current) backdropRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/extensions/commandDraft.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/extensions/commandDraft.ts electron-agent/src/features/extensions/commandDraft.test.ts electron-agent/src/features/extensions/PromptBodyEditor.tsx
git commit -m "feat(extensions): 命令表单校验与占位符高亮编辑框"
```

---

### 任务 15：命令页签 CommandsPanel

**文件：**
- 创建：`electron-agent/src/features/extensions/libraryStyles.ts`
- 创建：`electron-agent/src/features/extensions/CommandsPanel.tsx`
- 测试：`electron-agent/src/features/extensions/CommandsPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';

const io = vi.hoisted(() => ({
  listPromptCommands: vi.fn(),
  savePromptCommand: vi.fn(),
  deletePromptCommand: vi.fn(),
}));
vi.mock('../../lib/promptLibraryIo', () => io);
vi.mock('../chat/input/editor/commandLoader', () => ({
  loadCommands: vi.fn(async () => [
    { name: 'compact', source: 'frontend' },
    { name: 'goal', source: 'api', apiSource: 'extension' },
    { name: 'refactor', source: 'api', apiSource: 'prompt' },
  ]),
}));
vi.mock('../chat/input/editor/promptCommandCache', () => ({ invalidatePromptCommands: vi.fn() }));

import { CommandsPanel } from './CommandsPanel';

vi.setConfig({ testTimeout: 45000 });

const refactor = { name: 'refactor', description: '重构', body: '改 {file}', params: [{ name: 'file' }], path: '/p/refactor.md' };

function renderPanel(onResourcesChanged = vi.fn()) {
  render(
    <ThemeProvider>
      <App>
        <CommandsPanel workspace="/ws" onResourcesChanged={onResourcesChanged} />
      </App>
    </ThemeProvider>,
  );
  return onResourcesChanged;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CommandsPanel', () => {
  it('列出命令并显示参数个数，选中后编辑区填好', async () => {
    io.listPromptCommands.mockResolvedValue([refactor]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('command-item-refactor')).toBeInTheDocument());
    expect(screen.getByTestId('command-item-refactor')).toHaveTextContent('1 参数');
    fireEvent.click(screen.getByTestId('command-item-refactor'));
    expect(screen.getByTestId('command-name-input')).toHaveValue('refactor');
    expect(screen.getByTestId('command-detected-params')).toHaveTextContent('file');
  });

  it('新建时提示词里的参数实时识别，保存时带上保留名并通知重载', async () => {
    io.listPromptCommands.mockResolvedValue([]);
    io.savePromptCommand.mockResolvedValue({ ...refactor, name: 'fix' });
    const changed = renderPanel();
    await waitFor(() => expect(screen.getByTestId('command-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('command-new'));
    fireEvent.change(screen.getByTestId('command-name-input'), { target: { value: 'fix' } });
    fireEvent.change(screen.getByTestId('prompt-body-input'), { target: { value: '修 {bug=all}' } });
    expect(screen.getByTestId('command-detected-params')).toHaveTextContent('bug');
    expect(screen.getByTestId('command-detected-params')).toHaveTextContent('默认 all');
    fireEvent.click(screen.getByTestId('command-save'));
    await waitFor(() => expect(io.savePromptCommand).toHaveBeenCalled());
    expect(io.savePromptCommand.mock.calls[0][0]).toMatchObject({ name: 'fix', body: '修 {bug=all}', reserved: ['compact', 'goal'] });
    expect(changed).toHaveBeenCalled();
  });

  it('和保留名重名时就地报错且不能保存', async () => {
    io.listPromptCommands.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('command-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('command-new'));
    fireEvent.change(screen.getByTestId('command-name-input'), { target: { value: 'goal' } });
    fireEvent.change(screen.getByTestId('prompt-body-input'), { target: { value: 'x' } });
    await waitFor(() => expect(screen.getByTestId('command-error')).toHaveTextContent('/goal 和已有的内置、扩展或技能命令重名'));
    expect(screen.getByTestId('command-save')).toBeDisabled();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/extensions/CommandsPanel.test.tsx`
预期：FAIL，报错 `Failed to resolve import "./CommandsPanel"`

- [ ] **步骤 3：实现共用样式 `libraryStyles.ts`**

```ts
import { createStaticStyles, cssVar } from 'antd-style';

/** 命令页签和规则页签共用：左列表、右编辑。 */
export const libraryStyles = createStaticStyles(({ css }) => ({
  heroBar: css`
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    margin-block-end: 8px;
  `,
  heroTitle: css`
    font-size: 17px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  desc: css`
    margin-block: 0 14px;
    font-size: 13px;
    line-height: 1.55;
    color: ${cssVar.colorTextSecondary};
  `,
  split: css`
    display: flex;
    min-height: 420px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
  `,
  list: css`
    display: flex;
    flex: 0 0 42%;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  item: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    text-align: start;
    color: ${cssVar.colorText};
    background: transparent;
    cursor: pointer;

    &[data-active='true'] {
      background: ${cssVar.colorFillSecondary};
    }

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  badge: css`
    margin-inline-start: auto;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
    background: ${cssVar.colorFillTertiary};
  `,
  edit: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    padding: 14px 16px;
  `,
  label: css`
    margin-block-end: 4px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  error: css`
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
  empty: css`
    padding: 32px 0;
    font-size: 12px;
    text-align: center;
    color: ${cssVar.colorTextTertiary};
  `,
}));
```

- [ ] **步骤 4：实现 `CommandsPanel.tsx`**

```tsx
import { Button, Flexbox } from '@lobehub/ui';
import { App, Input, Popconfirm } from 'antd';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parsePromptParams } from '@extensions/prompt-commands/syntax';
import { deletePromptCommand, listPromptCommands, savePromptCommand, type PromptCommandInfo } from '../../lib/promptLibraryIo';
import { loadCommands } from '../chat/input/editor/commandLoader';
import { invalidatePromptCommands } from '../chat/input/editor/promptCommandCache';
import { CommandPillView } from '../chat/input/editor/CommandPill/CommandPillView';
import { EMPTY_COMMAND_DRAFT, validateCommandDraft, type CommandDraft } from './commandDraft';
import { libraryStyles as styles } from './libraryStyles';
import { PromptBodyEditor } from './PromptBodyEditor';

interface CommandsPanelProps {
  workspace: string;
  /** 模板文件变了：让会话重载资源，新命令才会出现在 Pi 的命令表里。 */
  onResourcesChanged: () => void;
}

function draftOf(command: PromptCommandInfo): CommandDraft {
  return { originalName: command.name, name: command.name, description: command.description, body: command.body };
}

export function CommandsPanel({ workspace, onResourcesChanged }: CommandsPanelProps) {
  const { message } = App.useApp();
  const [commands, setCommands] = useState<PromptCommandInfo[]>([]);
  const [reserved, setReserved] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      setCommands(await listPromptCommands());
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }, [message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void loadCommands(workspace).then((list) => {
      if (cancelled) return;
      setReserved(new Set(list.filter((command) => command.apiSource !== 'prompt').map((command) => command.name)));
    });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const existing = useMemo(() => new Set(commands.map((command) => command.name)), [commands]);
  const error = draft ? validateCommandDraft(draft, reserved, existing) : null;
  const params = draft ? parsePromptParams(draft.body) : [];

  const afterChange = async () => {
    invalidatePromptCommands();
    await reload();
    onResourcesChanged();
  };

  const save = async () => {
    if (!draft || error) return;
    setSaving(true);
    try {
      const saved = await savePromptCommand({ ...draft, reserved: [...reserved] });
      setDraft(draftOf(saved));
      await afterChange();
      message.success(`已保存 /${saved.name}`);
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.originalName) return;
    await deletePromptCommand(draft.originalName);
    setDraft(null);
    await afterChange();
  };

  return (
    <>
      <div className={styles.heroBar}>
        <span className={styles.heroTitle}>命令</span>
        <Button type="primary" size="small" icon={<Plus size={14} />} data-testid="command-new" onClick={() => setDraft({ ...EMPTY_COMMAND_DRAFT })}>
          新建
        </Button>
      </div>
      <div className={styles.desc}>全局命令保存在 ~/.pi/agent/prompts，在输入框打 / 选用。</div>
      <div className={styles.split}>
        <div className={styles.list} data-testid="command-list">
          {commands.length === 0 ? <div className={styles.empty}>还没有命令</div> : null}
          {commands.map((command) => (
            <button
              key={command.name}
              type="button"
              className={styles.item}
              data-testid={`command-item-${command.name}`}
              data-active={draft?.originalName === command.name}
              title={command.error}
              onClick={() => setDraft(draftOf(command))}
            >
              <CommandPillView name={command.name} args={[]} />
              {command.params.length > 0 ? <span className={styles.badge}>{command.params.length} 参数</span> : null}
            </button>
          ))}
        </div>
        <div className={styles.edit}>
          {draft ? (
            <>
              <div>
                <div className={styles.label}>命令名（即文件名）</div>
                <Input data-testid="command-name-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </div>
              <div>
                <div className={styles.label}>描述（菜单里显示）</div>
                <Input data-testid="command-description-input" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
              </div>
              <div>
                <div className={styles.label}>提示词</div>
                <PromptBodyEditor value={draft.body} onChange={(body) => setDraft({ ...draft, body })} />
              </div>
              <div data-testid="command-detected-params">
                <div className={styles.label}>识别到的参数</div>
                {params.length === 0 ? '无' : params.map((param, index) => (
                  <span key={param.name} style={{ marginInlineEnd: 8 }}>
                    {index + 1}. {param.name}
                    {param.defaultValue !== undefined ? `（默认 ${param.defaultValue}）` : ''}
                  </span>
                ))}
              </div>
              {error ? <div className={styles.error} data-testid="command-error">{error}</div> : null}
              <Flexbox horizontal gap={8}>
                <Button type="primary" size="small" data-testid="command-save" disabled={Boolean(error)} loading={saving} onClick={() => void save()}>
                  保存
                </Button>
                {draft.originalName ? (
                  <Popconfirm title={`删除 /${draft.originalName}？`} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void remove()}>
                    <Button size="small" danger data-testid="command-delete">删除</Button>
                  </Popconfirm>
                ) : null}
              </Flexbox>
            </>
          ) : (
            <div className={styles.empty}>选一条命令，或点「新建」</div>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/extensions/CommandsPanel.test.tsx`
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add electron-agent/src/features/extensions/libraryStyles.ts electron-agent/src/features/extensions/CommandsPanel.tsx electron-agent/src/features/extensions/CommandsPanel.test.tsx
git commit -m "feat(extensions): 命令页签"
```

---

### 任务 16：规则页签 RulesPanel

**文件：**
- 创建：`electron-agent/src/features/extensions/RulesPanel.tsx`
- 测试：`electron-agent/src/features/extensions/RulesPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';

const io = vi.hoisted(() => ({
  listContextRules: vi.fn(),
  saveContextRule: vi.fn(),
  setContextRuleEnabled: vi.fn(),
  deleteContextRule: vi.fn(),
}));
vi.mock('../../lib/promptLibraryIo', () => io);

import { RulesPanel } from './RulesPanel';

vi.setConfig({ testTimeout: 45000 });

const rules = [
  { id: 'zh', scope: 'global', path: '/g/zh.md', title: '中文回答', enabled: true, body: '- 中文' },
  { id: 'pnpm', scope: 'project', path: '/w/pnpm.md', title: '用 pnpm', enabled: false, body: '- pnpm' },
  { id: 'bad', scope: 'global', path: '/g/bad.md', title: 'bad', enabled: false, body: '', error: 'YAML 错误' },
];

function renderPanel(workspace = '/ws') {
  render(
    <ThemeProvider>
      <App>
        <RulesPanel workspace={workspace} />
      </App>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RulesPanel', () => {
  it('列出规则，按范围筛选', async () => {
    io.listContextRules.mockResolvedValue(rules);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-item-global-zh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-filter-project'));
    expect(screen.queryByTestId('rule-item-global-zh')).not.toBeInTheDocument();
    expect(screen.getByTestId('rule-item-project-pnpm')).toBeInTheDocument();
  });

  it('开关立即写盘', async () => {
    io.listContextRules.mockResolvedValue(rules);
    io.setContextRuleEnabled.mockResolvedValue(undefined);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-toggle-project-pnpm')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-toggle-project-pnpm'));
    await waitFor(() => expect(io.setContextRuleEnabled).toHaveBeenCalledWith('/ws', { scope: 'project', id: 'pnpm' }, true));
  });

  it('坏文件标警告且开关不可用', async () => {
    io.listContextRules.mockResolvedValue(rules);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-warning-global-bad')).toBeInTheDocument());
    expect(screen.getByTestId('rule-toggle-global-bad')).toBeDisabled();
  });

  it('新建规则保存到所选范围', async () => {
    io.listContextRules.mockResolvedValue([]);
    io.saveContextRule.mockResolvedValue(rules[0]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-new'));
    fireEvent.change(screen.getByTestId('rule-title-input'), { target: { value: '中文回答' } });
    fireEvent.change(screen.getByTestId('rule-body-input'), { target: { value: '- 中文' } });
    fireEvent.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(io.saveContextRule).toHaveBeenCalledWith({
      workspace: '/ws', scope: 'global', original: undefined, title: '中文回答', enabled: true, body: '- 中文',
    }));
  });

  it('没有工作区时项目范围不可选', async () => {
    io.listContextRules.mockResolvedValue([]);
    renderPanel('');
    await waitFor(() => expect(screen.getByTestId('rule-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-new'));
    expect(screen.getByTestId('rule-scope-project')).toHaveAttribute('aria-disabled', 'true');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/extensions/RulesPanel.test.tsx`
预期：FAIL，报错 `Failed to resolve import "./RulesPanel"`

- [ ] **步骤 3：实现**

```tsx
import { Button, Flexbox } from '@lobehub/ui';
import { App, Input, Popconfirm, Segmented, Switch, Tooltip } from 'antd';
import { Plus, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  deleteContextRule,
  listContextRules,
  saveContextRule,
  setContextRuleEnabled,
  type RuleInfo,
  type RuleRef,
  type RuleScope,
} from '../../lib/promptLibraryIo';
import { libraryStyles as styles } from './libraryStyles';

type Filter = 'all' | RuleScope;

interface RuleDraft {
  original?: RuleRef;
  scope: RuleScope;
  title: string;
  enabled: boolean;
  body: string;
}

const SCOPE_LABEL: Record<RuleScope, string> = { global: '全局', project: '项目' };

function draftOf(rule: RuleInfo): RuleDraft {
  return { original: { scope: rule.scope, id: rule.id }, scope: rule.scope, title: rule.title, enabled: rule.enabled, body: rule.body };
}

function sameRule(draft: RuleDraft | null, rule: RuleInfo): boolean {
  return draft?.original?.scope === rule.scope && draft.original.id === rule.id;
}

export function RulesPanel({ workspace }: { workspace: string }) {
  const { message } = App.useApp();
  const [rules, setRules] = useState<RuleInfo[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [draft, setDraft] = useState<RuleDraft | null>(null);

  const report = useCallback((error: unknown) => {
    message.error(error instanceof Error ? error.message : String(error));
  }, [message]);

  const reload = useCallback(async () => {
    try {
      setRules(await listContextRules(workspace));
    } catch (error) {
      report(error);
    }
  }, [workspace, report]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (rule: RuleInfo, enabled: boolean) => {
    try {
      await setContextRuleEnabled(workspace, { scope: rule.scope, id: rule.id }, enabled);
      await reload();
    } catch (error) {
      report(error);
    }
  };

  const save = async () => {
    if (!draft) return;
    try {
      const saved = await saveContextRule({ workspace, ...draft });
      setDraft(draftOf(saved));
      await reload();
    } catch (error) {
      report(error);
    }
  };

  const remove = async () => {
    if (!draft?.original) return;
    try {
      await deleteContextRule(workspace, draft.original);
      setDraft(null);
      await reload();
    } catch (error) {
      report(error);
    }
  };

  const visible = rules.filter((rule) => filter === 'all' || rule.scope === filter);
  const canSave = Boolean(draft && draft.title.trim() && draft.body.trim() && (draft.scope === 'global' || workspace));

  return (
    <>
      <div className={styles.heroBar}>
        <span className={styles.heroTitle}>规则</span>
        <Button type="primary" size="small" icon={<Plus size={14} />} data-testid="rule-new" onClick={() => setDraft({ scope: 'global', title: '', enabled: true, body: '' })}>
          新建
        </Button>
      </div>
      <div className={styles.desc}>
        启用的规则在每次发送时放进上下文。全局规则在 ~/.pi/agent/rules，项目规则在工作区的 .pi/rules。Pi 自己还会读 AGENTS.md / CLAUDE.md，这里不管它们。
      </div>
      <div className={styles.split}>
        <div className={styles.list}>
          <Segmented<Filter>
            size="small"
            value={filter}
            onChange={setFilter}
            options={[
              { label: <span data-testid="rule-filter-all">全部</span>, value: 'all' },
              { label: <span data-testid="rule-filter-global">全局</span>, value: 'global' },
              { label: <span data-testid="rule-filter-project">项目</span>, value: 'project' },
            ]}
          />
          {visible.length === 0 ? <div className={styles.empty}>还没有规则</div> : null}
          {visible.map((rule) => {
            const key = `${rule.scope}-${rule.id}`;
            return (
              <div key={key} className={styles.item} data-testid={`rule-item-${key}`} data-active={sameRule(draft, rule)} onClick={() => setDraft(draftOf(rule))}>
                <span onClick={(event) => event.stopPropagation()}>
                  <Switch size="small" checked={rule.enabled} disabled={Boolean(rule.error)} data-testid={`rule-toggle-${key}`} onChange={(checked) => void toggle(rule, checked)} />
                </span>
                <span>{rule.title}</span>
                {rule.error ? (
                  <Tooltip title={rule.error}>
                    <TriangleAlert size={14} data-testid={`rule-warning-${key}`} />
                  </Tooltip>
                ) : null}
                <span className={styles.badge}>{SCOPE_LABEL[rule.scope]}</span>
              </div>
            );
          })}
        </div>
        <div className={styles.edit}>
          {draft ? (
            <>
              <div>
                <div className={styles.label}>名称</div>
                <Input data-testid="rule-title-input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              </div>
              <div>
                <div className={styles.label}>范围</div>
                <Segmented<RuleScope>
                  size="small"
                  value={draft.scope}
                  onChange={(scope) => setDraft({ ...draft, scope })}
                  options={[
                    { label: <span data-testid="rule-scope-global">全局</span>, value: 'global' },
                    {
                      label: (
                        <Tooltip title={workspace ? undefined : '先打开工作区'}>
                          <span data-testid="rule-scope-project" aria-disabled={!workspace}>项目</span>
                        </Tooltip>
                      ),
                      value: 'project',
                      disabled: !workspace,
                    },
                  ]}
                />
              </div>
              <div>
                <div className={styles.label}>规则内容（Markdown，启用时每轮注入上下文）</div>
                <Input.TextArea data-testid="rule-body-input" autoSize={{ minRows: 6, maxRows: 18 }} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
              </div>
              <Flexbox horizontal gap={8}>
                <Button type="primary" size="small" data-testid="rule-save" disabled={!canSave} onClick={() => void save()}>保存</Button>
                {draft.original ? (
                  <Popconfirm title="删除这条规则？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void remove()}>
                    <Button size="small" danger data-testid="rule-delete">删除</Button>
                  </Popconfirm>
                ) : null}
              </Flexbox>
            </>
          ) : (
            <div className={styles.empty}>选一条规则，或点「新建」</div>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/extensions/RulesPanel.test.tsx`
预期：PASS。如果 antd `Switch` 在 jsdom 里 `toBeDisabled` 判断失败（它渲染成 `button[disabled]`，按理会通过），改为断言 `toHaveClass('ant-switch-disabled')`。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/extensions/RulesPanel.tsx electron-agent/src/features/extensions/RulesPanel.test.tsx
git commit -m "feat(extensions): 规则页签"
```

---

### 任务 17：扩展面板加两个页签

**文件：**
- 修改：`electron-agent/src/features/extensions/ExtensionsPanel.tsx:3, 13-14, 164, 322-345`
- 测试：`electron-agent/src/features/extensions/ExtensionsPanel.test.tsx`（追加用例）

- [ ] **步骤 1：编写失败的测试**

在 `ExtensionsPanel.test.tsx` 顶部的 mock 区加：

```ts
vi.mock('./CommandsPanel', () => ({ CommandsPanel: () => <div data-testid="commands-panel" /> }));
vi.mock('./RulesPanel', () => ({ RulesPanel: () => <div data-testid="rules-panel" /> }));
```

在已有的 `describe('ExtensionsPanel', …)` 里追加（和该文件其他用例一样，先 mock `getSettings` 再直接 `render(<ExtensionsPanel />)`）：

```tsx
  it('有命令和规则两个页签', async () => {
    getSettings.mockResolvedValueOnce({});
    render(<ExtensionsPanel />);
    fireEvent.click(await screen.findByTestId('ext-tab-commands'));
    expect(screen.getByTestId('commands-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ext-tab-rules'));
    expect(screen.getByTestId('rules-panel')).toBeInTheDocument();
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd electron-agent && npx vitest run src/features/extensions/ExtensionsPanel.test.tsx`
预期：FAIL，找不到 `ext-tab-commands`

- [ ] **步骤 3：实现**

- `lucide-react` 导入改成 `import { BookCheck, Package, Plus, ScrollText, Server, Sparkles, SquareSlash } from 'lucide-react';`。
- 导入 `import { CommandsPanel } from './CommandsPanel';` 和 `import { RulesPanel } from './RulesPanel';`。
- `useState<'mcp' | 'packages' | 'skills'>('mcp')` 改成 `useState<'mcp' | 'packages' | 'skills' | 'commands' | 'rules'>('mcp')`。
- 组件里加：

```ts
  const bumpResources = () => {
    setValue('PI_RELOAD_REV', String(Date.now()));
    markChanged();
  };
```

- 技能页签按钮后加：

```tsx
          <button type="button" className={`${styles.tab} ${tab === 'commands' ? styles.tabActive : ''}`} data-testid="ext-tab-commands" onClick={() => setTab('commands')}>
            <Icon icon={SquareSlash} size={15} />
            命令
          </button>
          <button type="button" className={`${styles.tab} ${tab === 'rules' ? styles.tabActive : ''}`} data-testid="ext-tab-rules" onClick={() => setTab('rules')}>
            <Icon icon={BookCheck} size={15} />
            规则
          </button>
```

- 内容区的条件链 `{tab === 'skills' ? (…) : tab === 'packages' ? (…) : <>…</>}` 前面插两个分支：

```tsx
          {tab === 'commands' ? (
            <CommandsPanel workspace={workspace} onResourcesChanged={bumpResources} />
          ) : tab === 'rules' ? (
            <RulesPanel workspace={workspace} />
          ) : tab === 'skills' ? (
```

（原来的 `tab === 'skills'` 分支及之后保持不变。）

- [ ] **步骤 4：运行测试验证通过**

运行：`cd electron-agent && npx vitest run src/features/extensions/`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/src/features/extensions/ExtensionsPanel.tsx electron-agent/src/features/extensions/ExtensionsPanel.test.tsx
git commit -m "feat(extensions): 扩展面板加命令和规则页签"
```

---

### 任务 18：ui-harness 场景 command-pill

**文件：**
- 创建：`electron-agent/ui-harness/scenarios/command-pill.tsx`
- 创建：`electron-agent/ui-harness/probes/command-pill.mjs`

- [ ] **步骤 1：写场景**

```tsx
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Editor, useEditor } from '@lobehub/editor/react'
import { buildCommandBlock } from '@extensions/prompt-commands/syntax'
import ReactChatTagPlugin from '../../src/features/chat/input/editor/ChatTag/ReactChatTagPlugin'
import ReactCommandPillPlugin from '../../src/features/chat/input/editor/CommandPill/ReactCommandPillPlugin'
import { CommandPillHostContext } from '../../src/features/chat/input/editor/CommandPill/hostContext'
import { INSERT_COMMAND_PILL_COMMAND } from '../../src/features/chat/input/editor/CommandPill/commands'
import { focusMissingPillArg, readComposerText } from '../../src/features/chat/input/editor/CommandPill/composerText'
import { loadPromptCommands } from '../../src/features/chat/input/editor/promptCommandCache'
import { renderMessageTags } from '../../src/features/chat/messageTags'
import { exposeActions, exposeData, installBridge, track } from '../stubs'

/**
 * 命令胶囊：真实 lobehub Editor + CommandPill 插件。插入走 INSERT_COMMAND_PILL_COMMAND（和斜杠菜单 onSelect 同一条命令），
 * 发送走 readComposerText，拦截走 focusMissingPillArg。下面三个气泡：command 块、刚发出的调用文本、无参数命令后跟正文。
 */

const REFACTOR = {
  name: 'refactor',
  description: '按指定风格重构文件',
  body: '请把 {file} 重构成 {style=functional} 风格。',
  params: [{ name: 'file' }, { name: 'style', defaultValue: 'functional' }],
  path: '/agent/prompts/refactor.md'
}

installBridge({
  invoke: async (command: string) => {
    if (command === 'list_prompt_commands') return [REFACTOR]
    throw new Error(`unstubbed invoke: ${command}`)
  }
})

const BLOCK = buildCommandBlock(
  'refactor',
  [{ name: 'file', value: 'src/a.ts' }, { name: 'style', value: 'functional' }],
  '请把 src/a.ts 重构成 functional 风格。'
)

exposeData({ blockBody: '请把 src/a.ts 重构成 functional 风格。' })

const bubble = { alignSelf: 'flex-end', maxWidth: '80%', padding: '8px 12px', borderRadius: 14, background: 'var(--ant-color-fill-secondary)', whiteSpace: 'pre-wrap' } as const

export default function CommandPillScenario(): ReactElement {
  const editor = useEditor()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void loadPromptCommands().then(() => setReady(true))
  }, [])

  const host = useMemo(() => ({
    submit: () => {
      if (focusMissingPillArg(editor.getLexicalEditor())) {
        track('blocked')
        return
      }
      track(`send:${readComposerText(editor)}`)
    }
  }), [editor])

  useEffect(() => {
    exposeActions({
      insertRefactor: () => {
        editor.focus()
        editor.dispatchCommand(INSERT_COMMAND_PILL_COMMAND, { name: REFACTOR.name, params: REFACTOR.params })
      },
      clear: () => editor.cleanDocument()
    })
  }, [editor])

  return (
    <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, display: 'flex', flexDirection: 'column', gap: 16, background: 'var(--gren-content-bg)' }}>
      <CommandPillHostContext.Provider value={host}>
        <div data-testid="composer" style={{ minHeight: 72, padding: 12, borderRadius: 12, border: '1px solid var(--ant-color-border-secondary)' }}>
          <Editor
            editor={editor}
            content=""
            type="text"
            variant="chat"
            plugins={[ReactChatTagPlugin, ReactCommandPillPlugin]}
            onPressEnter={({ event }) => {
              if (event.shiftKey || event.isComposing) return
              event.preventDefault()
              host.submit()
              return true
            }}
          />
        </div>
      </CommandPillHostContext.Provider>
      {ready ? (
        <>
          <div data-testid="bubble-block" style={bubble}>{renderMessageTags(`${BLOCK}\n\n顺便加测试`)}</div>
          <div data-testid="bubble-optimistic" style={bubble}>{renderMessageTags('/refactor "src/b.ts" ""')}</div>
          <div data-testid="bubble-plain" style={bubble}>{renderMessageTags('/review 顺便看看错误处理')}</div>
        </>
      ) : null}
    </div>
  )
}
```

- [ ] **步骤 2：写 probe**

```js
/**
 * 命令胶囊：插入后焦点在第一个参数；Tab / Shift+Tab 轮转并能跳出；空参数 Backspace 回退、第一个参数里删整个胶囊；
 * 必填参数空着时 Enter 不发送、焦点回到缺的参数、描边变红；填好后发送的是调用文本（空参数发 ""）；
 * 气泡：command 块整块成胶囊、正文不出现；刚发出的调用文本也成胶囊、空参数显示默认值；浅色主题下命令名是紫色。
 */

const COMPOSER = '[data-testid="composer"] [contenteditable]'
const PILL = '[data-testid="composer"] [data-testid="command-pill"]'
const ARG = (name) => `${PILL} input[data-arg-name="${name}"]`
const ACTIVE = 'document.activeElement?.dataset?.argName ?? document.activeElement?.getAttribute("contenteditable")'

export default async function (t) {
  t.ok('输入框渲染出来', await t.waitFor(COMPOSER))
  await t.click(COMPOSER, 20)

  // —— 插入：焦点落在第一个参数 ——
  await t.act('insertRefactor')
  t.ok('胶囊插入', await t.waitFor(PILL))
  t.check('插入后焦点在 file', await t.js(ACTIVE), 'file')
  t.check('style 空着时占位显示默认值', await t.js(`document.querySelector(${JSON.stringify(ARG('style'))}).placeholder`), 'functional')
  await t.shot('inserted')

  // —— 必填空着：拦下发送 ——
  await t.key('Enter')
  t.check('file 空着时 Enter 被拦下', (await t.events()).at(-1), 'blocked')
  t.check('拦下后焦点仍在 file', await t.js(ACTIVE), 'file')
  t.check('缺的参数标红', await t.js(`document.querySelector(${JSON.stringify(ARG('file'))}).closest('[data-invalid]').dataset.invalid`), 'true')

  // —— 填值、Tab 轮转 ——
  await t.type('src/a.ts')
  await t.key('Tab')
  t.check('Tab 到 style', await t.js(ACTIVE), 'style')
  await t.key('Tab', ['shift'])
  t.check('Shift+Tab 回到 file', await t.js(ACTIVE), 'file')
  t.check('值写回节点', await t.js(`document.querySelector(${JSON.stringify(ARG('file'))}).value`), 'src/a.ts')
  await t.key('Tab')
  await t.key('Tab')
  t.check('最后一个参数上 Tab 跳出胶囊', await t.js(ACTIVE), 'true')
  await t.type('more')

  // —— 发送 ——
  await t.key('Enter')
  t.check('发送的是调用文本加补充正文', (await t.events()).at(-1), 'send:/refactor "src/a.ts" "" more')

  // —— Backspace：空参数回退，第一个参数里删胶囊 ——
  await t.act('clear')
  await t.click(COMPOSER, 20)
  await t.act('insertRefactor')
  await t.waitFor(PILL)
  await t.key('Tab')
  t.check('先到 style', await t.js(ACTIVE), 'style')
  await t.key('Backspace')
  t.check('空的 style 里 Backspace 回到 file', await t.js(ACTIVE), 'file')
  await t.key('Backspace')
  t.check('空的 file 里 Backspace 删掉胶囊', await t.count(PILL), 0)

  // —— 气泡 ——
  t.ok('气泡渲染出来', await t.waitFor('[data-testid="bubble-block"] [data-testid="command-pill"]'))
  const blockText = await t.text('[data-testid="bubble-block"]')
  const { blockBody } = await t.data()
  t.ok('command 块正文不出现在气泡里', !blockText.includes(blockBody))
  t.ok('command 块后的补充正文还在', blockText.includes('顺便加测试'))
  t.check('刚发出的调用文本也成胶囊', await t.count('[data-testid="bubble-optimistic"] [data-testid="command-pill"]'), 1)
  t.ok('空参数显示默认值', (await t.text('[data-testid="bubble-optimistic"]')).includes('functional'))
  t.check('没有参数模板的 /review 不成胶囊', await t.count('[data-testid="bubble-plain"] [data-testid="command-pill"]'), 0)
  await t.shot('bubbles-dark')

  // —— 浅色主题 ——
  await t.setTheme('light')
  const color = await t.style('[data-testid="bubble-block"] [data-testid="command-pill"] > span:first-child', ['color'])
  const purple = await t.js(`getComputedStyle(document.documentElement).getPropertyValue('--ant-purple').trim() || getComputedStyle(document.documentElement).getPropertyValue('--ant-color-purple').trim()`)
  t.info('浅色主题命令名颜色', color.color)
  t.ok('浅色主题能读到紫色变量', Boolean(purple))
  await t.shot('bubbles-light')
}
```

- [ ] **步骤 3：跑场景**

运行：`cd electron-agent && npm run ui:check -- command-pill > ui-check.log 2>&1; tail -40 ui-check.log`
预期：全部 PASS，退出码 0。

排查顺序（AGENTS.md「断言的坑」）：
- 焦点断言失败、输入没进参数 → 先确认 `CommandPillEditor` 的原生监听真的挂在胶囊 span 上：`await t.js('document.querySelector("[data-command-pill]") !== null')`。
- Enter 直接发出去了、没被胶囊处理 → 说明 keydown 冒泡到了 Lexical 根节点，检查 `onKeyDown` 第一行是不是 `event.stopPropagation()`。
- 颜色断言：`--ant-purple` 变量名以 `HarnessRoot` 实际注入的为准，用 `checkColor` 对比前先 `t.info` 打出来再定。

- [ ] **步骤 4：Commit**

```bash
git add electron-agent/ui-harness/scenarios/command-pill.tsx electron-agent/ui-harness/probes/command-pill.mjs
git commit -m "test(ui-harness): command-pill 场景"
```

---

### 任务 19：ui-harness 场景 prompt-library-panel

**文件：**
- 创建：`electron-agent/ui-harness/scenarios/prompt-library-panel.tsx`
- 创建：`electron-agent/ui-harness/probes/prompt-library-panel.mjs`

- [ ] **步骤 1：写场景**

```tsx
import { useState, type ReactElement } from 'react'
import { App } from 'antd'
import { CommandsPanel } from '../../src/features/extensions/CommandsPanel'
import { RulesPanel } from '../../src/features/extensions/RulesPanel'
import { exposeActions, installBridge, track } from '../stubs'

/**
 * 命令 / 规则两个页签：真实组件，主进程命令用桩（数据在内存里改）。
 * workspace 可以通过 probe 切成空串，看项目范围置灰。
 */

let commands = [
  { name: 'refactor', description: '按指定风格重构文件', body: '请把 {file} 重构成 {style=functional} 风格。', params: [{ name: 'file' }, { name: 'style', defaultValue: 'functional' }], path: '/a/prompts/refactor.md' }
]
let rules = [
  { id: 'zh', scope: 'global', path: '/a/rules/zh.md', title: '中文回答', enabled: true, body: '- 中文' },
  { id: 'pnpm', scope: 'project', path: '/w/.pi/rules/pnpm.md', title: '用 pnpm', enabled: false, body: '- pnpm' }
]

installBridge({
  invoke: async (command: string, args: Record<string, unknown>) => {
    track(command)
    switch (command) {
      case 'list_prompt_commands': return commands
      case 'agent_get_commands': return [{ name: 'goal', source: 'extension' }, { name: 'refactor', source: 'prompt' }]
      case 'save_prompt_command': {
        const saved = { name: String(args.name), description: String(args.description), body: String(args.body), params: [], path: '' }
        commands = [...commands.filter((c) => c.name !== args.originalName && c.name !== args.name), saved]
        return saved
      }
      case 'list_context_rules': return rules
      case 'set_context_rule_enabled':
        rules = rules.map((r) => (r.scope === args.scope && r.id === args.id ? { ...r, enabled: Boolean(args.enabled) } : r))
        return undefined
      default: throw new Error(`unstubbed invoke: ${command}`)
    }
  }
})

export default function PromptLibraryPanelScenario(): ReactElement {
  const [workspace, setWorkspace] = useState('/w')
  exposeActions({ setWorkspace })
  return (
    <App>
      <div style={{ height: '100vh', boxSizing: 'border-box', padding: 24, overflow: 'auto', background: 'var(--gren-content-bg)' }}>
        <div data-testid="commands-area"><CommandsPanel workspace={workspace} onResourcesChanged={() => track('resources-changed')} /></div>
        <div data-testid="rules-area" style={{ marginTop: 24 }}><RulesPanel key={workspace} workspace={workspace} /></div>
      </div>
    </App>
  )
}
```

- [ ] **步骤 2：写 probe**

```js
/**
 * 命令页签：列表项是命令胶囊、带参数个数；选中后编辑区填好；改提示词时识别到的参数实时变；与保留名重名时就地报错、保存不可点。
 * 规则页签：开关立即写盘；按范围筛选；没有工作区时项目范围置灰。
 */

export default async function (t) {
  t.ok('命令列表渲染', await t.waitFor('[data-testid="command-item-refactor"]'))
  t.ok('列表项显示参数个数', (await t.text('[data-testid="command-item-refactor"]')).includes('2 参数'))
  await t.click('[data-testid="command-item-refactor"]', 20)
  t.check('选中后命令名填好', await t.js(`document.querySelector('[data-testid="command-name-input"]').value`), 'refactor')

  await t.click('[data-testid="prompt-body-input"]', 20)
  await t.key('End', ['control'])
  await t.insertText(' 另外 {scope}')
  t.ok('新参数实时识别', await t.waitForText('[data-testid="command-detected-params"]', 'scope'))
  t.ok('占位符在背景层高亮', (await t.count('[data-testid="commands-area"] mark')) >= 3)

  await t.click('[data-testid="command-name-input"]', 20)
  await t.key('a', ['control'])
  await t.type('goal')
  t.ok('与保留名重名就地报错', await t.waitForText('[data-testid="command-error"]', '/goal'))
  t.check('保存按钮不可点', await t.js(`document.querySelector('[data-testid="command-save"]').disabled`), true)
  await t.shot('commands')

  // —— 规则 ——
  t.ok('规则列表渲染', await t.waitFor('[data-testid="rule-item-project-pnpm"]'))
  await t.click('[data-testid="rule-toggle-project-pnpm"]', 10)
  t.ok('开关立即写盘', (await t.events()).includes('set_context_rule_enabled'))

  await t.act('setWorkspace', '')
  t.ok('切到无工作区后重新加载', await t.waitFor('[data-testid="rule-new"]'))
  await t.click('[data-testid="rule-new"]', 20)
  t.check('项目范围置灰', await t.js(`document.querySelector('[data-testid="rule-scope-project"]').getAttribute('aria-disabled')`), 'true')
  await t.shot('rules')
}
```

- [ ] **步骤 3：跑场景**

运行：`cd electron-agent && npm run ui:check -- prompt-library-panel > ui-check.log 2>&1; tail -40 ui-check.log`
预期：全部 PASS。

- [ ] **步骤 4：确认没有波及别的场景**

运行：`cd electron-agent && npm run ui:check -- --changed --dry-run`
预期：列出 `command-pill`、`prompt-library-panel`。如果还列出 `codemode-card` / `bash-job-card` 等（因为改了 `messageTags.tsx` 这类共用文件），按 AGENTS.md 判断：这些场景不渲染用户气泡，行为不会变，不跑，并在汇报里写明跑了哪些、没跑哪些。

- [ ] **步骤 5：Commit**

```bash
git add electron-agent/ui-harness/scenarios/prompt-library-panel.tsx electron-agent/ui-harness/probes/prompt-library-panel.mjs
git commit -m "test(ui-harness): prompt-library-panel 场景"
```

---

### 任务 20：文档

**文件：**
- 修改：`AGENTS.md`（「跑哪些场景」和「现有场景」两处）
- 修改：`docs/architecture.md`（末尾追加一节）
- 创建：`docs/decisions/extensions/2026-10-08-command-block-and-context-rules.md`

- [ ] **步骤 1：AGENTS.md**

- 「跑哪些场景」里这句：`目前有 codemode-card、bash-job-card、visual-panel、subagent-conversation、subagent-history、session-row 六个场景，全量就是它们。` 改成：`目前有 codemode-card、bash-job-card、visual-panel、subagent-conversation、subagent-history、session-row、command-pill、prompt-library-panel 八个场景，全量就是它们。`
- 「现有场景」列表末尾加两条：

```markdown
- 命令胶囊：`command-pill`（真实 lobehub Editor + CommandPill 插件，插入走 `INSERT_COMMAND_PILL_COMMAND`，`list_prompt_commands` 用桩；插入后焦点在第一个参数；Tab / Shift+Tab 轮转并能跳出胶囊；必填参数空着时 Enter 被拦下、焦点回到缺的参数并标红；发送文本是调用文本 `/名 "值" ""` 加补充正文；空参数 Backspace 回退、第一个参数里删整个胶囊；气泡里 `<command>` 块整块成胶囊且正文不出现，刚发出的调用文本也成胶囊、空参数显示默认值；浅色主题）
- 命令与规则面板：`prompt-library-panel`（真实 CommandsPanel / RulesPanel，主进程命令用内存桩；命令列表项是胶囊带参数个数；改提示词时参数实时识别、占位符背景高亮；与保留名重名就地报错、保存不可点；规则开关立即写盘；没有工作区时项目范围置灰）
```

- [ ] **步骤 2：docs/architecture.md 末尾追加**

```markdown
## 命令与规则

- **命令**是全局的 Pi prompt template，文件在 `<agentDir>/prompts/<名>.md`。正文里写了 `{参数}` / `{参数=默认值}` 的模板由 `extensions/prompt-commands` 在 `input` 钩子里接管：`/名 "值" …` 展开成 `<command name="…" args="{JSON}">正文</command>`，块后接补充正文；其余模板（包括 `$1` 写法）仍由 Pi 原生展开。语法在 `extensions/prompt-commands/syntax.ts`，扩展、主进程、渲染层共用。
- 输入框里带参数的命令是 Lexical `CommandPillNode`（`src/features/chat/input/editor/CommandPill/`），只能放在输入开头。markdown 写出时写私用区字符 U+E000，发送和存草稿时由 `readComposerText` 换成调用文本。气泡由 `messageTags.tsx` 把 `<command>` 块还原成只读胶囊，不显示正文。
- **规则**一条一个 Markdown 文件：全局 `<agentDir>/rules/*.md`，项目 `<工作区>/.pi/rules/*.md`，frontmatter 有 `title` 和 `enabled`。`extensions/context-rules` 在每次 `before_agent_start` 把启用的规则追加到 `systemPromptOptions.contextFiles`（全局在前、项目在后，同范围按文件名），按文件 mtime 缓存。子代理同样加载。
- 主进程 `PromptLibraryService` 负责读写两类文件，IPC 命令：`list_prompt_commands` / `save_prompt_command` / `delete_prompt_command` / `list_context_rules` / `save_context_rule` / `set_context_rule_enabled` / `delete_context_rule`。管理界面是扩展面板的「命令」「规则」页签；命令改动通过 `PI_RELOAD_REV` 让会话重载，规则改动下一轮生效。
```

- [ ] **步骤 3：决策笔记**

`docs/decisions/extensions/2026-10-08-command-block-and-context-rules.md`：

```markdown
---
title: 带参数的命令展开成 <command> 块，规则走 contextFiles 注入
status: active
date: 2026-10-08
scope: extensions/prompt-commands, extensions/context-rules, chat-input
files:
  - extensions/prompt-commands/syntax.ts
  - extensions/prompt-commands/index.ts
  - extensions/context-rules/index.ts
  - electron-agent/src/features/chat/input/editor/CommandPill/CommandPillNode.ts
  - electron-agent/src/features/chat/messageTags.tsx
supersedes:
superseded_by:
---

## 背景
需要全局命令（预置提示词，支持命名参数并在输入框里填空）和全局、项目两级的规则。Pi 已有 prompt template（只支持 `$1` 位置参数，参数解析不支持转义）和 AGENTS.md context files（整文件，不能逐条开关）。会话里存的是展开后的文本，气泡要显示成命令胶囊。

## 决定
- 命令复用 Pi prompt template 文件。正文里有 `{参数}` 的模板由 `prompt-commands` 扩展在 `input` 钩子里展开成 `<command name="…" args="{JSON}">正文</command>`，参数解析用自己的转义规则（双引号内 `\"` `\\`）。气泡识别这个块，还原成只读胶囊，参照现有 `<skill>` 块折回 chip 的做法。
- 输入框胶囊是 Lexical DecoratorNode 内嵌原生 `<input>`，事件在胶囊上原生截住，不让 Lexical 和 React 根节点处理。markdown 写出时写私用区字符，发送前换成调用文本，避开 remark 对参数里 `\ * _` 的转义。
- 规则一条一个文件，由 `context-rules` 扩展在 `before_agent_start` 追加到 `systemPromptOptions.contextFiles`，和 AGENTS.md 同一段。

## 放弃的方案
- 自建 JSON 存储加 `registerCommand`：和 Pi 原生 prompts、AGENTS.md 并存两套，CLI 和 App 看到的不一致。
- 规则直接编辑两份 AGENTS.md：不能逐条开关。
- 前端代入参数后直接发全文：气泡会是长正文，CLI 也用不了命名参数。
- 胶囊用 ElementNode 加原生 TextNode：规范化处理量大，和 @lobehub/editor 的快捷键插件冲突。
- 胶囊 markdown 直接写调用文本：remark 会转义参数里的 `\`、`*`、`_`。
- 用 `systemPrompt` 整体替换注入规则：绕开 Pi 的分段机制，比 `contextFiles` 复杂。

## 后果
- `<command>` 块格式是会话里的持久数据，改格式要兼容旧会话。
- Pi 原生模板展开不认 `{参数}`：带 `{}` 的模板在没有加载 `prompt-commands` 的环境里会原样发出占位符。
- 草稿发送失败恢复时走 `setDocument('markdown')`，胶囊会变回调用文本；文本直接发送仍然有效。若以后要恢复成胶囊，在恢复路径上复用 `resolvePromptPill`。
- 如果 Pi 将来原生支持命名参数，重新评估是否去掉 `prompt-commands` 的展开逻辑。
```

- [ ] **步骤 4：检查笔记格式**

运行：`node scripts/check-notes.mjs`
预期：输出 `notes OK`

- [ ] **步骤 5：Commit**

```bash
git add AGENTS.md docs/architecture.md docs/decisions/extensions/2026-10-08-command-block-and-context-rules.md
git commit -m "docs: 命令与规则的架构说明、决策笔记和 ui-harness 场景清单"
```

---

## 收尾验证

- [ ] `cd extensions && npx vitest run prompt-commands context-rules index.test.ts prompt-metadata.test.ts`，预期全部 PASS
- [ ] `cd cli && npx vitest run src/agent-data-plugins.test.ts src/extension-profile.test.ts`，预期 PASS
- [ ] `cd electron-agent && npx vitest run electron/app/promptLibraryService.test.ts src/features/chat src/features/extensions`，预期 PASS
- [ ] `cd electron-agent && npx electron-vite build`，预期构建成功
- [ ] `cd electron-agent && npm run ui:check -- command-pill prompt-library-panel`，预期全部 PASS
- [ ] 手动冒烟（需要用户的环境，或在 dev 模式下运行 App）：
  - 在扩展面板「命令」页签新建 `refactor`。
  - 重载后在输入框打 `/ref`，选中后填参数，发送。
  - 确认气泡显示胶囊，模型收到的是展开后的正文。
  - 在「规则」页签新建一条全局规则「回复以 OK 开头」，发送任意消息，确认模型照做；关掉开关后再发，确认不再照做。
