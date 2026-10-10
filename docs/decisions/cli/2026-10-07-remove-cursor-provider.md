---
title: 移除 Cursor 原生供应商，连同登录、模型勾选和 agent-loop 补丁
status: active
date: 2026-10-07
scope: cli
files:
  - cli/src/main.ts
  - cli/src/runtime.ts
  - cli/src/gren-runtime.ts
  - cli/package.json
  - electron-agent/electron/main.ts
  - electron-agent/electron/ipc/register.ts
  - electron-agent/electron/app/providerService.ts
  - electron-agent/src/lib/pi.ts
  - electron-agent/src/features/settings/ProvidersSettings.tsx
  - electron-agent/src/features/settings/providerPresets.ts
  - electron-agent/src/features/settings/providerConfigAdapter.ts
  - electron-agent/src/features/chat/input/thinkingLevels.ts
supersedes:
  - cli/2026-10-06-cursor-exec-bridge-session-tools.md
  - cli/2026-10-06-cursor-login-file-auth.md
  - cli/2026-10-07-cursor-exec-delete-fetch-background.md
  - cli/2026-10-07-cursor-first-turn-and-bash-description.md
  - cli/2026-10-07-cursor-transport-reset-retry.md
  - electron-agent/settings/2026-10-06-cursor-provider-account-and-model-visibility.md
superseded_by:
---

## 背景
Cursor 原生供应商（`cli/src/cursor/`，含从 omp 复制的客户端、protobuf 和目录规则）接进来之后一直用不起来：连接、首轮、流内工具执行接连出问题，修了几轮仍然不能稳定对话。它还要求 postinstall 给已安装的 `pi-agent-core` / `pi-coding-agent` 打补丁，每次升级 pi 都要重新对锚点。

## 决定
整块删掉，不留开关：

- 删除 `cli/src/cursor/`（约 170 个文件）和 `cli/scripts/patch-pi-cursor-loop.mjs`，postinstall 不再跑这个补丁。
- sidecar（`main.ts` / `runtime.ts`）和 Electron 主进程不再注册 `cursor-agent` 供应商；`gren-runtime.ts` 不再给会话挂 Cursor exec 桥。
- 删除 IPC 命令 `cursor_status`、`cursor_login`、`cursor_logout`、`cursor_models`、`cursor_set_hidden_models`，以及渲染层对应的 `pi.cursor*` 方法和类型；`ProviderService.agentDir` 只给这几条命令用，一并删掉。
- 设置页去掉 Cursor 预设、账号卡和模型勾选；`ApiType`、思考档位映射和对话里的回退阶梯去掉 `cursor-agent`。
- 删除 ui-harness 的 `cursor-provider` 场景。
- `docs/superpowers/` 下的 Cursor 规格和计划留在原处，不挪进 archive（archive 的 README 规定不再往里追加）。
- reducer 里「工具结果消息收掉仍在转 / 已中断的卡片」的处理保留：它按 toolResult 消息工作，和供应商无关，另有非 Cursor 的用例覆盖。

## 放弃的方案
- 保留代码、只把预设从设置页藏起来：vendor 目录和 agent-loop 补丁仍然随每次 pi 升级要维护，藏起来不省任何成本。
- 加一个默认关闭的开关：没有人会去打开一个已知用不了的供应商，开关只会让两条路径都要测。
- 保留 vendor 客户端以后再接：需要时可以从版本历史里取回，留在树里只会被测试、类型检查和依赖图反复扫到。

## 后果
- 用户 agentDir 里已有的 `cursor-credentials.json`、`cursor-models.json` 不再被读取，也没有自动清理。设置里的模型项（默认会话模型、标题模型、提示词增强模型、AgentData 模型、子代理模型）如果选的是 Cursor 模型，不会自动回退到默认模型，相关调用会报模型不可用，要在设置里重新选。
- 已经装好的 `node_modules` 里，pi 的 `agent-loop.js` / `agent.js` / `sdk.js` 仍带着旧补丁，直到重新安装这些包。补丁只在 `globalThis.__grenCursorExecResolved` 存在或模型 api 为 `cursor-agent` 时改变行为，删掉供应商后不会触发。
- 以后再想接 Cursor，应先确认有稳定的官方接入方式，再重新评估；不要直接恢复这次删掉的 vendor 代码。
