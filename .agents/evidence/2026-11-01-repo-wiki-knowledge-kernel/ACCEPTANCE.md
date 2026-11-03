# Repo Wiki KnowledgeKernel 验收记录

日期：2026-11-01。用户授权内核与 UI 一起改造，完整跑通生成、断点续跑、增量更新和失败修复。工作基线为已有未提交内容，分支 `codex/repo-wiki-knowledge-kernel`；未提交、推送、发布或操作真实用户项目。

## 行为验收

| 目标 | 实际执行与结果 | 证据 |
| --- | --- | --- |
| 全量 Wiki / Cards | 官方 Pi Agent 通过 Read 工具往返和生产完整消息模型桥，实际双 OS child 完成规划、页面、模块卡、仓库综合卡、关系、校验与发布。读取正式 `api`、`library`、`cards/api` 等文件，两个内容域互不覆盖 | `task-12-integration-green.log`、三份 `task-12-*.json` trace |
| 断点续跑 | 一页已 ACK、下一页实际 HTTP 在途时关闭应用；重建应用且不开 Wiki 页面，原 taskId 自动续跑。已 ACK 的规划和页面没有重复模型调用 | 同上 resume-incremental trace |
| 增量更新 | 修改 Git dirty `lib.ts`，只重做 Library；模型在途时旧正式正文、revision 和 storage_token 保持原值 | 同上 resume-incremental trace |
| 失败修复 | Library 注入两次 HTTP 500 后进入 partial，旧正式内容不变；repair 创建新 taskId，只补 Library，整批发布 | 同上 partial-repair-controls trace |
| 暂停与取消 | 手动暂停中止真实 HTTP，应用重启后仍 paused 且不发新请求；取消暂停或运行任务均落定 cancelled，在途 HTTP socket 实际 abort | 同上 partial-repair-controls trace |
| 持久预算与排他发布 | SIGKILL 独立进程后恢复已消耗预算；同 epoch 不能抢活跃租约；旧 fence 拒绝写入，journal/receipt 与索引失败可以恢复，人工编辑保留 | `final-kernel-worker.log`、`knowledge-pipeline-final.log` |
| UI 与任务中心 | 内容/运行/提交动作/准入分开显示，准备数不冒充发布数，未知总量不伪造完成百分比；暂停/恢复/修复/草稿可见，离页后台继续，旧资料 Wiki 与其他 AgentData 入口保留 | `task-11-tests.log`、`task-11-ui.log` |

真实工作流最终结果：2026-11-01 18:41:10 开始，3/3 PASS，67.70 秒。调度、存储、工具、模型请求、文件发布均走产品实现，只有 loopback HTTP 模型响应使用确定性 fixture；没有付费模型调用。

## 实跑检查

各组有重叠，不能相加为全仓测试数量。

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| 新内核 / worker / 完整消息 / 旧知识模型端口 | 25 文件，138 PASS | `final-kernel-worker.log` |
| 最终 pipeline / Cards / 恢复 / 增量 / ProjectPort | 6 文件，43 PASS；包含租约 busy 后恢复、源码 URI、嵌套依赖和同名内容域 | `knowledge-pipeline-final.log` |
| 宿主 / 旧工作流 / AgentData 任务与存储兼容 | 11 文件，98 PASS | `final-host-compatibility.log` |
| vendor 正式后端 runner | 238 PASS，0 fail | `final-vendor-backend.log` |
| vendor UI | 9 文件，71 PASS | `final-vendor-ui.log` |
| UI / 任务中心组件定向检查 | 5 文件，105 PASS | `task-11-tests.log` |
| Electron UI 场景 | 最终 Repo Wiki 135 PASS；此前直接影响的 AgentData 导航 15 PASS。只涉及 2/44 场景，空操作栏修复后仅重跑 Repo Wiki | `task-11-ui-repowiki-final.log`、`task-11-ui.log` |
| worker 独立开发/生产目录构建启动 | 2 PASS，无 node_modules 也可启动 | `final-host-build-layout.log` |
| 开发 / app.asar.unpacked 路径及许可证契约 | 2 PASS | `final-resource-contract.log` |
| 严格内核类型检查 | PASS，0 诊断，strict 保持开启 | `final-strict.log` |
| 生产构建（含 Repo Wiki 类型检查） | PASS | `final-production-build.log` |
| 可直接启动的 localrun 构建 | PASS；跳过字节相同的已锁定 guard 文件，保留正在使用的应用 | `final-localrun-build.log` |
| 目标文件 git diff --check | PASS；仅 Git 既有换行提示 | `final-diff-check.log` |
| 决策笔记门禁 | 136 篇通过，6 条既有证据措辞警告 | `final-verify-notes.log` |

独立复审覆盖租约、搜索范围、收据恢复、显式排除、Cards 映射、层级依赖及发布顺序。发现的问题已修复；恢复竞争还由审查者独立复跑，确认释放后会再次 claim 并进入 prepare。报告 `final-review-followup.md` 无未解决 P1/P2。

截图已人工检查：发布期空操作栏已移除，保留当前阶段和草稿入口；深色任务抽屉的确认卡与浅色窄屏概览可见。最终生产/localrun 构建和 UI 回归均在此修正后重跑。临时验收进程只读核对无遗留；没有关闭用户应用。

## 证据边界

- 双子进程验收覆盖应用关闭/重启与真实 HTTP 取消；预算另有真实 SIGKILL 测试。并非将计划中的每个阶段、每个文件 rename 窗口都逐一进行 OS 强杀。
- Electron UI 场景只替换主进程 I/O，验证实际组件和交互；不把这些桩当成真实 SDK/调度证明。截图与真实工作流证据分开保存。
- 未制作或发布安装包。已验证生产构建、独立 worker 启动及 unpacked 资源路径契约。
- 原 TaskViewService 的 4 条旧资料 Wiki 测试存在修改前同样失败的记录，不计为本轮新增通过。将完整 E2E fixture 额外纳入严格工程会传递拉入旧 CLI/extensions 类型链；新 Runtime 4 处诊断已修，14 处旧依赖诊断保留在 `task-12-expanded-typecheck-baseline.log`，未通过关闭 strict 或修改无关功能隐藏。实际严格产品工程及真实集成执行分别通过。
- 不承诺供应商 HTTP exactly-once；已持久确认的成果可复用，在途请求中断可能重新发出。旧计划没有默认/人工来源字段，保留完整计划约束和合法层级语义，不把所有默认 ID 强制成必选目录。
