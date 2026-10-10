---
title: 子代理卡片的模型标签追加实际运行的思考档位（模型 · 档位）
status: active
date: 2026-10-06
scope: electron-agent/chat
files:
  - extensions/multi-agent/registry.ts
  - extensions/multi-agent/embedded-runner.ts
  - extensions/multi-agent/index.ts
  - electron-agent/src/features/panels/subagentUtils.ts
  - electron-agent/src/features/chat/SubAgentInline.tsx
  - electron-agent/src/features/chat/SubAgentGroupInline.tsx
  - electron-agent/src/features/subagents/SubAgentCard.tsx
supersedes:
superseded_by:
---

## 背景
子代理卡片只显示模型名。`spawn_agent` 的 `thinking_level` 是可选参数，不传时子会话按设置默认值起，
还会按模型能力收窄，所以「请求的档位」不等于「实际运行的档位」。

## 决定
- 档位取子会话建好之后的 `session.thinkingLevel`。embedded runner 在 `onUpdate` 里带出 `thinkingLevel`，
  `registry.setSessionPath(id, path, level)` 写进新增的 `subagents.thinkingLevel` 列（COALESCE，流式帧不带档位时不清掉）。
- 工具结果 `details`（单任务、并行/链式的每行结果、后台 spawn）新增 `thinkingLevel`，和 `model` 并列，历史回放不用再查注册表。
  取值优先注册表，其次调用参数里显式给的 `thinking_level`（进程回退路径没有 embedded 会话，只有这个来源）。
- 前端统一用 `modelWithThinking(model, level)` 拼标签：`模型 · 档位`，档位用 `levelDisplayLabel`（关闭/最低/低/中/高…），与输入框同一套。
  没有档位时只显示模型。涉及单任务条、并行/链式行、右坞的 `SubAgentCard`。
- 注册表老库用 `PRAGMA table_info` 判断后 `ALTER TABLE` 补列；Electron 侧 `subagentService.list` 同样按列是否存在再 SELECT。

## 放弃的方案
- 只显示调用参数里的 `thinking_level`：不传参数时（最常见）没有值，且不反映模型收窄后的真实档位。
- 前端每次去读子会话 JSONL 里最后一条 `thinking_level_change`：轮询频率下读文件太贵，且已完成的卡片需要额外 IPC。
- 用父会话当前档位推断：子会话并不继承父档位，会显示错的值。

## 后果
- 进程回退路径（非 embedded）且没显式传 `thinking_level` 时，档位未知，卡片只显示模型。
- 子会话运行中被改过档位（目前没有入口）不会同步，标签以起会话时为准；需要时再在 `onUpdate` 里每帧刷新。
