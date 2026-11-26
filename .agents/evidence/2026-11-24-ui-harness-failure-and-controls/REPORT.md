# Electron UI harness：首次失败现场与两个真实试点

## 一次失败能回答什么

[首错 JSON](first-failure/failure.json) 中，第 6 步在 (251, 192) 点击。窗口记录显示 `button[data-testid="receiver"]` 收到按下并获得焦点；合成断言 `Receiver count` 则期望 1、实得 0。[窗口截图](first-failure/window.png) 显示的是 **First observation** 页面。probe 随后替换页面并制造第二次失败，这里保存的仍是第一次。JSON 只记下之前的输入／粘贴动作，不保存正文；窗口截图记录的是窗口可见像素。

## 真实场景与框架自检

| 检查 | 结果 |
| --- | --- |
| 离屏框架 smoke | 29 项通过。验证无可见窗口、焦点模拟、真实键鼠、动画和视口变化。自检临时场景已清理。[输出](smoke.txt) |
| `subagent-conversation` | 41 项通过。实际偏移处持续可点后展开思考；展开正文限高 160 px，真实滚轮能把内容滚到后文。[试点输出](pilots.txt) |
| `attention-toast` | 31 项通过。7,999 ms 仍可见且未开始退出，8,000 ms 后真实组件进入退出态并移除；审批推进 9,000 ms 后仍可操作，答复后计数归零。[最终时钟版本的输出](attention-final.txt) |

在仓库根运行 `node <已安装的 electron-ui-harness skill>/scripts/smoke.mjs --app electron-agent`。两个业务场景从 `electron-agent` 运行 `npm run ui:check -- subagent-conversation attention-toast`。时钟的跨进程错误传递修正后，只复跑了消费该接口的 `attention-toast`。本次共检查 2 个业务场景，未执行其余 61 个。[改动影响预览](selection.txt)只列选择结果，没有启动额外场景。

## 专项夹具（从 electron-agent 运行）

| 命令 | 实际验证 |
| --- | --- |
| `node --test ui-harness/failure-recorder.test.mjs ui-harness/failure-fixtures.test.mjs` | 两项测试通过。10 种隔离场景覆盖连续断言、窗口销毁、页面错误、probe 异常、严格点击失败、未就绪、零断言、渲染挂起超时、成功和关闭自动截图；同名并发目录互不覆盖，成功不生成失败包，禁用截图仍有 JSON。目录写不进去仍报告原错；子进程 0／1／2，外层 CLI 继续执行点名的下一场景并汇总为 1。 |
| `node --test ui-harness/tests/clickReady.test.mjs` | 离屏 Electron 夹具通过。中心可点但指定落点受阻时，严格点击零派发；原始点击能打到遮挡物。命中中断、节点替换和位置变化均重置稳定时间，恢复后只点击一次；禁用、不可见和目标消失分别报告。 |
| `node ui-harness/tests/clock.electron.mjs` | 离屏 Electron 检查通过。验证有效和非法推进、原生 rAF／定时器／性能计时与主进程超时、卸载恢复、异常销毁后新窗口不继承业务时间。 |
| `node --test ui-harness/tests/affected-runner.test.mjs` | 选场景检查通过。移出公共运行器的本地模块仍能被 `--changed` 识别；单个 probe 的专用辅助模块不因此扩大范围，独立失败夹具不进入日常场景清单。 |

需要另留一份合成失败示例时，运行失败夹具前设 `UI_KEEP_FAILURE_EXAMPLE=1`，看终端打印的示例目录。日常故障则直接看 `ui:check` 输出的「失败现场」，不需要打开调试窗口或事先开启录制。
