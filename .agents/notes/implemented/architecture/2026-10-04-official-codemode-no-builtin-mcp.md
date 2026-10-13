# Agent Note: 会话挂官方 codemode，CLI 换掉内置 MCP；兼容 pi 1.1.0 codemode 输出

Status: implemented

## Problem

### 会话挂官方 codemode，CLI 用 extensionFactories 换掉内置 MCP

1.0.2 的 CLI `main()` 会预置 `builtInExtensions`（含 `builtin:codemode`、`builtin:tool-search`、`builtin:mcp`）。SDK 的 `createAgentSessionServices` 不会预置它们。Electron 会话走 `makeGrenRuntimeFactory`，CLI 走 `main()`。官方 MCP 客户端不能和产品自己的 MCP 扩展一起加载。

### codemode 卡片按 pi 1.1.0 的合并文本块拆回各项，兼容 1.0.2 历史

pi 1.1.0 的 codemode 改了结果形状：多个 text() / 返回值各以 `==> text N/M <==` 行开头，console 行收进末尾的 `<console_output>` 块，失败时再接 `Script error:`，而且 `joinAdjacentText` 把结果头之后的相邻文本并成一块（图片把它隔开）。卡片原来按块分类，1.1.0 下整段成了一个文本块：标记和标签原样显示，返回值不再缩进成 JSON，脚本错误也不再单独标红。

## Decision

### 会话挂官方 codemode，CLI 用 extensionFactories 换掉内置 MCP

`makeGrenRuntimeFactory` 在 `PI_SYSTEM_WORKER !== "1"` 时，把 `extraFactories` 接在 `filterManagedExtensions` 之后。生产默认是 `createCodemodeExtension()` 和 `createToolSearchExtension()`。`PI_SYSTEM_WORKER === "1"` 时工厂列表仍是空的，不追加 extra。

CLI 的 `runtime.ts` 和 `pi-worker.ts` 继续把产品扩展传给 `main` 的 `extensionFactories`。argv 里还没有 `-builtin:mcp` 时，再追加 `{ name: "mcp", builtin: true, factory() {} }`。1.0.2 的 `MainOptions` 只有 `extensionFactories`。`main()` 把内置扩展放在前面，同名且 `builtin: true` 的后项覆盖 Map，空工厂替换 `createMcpExtension`。这两条路径不再追加 codemode 或 tool_search。

### codemode 卡片按 pi 1.1.0 的合并文本块拆回各项，兼容 1.0.2 历史

`parseCodemodeOutput` 对每个文本块先从尾部拆：未展示图片的提示、`Script error:`（仅当结果头不是 completed 时才认）、`<console_output>`（必须在行首且是剩余文本的结尾），剩下的文本只在块首行就是标记时按总数 M 相同的标记行切成各项，每项再按 JSON / 文本分类，相邻文本照旧合并。控制台输出成为新的 `console` 块，卡片里带「控制台」小标题单独画。1.0.2 的历史结果每项一块、没有标记，走同一路径时整块原样分类，显示不变。

### 涉及文件

- `cli/src/gren-runtime.ts`
- `cli/src/runtime.ts`
- `cli/src/pi-worker.ts`
- `electron-agent/src/features/tools/codemodeModel.ts`
- `electron-agent/src/features/tools/CodemodeCard.tsx`
- `electron-agent/ui-harness/codemodeFixtures.ts`
- `electron-agent/ui-harness/probes/codemode-card.mjs`

### 来源

- `docs/decisions/cli/2026-10-04-official-codemode-without-builtin-mcp.md`
- `docs/decisions/electron-agent/tools/2026-10-08-codemode-output-joined-block.md`
- 69cbb021（pi 升到 1.1.0）
- `docs/pi-sdk-upgrade-checklist.md`

## Alternatives considered

### 会话挂官方 codemode，CLI 用 extensionFactories 换掉内置 MCP

- 按计划初稿追加 `--extensions -builtin:mcp`：1.0.2 没有 `--extensions`。`--extension` / `-e` 是加载路径，不是禁用。裸参数 `-builtin:mcp` 会被当成未知选项并退出。
- `--no-extensions`：会同时关掉官方 codemode 和 tool_search。
- 把 `-builtin:mcp` 写进 settings：`setExtensionPaths` 会落盘，改到用户配置。
- 在 CLI 的 `extensionFactories` 里再放 `createCodemodeExtension()`：`main()` 的内置扩展已经加载一次，会注册两遍。

### codemode 卡片按 pi 1.1.0 的合并文本块拆回各项，兼容 1.0.2 历史

- 只把标记行和标签删掉、整块当文本显示：返回值 JSON 不再格式化，脚本错误混在普通输出里不标红，回到升级前要解决的问题。
- 按全文搜标记行切分、不要求块首行是标记：脚本自己打印出 `==> text 1/2 <==` 时会被误切；pi 只在多于一项时加标记，且第一项必在块首。
- console 行并进文本块（1.0.2 的观感）：1.1.0 已把 console 统一挪到末尾，和 text() 的先后关系没了，混在一起反而让人误读顺序。
- 在完成的结果里也识别 `Script error:`：普通输出里出现这一行时会被错标成错误。

## Consequences

### 会话挂官方 codemode，CLI 用 extensionFactories 换掉内置 MCP

`builtin:mcp` 这条资源默认仍会进入加载，但执行的是空工厂，不会连接官方 MCP。用户 settings 里的 `-builtin:mcp` 仍然可以排除这条资源；argv 已经包含该字符串时不再追加空工厂。Electron 不经过 `main()` 的内置列表，官方 codemode 与 tool_search 只从 `extraFactories` 进入一次。

### codemode 卡片按 pi 1.1.0 的合并文本块拆回各项，兼容 1.0.2 历史

截断过的输出（`Warning: truncated output` 开头）首行不是标记，整块按文本显示，里面残留的标记和标签不去掉，完整内容看 `fullOutputPath`。识别依赖 pi 1.1.0 `extensions/codemode/execute.js` 的 `formatOutput` / `joinAdjacentText` 格式，升级 pi 时对一下；`ui-harness` 的 `codemode-card` 场景实时用 1.1.0 形状、历史用 1.0.2 形状，形状变了它会先挂。

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
