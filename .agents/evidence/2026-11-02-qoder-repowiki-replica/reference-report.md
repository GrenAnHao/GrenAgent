# Reference 工作记录

## 写入与接口

- `electron-agent/electron/wikiService/reference/qoder-0.5.1/templates.ts`：固定副本静态提取的 12 个模板与作者 partial。
- `reference/qoder-0.5.1/jsonRepair.ts`：官方 jsonrepair 3.15.0（ISC）修复及本地括号扫描；`wikiTools.ts`：SearchWiki / ReadWiki 的只读快照纯 schema、execute 与引用分配；`render-fixtures.json`：完整 system / user 文本样例；`INVENTORY.md`：来源及 reference / host-adapter / unknown 对照。
- `referencePrompts.ts`：`ReferencePurpose`、`renderReferenceTemplate`、`renderReferenceExecution`、`catalogueChildVariables`、`referenceCatalogueRetryInstruction`、`referenceReadme`、`referenceValidFileCount`。
- `referenceParsers.ts`：`ReferenceResult`、`ReferenceCatalogueNode`、`ReferenceSection`、overview / plan / catalogue / page / commit analysis / incremental catalogue 解析。增量 API `parseReferenceIncrementalCatalogue(text, priorSections, idFactory, finalAttempt?)` 返回 update/add/delete 或 `{ok:false,error}`。
- `referenceProfiles.ts`：版本身份与默认限制。
- `referencePrompts.test.ts`、`referenceParsers.test.ts`：未执行的 golden、解析、增量引用/冲突及只读工具用例。
- `docs/repo-wiki-qoder-reference.md`：证据、范围及用户对两项 Wiki 快照工具的批准。

## 当前完成判定与前提

1.1–1.4、3.1–3.2 的资产、profile、目录/正文/增量解析、完整输出 golden 与说明已写；最终是否打勾由主代理静态整合审查决定。黄金输出是独立静态文本转换所得，未同原程序执行结果对照。已改为官方 jsonrepair 3.15.0 源码并保存完整 ISC 许可；Qoder archive 没有依赖锁，实际版本仅据 HTML entity 修复特征推断。打包 owner 须将该许可纳入现有 `build/licenses` 收集，未执行打包验证。

`referenceWikiTools` 只提供纯函数，不注册工具；执行器只在 `wiki.incremental.catalogue-analysis` 使用已确认并冻结的 priorCatalogue/priorPages 快照绑定。真实 SDK 隐式消息、原生工具完整 schema 和云端模型路由未获证实。

本轮只静态读取源、文本转换与写文件；未运行产品测试、类型检查、构建、Qoder、应用或模型。全部上述文件新增，无既有文件被覆盖。产品验收与运行检查由用户决定执行。
