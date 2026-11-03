# Repo Wiki 项目文件与按需服务审查

日期：2026-10-31。当前阶段：方案 / 跨边界契约 focused 预审，尚未收到最终任务 diff 包。以下为需明确的设计契约与最终代码审查检查点，不把并行实现的暂缺视为发现。

只读范围：AGENTS.md、proposed note、实现计划、storage / instant-host 两份设计报告、四份冻结任务 brief，以及少量当前接口定位。未运行测试、未读取用户项目或真实数据库、未重启应用、未调用 provider。仅新增本审查报告；没有修改产品代码。开工 567 项 dirty 与 87 份源码基线由主任务保留，最终只审查任务相对该基线的变化。

## 需尽早裁定的契约

### 1. 页面与计划的文件 CAS：统一 numeric revision / token 的职责

存储设计报告建议 `storage_token` / `expected_storage_token` 和 `plan_storage_token` / `expected_plan_storage_token`，但冻结 brief 未规定这些字段，存在 core、action 白名单和 UI 各实现一部分的风险。已分别通知 core、service、UI、host owner 与 root。

core owner 已回复页面采用：外部 Markdown hash 变化时分配更高语言级 numeric revision；该 counter 覆盖所有 namespace，现有 `expected_revision` 因而可以拒绝旧页面写。`storage_token` / 可选 `expected_token` 作为附加保护。该方案可接受的必要条件是：每次 edit / resolve 都先刷新真实 Markdown 和受保护 metadata，再执行 CAS；不能只在此前某次 get_page 刷新。计划没有相同的 numeric CAS，仍须统一计划读取、更新与生成前后核对的 token / revision 策略。主任务需给出唯一字段名及 embedded / standalone 兼容规则。

UI 草稿必须保留开始编辑时的 revision / token；后台刷新不得用新 token 替换旧草稿的 base。冲突响应保留草稿。否则即使后端 CAS 正确，UI 也会绕过冲突检测。

### 2. 每个 run 的 model cache key 必须在 fingerprint 前固定

`registerModelLease(id, {cacheKey, complete})` 和 `modelRequest.modelLeaseId` 只解决了请求路由的一半：引擎计算 fingerprint 时所见 provider cache key 也必须来自同一不可变 lease，而非长驻 child 启动时的 key。否则模型 B 可能命中模型 A 的生成缓存，即使实际 completion 路由已正确。

最终应验证 submit 时固定 context / workspace / project / configuration / cacheKey，provider identity 与 completion 使用该 lease；lease 撤销后，迟到请求失败，不借用当前上下文模型。切换与 timeout 不能只 reject 父 Promise 而让 child 继续生成或提交。

### 3. scan 单飞与取消所有权必须共同设计

scan 合并键至少应包含 workspace / language / target；不同 wiki/cards 不能因为同一 project 错用结果。必须明确是否跨 context 合并：若只同 context 合并，A-B-A 的新 A 不得复用旧 A 已取消的 promise；若跨 context 合并，任一 waiter's timeout / 旧 context cancel 不得错误终止仍有合法消费者的任务。in-flight 删除应核对 promise / task 身份，避免旧任务 finally 删除新任务。

最终代码审查应分别跟踪 request AbortController、scan owner 与 run AbortController，检查 cancelContext 和 cancelRequest 真正到达异步扫描、主机 completion / AgentData / HTTP，并在文件不可中断发布段前做最后取消检查。

### 4. 无 I/O 宿主快照仍须保留 canonical 授权来源

`readProjectSnapshot()` 不逐项目 realpath 的优化不能将 renderer 路径、可编辑登记字符串或 hydrate 时得到的新 realpath 直接提升为授权根。需区分“登记路径用于展示/匹配”和“此前由宿主确认的 canonical 根”。activate 可绑定登记；hydrate 仅实查当前根，并在 await 后重新校验 context、sender / frame、snapshot revision、登记是否撤销，以及 root 是否仍对应授权 canonical 身份。

