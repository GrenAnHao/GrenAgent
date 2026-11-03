# Repo Wiki 生成校验与 repair：app 集成验收

## 结果

四项定向用例均通过，均使用临时仓库、loopback 假模型 HTTP、真实 Pi SDK / Read 工具和两个独立 OS 子进程；没有使用付费模型或真实用户任务。

- v1 自然失败 + 模型 repair：`integration-v1-green.log`，1 passed / 12 skipped；产物 `validation-links-v1.json`。
- v2 自然失败 + 模型 repair：`integration-three-pass.log` 中通过；产物 `validation-links-v2.json`。
- v1、v2 历史候选本地复验：`integration-three-pass.log` 中通过；产物 `candidate-revalidation-v1.json`、`candidate-revalidation-v2.json`。该日志共 3 passed / 1 failed / 9 skipped；唯一失败的 v1 是验收 fixture 在子进程仍持锁时直接读正式文件，随后关闭 fixture 子进程再读取，并单独补跑通过。三项通过期间和补跑之间产品接线代码未再变化。

命令（`electron-agent` 目录，显式清除付费入口）：

```powershell
$env:REPO_WIKI_REAL_E2E=$null
npx vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts -t 'persists v|locally revalidates'
npx vitest run electron/app/repoWikiKnowledgeKernel.integration.test.ts -t 'persists v1 validation failures'
```

## 检查到的行为

- `missing-page.md` 触发 `INVALID_PAGE_LINK`；父任务失败项保留原始 payload、evidence、依赖和错误，且不是 running、draft、prepared 或正式内容。已完成的 `generate:api` 是唯一 draft，不重发。
- 模型 repair 创建新任务，仅对 library 再发一轮 Read + 最终结果（两次 loopback HTTP），api 不重发；父候选保持失败。
- 历史候选通过临时数据库 fixture 构造：保留真实输入哈希、Read evidence 和依赖，仅移除 unknown 链接并模拟旧校验器错误。新任务本地复验后发布，新增 HTTP 为 0；父候选仍为 failed，目标 library 为 prepared。
- 四例都检查正式 receipt 指向修复任务、冻结必需页面集合及实际 Markdown 文件清单完整，内容非空且每条来源属于冻结 manifest 并能读到真实非空源文件。正式页面包含 `api` 和 `library`；library 的 README 相对链接规范化为 `source:README.md#L1-L1`，保留 `api.md#api` 与代码块中的伪链接，不含真实 unknown；来源含 README 第 1 行。
- JSON 记录 build ledger、任务状态、输入输出哈希、候选 payload / evidence / dependencies、子进程阶段和 HTTP 调用；测试结束时临时仓库会清理，正文与来源结论来自执行时的实际磁盘断言，而非 JSON 自身保存的正式文件副本。
