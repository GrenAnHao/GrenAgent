# Agent Note: 保留会话身份的跨项目移动

Status: implemented

## Problem

用户在错误项目中聊天后，无法修正会话归属。`working_directory` 只改变工具 cwd，不重建项目规则、权限根及运行环境；直接改父会话 header 也会被旧 cwd 恢复、子代理 metadata 和旧 runtime 抵消，并可能让删除源项目误删子级历史。

本功能按 OpenSpec 实现，已通过迁移定向测试、真实 SDK／生产 IPC 探针及新增 UI 场景。完整需求及设计见 [OpenSpec 变更](../../../../openspec/changes/move-sessions-between-projects/proposal.md) 与 [设计](../../../../openspec/changes/move-sessions-between-projects/design.md)。

## Decision

主会话及已结算的关联子代理构成迁移族；保留 ID、条目和 JSONL 路径，只迁移项目身份、可恢复的 cwd／子代理登记并重建目标 runtime。整树写者及冲突操作必须先冻结；有运行或排队任务、待处理交互或未知状态则拒绝，不替用户停止任务。Goal 必须持久暂停（只在内存 disarmed 不够，目标的 autoContinueOnOpen 可能重新武装）；已确认／执行中的 Plan 同样拒绝。纯 idle 缓存刷新通过会话级 decision fence 暂停，不改持久预热设置；已在途的刷新等待结束后再移。已结算 worker 的 dispose 要等回执／退出，超时保留隔离写者，不因离开驻留池而误判空闲。

使用宿主持久 journal 与逐文件 before/after 校验保护多文件和 registry 更新。提交前故障回滚源；提交后目标打开失败报告已移动并提供重开，不能自动重跑迁移。启动先恢复事务再开放相关发送、删除及列表投影。未提交事务等待回源恢复；已提交事务的冷打开在本族屏障后独立进行，每次进程启动只自动尝试一次，失败等待显式重开，不让坏目标启动拖住其他项目。因别的进程持锁而跳过的恢复不算已尝试，锁释放后可以再恢复。目标其他会话不停机。

历史路径按迁移前的目录段解释，不能用新 header 根解释旧相对路径；迁移不删项目文件，尤其不能因 scratch 源不再有会话而触发自动孤儿清理。会话草稿及旧文件脏编辑保留，旧终端不能伪装成目标终端。

用量 ID／规范路径保持原样，不走 clone/import 来源登记。账本原有按会话当前 cwd 聚合项目的口径不变，只更新定位元数据，不新增历史调用或按发生时项目拆账。

## 身份、提交点与来源约束

公开入口使用 preview／commit／status／retry-open 窄合同；来源以 IPC 外层工作区为准，请求体只做等价确认，renderer 不能提供 journal、快照或 after-image。preview 固定原会话 ID、确认 leaf（包括 null-root）、全文件摘要和 registry 指纹；票据过期或任一事实变化都必须重新预览。

目标必须是已存在目录，按 realpath 去重，不替用户建目录；拒绝应用内部 sessions、works、journal、lease、positions、drafts 和 staging 根。源必须是托管主会话，符号链接文件、坏头、重复条目 ID、断链、成环、未知结算状态和目标登记冲突均拒绝且不写日志。族发现遍历完整分支日志及全量 registry；`header.parentSession` 不单独作为发现边，独立 fork／clone 的可见主会话不被误带走。

registry 按记录而非整库迁移；源退出与目标插入各自在 SQLite 事务内复核 CAS，目标项目原本就有且完全相同的记录不覆盖。目标库以 operationId／记录 ID 保存本次实际插入标记，冷回滚只删除这批新增行，不能凭“内容相同”误删迁移前就存在的记录。选择此标记而不整库备份，是为保留并发的无关会话记录；标记只含身份，不含 transcript 正文。

提交点是 manifest 原子替换为 committed。before／after／registry 使用 JSON 转义快照，绝不生成可被会话扫描器发现的 `.jsonl` 备份；opened／rolled-back 后删除敏感快照，只留下结果 manifest。旧写者释放后再次整族 CAS；每次替换在临时文件 flush 后、rename 前再核对原文件摘要与 lease，避免准备临时文件期间的外部追加遭覆盖。失锁后不再写日志、registry 或 journal，留待新 owner 接管。提交前回滚只接受已知 before／after，外部写入不能被覆盖。提交后只接受完整整行的合法追加，绝不把追加过的日志重新覆盖成旧 after-image。

