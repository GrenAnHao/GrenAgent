# 视觉评审与 Goal 生命周期：定向验证汇总

变更：`fix-visual-review-and-goal-lifecycle`。验证日期：2026-11-17。OpenSpec apply 已确认 `all_done`，51/51 项完成。

本目录保留早期失败、解析修正和最终通过日志。下表指定最终证据；不同测试组有重叠，不能把所有数量相加当作独立测试总数。未跑全量测试、全部 UI 场景或真实供应商请求；未提交、推送、同步主规格或归档 change。

## 七个点名 Electron UI 场景

全部使用 Vite 生产构建和真实 Electron 组件／输入事件；后端 I/O 使用确定性桥桩。仅运行本需求的七个场景，最终合计 182 项断言通过。

| 场景 | 最终结果 | 日志 | 主要覆盖 |
| --- | --- | --- | --- |
| visual-panel | 19/19 | [visual-panel-ui.log](visual-panel-ui.log) | 预览／滚动／演示浏览，无页面评审回传 |
| visual-review | 24/24 | [visual-review-ui.log](visual-review-ui.log) | 封闭通过／打回、自定义／补充、旧预览／后台／取消 |
| goal-lifecycle | 32/32 | [goal-lifecycle-ui.log](goal-lifecycle-ui.log) | dirty 草稿、真实提交回执、冲突／失败、冻结、上限新批次、主题／窄栏 |
| goal-round-card | 13/13 | [goal-round-card-ui.log](goal-round-card-ui.log) | 旧 hidden 轮次、新批次 details、实时去重 |
| request-recovery-feedback | 11/11 | [worker-4-ui-check.log](worker-4-ui-check.log) | 首正文／思考／工具增量撤旧错，空 start／旧 attempt 不清，恢复后取消 |
| session-compaction | 44/44 | [session-compaction-ui.log](session-compaction-ui.log) | 独立压缩、A/B、真实 renderer reload、后台完成统计、迟到请求、逐帧无内部 abort 闪错 |
| subagent-detached | 39/39 | [subagent-detached-ui.log](subagent-detached-ui.log) | 启动／首响应／待确认、自动退避、ID 查询第51行、终态不倒退、中性停止／中断及原 Bash 等待／超时 |

命令均在 `electron-agent` 下执行，形式为 `npm run ui:check -- <上表场景名>`，输出保存到对应日志。没有全局主题或共享 CSS 改动，不运行 `--changed` 或额外无关场景。各日志中的“1/60”表示该次只点名一个场景，不表示跑过其余59个。

视觉截图位于 [screenshots/](screenshots/)；另有 [Goal 编辑批准记录](goal-editor-review-v1.approval.json)、[子代理运行](subagent-detached-running.png)、[子代理终态](subagent-detached-finished.png)、[压缩重载恢复](session-compaction-restored-after-reload.png) 和 [压缩完成浅色](session-compaction-finished-light.png)。静态 Goal 方案批准通过实际原生 ask_user 收集，不冒充新的 visualReview registry 运行回执。

## Goal、控制与真实 SDK

| 范围 | 结果 | 最终证据 |
| --- | --- | --- |
| Goal TS-only 阶段性逻辑（后续恢复另验） | 15文件 118/118 | [goal-ts-suite.log](goal-ts-suite.log) |
| 真实 SDK、Goal／视觉评审／压缩组合 | 13/13 | [goal-final-sdk.log](goal-final-sdk.log)、[完整事件／结果](goal-sdk-event-sequences.json) |
| 控制 RPC／原会话路由与 renderer 水位／owner-loss 接线 | 4文件 43/43 | [goal-final-host-renderer.log](goal-final-host-renderer.log)、[回执](goal-control-rpc-receipts.json) |
| Goal 编辑组件／回执 | 27/27 | [goal-editor-unit.log](goal-editor-unit.log) |
| WorkspaceHandle 准备／接受后异常 | 11通过，35未选 | [goal-host-failure.log](goal-host-failure.log) |
| 新 owner confirmed loss 恢复／启动 | 37/37 | [goal-owner-loss-recovery.log](goal-owner-loss-recovery.log) |
| 主进程 tracker／HostApi 与生产内部广播包装 | 19/19（含原17项） | [goal-owner-loss-broadcast.log](goal-owner-loss-broadcast.log) |
| 无 settled 后同 owner 实际恢复派轮 | 21/21 | [goal-owner-failed-prompt-resume.log](goal-owner-failed-prompt-resume.log) |
| 只读 Goal 宿主查询 | 3通过，118未选 | [goal-owner-loss-readonly.log](goal-owner-loss-readonly.log) |

