# Agent Note: ui-harness 离屏静默运行，日常只点名跑当前场景

Status: implemented

## Problem

### ui-harness 默认离屏渲染 + CDP 焦点模拟静默运行，不再抢系统焦点

旧版 harness 每个场景弹一个真窗口，加载后 `win.focus()` + `moveTop()`，再轮询 `win.isFocused()`；probe 每次输入前 `ensureFocus()` 抢回系统焦点。跑的时候不能用电脑，主仓库和 worktree、正在运行的 GrenAgent 会互相抢焦点，键盘断言在全量连跑时偶发失败。按 electron-ui-harness skill 当前版本升级。

### ui:check 日常只点名跑当前需求的场景，构建按源文件签名复用，--changed 只用来查波及范围

AGENTS.md 要求「先单独跑这个场景，再跑一遍全量，然后才算完成」，并且每次 `ui:check` 都整套重新构建。改一个小组件，收尾却要把已经定档的场景全拉出来重跑，构建的 5 秒也每次都付。目前只有 `codemode-card` 一个场景，代价还不明显，场景增多之后会变成每次几分钟。按 electron-ui-harness skill 当前版本升级。本项目的特殊处：Vite 8（rolldown）、用 npm 跑脚本、渲染层在 `electron-agent/src`，`harness.config.mjs` 里唯一的别名 `@extensions` 指向仓库根的 `extensions/`（pi 扩展，主进程侧）。

## Decision

### ui-harness 默认离屏渲染 + CDP 焦点模拟静默运行，不再抢系统焦点

窗口一律 `show: false` + `webPreferences.offscreen: !visible`（`UI_SHOW=1` / `--show` 时才 `showInactive()` 显示，同样不抢焦点）；静默时 `setFrameRate` 跟主显示器刷新率（上限 240）。`loadFile` 之后按实测 `innerWidth` / `innerHeight` 校正视口（离屏会大 1~2px），再用 `webContents.debugger` 发 CDP `Emulation.setFocusEmulationEnabled`。probe 去掉所有抢焦点代码，`t.resize` 改成按视口校正。`check.mjs` 支持 `--show`、`scenarios/` 为空时以 1 退出。`run.mjs` / `probe.mjs` / `check.mjs` 与 skill 模板逐字一致，项目定制只留在 `harness.config.mjs`、`HarnessRoot.tsx`、`main.tsx`、`stubs.ts`、`index.html`、`vite.config.mjs`（dedupe）。

### ui:check 日常只点名跑当前需求的场景，构建按源文件签名复用，--changed 只用来查波及范围

日常只点名跑本次需求对应的场景；全量只在用户明确要求、或合并前由用户决定时才跑。`check.mjs` 新增 `--changed`（只跑受未提交改动影响的场景）、`--changed=<ref>`、`--dry-run`（只列范围不运行）、`--rebuild`；结尾写「只跑了 a/b 个场景」，不让部分通过被读成整体通过。构建默认复用：`depsGraph.mjs`（vite 插件）在构建时记下每个场景用到的源文件及其大小 + 修改时间，源码没变就跳过构建。`affected.mjs` 按这份依赖图把改动映射到场景：只被某几个场景引用的文件只选它们，公共文件（`index.css`、主题、`HarnessRoot.tsx`、配置、`run.mjs` / `probe.mjs`）选全部，全局样式按改动落在哪条规则、类名被哪些场景用到来缩小，拿不准退回全部。

项目侧改动：新增 `depsGraph.mjs`、`affected.mjs`，覆盖 `check.mjs`（与 skill 模板逐字一致）；`vite.config.mjs` 加 `depsGraphPlugin()`，保留原有的 `dedupe`；`harness.config.mjs` 加 `sourceRoots: ['../src']`，只列渲染层。`depsGraph.mjs` 对 Vite 8 没有的 `getWatchFiles` 做了容错。AGENTS.md 的 UI 检查章节补了命令（npm 的 `--xxx` 要放在 `--` 后面）、「跑哪些场景」，去掉了「再跑一遍全量」。

### 涉及文件

