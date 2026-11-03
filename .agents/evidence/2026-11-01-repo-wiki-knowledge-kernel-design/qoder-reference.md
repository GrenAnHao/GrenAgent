# Qoder 静态参考摘要

分析日期：2026-11-01。用途：为 Pi 自有 KnowledgeKernel 规划提供可携带的事实摘要。不是依赖安装说明，也不包含 Qoder 实现代码。

## 分析对象

- 本机安装：E:\Qoder\resources，Qoder 0.5.1 stable。
- commit：ef0366398c9f29539600fa5513d7edb1d5208360；Electron 43.1.1。
- app.asar SHA256：64d61cffe91ef9d566c3b8a175e65949f42d9950ea8ea8ecc97604eb862ed4a9。
- 知识中心插件：qoder.knowledge.center 0.1.1。
- manifest 指定 context 插件：1.0.91.b22f2d0a，revision 2026102902，zip 59e9e0dee0076bbfc0f0f4f638faa5d573cc26f0ab50b147b5ab282147ebcad6.zip。

本地完整解包与索引留在 git 忽略目录 `.tmp-qoder-analysis/`。本规格不依赖该目录或 E 盘存在，后续实现不复制 Qoder 包或代码。

## 已确认的静态事实

1. Repo Wiki 业务在独立知识中心插件；UI 通过 node.callService 到 Node 服务，再经本地 socket JSON-RPC 调 qoder-context daemon。
2. daemon 执行 KnowledgeKit 的分阶段构建，再调用 Qoder Agent SDK / worker。普通聊天 createSession 不是这一流程的生成入口。
3. Wiki 全量包含 readme、overview、plan、catalogue、page、completion validation 与 publish。目录可逐层展开，页面可并发生成。
4. 模型阶段有 purpose 和预算，工具组包含 Read/Glob/Grep，配合 ListDir；不是把全部源码固定拼进一次 completion。
5. SQLite 保存 partition、last_run、run_history、stage_output、run_lease、run_control、host_state。正文/目录有 staging 与 published snapshot，发布验证 completion manifest。
6. 页面正文完成事件与对应 checkpoint 配对，写入后再对外透出已完成状态。resume 使用同 run/snapshot，并跳过已完成条目。
7. 增量基于 Git baseline/差异和规划；失败项可以 repair。运行失败与已发布内容存在相互独立。
8. UI 分离 contentStatus、runState、动作提交和 admission；活动单项目串行轮询、隐藏停读、重开补读。前端缓存不决定任务是否存在。
9. 桌面 daemon 受 MCP bridge 生命周期管理。有序退出可暂停，重开恢复状态；静态启动路径未见统一自动重放旧 run。resumeInterruptedRuns 配置不能直接解释为“应用启动自动续跑”。
10. 有些代码只能证明数据字段存在，不能证明校验分支实际使用。例如 resume_hash 的读写不等于已实现所有身份变化的恢复检查；UI publishedSnapshotId 检测也存在 parser 丢字段疑点。

## 本项目采纳与保留

- 采纳：业务状态机、分阶段工具执行、阶段/条目确认、恢复身份、失败修复、增量影响分析、UI 正交状态。
- 保留 Pi：AgentData 唯一任务体系、项目 Markdown/元数据事实源、用户明确要求的应用启动自动继续、现有文件 token/journal 与独立 worker。
- 不直接采纳：Qoder 账号、SDK、MCP 宿主、数据库独占正文、云同步、默认恢复策略或发现的静态缺陷。

## 方法和限制

主应用文本解出 641 文件，逐项校验 ASAR 哈希；context zip 仅提取文本。压缩 bundle 经解析器格式化，主进程混淆表仅在无 I/O 的隔离解码器中做常量折叠；保留原始字节偏移和源文件哈希。

没有执行 Qoder 业务、生成任务或原生程序，没有读取用户账号配置/凭据，没有修改安装目录。没有验证真实模型质量、成本、崩溃恢复或 UI 操作效果。规划中的可靠性承诺必须由 Pi 自己的动态测试证明。
