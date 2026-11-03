# Qoder Repo Wiki 固定参考与宿主边界

参考为本机静态副本 Qoder 0.5.1 stable、context 1.0.91.b22f2d0a、revision 2026102902；行号对应 `.tmp-qoder-analysis/engine/qoder-search.pretty.mjs`，不是线上服务承诺。

| 类别 | 证据和状态 |
| --- | --- |
| reference：模板 | `pkt` 90042–92245：12 个模板与作者部分模板；`mkt/Zl` 92247–92296；`Pw/Aw` 92647–92672。资产位于 `electron/wikiService/reference/qoder-0.5.1/templates.ts`。 |
| reference：输入 | `fTe/qkt` 92943–92965；`Ukt` 92981–93038；`KUn` 93069–93107；`LUn/UUn` 93267–93336；增量 93802–94085。全量页 Branch 字面值 `main`，不代表目标 Git 分支。 |
| reference：并发和恢复 | `ZUn/KUn/VUn` 93038–93179：release 目录和页面各 3；首轮无成功即失败；有成功才对失败子集补偿一次。每轮单项各最多 2 次尝试。 |
| reference：限制 | `_n/nf` 55440–55484、`eTe/uM` 89949–90049、`R5` 119086–119476：context 150000、输出 16000、工作步 10 和 1 个收尾回合；ListDir 2000 tokens；最小 overview/catalogue/page 为 200/300/250 字节；最大深度 4；重试 5000/3000/2000 ms；Git 差异上限 100 commits、1000 files。context 窗口不是累计费用或 usage 限额。 |
| reference：解析 | `uTe/dTe/K9/fM` 92688–92866；overview 原文、plan 的 analysis 标签、目录 `documentation_structure` 和页面 docs/content 或标题。`dependent_file` 是源码文件，不是页面依赖。原版还有受限 JSON 修复，适配保留 256 KiB 和深度 64 护栏。 |
| reference：增量 | `vTe/wTe` 93427–93652、`xTe` 93768–94085；commit_summary 可回退全文；目录分析输出 update/add/delete，先 update 后 add。原版目录分析还调用已有 Wiki 查找/读取工具；这两个工具限于本运行冻结的已发布快照。 |
| host-adapter | Pi 模型、受限读取、路径授权、队列与费用策略均由宿主提供；不得把宿主实现当作 Qoder SDK 或云端服务。 |
| unknown | SDK 原生工具完整 schema、隐式系统消息、压缩行为、远端排队/模型路由和线上输出不可由固定副本证实。 |

代码和完整输出夹具已写入；未执行测试、构建、类型检查或真实模型。不得以此文档单独认定运行时验收通过。

## 增量目录分析的既有 Wiki 工具（规格遗漏）

`QUn` 93654–93765 只从该次输入的 priorCatalogue / priorPages 构造只读快照工具；`xTe` 93841–93856 仅在 `wiki.incremental.catalogue-analysis` 的 `localTools` 附加这两个工具，连同 ListDir；commit-analysis、page-update 和 page-add 均只挂 ListDir（仓库原生工具另列 Read/Glob/Grep），不挂这两个工具。名称来自 3949、94089–94102：

- `SearchWiki`：严格 object schema，必需 `query: string`（minLength 1），可选 `limit: integer`（1–20，默认 8），禁止其他属性；`access: read`。按小写空白分词，所有词都须匹配已发布页面 title、slug、breadcrumb 或 content；返回 `{query,matches:[{ref,title,path,snippet}]}`，snippet 将空白折叠并截至 500 字符。缺少该 section 的正文不参加搜索。诊断只含查询长度和 limit。
- `ReadWiki`：严格 object schema，必需 `ref: string`（minLength 4）；有目录节点时 enum 限定为本运行已分配的所有精确 ref（例如 W001），空目录时没有 enum；禁止其他属性；`access: read`。仅按本次 priorCatalogue 的 ref 查本次 priorPages，返回 `{ref,found:false}` 或 `{ref,found:true,title,path,content}`。诊断仅含 ref；不是任意文件读取。

目录 system 模板 90069–90103 明确要求必要时以 existing-Wiki tools 查看已发布页，并说明 W001 等是本运行 selector，不得从标题推断。原 `repo-wiki-prompts` 的“仅允许 Read/Glob/Grep/ListDir”遗漏这两个原版只读快照工具；用户已批准补齐，主代理负责同步规格与执行器接入。

已获用户确认：增量 catalogue-analysis 可在该次操作冻结的 priorCatalogue/priorPages 上使用上述两项只读 Wiki 工具；相应规格由主代理同步。`wikiTools.ts` 仅提供纯 schema 和处理函数，实际注册仍由执行器负责。目录候选提取与受限 JSON 修复、增量目录操作解析及全模板文本夹具现已写入；均尚未运行验证。JSON 修复使用有 ISC 许可的上游 jsonrepair 3.15.0 源码；本地保留完整许可。由于 Qoder 包内没有依赖版本清单，版本吻合是静态推断而非确证；打包时须由现有许可证收集器把该许可放进 `build/licenses`。
