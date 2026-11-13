# Agent Note: 隐藏当前模型的真实 Select 候选与探针边界

Status: implemented

## Problem

[内置模型显隐](../feature/2026-11-11-builtin-model-list-visibility.md) 的首轮真实 UI 中，多卡场景 154 项通过，但显隐场景 90 项通过、2 项失败。旧 ModelAction 使用 @lobehub/ui/base-ui Select，探针错误使用 antd 的 .ant-select 定位，出现 MISS 后全隐藏计数 0 仍被当作通过；另一处失败只是 AntD Button 将中文“显示”插入空格的渲染差异。

独立审查进一步确认功能遗漏：base-ui Select 的 useSelectValue 会把不在 options 中的已选 value 自动追加到 resolvedOptions。仅过滤传入 options，不能保证隐藏当前模型后真正从弹层候选移除。先前单测 mock 了 Select，未覆盖这个真实库行为。

## Decision

旧控件分开已存会话身份与可选 UI value：隐藏中的当前值仍存在组件状态，不调用任何模型 setter，但不把它作为 Select 的已选值传入；触发器以当前模型名称和已隐藏提示回显，弹层只接受可见候选。空值回调不解释为切模。

ModelAction 单测改用真实 Select，只有目录/会话等后端边界使用桩；model-visibility probe 改为真实 base-ui combobox 和 role=option，并在期望可打开时检查弹层确已出现。全隐藏时明确断言 trigger disabled，不能再让 MISS 自动算空候选。中文按钮以 aria-pressed 为主，文字断言只规范化组件插入的空白。

## Alternatives considered

- 把隐藏当前值作为 disabled option：最容易阻止再次选择，也能回显；但弹层仍展示本应隐藏的模型，不符合用户隐藏语义。
- 将旧入口换成 AntD Select：与现有错误探针匹配，改动较短；但为测试更换控件会改变样式/交互，且遗留真实依赖假设未被验证，故保留当前库并修正值/候选分离。

## Consequences

真实 Select 的已选模型隐藏后不再自补到 role=option；当前标签仍显示、会话 setter 不调用；跨供应商同 ID 仍可选，全部隐藏时禁用且没有陈旧弹层。探针不再 MISS 旧入口，也不将缺失控件当作空候选。两个本次 UI 场景均已通过。

代价是旧控件的 UI value 与内部保存身份分离，因此 onChange 显式忽略空值和不在可见候选中的键；null 不成为用户切模操作。真实组件单测取代渲染层 Select mock，避免再次只证明传入 options 而漏掉库处理。

## 验证

按 electron-ui-harness skill 完成，结果：通过。证据目录：`.agents/evidence/2026-11-11-builtin-model-list-visibility/`。

- `cd electron-agent && npx vitest run src/features/chat/input/actions/ModelAction.test.tsx`：先在 legacy-real-select-red.log 复现真实 Select 弹层有 2 项而非 1 项，再在 legacy-real-select-green.log 中 1/1 通过；当前名称不丢、setter 未调用、全隐藏禁用均验证。
- `cd electron-agent && npm run ui:check -- model-visibility`：99/99 通过，见 visibility-ui-green.log。旧入口 combobox 存在、真正打开 base-ui option、隐藏项没有被补回、全隐藏禁用均已断言；无 MISS。前一轮失败完整保留在 ui-first-red.log，不以此次通过覆盖历史。
- 原 builtin-model-settings 154/154 通过，本修正没有 UI 行为影响，不额外重跑；本任务总计只跑 2/54 个场景，其余 52 个未跑。最终定向回归 13 文件 140/140 与生产构建通过，见 final-tests.log、production-build.log；独立最后静态复查无新阻塞，审查者没有独立实跑。
- 生产/场景定向严格类型检查仍有工作区原有 5 条 OAuth 类型诊断，本修正无新诊断，见 renderer-typecheck.log；没有宣称全仓类型检查通过。未读真实 auth、未发真实模型请求。
