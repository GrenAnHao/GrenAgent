# Agent Note: 定向验证必须读取当前 TypeScript 而非旧编译副产物

Status: implemented

## Problem

实施视觉评审与 Goal 生命周期时，`npx vitest run goal/fold.test.ts` 的四个新增断言失败，但实际载入的是 `extensions/goal/fold.js` 和 `types.js`，不是已修改的 TypeScript。目录有 2026-11-08 生成且被 Git 忽略的 `.js` / `.d.ts` 副产物。直接运行默认解析会产生假失败，也可能造成假通过。

## Decision

仅为本次定向验证提供证据目录中的临时 Vitest resolver，对仓库内明确存在同名 TypeScript 的相对 `.js` import 优先使用 `.ts` / `.tsx`。不删用户副产物，不修改产品构建或全局配置。真实 SDK 动态扩展加载需另外确认实际执行源，不能以 Vitest resolver 推断 jiti 行为。

本记录与[生命周期修复](2026-11-17-visual-review-and-goal-lifecycle.md)相邻，单独记录验证环境失效，不改变产品契约。相关历史检索只有原 Goal 实跑记录，没有相同副产物解析决定。

## Alternatives considered

删除全部生成的 JavaScript 能恢复常规解析，但会更改用户本地环境且波及其他任务，因此不采用。只在测试 import 改成 `.ts` 更简单，但间接 import 仍可能读旧 JavaScript，因此不足。

## Consequences

定向 fold 测试使用当前 TypeScript，通过新增批次与条件版本断言；日志同时保留原失败与更正后的结果。SDK 夹具独立确认动态装载来源，不能用普通 resolver 代替。用户本地编译副产物保留，默认入口与部署仍需各自验证。

### 限制

临时配置不代表默认测试入口已修复；在交付记录中明确实际命令和解析条件，不掩盖限制。

## 验证

原命令 `cd extensions && npx vitest run goal/fold.test.ts`：失败（4 项新增断言），日志 `.agents/evidence/2026-11-17-visual-review-and-goal-lifecycle/goal-fold.log`。加 `--config ../.agents/evidence/2026-11-17-visual-review-and-goal-lifecycle/source-vitest.config.mjs` 后同一 TS 文件 14/14 通过，日志 `goal-fold-source.log`。Electron 对应 `visual-vitest.config.mts` 在各 node／jsdom project 中安装 resolver，保留原测试环境划分。

真实 SDK 的 jiti 装载探针 `probe-jiti-source.log` 确认原目录旧 JS 仍会遮蔽当前实现；`probe-real-sdk-overlay.log` 及 `goal-visual-compaction-sdk.log` 使用临时 TS-only overlay，真实 SDK 13/13 通过。overlay 测试结束清理，只替换确定性模型传输和 UI 输入，不删除本地副产物。不把这些结果当作默认入口、已运行应用或部署打包已更新的证明。
