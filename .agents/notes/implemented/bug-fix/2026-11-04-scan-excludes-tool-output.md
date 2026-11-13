# Agent Note: 源码扫描排除工具输出目录，单文件上限提到 512 KiB

Status: implemented

## Problem

Repo Wiki 与知识卡共用的源扫描器（`vendor/repo-wiki/packages/core/src/scanner.ts`）把工作区里的一切非忽略文件都当源码证据。三个真实仓库因此无法生成：

| 仓库 | 扫描结果 |
| --- | --- |
| `note-pocock-flow` | 173 文件，`partial=false` |
| `Engineering Decision Management` | 293 文件，`partial=true`（7 个 oversized：260 KiB 的 plan md、`.pi/ui-history/*.jsonl`、`.codegraph/codegraph.db-wal`） |
| 本仓库 | 命中 1000 文件上限，3182 个被 `file_limit` 跳过 |

`coverage.partial` 在 `wikiService/repository.ts` 与 `knowledgeProcess/projectPort.ts` 两处都是**硬失败**（`SOURCE_COVERAGE_INCOMPLETE`）。也就是说：一个仓库只要自带 CodeGraph 索引、agent 状态目录或构建产物，就永远生成不出 wiki。

这不是"文件太多"的问题——是扫描器把**本应用的生成物**当成了项目源码。

## Decision

**一、默认排除清单增加五个目录。**

`.codegraph`、`.pi`、`out`、`out-pkg`、`.claude`。

前两个是本应用的索引库与 agent 运行时状态，后三个是构建输出。它们不是项目源码，且在真实仓库里体积占绝对多数。

**二、单文件上限 200 KiB → 512 KiB。**

`MAX_FILE_BYTES` 提为常量并替换四处硬编码。260 KiB 的 plan/spec 文档是**合法源码证据**，200 KiB 的上限会把它判为 oversized 并让整个仓库 partial。

**三、`partial` 判据不变。**

超过 512 KiB 仍然标 `oversized`、仍然进入 `omitted_files`、仍然让生成失败。这次只把"本应用自己的产物"从源码里摘出去，没有放宽"绝不静默漏文件"的保证。

## Alternatives considered

- **把 `oversized` 从 `partial` 的原因里移除** — 能让所有仓库都生成。否决：那等于允许静默漏掉真实源码文件，与 `freezeRepository()` 在发布前二次校验 manifest 的前提直接冲突。
- **只改调用方的 exclude 参数，不动 vendor** — 不改共享组件。否决：`repository.ts` 与 `projectPort.ts` 都从用户 plan 取 include/exclude，用户没有理由知道我们的构建目录；且两处要同时改，改 vendor 一处更少。
- **无限提高单文件与总字节上限** — 能用。否决：20 MB 的 `maxTotalBytes` 与上下文窗口是耦合的，提上限会让大仓库的提示词直接超窗。
- **把本仓库的 `release/**` 也加进默认排除** — 能让本仓库通过。否决：`release/` 不是所有项目都有的约定名，把它写进通用排除清单是把自己的发布习惯强加给所有仓库。

## Consequences

- **收益**：`Engineering Decision Management` 从 `partial=true`（293 文件）变为 `partial=false`（151 文件）；`note-pocock-flow` 保持 173 文件、不 partial。
- **收益**：自带 CodeGraph 索引的仓库不再因为自己的索引库而无法生成 wiki。
- **代价**：`.claude` 被排除意味着某些项目里放在该目录的源码不会被扫描。这是有意的——该目录是 agent 工作目录；若某项目确实把源码放在那里，用户仍可用 plan 的 include 显式加回。
- **代价与已知上限**：本仓库自己仍然 `partial=true`（1000 文件上限 + `release/**` 里 59 个超大文件）。**本变更不解决这个**——那需要另一次关于"文件数上限"与"发布产物目录"的决定。
- **必须重访的信号**：当某个项目的真实源码文件被这些默认排除误伤时，先确认是目录用途判断错误，再改清单；不要为了让某个仓库通过而逐个追加。

## Verification

- `node --import tsx --test packages/core/tests/scanner.test.ts`（在 `vendor/repo-wiki` 下）：16 项通过。新增两项：含五个工具输出目录的仓库扫描结果不含这些路径且 `partial=false`；260 KiB 文档被收录、600 KiB 文件被标 oversized 并出现在 `omitted_files`。
- 三个真实仓库扫描：`note-pocock-flow` 173 文件 `partial=false`；`Engineering Decision Management` 151 文件 `partial=false`；本仓库 1000 文件 `partial=true`（`file_limit` 2523、`oversized` 59，主要在 `release/**` 与 `package-lock.json`）。
- 知识卡回归：`npx vitest run --project main electron/knowledgeProcess electron/agentData/knowledgeKernel` 全绿——扫描器同时服务这两条链路，此步确认没有改坏知识卡。