快照失败必须 fail closed。child 启动的空 roots 是 embedded deny-by-default；不能继承 standalone 的 `[] = unrestricted`。child constructor 也不应为 7 个 roots 再做 canonical I/O，当前根实查放目标访问路径。

## core owner 已确认的边界

- hydrate 无 Git；使用 project.json 的持久 identity / namespace；无历史时 local / unknown。scan 刷新 identity 后切换 namespace，以语言级全 namespace 唯一 revision 拒绝旧 UI 写。
- journal 含 before 独立备份；recovery 遇到既非 before 也非 after 的未知 hash 则 blocked。
- blocked 项目整体拒绝应用 get / list / data 读取，不返回已经部分发布的混合视图。

最终需核实这些断言的实际代码和故障注入证据。普通 hash-check + rename 与任意外部编辑器之间仍非原子 CAS；报告必须保留这一明确工程边界。不能宣称任意时刻外部写入绝对零丢失。

## root 已冻结的跨边界决策

root 在预审反馈后统一通知所有 owner，以下取代上文“需裁定”的未决状态，最终审查按此验收：

- 页面返回 `storage_token`，项目返回 `plan_storage_token`；edit / resolve 输入 `expected_storage_token`，plan 输入 `expected_plan_storage_token`。提供时为 64hex；embedded service 缺 token 返回 409；core / direct legacy 可选。
- UI 使用打开编辑器 / 计划时的原 token。numeric revision 每写前先刷新磁盘，计数器持久化且覆盖所有 namespace。generation / import commit 同样执行文件 CAS。
- scan scope 至少 project + language + target + context；不跨 context 复用旧 promise，旧 A 的取消不能终止新 A。
- model lease 在 submit 前固定 cacheKey。

## 最终 diff focused 检查点

### 文件事实 / 迁移

- 提交在同文件系统 staging、before/after hash、prepared / committed 标记、完整 fsync 与锁；已发布部分发生失败后，任何读写先恢复或明确 blocked。缓存写失败不得把已经成功的文件提交判成丢失。
- 当前 canonical workspace + language 才触发旧库导入；该语言必须迁入全部历史 namespace、wiki/cards、baseline、pending、archived、sources、计划、revision counter。不是仅迁当前 Git branch。
- 原 DB / WAL / SHM 不由 SQLite 直接打开；copy-first 副本查询，源快照前后名称、stat、hash 不变；源损坏 / 忙 / journal / 改变不得静默创建空知识。旧原件不迁 schema、不清理。
- 项目文件完整有效时优先，不因 receipt 中旧 hash 与人工编辑后正文不同而重新迁移。目标同名非本产品文件、partial target、ambiguous legacy project 均保留并报冲突。
- 删除或损坏新缓存后，以项目文件恢复全部内容与 counter，不再依赖旧库。不同 clone 的同磁盘 project_id 必须按授权 workspace + language 隔离缓存。
- docs/repo-wiki 产物必须从枚举、worktree hash、dirty / tracked-deletion、watch 变化中强制排除，防止自我摄入与自动重复生成。

### 宿主 / 租约 / 热路径

- activate 和 hostProjects 无 model、child、project filesystem / Git；当前 hydrate 不访问其他 6 个 roots。
- project / changes / run / health 不 scan，不通过 registration 的昂贵 project 预读间接 scan；source 读取不能为一个范围全仓 scan。
- list_projects / metadata index / child construction / inactive watch 不逐项目 Git；只读 unknown 不伪装 no-change。
- 取消、状态读取不排在 ensureConfiguration / scan transition 后；普通 A-B-A 不重启 child，旧 request / progress / model response 使用原 scope，不贴当前 token。
- 无 2500ms detail+changes+run interval，无 idle watch 1500ms 全列表；活动 run poll after-settle 单飞，terminal 只刷新一次，卸载 / 切换清理。
- model cache key、lease 配置身份、core fingerprint 一致；撤销 / 配置改变 / child crash / retry 预算失效均 fail closed，mutation 不自动重放。

