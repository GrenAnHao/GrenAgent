# Agent Note: MCP 权限在模块挂载时独立读取

Status: implemented

## Problem

扩展页重构核验发现，权限读取 effect 使用空依赖数组，却在服务器仍加载时直接返回。首次挂载 `mcpLoading` 固定为 true，因此已有权限不会读取；后续点击权限可能从空文档开始写入，丢失其他工具的原有策略。

## Decision

权限文件读取独立于服务器列表，模块挂载时发起一次读取，卸载后忽略回执。保留原有文件格式、权限设置和参数规则序列化，服务器加载或重载不重复读取权限。

## Alternatives considered

- 把 `mcpLoading` 加入依赖能在列表完成后再读；但权限并不依赖服务器列表，启停导致的重复加载还可能用迟到回执覆盖刚修改的状态，因此直接移除无关等待。
- 保留空文档直到第一次设置能减少请求，但会遗漏已有策略，无法满足管理页显示及保留配置的要求。

## Consequences

已有工具权限在首次进入时可见，修改一项时保留其他工具策略。此修复不改变写入失败的现有处理方式，也不增加权限文件监听。

## Verification

- `ExtensionsPanel.test.tsx` 新用例先观察到读取次数为 0 的失败，移除等待后通过。
- 定向 MCP 测试六文件 43 项通过；复核新增的选择与空态后，三个 UI 组件测试文件 18 项通过。
- 证据：`.agents/evidence/2026-10-31-extension-workbench/mcp-policy-red.log`、`mcp-unit-green.log`、`mcp-review-green.log`。集成场景继续检查已有策略回显及其他服务器权限保留。