SDK 序列覆盖：最终失败→补拉→人工恢复→编辑→上限→新批次；直接及 codemode 嵌套调用的不可变归属；重试成功／耗尽；真实压缩成功／失败；评审等待、打回新版本后才批准；人工暂停优先于迟到批准，最终压缩失败优先于续跑。只使用 faux 模型传输与确定性 UI 输入，没有真实模型费用。

生产 `RpcPeer`／`createAgentPorts`／`PiRuntimeService` 回环使用结构化克隆，真实提交后扣住 ack，再以同 operationId 重取，未重复追加。这是生产路由组件的进程内 RPC 回环，不是独立 OS host 进程实测。

补充恢复已完成六个明确 TS 文件 81/81（[goal-owner-loss-resume-boundary.log](goal-owner-loss-resume-boundary.log)）：未持久暂停按 stoppedAt 先补写；同 operationId 半提交重试；历史 pause 的当时 fold 核验；可信控制 supersedesConfirmedLoss 与丢 ACK 重证；旧 marker 不 ACK 新 loss；await claim 期间 edit／clear+create 再次 CAS 冲突；已确认 host catch 释放自己的槽后最多单次续跑；新 Goal 不继承旧故障 latch。相关源码／测试定向 tsc 无诊断（独立收尾命令 [goal-recovery-final-tsc.log](goal-recovery-final-tsc.log)，配置 [goal-recovery-tsconfig.json](goal-recovery-tsconfig.json)），实际最小事件为 [goal-recovery-events.json](goal-recovery-events.json)。

生产 hostEntry 的内部执行槽广播包装断开已修复：现在直发 internal.goal-workslot，而非包进普通 renderer broadcast。真实生产 broadcaster／RpcPeer 接线 19/19 验证内部证据到达 tracker 且不送 renderer、普通事件照旧广播；原17项直接 tracker／HostApi 回环本身不足以证明入口，保留此失效原因。测试中的 main 分支是同构 dispatch，并经逐行复核与当前 main.ts 一致；并未直接启动 Electron main 或独立 OS host。

## 恢复提示、压缩活动及子代理观察

| 范围 | 结果 | 最终证据 |
| --- | --- | --- |
| reducer／host／恢复与压缩等定向 | 10文件 238/238 | [worker-4-7-final-vitest.log](worker-4-7-final-vitest.log) |
| 真实 SDK 429 自动重试与源 attempt 归属 | 1/1 | [worker-4-sdk-integration.log](worker-4-sdk-integration.log) |
| 真实 SDK 压缩来源／跨帧内部 abort | 2/2 | [worker-7-sdk-integration.log](worker-7-sdk-integration.log) |
| 活动／压缩策略扩展 | 12/12 | [worker-7-extension-vitest.log](worker-7-extension-vitest.log) |
| snapshot／stats 请求乱序 | 15/15 | [worker-7-snapshot-stats-vitest.log](worker-7-snapshot-stats-vitest.log) |
| 原会话压缩目标／租约边界 | 3通过，118未选 | [worker-7-target-route-vitest.log](worker-7-target-route-vitest.log) |
| 子代理 service／utils／共享观察 store | 88/88 | [subagent-unit.log](subagent-unit.log) |
| 视觉 preview frame | 7/7，无跳过 | [visual-preview-frame-tests.log](visual-preview-frame-tests.log) |
| 打回代理循环与 registry | 24/24 | [visual-review-loop-tests.log](visual-review-loop-tests.log) |
| 历史答复 append 后才 settle | 12/12 | [visual-review-commit-tests.log](visual-review-commit-tests.log) |
| 视觉兼容壳／官方工具 prompt 元数据 | 6/6 | [visual-legacy-extension-tests.log](visual-legacy-extension-tests.log) |

`session-compaction` 的真实 webContents.reload 销毁 renderer store；宿主契约桩的快照独立存在 localStorage，重载后只通过 `agent_list_running_turns` 和生产 `restoreRunningTurns` 恢复，没有重放 start。这证明 renderer 恢复接缝，不证明真实独立 OS host 存活；也不是产品把 compacting=true 落盘。真实 SDK 和宿主 tracker／协议故障分别由上表测试覆盖。

## 解析条件、失败记录与未运行范围

