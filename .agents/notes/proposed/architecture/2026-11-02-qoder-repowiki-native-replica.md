# Agent Note: Qoder Repo Wiki 本地生成内核完整复刻

Status: proposed

## Problem

旧部分对齐混用了本仓库的提示词、JSON 输出、页面 DAG、累计额度和全必需页成功发布，未获得真实生成闭环。用户已批准完整 OpenSpec 提案并要求实施；此前仅准人工测试，现明确授权实现并执行无 UI、无付费模型的 CLI 调用链验收。UI 与真实模型生成仍由用户决定。

## Proposal

按 [OpenSpec 设计](../../../../openspec/changes/replicate-qoder-repowiki/design.md) 实现 native `qoder-wiki-local-v1`。该变更是执行合同与任务的权威，本篇只记录决策归属和历史适用边界，避免重复维护规格。

## Historical note audit

- [旧部分对齐](../../implemented/architecture/2026-11-02-repo-wiki-qoder-alignment.md) 部分被替代：新 Wiki 不再使用页面 DAG、自定义 JSON/来源硬校验及全成功发布；旧任务/cards 的独特理由仍有效，不整篇归档。
- [KnowledgeKernel](../../implemented/architecture/2026-11-01-repo-wiki-knowledge-kernel.md) 的旧任务所有权、恢复和凭据边界保留；新 Wiki 转为独立服务与分区 snapshot 权威。
- [当前故障修复](../bug-fix/2026-11-02-repo-wiki-generation-validation-repair.md) 是 legacy 合同修补，未执行的新验证不会被当作 native 已验证证据。

## Alternatives considered

1. 继续补旧内核：最容易复用已有账本与测试；不选为新内核，因为提示词、页面依赖和发布规则仍不等于原版。
2. 直接运行 Qoder bundle：运行外形最接近原环境；不选，会依赖其 SDK、worker/私有服务和产品权限。
3. 独立复现可见本地合同：保留批准的 Pi 模型和宿主安全适配，同时将必要差异与未知项登记；选择此方案。

## Acceptance criteria

按 OpenSpec 六份规格及逐项任务交付。当前在临时仓库/临时数据库中实际执行无 UI 的离线 CLI 回归，模型边界使用固定输出，不访问真实模型或修改用户任务；仅构建测试所需知识子进程，不构建/重启桌面应用。界面与真实模型验收仍由用户执行，离线发布与付费模型结果分别记录。

## Implementation handoff

代码与静态审查记录见 [执行记录](../../../evidence/2026-11-02-qoder-repowiki-replica/WORK.md)，人工步骤见 [验收手册](../../../../docs/repo-wiki-native-manual.md)。该笔记保持 proposed，等待用户人工运行证据后再按笔记流程落地；不能将源码存在写成已验证。

本次宿主适配包括：固定参考 profile 与独立累计费用策略、只读项目身份 registry、branch 作者配置归档、ProjectFiles schema 2 降级 guard、部分发布成功集与可读旧文分别计数，以及 SQLite publication → 文件 journal/CAS 的可重放投影。它们不冒充 Qoder 的私有服务或未知 SDK 行为。

## 正常入口必须就是对齐流程

2026-11-03 用户再次明确要求 Qoder 怎样实现就怎样，不接受反复给旧 v2 增加预算补丁。实际手测任务仍使用 `knowledge-kernel-qoder-v2`，因为 native 被放在第二个“原版 Wiki”入口，正常生成/重试仍走旧链路。新模块存在不代表替代完成；此前代码任务勾选没有覆盖这一实际接线缺口。

宿主 Repo Wiki 的正常概览、生成、更新、控制和修复统一调用 `qoder-wiki-local-v1`，不再让用户自行选择第二个引擎入口。确认框在外发前明示该引擎、模型、scope 和费用，仍由用户手动确认；默认自动规划无需先编辑 JSON 计划。知识卡与已有 legacy API 保持原合同。旧 Wiki 任务、九份已保存正文、历史用量、正式文件和草稿只作为原身份历史读取，不暗中迁移成 native 检查点，也不自动新开付费生成。旧任务的显式历史动作不伪装成新流程。

