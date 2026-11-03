# Agent Note: Fast 改为第五项会话独立偏好

Status: implemented

## Problem

用户实际观察同项目切换时 Fast 开关一起变化。原实现按供应商和模型共享，这符合旧规格，但用户在本轮明确选择“Fast 也改为按会话独立记忆”。旧共享规则因此被取代。原四项偏好、能力元数据、provider 请求字段的约定保留，见[原会话偏好](../../implemented/feature/2026-10-28-session-preferences-behavior.md)。

## Decision

可选布尔 fastMode 是 session-preferences 的第五项。会话按原 sessionPath 提交，草稿按独立 draftId 保存，首发过户，切换/重载恢复。缺字段的旧会话按关闭展示和执行，不再从 fast-mode.json 继承别的会话的最近选择。显式项目默认可包括 Fast；普通开关不改默认。

before_provider_request 从发起会话的 sessionManager 读取 Fast，再检查当前模型目录的 supportsFastMode；只有二者同时满足才注入已有 Fast wire 字段。能力取消不抹掉保存值；换回支持模型时恢复会话自己的开关。保存失败回滚，不影响思考/模式/审查/模型，不改已发出的请求。原全局 getter/setter 与旧文件保留兼容，但输入栏和实际请求均不再使用它们。

## Related notes

同主题审计：[模型 Fast](../../implemented/feature/2026-10-28-model-fast.md)部分重叠，其能力声明、协议字段、图标布局与旧取舍继续保留，仅共享开关归属与加载来源被本篇取代；[四项会话偏好](../../implemented/feature/2026-10-28-session-preferences-behavior.md)部分重叠，保留原四项规则，Fast 共享小节标注取代。其它附件与展开状态回归笔记不涉及 Fast 决策，不修改。

## Alternatives considered

保留按模型共享最少改动，且与旧 Fast 规格一致；用户已明确否定这一归属。

只让输入栏开关按会话显示可减少后端改动；发送仍读共享文件会造成“显示关闭却发送 Fast”，不能采用。

按会话再按模型建嵌套开关表可保留每个模型自己的记忆，但本轮已说明改为第五项会话偏好，沿用统一字段与 revision 流程更清晰，不引入第二套键。

## Consequences

同项目、同供应商、同模型的 A 开 B 关互不影响；A/B 往返、重挂、草稿首发保持。false 正确通过解析、合并、回执和持久化；请求按发起会话注入，思考原样，能力取消阻止注入。

这是用户批准的行为变更，旧共享 true 不再自动套到旧会话，需要重新为希望使用的会话打开。显式设为项目默认可以让后续新草稿开启，普通开关不动默认。所有布尔字段用类型判定保留 false。旧会话的渲染快照显式补 false，保证“用当前关闭会话设默认”不会意外保留旧的 true。

Fast 本地保存中/失败状态由 owner 与 attempt 双守卫保护，A 的迟到回执不能清 B 的等待态或在 B 弹错误；A→B→A 及控件卸载也会作废旧 attempt。原模型能力矩阵、键盘与中英文 UI 覆盖保留。

## 验证

结果：通过。证据入口为[验证记录](../../../evidence/2026-10-28-session-fast-mode/README.md)。test-driven-development 的 RED/GREEN 日志覆盖解析（3 failed→27 passed）、宿主/IPC/SDK（9 failed→153 passed）、实际 provider wire（4 failed→5 passed）、渲染层（13 failed→最终 118 passed），另有迟到失败与卸载场景的独立 RED/GREEN。

使用 electron-ui-harness，`npm run ui:check -- model-fast` 94 passed，`npm run ui:check -- session-preferences` 171 passed，共 265 条断言通过；只执行本需求 2/39 个场景，未跑全量。shared/hook 两个真实源文件的独立 TypeScript 检查退出码 0；实际 include renderer/场景的检查已修新 fixture 类型问题，只剩既有 StreamingCodeView 主题声明错误，不宣称全工程类型检查通过。没有使用 files:[] 的根配置冒充 renderer 检查。

独立 reviewer 对共享解析与请求路径复核无阻断，并复跑 27/5 条；父线程复核后端原路径路由、显式默认分离、前端迟到回执和关闭默认边界。未重启当前用户应用、未提交/推送；宿主 API 需要重新构建并重启应用加载。