## 验证结论

尚未进行最终规格符合性与质量审查；本 reviewer 未运行任何测试。待 root 提供最终任务 diff 包与各 owner 证据后，按以上边界给出确定发现及准确文件行号。

## FINAL — 最终规格与质量审查

审查输入为 `.tmp-repowiki-optimization/final-review-package.md` 与 `review-source-manifest.json`（42 个任务文件，约 525KB），以本轮 87 份基线快照过滤已有 dirty；分块阅读生产路径、测试差异、task-1..5 报告和对应日志末尾。后续 Worker / close 及发现修复另按 delta 复核，不把原本 567 项 dirty 的无关改动计入。reviewer 没有重跑已通过检查。

### 已发现并立即交 owner / root 的 Important

1. **复制项目的 portable project id 覆盖另一根的派生状态。** 候选版 `engine.ts:442` 的 `files.set(p.id, store)`、`projects(id PRIMARY KEY)` 与 pages/snapshots 按 id 删除，使复制同一 `docs/repo-wiki` 的两个根以相同磁盘 id 互相替换。直接后果是列表丢一项、读写/运行记录可能指向后加载根。源代码可直接证明；本 reviewer 未运行新复现。core owner 正在加入真实双 root 夹具并按 canonical workspace + language + portable id 构造稳定的运行时缓存身份，保留磁盘 portable id。
2. **Windows 已有大小写目录会漏掉产物排除。** 候选版 `scanner.ts:30` 的严格字符串匹配无法识别 `Docs/repo-wiki` / `docs/Repo-Wiki`；Windows 文件系统却把 `ProjectFiles` 的固定 `docs/repo-wiki` 写入同一物理目录。枚举路径保留大小写，因而自己的 Markdown 可进入源码和 worktree hash；`service.ts:632` 的 watch 排除也同样遗漏。静态路径链明确。core / process owner 正在共用按平台处理的输出判断并加 Windows 定向夹具。
3. **外部 Markdown 编辑后直接导出仍取旧缓存正文。** 候选版 `engine.ts:1158` 的 export_markdown 只调用不刷新文件的 get_project；hydrate/get_page 后外部改 `.md`，不再经 page/scan/write 而直接 export 时会导出旧 SQL 正文。事实原件仍保存，但导出产物错误。core owner 已接收，仅在显式 export 刷新当前 facts，不增加普通状态热路径的全量读取。

### 按任务的规格与质量结论

| 任务 | 当前结论 | 审查依据与重点 |
| --- | --- | --- |
| 1 文件存储 / 扫描 | 规格通过；质量通过，发现均已闭环 | 文件先发布，SQLite 投影可删除重建；计划/全文 metadata/全部 namespace/baseline/pending/archive/revision 在项目内。每次 mutation 刷新磁盘，embedded token CAS 贯通；generation 在最终 source/plan 验证后按最新人工正文三方合并。journal 保存独立 before 文件，未知 after/before hash 阻断项目。旧库只经副本读取，当前根+语言导入全部 namespace，不扫描其他根。 |
| 2 service / process | 规格通过；质量通过 | create 为 hydrate，project/changes/run 不源码 scan；作用域附在请求及原 run，provider cache identity 在 submit 固定。cancelRequest、cancelContext、host completion、core signal 均实际贯穿。Worker 使用同 host bundle，不新增打包资源；主进程端仅在 worker exit/terminate settled 后兑现 snapshot Promise，core finally 再清 temporary。 |
| 3 host snapshot / 权限 / view | 规格通过；质量通过 | activate 只词法绑定、同步快照、可信 window/frame；hydrate/data await 后重查同 context/sender/登记，当前 root realpath 必须匹配已登记 canonical，不遍历其他根。child 启动完成后再次核权再 hydrate。view_id 每次挂载独立、同 view 重试保持，release 只撤销 captured token，旧 view 清理不能撤销新 view。普通导航同 child PID；lease 按 context/project/run 释放。 |
| 4 即时 UI / 更新 | 规格通过；质量通过 | 首 render 直接宿主七项目 summary，无假 Wiki id；activate/hydrate 未返回仍可选择。无固定 detail+changes+run interval；活动 run only after-settle 串行 poll，事件拒旧 token/instance/sequence。page/plan 保留开始编辑 token，冲突留草稿；卸载含在途 activation 的 captured-token release。 |
| 5 实际链 / 证据 | 指定集成范围通过；证据与最终生产源码一致 | 真实 WorkspaceService→RepoWiki child→AgentData child→WikiService→ModelRuntimeHost/Pi SDK→loopback，只有 fixture 与本地 provider。12 项记录涵盖首屏按需、当前根迁移、扫描响应/取消、cache 删除重建、共享预算/配置和 HTTP cancel；没有把 UI 桩当后端证据。 |