正常 UI 不再用旧任务的 blocked/预算错误覆盖 native 状态，项目与任务中心的当前活动展示要从 native task 投影取值。保留旧阅读与草稿入口，但不以旧状态让默认生成按钮回落旧 v2。旧版预算补丁方案已停止，未修改真实额度或任务；源码交付、用户载入版本与真实生成验收仍分别记录。

### 概览沿用产品界面，不暴露调试表单

用户载入后的截图显示 native 主概览退化为贴左的 HTML 表单：原生 fieldset/select/input、六个并列动作和预算说明占据首屏。原因是把只做功能接线的 `NativeWikiPanel` 直接提升为主界面，没有消费既有 `rw-generation-overview`/`rw-state-card` 布局和 antd 控件；全局 reset 又使普通按钮呈现为纯文字。

保留 native 会话与 RPC，不回退引擎。主概览复用原有居中图标、标题、状态卡、语言分段和森林绿主按钮；根据实际运行/发布状态提供一个主操作，其他动作在更多菜单中保留。费用上限和作者配置折叠在生成设置，外发确认仍完整显示模型、scope、engine、费用与目标。继续/修复的原预算、后台生命周期和旧草稿只读语义不改变。

仅给现有调试表单补间距和边框最省改动，但仍会让普通用户面对六种互相竞争的动作和默认费用配置，因此不选。恢复整个旧概览的 KnowledgeKernel 状态最容易还原外观，但会重新引入旧引擎状态争权，也不选。

用户仍要求人工测试：编写居中、主按钮、折叠设置、窄屏和确认等定向 probe，不运行 UI、构建、类型检查或模型。截图与修改前源码位于 `.agents/evidence/2026-11-03-repo-wiki-overview-ui/`；视觉复验仍由用户执行。

## 公共请求校验按引擎分流

用户在正常首次生成时遇到 `Unexpected request property`。公开入口 `validateRequest('native', ...)` 先运行专用 `validateNativeRequest`，却继续运行旧的统一字段表：后者没有 `expected_storage_token` 和 `spending_policy`。仅补字段仍不够，后续旧编辑 CAS 规则还要求 token 为 64 位十六进制，与 native 在尚无配置文件时允许空 token 的合同不符。现有 native 单测已直接写了公开入口接受 opaque token 的断言，但未获运行授权，不能把这份代码当成通过证据。

native 专用 validator 唯一拥有其命令字段、类型、令牌和费用规则；公共入口仍核验 action/普通对象/可序列化/8 MiB 上限，再结束 native 校验，不落入旧编辑/计划规则。旧调用保持原字段、64 位 CAS token 和其他校验。渲染适配器和主进程共享这一公开入口，不在客户端临时删字段，也不放松所有请求的未知字段检查。

`contracts/src/native.test.ts` 原本未被根 main/renderer 的 include 或 vendor 的 `packages/*/tests` runner 收录。将该目录的合同用例接入既有 `vitest.repo-wiki.config.ts`，与其已依赖的阅读器/JSX 环境共用；手册给出只点名该文件的命令，不新建框架、不执行测试。这样新回归不再只有文件、没有可用入口。

给统一字段表补两个字段的优势是改动最少，但会保留跨引擎 token 冲突与重复维护，因此不选。提前返回 native 的优势是彻底绕过旧规则，但若放在公共字节限制之前会丢失 8 MiB 保护，因此只在公共保护完成后返回。按用户边界只补公开入口与渲染转发的未执行回归，不自动测试、构建、重启或启动模型。

## CLI 从公开入口验收到正式文件

