# 校验修复执行交接

停止原因：2026-11-02 根代理通知调整模型路由，当前执行者停止新增实现与验证。没有启动真实模型、重启用户应用、提交或推送。没有正在运行的命令或后台进程。

## 已写入（尚未完成整条修复）

- `electron-agent/shared/wikiLinks.ts`：新纯 URL helper `resolveWikiLink(href,currentPageId?)`。返回 page `{pageId,path,hash?}` / source `{path,start?,end?}` / anchor `{hash}` / external `{url}` / invalid。hash 无 `#` 且解码；无当前页按根目录；HTTP(S)/mailto/`//` 为外链；源码显式 source: 或 #L 行定位，以仓库根为准；Wiki 相对当前页目录，剥 query、解码URL、拒绝越根/未知协议/本地绝对路径。UI owner `/root/review_ui` 已取得该接口，正在改 UI，勿接管其文件。
- `electron-agent/electron/agentData/knowledgeKernel/markdownLinks.ts`：新 AST helper，复用已有 unified/remark-parse/remark-gfm，只返回实际链接与被引用 definition 的 destination；代码/图片/未使用definition不算链接；通过源位置只替换目标、不重排整页。
- `electron-agent/electron/agentData/knowledgeKernel/validation.ts`：替换正则为上述 AST/shared URL helper；normalizeStageSources 新增第五个可选 context `{pageId,pageIds}`。将 manifest+Read证明的根级源码 Markdown 普通链接转 `source:path#Lx-Ly`，保留合法 Wiki 链接；普通相对 Markdown 来源链接只有 manifest+Read 范围证明后才转成 source:；真正未知 Wiki 链接/非法路径留给严格验证。显式 source: 链接若无法核实，保持既有兼容合同：降级为纯文字，不伪造来源。新增 `StageValidationError(code,pageId,target)` 与 `stageFailure(error)`，后者尚未接线。
- `electron-agent/electron/agentData/knowledgeKernel/validation.test.ts`：新 5 个测试（代码块/inline code、reference、URL编码、源码Markdown、严格unknown/越权、错误详情 query 不泄漏）。
- `.agents/notes/proposed/bug-fix/2026-11-02-repo-wiki-generation-validation-repair.md`：已写方案/旧note审计/验收边界，root最终迁移implemented。

## 基线与证据

本轮产品代码写入前已保存 `baseline/validation.ts`、`baseline/store.ts`、`baseline/coordinator.ts`、`baseline/contracts.test.ts`、`baseline/pipelinePrompts.ts`。这些后3者及store目前未改；禁止从HEAD恢复脏工作区。

- `core-red.log`：5/5 因预期旧行为失败（包括把inline code来源删成文字、未识别reference、缺诊断细节）。第一次创建测试误用cwd路径导致无测试文件，已修正；有效RED覆盖了全部5项。
- 最新命令在仓库根执行 `npx vitest run electron/agentData/knowledgeKernel/validation.test.ts`：5/5 GREEN，输出在tool历史，尚未存green日志。后续请在 electron-agent 目录使用它的vitest（此次根目录选到4.1.12，应用原本4.1.11）。
- 未跑严格类型、其他相关测试或notes gate；不能宣称整个修复完成。
- 集成owner `/root/integration_acceptance` 已保存 `integration-red.log`：v1/v2自然运行均复现父failed、构建library仍running/payload null。

## 调查结论

`runStage` 先beginAttempt，再normalise/validate，校验抛错后v1/v2 catch只写父任务错误、不commitItem，因此残留running、正文丢失。实际最新用户任务这3条无payload，无法补救不存在的候选；只能复用9条prepared。

renderer真实行为原为react-markdown+GFM，但相对Wiki目标原样传App.navigate，缺目录解析/解码；root已分配review_ui修复。共享helper是唯一语义边界，不要再写并行URL解析。显式 source: 未能通过 manifest+Read 证明时继续按旧 normalizeStageSources 合同降级为纯文字；只有新普通相对 .md 链接按本轮规则严格验证。

## 后端执行结果（2026-11-02）

1. `runStage` 现在传 `pageId/pageIds` 给 `normalizeStageSources`。校验失败返回 `disposition: 'failed'`，候选保留模型原始 payload、read evidence、resolved dependencies；`StageValidationError` 保留固定 code 与安全页面/相对目标详情。非校验执行异常只输出安全的固定诊断，不泄漏完整错误文本。
2. v1 与 v2 catch 在当前 fence 且 item 仍 running 时提交 failed/blocked 终态；有已返回结果时保留其 payload/evidence/dependencies。已过期 fence、终态 item、暂停/取消的 aborted path 不做该提交。
3. `store.readFailedCandidate(ref)` 只读 `state=failed`、带 output hash/payload、错误码 `INVALID_*` 的候选，复验 hash；否则抛 `CANDIDATE_NOT_FOUND`。失败项仍不会进入 `listCheckpoints`/drafts。
4. repair 先复用 prepared 项，再对同输入候选校验 input hash、完整 dependency hash 列表、source/model/plan/pipeline 身份；本地重新 normalize+validate+advance 后由 `copyRepairCandidate` 以 attempt=0 复制成目标任务 prepared。候选不合法则回原 stage 与正常预算，旧候选不变。
5. `pipelinePrompts` 已明确区分真实 Wiki links、Read 证明的 source links 和代码示例。
6. 合同已按根代理裁定：显式 `source:` 目标无法从 manifest+Read 证明时，继续旧合同降级为纯文字；普通相对 `.md` 只有在 manifest+Read 证明后转 source，否则作为未知 Wiki link 严格失败。相关 contracts/validation 测试覆盖；不扩大旧合同。
7. 新增 store candidate 行为测试和 coordinator v1/v2 无效链接候选、异常终态落账测试。validation/store/coordinator 测试覆盖候选读写、v1/v2 unknown-link 失败与 repair 重试、执行异常终态和 fence；app 四条双 child 集成另由 `/root/verify_boundary_terra` 执行并已报告 4/4 GREEN（其中包括合法候选本地复验路径）。
8. 定向 core checks 与 `npm run typecheck:knowledge-kernel` 通过，具体命令/输出见 `core-green.log` 和 `core-report.md`；限定源 diff 见 `core-limited.diff`。没有启动真实模型/用户任务、重启应用、提交或推送。Root 持有最终独立审查与获准的一次真实 repair。

## 尚需根代理完成

- Sol 独立审查当前实现与 `core-limited.diff`。
- 在其审查后由 root 按唯一授权执行一次真实 repair；是否最终闭环以真实实例与 app 集成的共同结果决定。
- root 负责将 proposed note 迁移至 implemented。此执行者未跑 notes gate（当前 note 仍为 proposed）。

## 集成owner同步

已告知 `/root/integration_acceptance` 候选字段是原 payload `{markdown,sources}`（不封装），error 为 `{code,message,retriable:false}`。后端已补 `readFailedCandidate` 和本地 revalidate/copy 接口。Terra 报告 app 四项双 child 闭环 4/4 GREEN；root 在最终 review 后执行唯一授权的真实 repair。

核心实现与验证记录已可直接审查：先看 `core-report.md` 和 `core-limited.diff`。
