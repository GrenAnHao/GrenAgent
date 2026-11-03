# 子代理“0 个”展示修复验证

修复了非空 task 同时带 tasks:[] / chain:[] 时，真实子代理被展开为零行的问题。有效任务序列现在统一决定单卡/组卡、标题、模型与详情索引；chain 的优先级及单步结果身份保留。单任务后续结果继续并回原卡。组卡在调用级失败时显示原始错误正文，限高 160px 并跟随主题；部分失败仍保留成功项。

本次仅修改前端展示及对应回归、场景文档；后端启动、权限、调度及模型设置保持原有行为。

验证结果：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 修复前新回归 | 8 条预期失败，确认捕获零行、身份丢失、跟进结果与错误丢失 | [vitest-red.txt](vitest-red.txt) |
| 修复前真实 Electron 场景 | 15 条预期失败，重现零项单卡/链式等 | [ui-red.txt](ui-red.txt) |
| 修复后相关单元测试 | 4 文件、88 项通过 | [vitest-green.txt](vitest-green.txt) |
| 修复后 subagent-history | 32 条通过：成功/拒绝、单步与多步 chain、混合元数据、后续结果、真实参数流、重挂载、浅色主题 | [ui-history-green.txt](ui-history-green.txt) |
| 修复后 subagent-detached | 23 条通过：运行/完成/中断、身份恢复及停止轮询 | [ui-green.txt](ui-green.txt) |
| 笔记校验 | npm run verify-notes 退出 0；原有六条历史笔记警告保留 | [verify-notes.txt](verify-notes.txt) |
| 定向 TypeScript 检查 | 退出 1；改动文件无诊断，两个未改文件报错 | [typecheck-with-setup.txt](typecheck-with-setup.txt) |

首次 UI 合跑中，历史场景的业务断言通过后，新 probe 给 t.style 传了字符串，API 实际要求属性名数组，造成主题检查报错。修正 probe 后单独复跑 subagent-history 全部通过；harness 自身未修改。合计只验证本需求相关的 2/34 个场景，未跑其他 32 个场景。

定向类型检查的两个错误位置是 `electron-agent/src/features/chat/messageActions/types.ts:2`（相对导入路径）与 `electron-agent/src/features/tools/StreamingCodeView.tsx:81`（高亮主题类型不匹配）。这两个文件 git diff 为空，本次没有扩大范围处理，不能宣称项目类型检查通过。

修复后的实际 Electron 截图：[ui-empty-arrays-light.png](ui-empty-arrays-light.png)。

决策笔记：[2026-10-28-subagent-empty-array-display.md](../../notes/implemented/bug-fix/2026-10-28-subagent-empty-array-display.md)。历史调查材料在相邻的 `2026-10-28-parallel-subagent-investigation/`，描述的是修复前状态。
