# Agent Note: 控制面经 runtime-settings.json + watchConfig，不走假 prompt 或斜杠命令

Status: implemented

## Problem

模式、审批、删段等控制操作需要从桌面传到扩展。01477049（2026-06-15）起扩展的运行时设置改为经 `getConfig` / `getAllConfig` 读取。

原因（用户说明）：控制面大多是 UI 层的功能，没必要再走斜杠命令。

## Decision

- 模式 / 审批 / 删段由桌面 IPC 带锁写 `runtime-settings.json`，扩展用 `watchConfig` 应用（`docs/architecture.md`「控制面约定」）。
- 斜杠菜单只保留发生式命令（`/goal`、`/rules`、工作流、技能、前端 `/compact`）；`/plan-build` 仍由计划卡片 `runCommand` 触发，但不出现在菜单。
- 每个会话（含子代理）各订一份 `watchConfig`，`session_shutdown` 时退订，见 [并行子代理冷启动开销](./2026-10-10-subagent-parallel-startup-cost.md)。

### 涉及文件

- `electron-agent/electron/app/piRuntimeService.ts`
- `extensions/_shared/`

### 来源

- 01477049
- `docs/architecture.md`「控制面约定」

## Alternatives considered

- **经假 prompt 或斜杠命令下发控制**：不采用：大多是 UI 层功能，没必要用斜杠命令（用户说明）。

## Consequences

- 新增控制项要走 runtime config 字段，不新增控制类斜杠命令。

## Verification

verify: n/a 回填的历史决定，源提交未记录验证