历史 metadata 与逐引用来源快照均为 version 1；marker 记录 operationId、来源／目标、原 header cwd、确认 leaf、树条目边界、before 摘要及快照引用（无树身份的旧标题行不计入 entryCount）。after-image 的追加 ID 从 operationId 确定性生成。逐 entry／toolCall 引用沿自身父链固定来源，原快照不会因往返迁移被新根覆盖；重复快照或回放出现不同来源时拒绝为 `TRANSFER_PROVENANCE_CONFLICT`，不推测哪一份正确。原始历史行及 CRLF、思考签名、标签、context edits、未知合法字段保留；冷恢复只认最后迁移之后、当前 leaf 父链上的 cwd。下一次显式请求注入迁移系统事实，预览／打开不伪造用户消息。迁移专用只读 parser 将精确形状的旧标题行作为 opaque 保留；v1 的无 ID 树按原日志和位置生成确定性 ID／父链，v2 按 SDK 规则升级角色，均只在 after-image 明确升级为 v3。预览、活动检查和快照读取使用内存 manager，不能调用会自动升级并重写源文件的 SDK `open()`。

main 与 agent-host 对同一路径使用跨进程 lease 和同一 journal 屏障；尚未创建的日志或 prepare sentinel 解析最近已有的物理祖先，确保目录别名下创建前后使用同一个锁键；项目级删除还按 journal 原来源／目标匹配，避免 applying 时新 header 已指向目标而漏掉源清理。源 scratch 保留根写入迁移 metadata 的 `retentionRoots` 并累积，只有历史引用存续时自动 prune 才保留原生成文件。

输入栏偏好按显式 `targetSessionPath` 调用 `agent_get_state`，与同一会话的历史加载等请求可能短暂争用同一把锁。这个读入口在 agent-host 内用现有 lease 的有界等待（500 ms）重试取锁：等到才按原规则读，超时仍报 busy，未完成迁移仍受 journal 拦截。无显式目标的状态探测、写入和迁移的取锁规则不变；后续对无 target 纯配置读的第一个例外见 [草稿偏好 lease 争用](../bug-fix/2026-11-20-draft-preferences-lease-busy.md)。

## Existing decisions

- [桌面会话工作流](../../proposed/feature/2026-11-10-desktop-session-workflows.md)：部分重叠，复用身份／位置／恢复屏障，不恢复已撤回的树和导入导出 UI，不改旧 change。
- [会话归档](../../implemented/feature/2026-10-19-session-archive.md)：部分重叠，沿用路径稳定及不停止任务的理由；归档是显示状态，本项是项目身份变更，不取代原决定。
- [历史文件 cwd](../../implemented/bug-fix/2026-10-16-session-cwd-file-paths.md)：部分重叠，沿用工具发生时 cwd；新增迁移目录段，不把项目根简单换成当前工具 cwd。
- [右栏会话绑定](../../implemented/bug-fix/2026-10-16-right-dock-session-binding.md)：部分重叠，保留原文件编辑器和草稿身份，迁移时不得带入源项目服务。
- 检索未发现同主题迁移提案，无完全吸收、过时或需要归档的笔记。

## Alternatives considered

- 只追加 `working_directory`：最强理由是已有工具可直接复用，改动最小。不采用，因为它不改变项目归属、项目资源和权限根。
- clone 到目标再删源：最强理由是已有 candidate 的准备／发布流程可借鉴。不采用现有 clone，因为它只有当前分支且生成新身份，丢旁支并扩大路径、子代理及来源迁移面。
- 将同 ID JSONL 挪到目标编码目录：最强理由是物理目录与项目一致，目录管理更直观。不采用，因为路径参与来源所有权、位置、父子引用及 UI 状态；现有合法 header 本就优先于目录编码。
- 单改父 header 并原地修改 live runtime：最强理由是无需新 owner 和恢复记录。不采用，因为旧 cwd、驻留子代理、共享 registry 和在途事件仍绑定源项目，且多文件失败无恢复边界。
- 由输入栏收到 busy 后重发 IPC：最强理由是只影响该控件。不采用，因为需解析 Electron 包装后的错误文本并重复请求；宿主已有按路径的有界等待，可在不跳过 journal 检查的前提下只重试取锁。