用户要求整条调用链一次检查并提供可反复运行的 CLI，而不是每次依赖 UI 和人工发现下一个错误。复用 Vitest、`buildRepoWikiHost`、实际 `createGrenRepoWikiClient`/`RepoWikiService`/Node 子进程，直至 native SQLite、AgentData 投影和 ProjectFiles；只替换付费 provider 及 AgentData RPC 传输，本地投影/租约存储使用真实实现。固定输出至少覆盖默认 auto 首次生成、Read 工具往返、部分发布与失败修复、响应重试和无模型补投影；失败必须指出断裂边界，不能仅断言 completed。

此前离线夹具直接调用 `WikiService.start`，使用作者显式 pages 与 `src/**` 范围。它在本轮可跑 2/2，但绕过了默认配置、公开请求、main/真实 child 及默认扫描范围，因而无法发现接线与自引用输出问题。保留这份有价值的内核回归，不把它冒充新 CLI 的覆盖。

用户此次仓库只读状态显示 59 个 `.qoder/repowiki/` 输出和 7 个 `docs/repo-wiki/` 输出未跟踪；扫描器只排除后者，前者被当源码，随后触发 `DIRTY_WORKTREE_REQUIRES_REVIEW`。仅排除确定的两种 Wiki 输出路径，不忽略整个 `.qoder`、不忽略普通未提交源码、不替用户提交或修改 gitignore。CLI 在默认扫描范围下种入这些输出，先观察失败再修正，同时保留真实脏源码拒绝和零模型请求断言。

调用链还必须校验回传对象的含义，而不只校验数据库和 completed。实际执行 native 投影单测又发现 `JobStore.parseJobMetadata` 会丢弃已存的 projectId，使当前项目按身份过滤时不显示对应任务。解析器在验证安全项目 ID 后保留该可选字段；旧元数据仍可读，非法身份不投射。完整 CLI 增加 projectId/workspace/language 的最终 TaskView 断言，并将相关快单测一起收录。

旧失败任务在脏工作区检查前已经保存 source pin，直接改变输出排除规则会让它修复时再报 `SOURCE_SNAPSHOT_CHANGED`。只对尚无任何源码相关 checkpoint/attempt 的 preflight pin 做规范化：去除已识别的 Wiki 输出后，剩余文件路径/内容身份必须与当前 manifest 完全一致，才更新当前运行的 source pin。已做过 overview/plan/catalogue/page 或任何 attempt 的成果不适用；真实源码变化仍拒绝，不改父任务成果、历史用量或预算。否则仅解决新任务、让当前失败任务掉进下一个确定性错误，仍不是完整修复。

直接内核用例最快，但已经证明不能守住入口合同；每次完整 UI 验收覆盖外观却慢、难以隔离错误。因此选择真实知识子进程的无 UI CLI，复用已有工具链，不另造业务模拟器。CLI 测试允许固定 provider 和临时数据库；真实供应商、界面呈现和完整 AgentData OS 进程的验收边界仍单独说明。

命令前置运行 Repo Wiki 定向 TypeScript 检查，再构建临时知识 child 并测试。实际类型检查发现了公共 assertion 影响旧请求索引类型、UI 返回值联合推导和两处分块响应循环推导错误；分别以独立未知类型参数、command→response value 类型映射和显式 chunk 类型纠正，不改运行数据。只有 esbuild 的“能启动”不能代表桌面构建能过。

真实 child 测试由专用 flow 配置独占，默认 main 测试配置精确排除该文件；缺少临时产物环境时在分配资源前明确报使用 CLI 入口，而不 skip 或偷偷启动其他版本。原 `npm test` 不因新用例增加临时构建环境前提。测试框架失败必须退出非零，不能仅靠文件存在或部分跳过显示通过。

## Risks

SDK 隐式消息与云端行为不完整；不把宿主适配冒充已证实的线上 1:1。DB 发布与文件投影必须保持单一权威及可恢复收据，回滚关闭派发但保留 native 内容读取。
