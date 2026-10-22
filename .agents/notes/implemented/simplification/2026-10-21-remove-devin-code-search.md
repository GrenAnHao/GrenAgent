# Agent Note: 完全移除 Devin 集成（搜索工具、网页搜索通道、登录与代码）

Status: implemented

## Problem

Devin 集成依赖 Windsurf / Codeium 的非公开协议，协议一变就会失效。它有两条用法：`devin_code_search` 把查询和选中的文件片段发往 Windsurf；`web_search` 在登录有效时先走 Devin。两条都要 OAuth 登录，登录还不会自动刷新。本地已有 `search`（正则 / 字面量）和 `code_explore`（CodeGraph 索引），网页搜索有 Bing、搜狗、百度等无需账号的引擎，这套云端依赖不再值得维护。

## Decision

整个 Devin 集成删除，不留开关。

- 工具：`web-search` 扩展不再注册 `devin_code_search`；`web_search` / `web_search_multi` 不再有 `devin` 引擎。
- 引擎链：`resolveWebSearchChain(explicit, provider)` 和 `defaultSearchChain(provider)` 去掉 `devinReady` 参数。`bing` 的默认链是 bing → sogou → baidu。`BuiltinEngine` 与 `SUPPORTED_SEARCH_ENGINES` 不再含 `devin`，`WEB_SEARCH_PROVIDER=devin` 或引擎链里写 `devin` 被当作未知值忽略，回落到默认的 bing。
- 代码：删除 `extensions/devin-client/` 整个目录和 `extensions/web-search/devin.ts`；删除 `electron/app/devinAccount.ts`、`devinOAuthWindow.ts`，`ipc/register.ts` 去掉 `devin_account_status` / `login` / `logout` 三个命令；渲染层删除 `lib/devinAccount.ts`、`DevinAccountCard.tsx`，`pi.ts` 去掉三个 `devinAccount*` 桥方法，设置页「搜索」分区不再显示 Devin 账号卡片，设置项文案同步改掉。相关测试一并删除。
- 文档：`docs/architecture.md` 的 web-search 行改写。

## Alternatives considered

- 保留 `web_search` 的 Devin 通道和登录，只删代码搜索。最强理由是网页搜索通道质量高、改动小，上一轮就是这么做的。不选它，因为登录不会自动刷新、协议私有，通道失效时只会拖慢回退，用户明确要求完全移除。
- 把工具保留、默认关闭。最强理由是想用的人还能开。不选它，因为私有协议的维护成本和代码片段外发的风险都还在。

## Consequences

收益：没有代码片段发往 Windsurf 的路径，没有 OAuth 窗口、本地回环回调和本机会话文件（`~/.config/devin-search`）要维护，设置页和 IPC 面更小。代价：没有云端语义代码搜索，按语义找代码只能靠 `code_explore`；网页搜索失去 Devin 这个首选源，质量回到 Bing 链的水平。用户机器上已有的 `~/.config/devin-search` 会话文件不会被清理。旧决策 `docs/decisions/extensions/2026-10-05-devin-web-and-code-search.md` 已冻结，不改动，以本篇为准。

## 验证

- `cd extensions && npx vitest run web-search prompt-metadata`：4 个文件 28 个用例，结果通过。
- `cd electron-agent && npx vitest run src/features/settings electron/ipc`：18 个文件 137 个用例，结果通过。
- verify: n/a 设置页只是少了一张卡片，没有新的交互路径，不需要新的 ui-harness 场景。
