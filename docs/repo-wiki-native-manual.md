# Repo Wiki：CLI 回归与人工验收

## 日常改动先跑这一个命令

在 `D:\OneDrive\Project Files\Pi\electron-agent` 运行：

```powershell
npm run test:repo-wiki-flow
```

命令依次执行定向类型检查、临时知识子进程构建和离线回归，不构建界面、不打开窗口、不连接真实模型。测试只使用临时 Git 仓库和临时 SQLite；失败退出码非零。默认 `npm test` 不承担这份需要临时 child 的专用测试。

覆盖分层如下：
- **完整公开链：** 默认 auto、README、旧 Qoder Wiki 输出 → 配置保存/费用确认 → 客户端校验/IPC/真实 Node child → Read/Glob/Grep/ListDir 真实往返 → publication/outbox/任务视图 → 公开 project/page 与正式 Markdown 逐字一致；同 request 重试不重复任务或模型调用。
- **服务级恢复：** 复用固定 provider 的 WikiService 集成用例，检查部分发布、只修失败项、补投影不调用模型、保留人工编辑、增量、无相关 diff 和暂停排空。这些恢复分支不是整条公开 IPC 链的覆盖。
- **快边界：** source pin、普通脏源码拒绝、令牌/过期确认、模型桥、任务元数据和 store/host；AgentData 使用真实投影/租约/任务存储与本地 RPC 接线，不冒充完整 AgentData OS child 或实际全局调度。

只改默认生成链时，可用同一入口点名用例：

```powershell
npm run test:repo-wiki-flow -- -t "default auto generation"
```

本轮已实际执行 CLI 和定向类型检查；桌面构建、界面和真实供应商/模型仍未验收。模型输出质量与真实费用需另行人工确认，不能用固定输出通过代替。

## 验收前确认

1. 确认正在使用的是包含本次更改的实际构建，而不是旧进程或旧安装包。需要切换构建或重启时，由用户自行安排；先记录当前任务状态，等待在途请求排空。
2. 选择隔离的 Git 测试仓库，记录项目根、分支、语言、已发布 baseline 和目标 commit；保护该仓库现有正式正文、人工修改与草稿。使用已配置的 Pi 知识模型，核对模型身份、作用范围和允许费用；外发确认前不要开始生成。
3. 打开 Agent 数据 → Repo Wiki → 当前项目概览，应看到居中的图标、状态卡、语言分段和森林绿主按钮；预算/JSON 表单默认折叠，不再需要第二个“原版 Wiki”按钮。主按钮按当前状态提供首次生成、增量更新、修复或继续，其他动作在其右侧的更多菜单。展开“生成设置 → 运行详情”或查看外发确认，核对引擎为 `qoder-wiki-local-v1`，记录 operation ID、revision 与执行状态；旧任务的失败或预算受阻不能变成当前 native 状态。打开页面、切项目或重启本身不应新建付费任务；历史 legacy 任务不自动升级。
4. 默认作者模式为 `auto`，首次生成无需改 JSON；点击“首次生成”才按需保存默认配置并准备外发确认，不在挂载时保存。取消确认不得调用模型。若要自定义，展开“生成设置 → 作者配置”；只写约束/notes 不应被当作完整页面计划。显式 `pages` 需提供安全页面 ID、标题和 prompt，可含 template/children。旧计划转换必须用户明确点击；检查被丢弃的 `depends_on` 报告，保存后再确认。若检测到外部编辑或版本冲突，重新读取配置，不覆盖他人修改。
5. “查看旧引擎历史草稿”只读展示旧任务 ID、原状态和已保存草稿；native 任务投影不能遮蔽旧记录。原来的 9 份成果仍留在旧任务中，不自动导入新引擎，也不因打开历史入口继续收费。知识卡片继续使用原来的生成路径。

用户决定载入源码版时，先保留当前状态、停止并排空任务，再自行关闭旧 GrenAgent；在 `D:\OneDrive\Project Files\Pi\electron-agent` 手动执行：

```powershell
npm run build
npm run start
```