## Consequences

已有项目／本地目录两种目标都可确认移动；完整树、当前位置、草稿、文件出处和子代理历史保留；后续工具及可续聊子代理使用目标环境。忙碌状态后端拒绝，目标其他会话不受影响。重复提交、各阶段崩溃、删除源项目和反复移动不丢历史、不双写、不增加历史费用。

### 恢复与降级边界

迁移跨 JSONL 和多个登记库，不能假装单次 rename 即全局原子。局部故障必须由可校验 journal 恢复；原始数据在外部被改动时停止恢复并明确阻塞，不覆盖未知数据。旧版应用不识别恢复闸门，未完成事务不能交给旧版本继续写。

## 验证

已运行迁移 owner／工作区／历史引用的定向 Vitest、真实 SDK 和生产 IPC 临时工作区探针，以及 `cd electron-agent && npm run ui:check -- session-project-transfer` 新场景。覆盖目标选择、历史保真、权限／cwd、子代理续聊、逐阶段故障、源删除保护、旧列表乱序和用量去重。模型只指向本地 mock；预览、迁移、状态与重试阶段新增请求为 0。

证据保存至 `.agents/evidence/2026-11-17-session-project-transfer/`。收尾 `openspec validate move-sessions-between-projects --strict` 与根 `npm run verify-notes` 均通过（退出码 0）；后者有 6 条既有 implemented 笔记的结果措辞警告，本篇无新增警告。

本轮收尾已通过 main 迁移定向测试 18 文件 214 用例（`final-backend-vitest.log`）、renderer 9 文件 58 用例（`final-renderer-vitest.log`）、扩展 4 文件 40 用例（`final-extensions-vitest.log`）。main 包含真实 SDK／loopback 的运行时测试、64 项恢复测试（其中 42 个持久化故障边界）及失锁边界测试；真实目标会话保持流式运行时，移动仍以 additional handle 打开且不新增模型请求。另补运行时模型不可用用例 1 项通过（`unavailable-model-runtime-vitest.log`），确认保留请求模型并拒绝 fallback 发送。UI 只运行 `session-project-transfer`，93 项通过、0 失败，仅跑 1/56 场景；历史文件缺失且目标有同名文件的真实点击仍请求源路径并显示错误，保留原脏标签。精确命令及截图见本目录证据。

后端与渲染层均执行定向 `tsc --noEmit`，退出码都是 1；诊断落在已有依赖／未改行，包括 agentData 重复实现、OAuth 类型引用及聊天／文件查看器旧类型问题。本次迁移新增文件与新增行无诊断，未修这些无关基线，也不把整个类型检查记为通过。原始输出、输入配置与逐项定位见 `final-*-typecheck.log` 和 `final-typecheck-diagnostics.json`。

生产 IPC 命令 `node electron-agent/scripts/session-project-transfer-ipc-check.mjs` 通过 46 项断言，退出码 0（`probe-final.log`、`production-ipc-results.json`）。使用真实生产 hostEntry 源码入口、SDK／扩展和 WorkspaceService；授权端点为临时桩，模型拒绝非 loopback 请求。主会话与可续聊子级均通过真实 read 工具读到目标同名文件；one-shot 拒绝续聊；删除源项目后主／子／null-root 历史可读。显式请求计入后反复移动与两次 reconcile 的总量均为 84 tokens／11 条调用；4 个 journal 全为 opened，阻塞列表为空。

精确命令、6 张截图、42 点故障矩阵及类型诊断见[验证记录](../../../evidence/2026-11-17-session-project-transfer/verification.md)。未跑安装包入口或远程供应商，未用真实会话；历史图片／音频卡的来源绑定有单测，本 UI 场景没有逐种检查真实磁盘加载。没有修改 SDK、增加依赖、提交或自动 archive。

偏好读取回归用两个临时项目的真实 JSONL 与 lease：A 的迁移锁保持持有，B 的短锁 100 ms 后释放。修复前 B 读偏好立即报 busy；修复后读到 B 自己的快照，同期的写操作仍被拒。宿主偏好与失效压缩意图定向 16 项、输入栏偏好 39 项通过，持续占锁和 journal 阻塞仍返回原错误。
