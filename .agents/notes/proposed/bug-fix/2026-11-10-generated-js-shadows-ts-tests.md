# Agent Note: 工作区生成的同名 JavaScript 遮蔽 TypeScript 测试目标

Status: proposed

## Problem

验证 [日志断管修复](../../implemented/bug-fix/2026-11-10-agent-host-log-broken-pipe.md) 时，修改后的 `agentProcessClient.ts` 已捕获 EPIPE，但同目录 `agentProcessClient.test.ts` 的 `./agentProcessClient.js` 导入仍加载了未跟踪的旧生成文件。`agentProcessClient.js` 的修改时间为 2026-11-07，TS 为 2026-11-10。修复后常规命令仍有四条 EPIPE 测试失败，日志在 `.agents/evidence/2026-11-10-agent-host-log-broken-pipe/vitest-green.txt`。这是测试加载旧实现，不是修复失效。

## Proposal

后续独立确定生成物来源与输出目录，避免构建向源码目录 emit。当前任务不删除工作区既有生成物、不修改公共 Vitest 策略；证据目录的临时配置只将客户端的显式 `.js` 导入 alias 到 `.ts`，用于验证本次修复。

## Alternatives considered

- 批量删除未跟踪 `.js` / `.d.ts`：最强理由是恢复干净源码解析，普通命令即可使用 TS。不选：工作区大量他人改动和生成物，不足以确认所有文件归属，本次不做清理。
- 修改公共 Vitest resolve 扩展优先级：最强理由是统一优先 TS。但有全局解析行为影响，超出本次日志故障修复；先用显式单模块 alias 留下可重复证据。

## Acceptance criteria

正常测试命令能直接验证当前 TypeScript 源码；构建不再向源码目录生成遮蔽文件。

## Risks

生成物来源与全仓遮蔽问题尚未修复，常规命令仍可能运行其他旧 JS。本次仅同步目标 `agentProcessClient.js` 的同一处 EPIPE 修复，使该目标的常规测试与本机构建不再使用未修复逻辑；不删除或同步其他生成物。临时 alias 只证明指定模块，不代表全仓解析正确。

## 验证

已确认错误加载路径及文件时间；原始失败证据见上述日志。使用临时 alias 的客户端红绿回归结果另记录在断管笔记中。生成物根因与永久修复未实施，保持 proposed。