`build` 包含类型检查，失败时先记录错误，不把旧构建当成新版本验收。这里不会替用户运行命令或重启应用；源码修改不会自动进入已运行的旧进程。

## 固定输入与界面检查（由用户自行执行）

`electron-agent/electron/wikiService/` 下的 `referencePrompts.test.ts`、`referenceParsers.test.ts`、`fullGeneration.test.ts`、`incremental.test.ts`、`sessionRuntime.test.ts`、`store.test.ts`、`service.test.ts` 和 `host.test.ts` 包含固定输入或本地替身；`reference/qoder-0.5.1/render-fixtures.json` 是完整提示词对照。`sessionRuntime.test.ts` 的 `requestModel` 是本地固定回调，不连接真实模型。用户可在 `electron-agent` 目录手动选取相应 Vitest 文件，例如：

```powershell
npx --no-install vitest run --config vitest.repo-wiki.config.ts vendor/repo-wiki/packages/contracts/src/native.test.ts
npx --no-install vitest run electron/wikiService/referencePrompts.test.ts electron/wikiService/referenceParsers.test.ts electron/wikiService/sessionRuntime.test.ts electron/wikiService/fullGeneration.test.ts electron/wikiService/incremental.test.ts
npm run test:repo-wiki-native-fixture
npm run ui:check -- repo-wiki-primary --show
npm run ui:check -- repo-wiki-native --show
npm run ui:check -- native-task-summary --show
```

这些入口会执行代码；ui:check 会构建 UI harness 并启动 Electron 窗口。`repo-wiki-primary` 检查概览居中、主按钮颜色/宽度、折叠设置和窄窗，另覆盖默认配置→准备→确认→开始、真实 task_id 回传、旧任务/9 份草稿只读、知识卡片路径与项目切换；`repo-wiki-native` 检查配置、费用和控制；`native-task-summary` 检查 completed 与部分覆盖并存、发布/可读/失败分别计数、投影错误及深浅主题。不需要跑其他无关场景或全量 UI。按需另由用户决定 `npm run typecheck:repo-wiki` 和 `npm run build`。`scripts/test-repo-wiki.mjs` 是 vendor 包与本地宿主的既有入口，会先构建子进程，不能把它视作 native 全链路 fixed-provider 验收。

`test:repo-wiki-native-fixture` 对应 `nativeWorkflow.integration.test.ts`，已纳入并执行于上述 CLI：临时 Git 仓库、真实 WikiService / WikiStore / executor / ProjectFiles 投影，模型仅用固定内存回调，不使用网络或凭据；覆盖 accepted 响应丢失、部分发布与修复、暂停排空、投影失败重放、人工编辑、旧页保留和无相关 diff advance。它模拟投影锁失败而非进程崩溃，不覆盖完整双进程宿主链路。

第一条命令仅检查公开请求合同和本地渲染转发，不启动模型：首次保存空 token、费用上限、未知字段、8 MiB 上限和旧编辑 token 规则。该文件由 Repo Wiki 专用 Vitest 配置收录，根默认 main/renderer 项目不扫描 vendor；不能省略 `--config`。本轮未执行。

建议手动保留正常概览截图：深/浅主题、窄窗口、外发确认、运行中、部分覆盖、投影冲突与旧草稿；记录使用的构建、时间和实际结果，而不只记录断言数。

## 用户授权真实模型后：全量到增量

