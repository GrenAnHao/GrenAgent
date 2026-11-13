# Agent Note: 高级参数样式探针按可见标签取样

Status: implemented

## Problem

高级参数折叠场景实跑中，功能、草稿和键盘检查通过，样式检查却因 getComputedStyle(null) 中断。新增 probe 假设 InputNumber 的 data-testid 总在外层容器，并从 parentElement 取标签，实际 DOM 不保证该层级；高级字段也已将字重放到独立标签 span，不能再取整个 label 容器的字重。

## Decision

探针在真实模型正文中定位可见“最大输出”标签，并取高级字段的直接标签 span，比对用户实际看到的字体。缺目标时明确报错，不以默认样式或跳过断言掩盖失败；不为配合测试更改生产布局。

## Alternatives considered

- 放宽到任意父级或在缺失时默认14px/600：改动最少；但会掩盖真实字体不一致，因此精确取实际标签并保留断言。

## Consequences

model-advanced-settings 完整通过字体、网格、主题和窄屏断言，无页面脚本错误，原有功能回归不删除。探针不再依赖 InputNumber 的 DOM 包装层级；代价是可见标签文字改名时需同步这个参考目标。

## 验证

按 electron-ui-harness skill 单独复跑 `cd electron-agent && npm run ui:check -- model-advanced-settings`：138/138 通过，无 MISS、FAIL 或页面脚本错误。失败日志保留为 style-probe-red.log，完整通过记录为 advanced-ui-green.log；证据目录：`.agents/evidence/2026-11-11-advanced-parameters-accordion/`。只修 probe，没有为通过检查修改生产布局；未跑全量场景。