### 专项判断：core physical scan 共享

`engine.scanFlights` 的 key 不带 context/target，但共享的是同 path/语言/include/exclude 的纯 source 扫描结果，且每个 caller 有独立 signal 与 users 计数；最后一个 caller abort 才终止物理任务，删除 map 时核对 promise 身份。`scan_project` 在 await 后先 checkAborted 才发布 current_identity，generation 也继续核对自己的 signal。因而这层物理共享本身没有发现旧 A 取消杀新 A、或被取消 caller 发布结果的错误，不能仅凭少 context 字段判错。

service 的显式 scan 包装也给 waiter 独立取消。`cancel(projectId)` 会 abort 对应全部显式 scan；生产导航的 cancelContext 消息先于新 scope 请求发到同 IPC channel，目前未定位新 A 被旧取消终止的可达路径。以上是静态判断，已有真实 A-B-A / timeout 测试为配套证据。

### 明确工程边界（不作为阻塞缺陷扩围）

- 普通 hash 核对 + rename 对任意外部编辑器不是内核级原子 CAS；独立 before image 和 blocked recovery 是此次承诺。任意外部读者也可能在多文件发布中看到中间态；应用读者受存储锁/恢复隔离。
- root 已明确：本次不新增通用 corrupt-cache 自动 quarantine / autoheal。坏新缓存可明确失败，事实文件保留；删除 fixture 缓存后重建须完整恢复。坏 generation-cache JSON 可按 miss 小修；事实发布后 SQLite COMMIT 失败需故障夹具证明事实未丢、重读/重建可恢复。旧 workspace.sqlite3 不参与自动修复。
- root 已正式裁定配置边界：每个 run 固定 model lease/cacheKey；实际派发前执行 expectedConfiguration / expectedModel 校验，设置变化阻止后续旧配置派发。已派发 HTTP 不因设置变化自动 abort，显式取消、切项目和关闭仍会 abort。不新增定时 resolveModel；早期设计报告中的更强“模型变化主动取消旧调用”建议未采纳。
- 318.8ms 是静默 Electron 生产 UI fixture 的 ModuleRail click→首 DOM（七 summary 和当前壳），7.778ms 是内存宿主快照 activate API；均不是对用户 OneDrive 七项目/旧 33.48s 样本的同环境重测。

### 已阅读的验证证据

日志末尾直接确认 core 初版 143/143，service/process 初版 67/67，host 65/65、view ownership 23/23，React 30/30、vendor 71/71，实际 repo-wiki harness 76 PASS / 0 FAIL（仅 1/44 场景），最新 Worker 真链 3 files / 12 tests PASS。root 通知后续 core144+snapshot hook15、process Worker Node22 等增量；这些增量与 Important 修复尚待本 reviewer 阅读最终 delta/日志，不能冒充已由 reviewer 重跑或最终全部通过。

### 最终 delta 回审与发现关闭

