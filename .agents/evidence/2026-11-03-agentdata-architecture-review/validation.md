# AgentData 架构评审验证记录

交付对象：`2026-11-03-agentdata-lightweight-decoupling-review.md`，状态 proposed。

## 本轮有效证据

- 以当前工作区源码和配置追踪端到端调用；三条调查线并行只读，独立审阅复核关键合同，修订见 `review.md`。
- 本机只读采样成功。`read-only-inventory.mjs` 直接使用 SQLite `readOnly: true`、`PRAGMA query_only=ON`，查询 schema、表名、计数和任务分组；没有调用应用 Service 或迁移/恢复方法。进程只记录角色、PID/父 PID 和内存，不保存命令行或密钥。诊断仅读取末尾至多 2 MiB；目录发现有深度界限，因此不声称全盘数据清点。
- 结果见 `inventory.json`；观察时共享库 845.86 MiB、schema7、22条Job均终态，Native 三分区中仅一分区有一个失败操作，不能外推总体模型生成成功率。

## 文档检查

命令：

```bash
node .agents/evidence/2026-11-03-agentdata-architecture-review/validate-document.mjs
pnpm exec tsx .agents/skills/write-notes-like-deepseek/scripts/verify-agent-note-format.ts
```

结果：两条命令退出码 0。报告 690 行，15 个相对文件链接、41 个显式完整源码路径锚点和 4 个 Mermaid 图通过存在性/行号上限/语法检查；149 篇笔记格式通过。源码锚点检查不代替人工对结论的核查，也不覆盖证据表中的相对缩写路径。图表做语法解析，未声称验证客户端最终布局。

对应输出：`document-check.json`、`note-format.log`。

## 仓库级检查未通过

命令：`npm run verify-notes`。

退出码 1；停止在 tree/link 阶段：

```text
link: proposed/bug-fix/2026-11-02-repo-wiki-generation-validation-repair.md -> "../content/modules/pocock/categories.md" target file does not exist
```

失败位于本轮未修改的既有提案，不是本次新增报告链接；未扩大范围修改那篇文档。因为总脚本使用 `&&`，后续 archived/evidence 检查没有由此命令执行；格式检查已单独执行通过。完整日志在 `verify-notes.log`，不能宣称仓库级门禁全绿。

## 未执行的工作

未改产品代码、现有配置或生产数据；未构建、重启应用、启动 UI harness、运行产品测试、扫描源码生成 Wiki、重建索引或调用模型。没有提交、推送或发布。既有进程继续运行。

这份评审稿能用于确认当前代码链路、架构边界与迁移顺序；实际 bundle 对齐、UI 视觉复现、生成效果、最大规模性能、遗留 lease/outbox/journal 债务和迁移恢复仍依报告相应阶段验证。