仓库本地被忽略的旧 `.js`、`.d.ts`、`.test.js` 会遮蔽 TypeScript。未删除这些用户文件、未修改全局测试／产品构建。扩展的明确 TS 文件使用 `source-vitest.config.mjs`；Electron 使用 `visual-vitest.config.mts` 或同目录等价的 `electron-source-vitest.config.ts`，保留原 node／jsdom project。命令形式：

```bash
cd extensions
npx vitest run goal/goal-auth.real.test.ts --config ../.agents/evidence/2026-11-17-visual-review-and-goal-lifecycle/source-vitest.config.mjs

cd ../electron-agent
npx vitest run electron/app/goalControlHost.test.ts src/stores/goalStore.test.ts src/features/extensionUi/goalStatus.test.ts src/features/extensionUi/ExtensionUiHost.test.tsx --config ../.agents/evidence/2026-11-17-visual-review-and-goal-lifecycle/visual-vitest.config.mts
```

真实 SDK 另以临时 TS-only overlay 装载当前扩展；[原目录装载探针](probe-jiti-source.log) 与 [overlay 装载探针](probe-real-sdk-overlay.log) 分别保留。早期 `goal-fold.log`、`worker-4-7-renderer-host-vitest.log` 的失败不被删除，也不计作通过；修正解析后的最终结果见表。

相关 Goal 恢复源码／测试的定向 TypeScript 检查通过；视觉 registry 的历史 previewId UUID 推断类型问题已显式标注 string，并通过独立 [visual-registry-final-tsc.log](visual-registry-final-tsc.log)（[配置](visual-registry-tsconfig.json)）。跨工程依赖检查仍未通过，见 [worker-4-7-typecheck.log](worker-4-7-typecheck.log) 及 owner-loss 检查记录。涉及既有依赖／环境类型及非本需求代码，未扩大范围清理；不宣称全工程类型检查通过。UI 构建通过不等于 tsc 通过。日志里的 Electron 资源／缓存警告和 ResizeObserver 提示未导致所选断言失败。

未验证已运行桌面程序热更新、真实供应商／自然数小时挂机、完整应用部署／独立 OS host 失效恢复，亦未运行无关 session-transfer、沙箱或后台命令全套回归。已有这些功能的未提交改动保留，不将整个工作树 diff 冒充本轮改动。

## 剩余观察边界

已关闭的复核阻塞包括：无 settled 后旧槽遗留、未持久暂停无法恢复、历史 loss 标签被后续修订遮蔽、异步 claim 后 CAS 窗口和内部执行槽广播入口断开。相关实现通过定向回归和只读交叉复核。

没有量化真实用户长时间自然运行或大量子代理观察缓存的资源曲线；可信终态停止查询，但终态事实保留以防重挂倒退。压缩结束消息遗漏后的宿主快照对账由既有重载／切换路径触发，不声称新增了持续周期轮询。独立 OS host 失效和完整部署仍未实测，不把回环或 localStorage 宿主契约桩说成它们。以上观察不以自动扩大测试或权限范围解决。

## 交付门禁

`pnpm run verify-notes` 通过，157 篇笔记的树／格式／链接和22篇归档封印验证通过；六篇既有记录缺结果的非阻塞警告保留，未擅改它们。证据：[final-notes-validation.log](final-notes-validation.log)。主记录与解析环境记录已转 implemented，仍有效历史记录按部分取代／相邻分工互链，未归档旧决定。

`openspec validate fix-visual-review-and-goal-lifecycle --strict` 通过，见 [final-spec-validation.log](final-spec-validation.log)。没有自动同步主规格、归档、commit 或 push。

范围内 CRLF-aware whitespace 检查通过，见 [diff-check-scoped.log](diff-check-scoped.log)。默认 `git diff --check` 将既有混合 CRLF 算作行尾空白；开启 `cr-at-eol` 后发现本轮五处空白，已定点清理。原命令及失败结果保留为 [diff-check.log](diff-check.log)、[diff-check-crlf.log](diff-check-crlf.log)，不把它们改称通过。最终检查只排除独立任务已有的 `electron-agent/src/stores/dockStore.test.ts` 末尾空行，不批量改用户文件行尾。

一次包含整个 WorkspaceHandle 文件的过宽检查已取消、不算通过，改为 `-t 'Goal|prompt'` 的11通过／35未选，最终有范围的证据保留。其它仍失败的跨工程 tsc 也已如实列出，不以所选测试或 UI 构建通过替代。
