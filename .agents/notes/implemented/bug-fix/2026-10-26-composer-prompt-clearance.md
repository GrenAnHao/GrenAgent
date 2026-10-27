# Agent Note: 提问浮层纳入正文底部避让

Status: implemented

## Problem

普通 select 与 ask_user 共用 ComposerPromptOverlay，portal 到对话列后不参与 composer-seat 测高。ChatView 只把 seat 高度传给虚拟列表，正文滚到底仍被卡片盖住，回到底部按钮也可能被盖住。

## Decision

保留浮层挂在会话列里的归属。用 ChatView 内的 React context 登记当前浮层 DOM，统一观察正文视口、输入区及浮层尺寸，并观察浮层定位 style 的变化。底部留白取输入区高度与「视口底边到浮层顶边 + 8px」的最大值；隐藏、关闭、切会话时释放旧登记。继续由 VirtualizedMessageList 的尾部占位、内容测高和 TranscriptFollow 处理滚动，不强制跳到底部。

已搜索活跃笔记，没有同主题记录；冻结的 docs/decisions/electron-agent/chat/2026-10-03-prompt-overlay-in-session.md 解释了会话列 portal 的原因，本次保留该决定，不修改历史。会话查找笔记只涉及顶部查找栏，不合并两种独立避让规则。

## Alternatives considered

- 把卡片改回输入区普通文档流：现有 seat 测高即可覆盖，代码最少；不用，因为会改变既有浮层和会话列裁剪关系。
- 直接追加固定 480px 或每次弹出 scrollToBottom：实现简单；不用，因为短卡、换题、窄窗口的实际高度不同，而且会打断上翻阅读。
- 输入区高度与浮层高度直接相加：容易计算；不用，因为浮层锚定 surface，而 seat 还可能包含 Goal 或审批区，直接相加会重复计算，改用实际覆盖范围。

## Consequences

浮层 portal 脱离输入区，必须显式释放观察者和会话登记；不能把浮层移动造成的几何变化漏掉。真实 UI 运行依赖当前环境的 Electron 浏览器模式可启动。

## Verification

- `cd electron-agent` 后执行 `vitest run src/features/chat/ChatView.test.tsx src/features/chat/input/ComposerPromptOverlay.test.tsx src/features/chat/VirtualizedMessageList.test.tsx src/features/chat/transcriptFollow.test.ts --maxWorkers=2`：58 项通过，退出码 0。新增两项回归在实现前失败（应预留 308px，实际只有 100px），实现后通过。
- 显式 `tsc -p <临时 renderer-vite 配置> --noEmit`：退出码 1，130 条既有诊断；按文件与诊断内容去掉行列号比较，与基线一致，无本次新增诊断。临时配置包含 src 与 vite/client，避免根 tsconfig 的空 files 漏查引用项目。
- `node ui-harness/check.mjs composer-prompt-clearance`：生产构建成功，Electron 子进程退出 2147483651（0x80000003），包装命令退出 1，未执行布局断言。场景覆盖共用浮层、真实虚拟列表、换题、输入区移动、窗口缩放、上翻阅读、按钮和关闭/切会话；真实 UI 验证仍受环境阻碍，不能宣称 PASS。未绕过沙箱或修改安全设置。
- 本次日志与初始 Git 快照在系统临时目录 `pi-overlay-fix-20261026`；不提交临时构建产物。
- 补充窗口测高、浮层仍在时切会话后，`vitest run src/features/chat/ChatView.test.tsx -t 'prompt overlay clearance' --maxWorkers=1`：2 项通过、31 项按筛选跳过，退出码 0。将新 UI 场景加入临时 tsc include 后仍为相同 130 条诊断；probe 的 `node --check` 通过。
- `npm run verify-notes` 退出 1：本机 pnpm 解析仓库目录时报 os error 5，校验脚本尚未启动。改用已安装的 `node node_modules/tsx/dist/cli.mjs <脚本>` 执行该命令中的四个原脚本，全部通过（各退出 0）；101 篇笔记通过结构与格式校验，证据校验仅有 6 条既有警告。
