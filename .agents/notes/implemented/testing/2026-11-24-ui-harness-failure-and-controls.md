# Agent Note: 离屏 UI 检查保留首错，区分实际输入与业务时间

Status: implemented

## Problem

虚拟列表的按钮位置不变，实际接收点击的却可能是外层。一长串同步断言跑完再截图，往往看不到第一个失败。通知倒计时也不应通过实等九秒来判断八秒的边界。

## Decision

沿用[离屏运行与按需检查](2026-10-05-ui-harness-offscreen-and-scoped.md)：真实输入、不抢焦点、只跑当前场景。首个失败同步锁定断言及最近最多 32 步，立即启动限时取证；原断言仍返回布尔值并累计失败。自动附件与手动截图分开，前者按工作区、运行和场景隔离。严格点击先在指定位移处等待命中，再发送一次原生点击；旧点击保留原语义。通知场景只推进渲染窗口的 `Date.now()`，绘制与退出动画仍走真实时间。

Pi 的 `run.mjs` 和 `probe.mjs` 接入本仓库的诊断、点击和时钟模块，不能再用共享模板逐字覆盖。工具箱的 Node 侧依赖也计入 `--changed` 的选择，拆出独立模块不会漏报。全局 skill 不变。

## Existing notes audit

原离屏笔记保留其运行和选场景决定；本篇补充诊断、严格点击和时间控制。[提醒的产品语义](../feature/2026-10-19-session-attention-badges-and-notifications.md)不变。

## Alternatives considered

- 全程录屏便于倒看；它让成功的场景也承担持续采集成本。自动重跑虽简单，却可能再也看不到第一次失败。
- 把所有点击都改为等待可点，场景作者不必选 API；故意点被遮或禁用目标的负向场景却无法执行。
- 整页虚拟时钟可以加速更多等待；冻结动画帧、性能采样或看门狗会改变被测行为。仅控制通知依赖读取的墙上时间。

## Consequences

失败包能区分“鼠标打到了别的元素”和“按钮收到点击但结果不符合预期”。断言和最近步骤是同步锁定的；像素与焦点是随后异步采样，不保证同帧。窗口挂起或销毁时保留缺项原因。截图可能包含合成窗口的可见正文，可按场景禁用；JSON 不复制输入正文。

## Verification

`node --test ui-harness/failure-recorder.test.mjs ui-harness/failure-fixtures.test.mjs` 在 `electron-agent` 下通过。证据目录：`.agents/evidence/2026-11-24-ui-harness-failure-and-controls/`，见[验收记录、命令及首错样例](../../../evidence/2026-11-24-ui-harness-failure-and-controls/REPORT.md)。实际离屏 smoke 29 项、子代理详情 41 项、通知 31 项通过；通知 7,999／8,000 ms 关闭边界和审批 9,000 ms 不消失均由真实组件验证。故意制造的两次失败只生成一份首错，首个点击坐标、实际按钮和画面吻合。
