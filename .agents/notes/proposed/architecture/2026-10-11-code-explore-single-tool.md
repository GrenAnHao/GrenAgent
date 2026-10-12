# Agent Note: CodeGraph 检索工具收敛为单个 code_explore

Status: proposed

> 草稿：由 Grok Bot 依据提交 / diff 整理，等用户审阅。代码已经落地，按用户要求先放在 proposed/；审完后按 SKILL 的转正契约改写并移到 implemented/。标「待确认」的地方我不知道当时的理由，请补上。

## Problem

`extensions/code-retrieval/tools.ts` 原来向模型注册了 20 个 `code_*` 工具（search、callers、callees、impact、node、files、status、usages、path、hierarchy、call_graph、deps、cycles、dead_code、metrics、routes、traverse、context、changed、explore），每个都把 SDK 的全部参数暴露出来，提示词还要求「每个相关参数都要传」。待确认：实际观察到了什么问题（工具太多选错？上下文占用？调用质量差？）。

## Proposal

已落地，未提交（工作区）。

- `tools.ts` 只注册 `code_explore`（远端是 `codegraph_explore`），参数只有 `query`（必填，1~4000 字）和 `maxFiles`（1~20，默认 12）。提示改成「先用 code_explore；把 code_explore 返回的源码当作已读，没截断就别重读」。
- `prompt.ts` 的索引提示从 `code_*` 改成 `code_explore`。
- 下游跟着改：`agent-mode/modes.ts` 的只读白名单只留 `code_explore`（注释写着「与上游 MCP 一样只列这一个」）；`fable-behavior/default-agents.ts` 里各默认 agent 的 `tools:` 和提示词只留 `code_explore`，`FABLE_AGENT_SEED_VERSION` 升到 `2026-10-11.1`，这样已经播种出去的模板会被更新。
- 同一批未提交改动里，`multi-agent/embedded-runner.ts` 和 `activation.ts` 共用 ModelRuntime、fable 一个进程只播种一次、`agent-mode` 在 `session_shutdown` 时退订，这些已经写在 [并行子代理冷启动开销](../../implemented/architecture/2026-10-10-subagent-parallel-startup-cost.md) 里，本笔记不重复。

## Alternatives considered

- **保留全部 20 个工具** — 最强的理由是能力最全：调用方、影响面、死代码这些查询只有专门的工具能做。待确认：为什么放弃（收敛以后这些查询只能靠 explore 的自然语言或者 grep）。
- **保留少数几个（比如 search、explore、node）** — 待确认：有没有考虑过。上游 MCP 只暴露 explore，这次是向它对齐。

## Acceptance criteria

- `cd extensions && npx vitest run code-retrieval agent-mode multi-agent` 通过。
- ask 模式下 `code_search` 会被拦（`modes.test.ts` 有覆盖）。
- 新开会话、子代理的工具列表里只有 `code_explore`，提示词里不再出现 `code_*`。

## Risks

- 用户本地已经播种的 agent 模板，如果被手动改过，升级种子版本时可能被覆盖或者产生冲突。待确认：seed 的覆盖策略。
- 调用方、影响面这类精确图查询的能力下降了。