- `electron-agent/ui-harness/run.mjs`
- `electron-agent/ui-harness/probe.mjs`
- `electron-agent/ui-harness/check.mjs`
- `electron-agent/ui-harness/harness.config.mjs`
- `electron-agent/ui-harness/probes/codemode-card.mjs`
- `electron-agent/ui-harness/depsGraph.mjs`
- `electron-agent/ui-harness/affected.mjs`
- `electron-agent/ui-harness/vite.config.mjs`
- `AGENTS.md`

### 来源

- `docs/decisions/electron-agent/ui-harness/2026-10-05-silent-offscreen-harness.md`
- `docs/decisions/electron-agent/ui-harness/2026-10-05-scoped-ui-check.md`
- AGENTS.md「UI 检查（ui-harness）」

## Alternatives considered

### ui-harness 默认离屏渲染 + CDP 焦点模拟静默运行，不再抢系统焦点

- 普通窗口 + `show: false`（不离屏）：从没显示过的窗口不推进 CSS 过渡、不应用 hover、滚轮不滚，antd 弹层关不掉。
- 只开离屏、不做焦点模拟：离屏窗口永远不是系统前台，`el.focus()` 不发 focus 事件，靠 focus 记状态的组件会忽略后续按键。
- 加载前就发焦点模拟命令：命令会一直挂着，每个场景都等到超时。
- 保留抢焦点（`win.focus()` / `ensureFocus`）：正是偶发键盘失败和「跑的时候不能用电脑」的根因。

### ui:check 日常只点名跑当前需求的场景，构建按源文件签名复用，--changed 只用来查波及范围

- `sourceRoots` 缺省取别名指向的目录：本项目唯一的别名是 `@extensions` → `../../extensions`，会把 pi 扩展当成渲染层，`extensions/` 下每次改动都被报成「没有场景覆盖」。所以显式写 `sourceRoots`。
- 每次收尾跑全量：和「只验证当前需求」冲突，已定档的场景重跑没有新信息。
- 按目录名猜场景（`features/tools` → `codemode-card`）：目录一调整就静默漏跑。依赖图是构建时记下的真实 import 关系，不靠命名。
- 按 `git diff` 判断要不要重建：暂存、未提交、切分支都会判错。改用源文件的「大小 + 修改时间」签名，用「不相等」而不是「更新」判断，旧版本拷回来也能发现。
- 「没有场景覆盖」对 `.ts` 也提示：`settingsSchema.ts` 这类纯逻辑文件由 vitest 管，提示补场景是噪音。只对 tsx / css 等会渲染的文件提示。

## Consequences

### ui-harness 默认离屏渲染 + CDP 焦点模拟静默运行，不再抢系统焦点

静默模式下每次 `executeJavaScript` 往返约 65~78ms（显示窗口时 <1ms），`capturePage` 每张约 75ms（显示时约 20ms），`codemode-card` 全量从约 6s 变成约 8s；probe 里 `t.*` 读取越多越明显。fps 只作参考，性能结论用 `--show`。Linux 上离屏渲染仍要显示服务（`xvfb-run`）。改 `run.mjs` 后要跑 skill 的 `scripts/smoke.mjs`（会检查无可见窗口、页面有焦点、JS focus() 发事件、CSS 动画走完、视口尺寸）。Electron 升级后若 `Emulation.setFocusEmulationEnabled` 失效，`run.mjs` 只打 WARN，键盘断言会先挂。

### ui:check 日常只点名跑当前需求的场景，构建按源文件签名复用，--changed 只用来查波及范围

`--changed` 对全局样式是按类名匹配的启发式，类名在源码里找不到、改 `:root` 变量、`@font-face`、没人引用的 `@keyframes` 时退回全部，可能多跑，不会漏跑。构建复用只看大小和修改时间，内容变了但两项都没变（几乎不会发生）时发现不了，怀疑时加 `--rebuild`。升级依赖、换 Electron 后第一次会自动重建（依赖安装标记变了）。Vite 以后再改插件接口，`depsGraph.mjs` 构建报错时需要照 skill 模板更新，`--rebuild` 绕不过去。场景增多后，如果 `--changed` 的结果经常不符合预期，先看输出里写的原因，再决定是补 `sourceRoots` 还是点名跑。

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
