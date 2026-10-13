> 已迁移：本决定现由 [.agents/notes/implemented/testing/2026-10-05-ui-harness-offscreen-and-scoped.md](../../../../.agents/notes/implemented/testing/2026-10-05-ui-harness-offscreen-and-scoped.md) 维护；本文件冻结只读。

---
title: ui:check 日常只点名跑当前需求的场景，构建按源文件签名复用，--changed 只用来查波及范围
status: active
date: 2026-10-05
scope: electron-agent
files:
  - electron-agent/ui-harness/check.mjs
  - electron-agent/ui-harness/depsGraph.mjs
  - electron-agent/ui-harness/affected.mjs
  - electron-agent/ui-harness/vite.config.mjs
  - electron-agent/ui-harness/harness.config.mjs
  - AGENTS.md
supersedes:
superseded_by:
---

## 背景

AGENTS.md 要求「先单独跑这个场景，再跑一遍全量，然后才算完成」，并且每次 `ui:check` 都整套重新构建。改一个小组件，收尾却要把已经定档的场景全拉出来重跑，构建的 5 秒也每次都付。目前只有 `codemode-card` 一个场景，代价还不明显，场景增多之后会变成每次几分钟。按 electron-ui-harness skill 当前版本升级。本项目的特殊处：Vite 8（rolldown）、用 npm 跑脚本、渲染层在 `electron-agent/src`，`harness.config.mjs` 里唯一的别名 `@extensions` 指向仓库根的 `extensions/`（pi 扩展，主进程侧）。

## 决定

日常只点名跑本次需求对应的场景；全量只在用户明确要求、或合并前由用户决定时才跑。`check.mjs` 新增 `--changed`（只跑受未提交改动影响的场景）、`--changed=<ref>`、`--dry-run`（只列范围不运行）、`--rebuild`；结尾写「只跑了 a/b 个场景」，不让部分通过被读成整体通过。构建默认复用：`depsGraph.mjs`（vite 插件）在构建时记下每个场景用到的源文件及其大小 + 修改时间，源码没变就跳过构建。`affected.mjs` 按这份依赖图把改动映射到场景：只被某几个场景引用的文件只选它们，公共文件（`index.css`、主题、`HarnessRoot.tsx`、配置、`run.mjs` / `probe.mjs`）选全部，全局样式按改动落在哪条规则、类名被哪些场景用到来缩小，拿不准退回全部。

项目侧改动：新增 `depsGraph.mjs`、`affected.mjs`，覆盖 `check.mjs`（与 skill 模板逐字一致）；`vite.config.mjs` 加 `depsGraphPlugin()`，保留原有的 `dedupe`；`harness.config.mjs` 加 `sourceRoots: ['../src']`，只列渲染层。`depsGraph.mjs` 对 Vite 8 没有的 `getWatchFiles` 做了容错。AGENTS.md 的 UI 检查章节补了命令（npm 的 `--xxx` 要放在 `--` 后面）、「跑哪些场景」，去掉了「再跑一遍全量」。

## 放弃的方案

- `sourceRoots` 缺省取别名指向的目录：本项目唯一的别名是 `@extensions` → `../../extensions`，会把 pi 扩展当成渲染层，`extensions/` 下每次改动都被报成「没有场景覆盖」。所以显式写 `sourceRoots`。
- 每次收尾跑全量：和「只验证当前需求」冲突，已定档的场景重跑没有新信息。
- 按目录名猜场景（`features/tools` → `codemode-card`）：目录一调整就静默漏跑。依赖图是构建时记下的真实 import 关系，不靠命名。
- 按 `git diff` 判断要不要重建：暂存、未提交、切分支都会判错。改用源文件的「大小 + 修改时间」签名，用「不相等」而不是「更新」判断，旧版本拷回来也能发现。
- 「没有场景覆盖」对 `.ts` 也提示：`settingsSchema.ts` 这类纯逻辑文件由 vitest 管，提示补场景是噪音。只对 tsx / css 等会渲染的文件提示。

## 后果

`--changed` 对全局样式是按类名匹配的启发式，类名在源码里找不到、改 `:root` 变量、`@font-face`、没人引用的 `@keyframes` 时退回全部，可能多跑，不会漏跑。构建复用只看大小和修改时间，内容变了但两项都没变（几乎不会发生）时发现不了，怀疑时加 `--rebuild`。升级依赖、换 Electron 后第一次会自动重建（依赖安装标记变了）。Vite 以后再改插件接口，`depsGraph.mjs` 构建报错时需要照 skill 模板更新，`--rebuild` 绕不过去。场景增多后，如果 `--changed` 的结果经常不符合预期，先看输出里写的原因，再决定是补 `sourceRoots` 还是点名跑。