已完成 `.tmp-repowiki-optimization/final-review-delta.md` 的 14 文件 focused 回审，仅核对上述发现修复和增量引入的风险。读取当前生产 source/定向 fixture、owner 报告及日志末尾，并对 `review-source-final-manifest.json` 的全部 **42 文件**执行只读 SHA256 核对，**0 mismatch**。Task 5 最终 source snapshot 与该 manifest 重叠的 **10 个生产输入**也全部匹配；aggregate identity 为 `694c72cb01ed81c40bd46f72882346582b9f9c5459a236939adcc855b28cf775`。

- **Important 1 已关闭。** runtime/cache `id = hash(canonical workspace, language, portable id)`，返回 `portable_id`；文件保存还原 portable id、不写 runtime id。复制双 root 独立 page/plan、反向重建 cache、A-B-A 均有 fixture。旧投影按 cache_metadata 版本一次性清除；facts/旧 DB 不改。另补同根 portable id 变化护栏：旧 runtime request 先 409，hydrate 退役旧 files/scans/SQL 后绑定新 id，旧 API 404，避免旧 facts 写回新身份。
- **Important 2 已关闭。** scanner 的统一 `isKnowledgeOutput` 规范分隔符并在 Windows fold case，枚举/身份/deletion/source/watch 共用。native Windows `change Docs` 祖先目录重复通知也过滤；保留普通文件及目录 rename 通知。fixture 同时覆盖 embedded / standalone：Wiki 写入和外部 Wiki 编辑不触发 source scan，普通 Docs/guide 仍触发。核心跨平台测试按 POSIX case-sensitive 条件期望，没有跳过来隐藏问题。
- **Important 3 已关闭。** 显式 export 先刷新当前事实文件，再构造 Markdown/manifest；fixture 外改正文后直接 export 含新内容，并保持 source scan timestamp 不变。
- **增量无新 Important。** mutation 只 refresh 当前 project，避免已访问但不可用的其他 root 拖垮当前操作。坏 generation JSON 为 miss；新 DB 损坏明确 503 且关闭句柄，facts 保留。文件已发布后 SQL COMMIT 失败返回“文件已保存、缓存失败”，重新读取及删除 fixture cache 重建恢复新增文字。初始 mkdir 的 EPERM/EACCES/EROFS 在服务边界明确 403 并隐去原始路径，失败不假装只存 cache 成功。
- **Worker/close 已闭环。** actual Node22 child 使用同 bundle worker；service dispatch 的 controller/request 集合在 close 时 abort 并 await，接着 worker terminate/join、core finally 清 staging、engine close、child exit。约 50MiB 旧库 fixture 覆盖 copy 期间 health、cancel/retry、stop 后无 staging；旧 DB hash 与未选项目目录保持。

最新已读证据：core affected 5 files **98/98**（`task-1-identity-core-final.log`，strict 无诊断）；process/service aggregate **68/68**、Windows watch affected **24/24**、permission focused **2/2**；host view **23/23**，最终仅 fake 类型 cast 后 **19/19**；UI 的 React **30/30**、vendor **71/71**、repo-wiki **76/76**不受后端增量改变；最后重新编译的真实 SDK/双 child/Worker 集成 **3 files / 12 tests** 通过（`task-5-integration-identity-final.log`，6.90s）。最终 API cold activation 样本更新为 **7.576ms**；UI first-visible 仍 **318.8ms**，都保留不同于旧真实项目 33.48s 的测量边界。

reviewer 还独立打开了 cold-host-first-frame 与 generation-consent 两张最终截图：七项目与当前壳同屏、局部准备提示、森林绿样式及知识模型确认行均可读，无明显裁切/遮挡。没有因此重跑 harness。

**结论：任务 1–5 的上述规格与质量审查通过，未决 Important = 0。** 本 reviewer 仅做静态/证据/截图/源 hash 审查，未运行测试或访问真实数据；生产 build、asar.unpacked 路径 smoke、笔记落地及 verify-notes 的最后门禁由 root 完成，本报告不提前宣称这些尚在执行的门禁已通过。全 Node 工程剩余 150 条既有诊断也不表述成全仓类型检查成功。