1. **全量：** 从正常概览点“首次生成”（自定义配置则先保存），核对确认框中的 `qoder-wiki-local-v1`、模型、作者版本、分支、目标提交及 scope，再显式确认外发。记录 operation ID、任务中心收到的真实 task_id、运行阶段、实际用量与结束状态；比对完整规划、已发布页面数、失败项、原始输出/检查点和正式 Markdown。发布/补投影完成后左侧目录与阅读正文应刷新，不能只有概览数字变化。检查项目 `docs/repo-wiki/<语言>/` 的内容，不只看任务完成。
2. **失败子集修复：** 仅在确有部分失败时，记录成功/失败清单和目标提交；确认既有正文仍可读，点修复并核对目标任务及确认信息。检查只重做允许修复的失败项，成功页/人工草稿不被删改，用量连续记录。若当前没有可复现的部分失败，不要为了制造故障擅自破坏真实项目；该项留待固定 provider 夹具。
3. **无相关 diff advance：** 在隔离仓库形成仅影响排除范围文件的目标提交，确认旧 baseline、目标 commit 和实际索引范围；执行适用同步后核对 baseline 前移、正文不变、模型请求增量为 0，且同目标失败债务仍可修复。若不能观察基线或用量证据，标记未验收。
4. **有变化的增量：** 在测试仓库提交可定位的源码改动，确认目标提交和授权后执行 update/sync。核对分析、先更新后新增、显式删除、部分失败保留旧页，以及 publication、coverage、baseline 和费用。超阈值 update 应明确要求重新生成；不要默认接受整仓重做。
5. **阅读与编辑：** 阅读已发布与失败保留页面，检查 `file://相对路径#Lx-Ly` 安全定位；不存在或危险路径只显示不可定位/错误，不得访问根外文件。通过既有编辑入口修改一页，确认草稿与外部编辑冲突保护；复核切项目/语言后任务与正文没有串用。
6. **文件投影：** 有 pending/conflict/error 时先保留实际文件与冲突信息，选择投影修复；核对 publication 身份不变、不重发模型请求、修复后文件及正文一致。若无法安全制造投影故障，该分支留给固定夹具或真实故障，不破坏现有内容。

任何新出现的确定性失败先停止，不自动反复整轮生成；记录实际任务、请求、检查点、已发布页面、文件投影、用量及错误，再判断修复范围。

## 停用与降级

源码已接入 `GREN_DISABLE_NATIVE_WIKI=1`：禁止 native 的 prepare/start，同时保留 status、阶段正文和文件投影修复，不因停用而绑定模型。`userData/repo-wiki/native/projects.json` 只记录项目身份；项目文件无法 hydrate 时可恢复只读壳，再从 native SQLite 读取记录和阶段正文。用户仍需手动验证这些路径，由用户决定何时设置环境并重启；不要通过删除数据库、草稿或正式 Markdown 关闭功能。

显式保存 native 作者配置后，项目元数据写为带 native_engine 的 schema 2；当前读取器支持 1/2，冻结的旧读取器只接受 1，会拒绝接管新格式。不要手动把版本号改回 1。降级必须保留支持 native 读取的版本，或先完成可读导出；旧版二进制的实际拒绝行为尚未运行验收。投影 pending/冲突时保留完整 native 数据目录、项目 Markdown/meta、人工草稿和收据，不能只备份缓存。

## 上下文与累计费用分别记录

参考默认是 150000 上下文、16000 最大输出、10 个工作步加 1 个收尾回合；系统模型能力更小时取较小有效值，并在确认框中显示。它们不是累计 Token 额度。

新任务可在“生成设置 → 费用上限”另填模型请求次数和累计 Token 上限，空白表示不设该项累计上限。每次提交先预留有效上下文加最大输出，返回后按 actual 结算；无法确认用量时保留 unknown 预留。修复/继续沿用原任务上限和历史费用，不重置。显式继续中断会话时，已保存业务检查点仍复用；未保存 transcript 的在途 attempt 会重建会话，sessionRestartCount 和额外用量保留。

作者配置的入口仍是 `docs/repo-wiki/<语言>/author-config.qoder-v1.json`。切分支保存前将旧分支配置归档到同目录 `.native-author-configs/`；切回分支恢复其配置。revision 与文件 storage_token 同时参与 CAS，手工改正文而未改 revision 也不能被旧表单覆盖。

## 记录结果

记录构建身份、项目/分支/语言/目标提交、模型、用户确认、各项操作 ID、baseline、完整规划数、成功/失败数、partial、投影状态、人工修改、实际用量与未决请求，以及每一项通过/失败/未执行。固定参考与宿主差异见 [Qoder 参考说明](./repo-wiki-qoder-reference.md)，任务和未完成验收见 [OpenSpec](../openspec/changes/replicate-qoder-repowiki/tasks.md)。
