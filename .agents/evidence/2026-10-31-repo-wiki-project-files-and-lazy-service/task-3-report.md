# Task 3：宿主快照与按需准备

状态：本任务主干已完成，可独立审查。所有产品修改仅限分配文件；未提交/推送、未启动或重启用户应用、未访问真实 7 个项目、未调用付费模型。开工前 dirty 由主任务保留，没有恢复或覆盖无关修改。

## 更改

- `vendor/repo-wiki/packages/contracts/src/host.ts`：共享 HostProjectSummary、HostProjectsSnapshot、HostActivation、hydrate/release DTO 与 request/response maps。状态为 bound/pending/empty，宿主显示 key 不冒充 Wiki DB id。`repoWiki_release` 使用 expected context token，旧 A 的迟到 release 返回 false，不清理 B。
- `electron/app/workspaceService.ts`：同步 `getProjectSnapshot()` 返回内存副本；`readProjectSnapshot()` 仅读宿主登记 JSON，绝不逐根 stat/realpath。非法 JSON/读失败撤销同步权限快照并抛错，ENOENT 为受控空集合。已有登记读取、写入、listProjects 同步刷新快照；补无 I/O 的 scratch 分类。
- `electron/main.ts`：Repo Wiki 的权限来源改为 metadata-only readProjectSnapshot，另注入同步快照与 scratch 分类；启动时后台 prime 一次宿主元数据并通知。使用局部补丁，保留 main 中其它 dirty。
- `electron/app/repoWikiService.ts`：activate 仅词法绑定可信窗口、路径/语言/context；hostProjects 仅同步快照。hydrate 才重读宿主登记并只实查当前 canonical root，然后调用 scoped cheap create/hydrate。没有全 roots create，没有激活模型准备；health 与列表显示不启动 child。
- 直接注册公开 ACTIONS，仍逐请求 strict validateRequest、窗口/顶层 frame/context/project binding 校验；去除 vendor 每请求先读取整个 project 的重复授权路径。run/cancel 不进入模型/configuration/扫描等待链。
- 普通 workspace/language 切换只 cancelContext/轮换 token、释放 lease，PID 保留；仅权限根集合变化、物理崩溃或失败后的显式 retry 涉及 supervisor 更换。错误预算仍由 process client 管理，不重放 mutation。
- 生成前固定 model binding → registerModelLease → invokeScoped；保留 RepoWikiKnowledgeModel 的 expectedModel/expectedConfiguration/共享知识调度，不改它已有实现。lease 在对应 run 终态、取消、context 退出与 stop 清理；迟到旧 run 终态不能清理新 run 的 lease。
- `repoWikiService.test.ts` 按新契约重写真实 wire-child 回归；`repoWikiLazyHost.test.ts` 新增冷绑定/快照/错误撤权回归。

## 信任边界

renderer 的 registeredProjects 只负责显示，不授予权限。宿主持久化登记是 canonical authority（由 ensureWorkspace 持久化）；activate 的 bound 仅表示已登记匹配，不代表可直接访问文件。hydrate/数据准备只对选中 root 调 async realpath，结果必须与登记 canonical 路径等价；root 后来变 junction/symlink 时返回 403，不能把新 target 自动提升为授权根。

每次异步等待后重新检查 context、sender trust 和同步宿主权限快照，包括 child 启动完成后、向 child 发起可能写项目文件的 hydrate/create 之前。读失败时 fail closed。run/cancel 可使用已绑定的 project/context，但 child 仍负责目标路径校验；撤销 scope 的私有控制面不依赖目录可用或模型配置。事件保留原 context、物理 child instance、project/run 身份，不能在迟到事件上重新贴当前 token。

宿主 registry 通知按 context/project/revision 去重；prepare 读到快照不会额外触发项目登记通知，订阅回调与显式刷新并发仍只通知一次变更。

## RED 与验证记录

开始时先运行新增测试，旧 activate 的失败原因是实际进入 allowedWorkspaces（抛出 `activation read host roots`），另两条发现 snapshot API 尚不存在；随后新增 corrupt registry 回归先失败为 promise resolved [] instead of rejecting，再实现 strict/fail-closed。这些初次 RED 只有工具返回记录，未保留原始 stdout 文件，未伪称有 RED 原始日志。

Windows sandbox 的 SSR cache rename 和对测试新建目录 realpath 产生 EPERM。先用工作区 TEMP 避开缓存错误，最终相关隔离 fixture 测试在正常权限下运行；这是执行环境限制，不是产品回归证据。临时 `.tmp-host-test` 缓存已在确认绝对路径后清理。

从 `electron-agent` 运行的命令与实际 stdout：

