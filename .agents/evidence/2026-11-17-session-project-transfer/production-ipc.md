# 会话跨项目迁移：生产 IPC 集成探针（任务 6.1）

脚本（均为新增，未修改生产源码）：

| 文件 | 作用 |
| --- | --- |
| `electron-agent/scripts/session-project-transfer-ipc-check.mjs` | 生产 IPC 全链探针 |
| `electron-agent/scripts/session-project-transfer-host-fixture.mjs` | 以源码加载真实 `hostEntry.ts`，只拦非 loopback fetch |
| `electron-agent/scripts/fixtures/session-project-transfer-fixture.mjs` | 真实 SDK 写的临时会话 / 子代理 / 登记 / 项目规则夹具 |

命令：

```bash
node electron-agent/scripts/session-project-transfer-ipc-check.mjs
```

结果：`PASS production source IPC 46`，退出码 0，日志 `probe-final.log`（46 条断言全 PASS）。
当前证据：`production-ipc-results.json`；`production-ipc-failure.historical.json` 是早期版本的历史失败，不代表当前状态。
`probe-run1..16.log` 保留每次迭代的失败/修复轨迹。

真实入口与数据边界：

- 子进程入口：`electron/agentProcess/hostEntry.ts`（tsx 源码加载）+ 真实 Pi SDK + 真实扩展（safety / sandbox /
  context-rules / multi-agent / usage-ledger / working-directory / session-project-transfer context）。
- 临时 HOME / agentDir / 两个项目 / 第三、四目标全部在 `tmpdir`，结束删除；`models.json` 只指向本机 loopback；
  非 loopback fetch 记 `remote-attempts.log` 并抛错。
- 主进程侧：真实 `WorkspaceService`（列表 / 项目登记 / `removeProject`）+ `installSessionProjectTransferMainGate`；
  只在探针自己的 host RPC 里做一次性 `resolveWorkspace` 故障注入（模拟提交后打开失败），不改生产代码。
- AgentData 端点是最小桩，只回答工具授权 / `codeRetrieval.call`，token 固定。

覆盖与结果（`production-ipc-results.json` 里逐条 `facts`）：

- preview：同路径 no-op / 无效目标拒绝 / 身份·leaf·revision·族摘要·目标策略 / 零写入零模型请求；真实在途回合 → `busy` 且任务不被取消。
- commit：一次 `resolveWorkspace` 故障 → `committed-needs-open`；ID、原路径、全部分支、签名、工具正文、标题、
  `session_project_transfer` marker + 目标 `working_directory` 均保留；子级与 registry 记录级迁移，源项目无关行不动；
  committed 期间两侧列表都不出现半迁移会话；计费分组已跟随持久目标。
- 回执：`status` 不重跑；重复 `commit` 不追加第二个 marker；`retry-open` 幂等补登记并打开；二次 `retry-open` 无变化。
- 打开后：只有目标项目列出；目标 runtime 持有同一 canonical path 且权限收敛为 Ask/只读；源 workspace 拒绝重开。
- 下一次显式请求：等到持久 terminal entry + `agent_settled`；真实 `read` 工具读到目标项目同名文件（不含源内容）；
  系统提示带目标 `AGENTS.md` / `.pi/rules`，无源内容；迁移事实以 system section 出现，不伪造用户消息。
- 子级：continuable 显式冷恢复在目标环境真实读数（目标文件内容）；one-shot 拒绝续聊。
- 删除源项目后主/子/null-root 历史仍可读；第二、三次移动保留单一身份、追加新目录段。
- null-root：预览 `leafId: null`、提交后在目标重开仍为空根。
- 用量：显式两次调用先断言确实各记一次（相对 commit 时增长），随后再次移动 + 两次 `reconcile` 总量不变。
- 模型请求归因：`requestTriggers` = explicit-busy / explicit-main / tool-continuation / explicit-child /
  tool-continuation / child-settlement / tool-continuation，共 7 次；快照 `postExplicitRequestCount` 之后的移动、
  retry、null-root 与 reconcile 均为 0 次新增；全部走 loopback，无远程尝试，未使用真实凭据。
- journal：最终 4 个 operation 全部 `state: opened, opened: true`，`readTransferJournalBlocks` 无残留阻塞。

未覆盖 / 需说明：

- 仍以源码入口运行；packaged bundle 路径需父代理确认后加 `SESSION_PROJECT_TRANSFER_HOST_ENTRY` 再跑同一脚本
  （`SESSION_PROJECT_TRANSFER_EXEC_PATH` 指向 Electron 时自动带 `ELECTRON_RUN_AS_NODE=1`）。
- 故障注入只覆盖“提交后打开失败”这一条真实路径；journal 各阶段故障矩阵由 owner 的定向测试负责，本探针不重复。
- 未运行旧 session-workflows 整套或无关 UI 场景。
