> 已迁移：本决定现由 [.agents/notes/implemented/testing/2026-10-05-ui-harness-offscreen-and-scoped.md](../../../../.agents/notes/implemented/testing/2026-10-05-ui-harness-offscreen-and-scoped.md) 维护；本文件冻结只读。

---
title: ui-harness 默认离屏渲染 + CDP 焦点模拟静默运行，不再抢系统焦点
status: active
date: 2026-10-05
scope: electron-agent
files:
  - electron-agent/ui-harness/run.mjs
  - electron-agent/ui-harness/probe.mjs
  - electron-agent/ui-harness/check.mjs
  - electron-agent/ui-harness/harness.config.mjs
  - electron-agent/ui-harness/probes/codemode-card.mjs
supersedes:
superseded_by:
---

## 背景

旧版 harness 每个场景弹一个真窗口，加载后 `win.focus()` + `moveTop()`，再轮询 `win.isFocused()`；probe 每次输入前 `ensureFocus()` 抢回系统焦点。跑的时候不能用电脑，主仓库和 worktree、正在运行的 GrenAgent 会互相抢焦点，键盘断言在全量连跑时偶发失败。按 electron-ui-harness skill 当前版本升级。

## 决定

窗口一律 `show: false` + `webPreferences.offscreen: !visible`（`UI_SHOW=1` / `--show` 时才 `showInactive()` 显示，同样不抢焦点）；静默时 `setFrameRate` 跟主显示器刷新率（上限 240）。`loadFile` 之后按实测 `innerWidth` / `innerHeight` 校正视口（离屏会大 1~2px），再用 `webContents.debugger` 发 CDP `Emulation.setFocusEmulationEnabled`。probe 去掉所有抢焦点代码，`t.resize` 改成按视口校正。`check.mjs` 支持 `--show`、`scenarios/` 为空时以 1 退出。`run.mjs` / `probe.mjs` / `check.mjs` 与 skill 模板逐字一致，项目定制只留在 `harness.config.mjs`、`HarnessRoot.tsx`、`main.tsx`、`stubs.ts`、`index.html`、`vite.config.mjs`（dedupe）。

## 放弃的方案

- 普通窗口 + `show: false`（不离屏）：从没显示过的窗口不推进 CSS 过渡、不应用 hover、滚轮不滚，antd 弹层关不掉。
- 只开离屏、不做焦点模拟：离屏窗口永远不是系统前台，`el.focus()` 不发 focus 事件，靠 focus 记状态的组件会忽略后续按键。
- 加载前就发焦点模拟命令：命令会一直挂着，每个场景都等到超时。
- 保留抢焦点（`win.focus()` / `ensureFocus`）：正是偶发键盘失败和「跑的时候不能用电脑」的根因。

## 后果

静默模式下每次 `executeJavaScript` 往返约 65~78ms（显示窗口时 <1ms），`capturePage` 每张约 75ms（显示时约 20ms），`codemode-card` 全量从约 6s 变成约 8s；probe 里 `t.*` 读取越多越明显。fps 只作参考，性能结论用 `--show`。Linux 上离屏渲染仍要显示服务（`xvfb-run`）。改 `run.mjs` 后要跑 skill 的 `scripts/smoke.mjs`（会检查无可见窗口、页面有焦点、JS focus() 发事件、CSS 动画走完、视口尺寸）。Electron 升级后若 `Emulation.setFocusEmulationEnabled` 失效，`run.mjs` 只打 WARN，键盘断言会先挂。