| 命令 | 结果 | stdout |
| --- | --- | --- |
| `npx vitest run electron/app/repoWikiLazyHost.test.ts electron/app/workspaceService.test.ts` | 48/48 PASS | `task-3-host-first-green.log` |
| `npx vitest run electron/app/repoWikiService.test.ts electron/app/repoWikiLazyHost.test.ts electron/app/workspaceService.test.ts` | 首轮 63/63 PASS | `task-3-host-regression.log` |
| 同上，追加 startup 授权竞态与旧 run 终态/lease 回归 | 最终 65/65 PASS，3 files；无跳过 | `task-3-host-regression-final.log` |
| `npm run typecheck:repo-wiki` | 当时 exit 1；host/task3 文件没有诊断，其它 owner 正在编辑中的 UI types 与 service factory 诊断已回报相应 owner | `task-3-typecheck.log` |
| `node --import tsx ../.tmp-repowiki-optimization/task-3-activation-benchmark.mjs` | exit 0；7 根纯内存 fixture activate 14.1502ms、hostProjects 0.1783ms；registry/model 调用均 0，child PID null | `task-3-activation-benchmark.json` |

最终 65 项包括 WorkspaceService 原有 44 项、新 lazy-host 4 项、host service 17 项。覆盖当前根唯一 hydrate、语言 namespace、A-B-A 同 PID 与不同 token、旧请求/事件拒绝、模型仅生成前准备、不同模型缓存身份仍同 PID、真实 wire model abort/retry、expected token release、窗口/frame/导航、未经授权/撤销/坏登记、junction 变向、启动等待期间撤权、mutation crash 不重放、退出等待与 lease run 隔离。

## 边界与交接

- 14.15ms 是 cold host API 的内存 fixture 测量，不含 Electron 首屏、真实目录、文档迁移或扫描；不能当成与现场 33.48s 完全同环境的端到端加速比。
- 这里的 wire child 替换 engine 与 provider，用于宿主授权/生命周期验证；真实 core 存储/迁移、异步扫描和双 child/SDK loopback 由 task 5 owner 验证，不用本报告的桩宣称已经覆盖。
- typecheck/build、唯一 repo-wiki UI harness、verify-notes 和跨任务最终检查由 root 统一执行。本任务没有跑其它 UI 场景或全仓测试。
- 独立审查可进入；本 agent 继续响应审查问题。需要关注跨层的 scoped run 取消、项目文件 CAS 和模型派发前身份校验，未削弱这些既有契约。

## 同路径重挂载 ownership 后续修正

UI 收尾确认了另一条真实竞态：首次 activate 的响应尚未送到旧 panel，旧 panel 已卸载；新 panel 立即选择同一路径。如果仅按路径复用 token，旧响应迟到后的 release 会撤销新 panel。不能用每次 activate 都换 token 解决，否则同一 panel 的登记通知/重试会反复失效。

共享 `HostActivationRequest` 增加可选 `view_id`，每个 RepoWikiWorkspace mount 使用一个稳定独立 ID，每次 activate 都携带。主进程 owner 是 `(trusted sender.id, view_id)`；owner 改变时，即便同路径/同语言也同步 cancel 旧 scope、释放旧 model lease 并轮换 context，child PID 保持。相同 owner 的同路径通知刷新保留 token 和语言。未传 view_id 的旧 direct API 使用 sender 默认 owner 兼容。迟到 release 仍只针对 captured token，新 owner 的 token 不同，因此旧 cleanup 返回 released:false。

两条新 host 测试先精确 RED：允许字段进入后，断言显示重挂载 token 相同，以及 ownership 转移未 abort 旧 model signal（无未处理错误）。原始输出在 `task-3-view-ownership-red.log`。实现 owner 绑定后运行：

`npx vitest run electron/app/repoWikiService.test.ts electron/app/repoWikiLazyHost.test.ts`

结果 23/23 PASS（host 19 + lazy 4），stdout 在 `task-3-view-ownership-green.log`。同时覆盖同 view 重试不换 token、语言通知刷新保留选择、旧 release 不影响新 view、model lease 转移取消与 PID 不变。WorkspaceService 未修改，因此没有重跑其已通过的 44 项；没有扩大 UI 场景范围。UI owner 另覆盖首次响应被 hold 的真实 React 卸载/同路径重挂载路径。

## 最终测试边界类型修正

全 Node strict 工程发现测试构造的最小 window/WebContents fake 不满足完整 Electron BrowserWindow 类型，引入两条新类型诊断。仅在测试可信边界增加 type-only BrowserWindow import 并把同一 fake 对象明确 cast 为 BrowserWindow；没有给 fake 增加虚假方法、替换对象身份或改变生产 sender/frame 信任逻辑。

- `npx vitest run electron/app/repoWikiService.test.ts`：19/19 PASS；stdout `task-3-test-boundary-cast.log`。
- `npx tsc -p tsconfig.node.json --noEmit`：exit 1，诊断由 152 回到 150；`repoWikiService.test.ts` 的两条诊断已消失，其余 150 条由 root 对照既有诊断处理，不宣称全 Node strict 已通过。stdout `task-3-full-node-typecheck-after-cast.log`。

生产源码在本轮保持冻结。最终审查确认的模型配置边界是“新派发必须通过 expectedConfiguration 校验”；已在执行的旧 HTTP 不因 refreshConfiguration 通知主动中断，context 切换/关闭/取消仍立即 abort。它与更早只读设计建议中更强的“配置变化主动取消旧调用”不同，最终验收以 root 已批准的派发前校验范围为准。
