# Repo Wiki CLI 调用链验收

## 一条命令

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"
npm run test:repo-wiki-flow
```

最终候选：退出码 0，定向类型检查通过，临时知识 child 构建完成，9 个文件、48 项测试通过。测试阶段 24.75 秒，包含类型检查和 child 构建的整条命令 34.12 秒；原始输出见 `cli-final.log`，计时见 `cli-final-run.json`。使用两个 worker 限制 Windows 上并发导入/临时 Git 进程数量；实际耗时随机器负载变化。

## 检查的实际链路

`createGrenRepoWikiClient` → 公共 `validateRequest` → 真实 `RepoWikiService` 注册命令/作用域 → `NativeWikiController` → 生产构建方式生成的真实 Node OS child → `NativeWikiHost`/`NativeWikiProjectAdapter`/执行器 → native SQLite publication/outbox → ProjectFiles → 公开 project/page、正式 Markdown 与 TaskViewStore。

- 默认 auto 配置首次读取、空 CAS token 保存、显式费用策略、prepare/start 与实际 task_id。
- README 在初始 Git 提交中；overview 收到 README，Read/Glob/Grep/ListDir 四个工具真实执行且均无错误。固定 provider 总计 5 次调用，没有真实供应商请求。
- overview/plan/catalogue/page 检查点正文、完整 publication、任务 projectId/workspace/language、公开页面及正式文件逐字一致。
- 同确认/请求立即重试及完成后重试均复用 operation/job，不新增任务，完成后模型计数不变。
- 非本项目、私有参数、过期确认和未授权 start 被拒绝；普通脏源码在执行前期失败，provider 为 0 次。
- 同命令复用服务级 partial/repair/投影补写/人工编辑/增量/无 diff/暂停夹具，并运行 controller/model/store/host/投影/source 快单测。

AgentData 使用真实 SQLite 投影、租约和任务视图组件，本地接线替代其 RPC/全局 slot；不冒充完整 AgentData OS child 或真实全局队列。恢复分支来自直接 WikiService 集成用例，不称为这些分支的全 IPC 覆盖。固定模型输出不证明真实模型质量、供应商连接或实际费用；没有运行 UI 或重启桌面应用。

## 本轮查出并修复的问题

1. **生成输出被当源码。** 用户只读 Git 状态为 59 个 `.qoder/repowiki` 和 7 个 `docs/repo-wiki` 未跟踪文件。此前扫描器仅排除本方输出，所以在已有 Qoder Wiki 的仓库中自触发 `DIRTY_WORKTREE_REQUIRES_REVIEW`。现在精确排除两种输出树；`.qoder/rules` 与普通脏源码仍检查。
2. **旧 preflight source pin 造成下一次修复失败。** 仅在没有任何模型阶段/attempt、去除 Wiki 输出后其余 manifest 与当前完全一致时规范化当前 pin。已有生成成果和实际源码变化不适用，不更改父任务、预算或用量。
3. **任务项目身份在读回时丢失。** SQL 已有 projectId，但 `parseJobMetadata` 重建 nativeWiki 时丢字段，项目活动过滤会漏掉任务。解析器现在验证并保留可选身份，旧行和非法值边界保留。
4. **能转译却不能通过类型检查。** 修正公共 assertion 对旧请求索引类型的污染、UI RPC 联合返回推导和分块循环推导；CLI 现前置定向 tsc，失败即停止，不只用 esbuild 的能启动判断可交付。

## 验证过程

- 原服务级夹具基线 2/2 通过，但其显式 pages 和 src/** 范围绕过默认入口问题；保留该证据的实际范围。
- 新真实 child 默认链在未修改 scanner 时复现 DIRTY 错误，provider 为 0；恢复 `.qoder` 输出种子后最终通过，没有靠收窄范围规避。
- repository 回归先 2 失败/5 通过，修正后 7/7 通过；包括禁止把生成后/attempt 后的 source pin 当成可迁移预检。
- 后端 36 项检查先发现两项 projectId 丢失；修正并补旧行/非法 ID 后该文件 5/5，通过最终合并 CLI。
- 定向类型检查先失败，三处类型原因纠正后退出码 0；最终已包含在一条命令中。
- 还在外层故意设置不存在的 GIT_DIR/GIT_WORK_TREE 执行 48 项，通过并退出 0。CLI 清除继承的 GIT_*，防止临时 Git init/add/commit 被开发者环境重定向；不设置实际用户仓库环境。清理前验证临时绝对路径父级/前缀。
- 真实 child 测试由专用配置独占，默认 main 测试保留原排除规则；缺失临时构建环境时在创建资源前明确报错，不使用 skip 伪装成功。

root 负责链路、生产修正与最终实跑；Terra 交付 CLI 框架并实跑，Sol 只读独立审查未发现阻断。代码修改前副本在 `preimage/`；用户报错截图在 `user-observed.png`。

## 使用与剩余验收

以后修改 Repo Wiki 先运行上面的一条命令；只查默认生成可追加 `-- -t "default auto generation"`。当前桌面进程不会因该命令自动更新，实际载入新构建、UI 与真实模型仍由用户安排。没有操作实际生成任务、历史成果、数据库或预算，也没有发布客户端。
