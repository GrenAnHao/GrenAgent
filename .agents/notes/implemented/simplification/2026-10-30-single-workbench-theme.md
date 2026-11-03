# Agent Note: 收敛为单一工作台配色并对齐会话输入宽度

Status: implemented

## Problem

专业工作台固定了外壳配色，外观设置却仍能用方案、主题色和中性色改变控件，形成两套颜色。用户要求取消配色方案。用户还反馈消息页输入卡被单独限宽为 880px，和较宽的消息内容列不对齐。

## Decision

移除配色方案、主题色、中性色选项和对应运行时入口，统一固定工作台 palette 与真实组件 token。保留字号、浅色、深色和跟随系统。App、预览及 harness 共用真实主题 Provider；旧存档中的颜色偏好不再进入运行态，新写入只保留明暗与字号。

输入卡只在新对话空态保持紧凑宽度；有消息后与真实消息内容列共用宽度与左右边缘，保留同一个编辑器及草稿。

左侧图标栏宽 52px，按钮缩为 36px、圆角 8px、图标 18px、行间距 12px；每侧留白为 8px。选中只使用淡背景与图标色，不画左侧竖条。

图标栏、会话列表、聊天区分别采用独立的固定表面色：浅色依次为 #e7e9e4 / #f3f3f0 / #fffefa，深色为 #151719 / #222325 / #191a1c。标题栏与图标栏同色，形成连续外框。图标栏通过 --gren-rail-bg 取色，不再与会话列表共用背景变量。

## Related notes

草稿空态的位置与窄列比例以用户视觉确认的[响应式整体居中](../bug-fix/2026-10-31-responsive-empty-chat.md)为准；[统一贴底](../bug-fix/2026-10-31-draft-composer-bottom.md)是此前调整记录。已有消息仍贴底，本篇的配色和消息态水平对齐继续有效。

这是对[专业工作台](../../implemented/feature/2026-10-30-professional-workbench.md)的部分修正：取代「管理面板及表单沿用用户配色偏好」和「所有状态输入卡最大 880px」两项；原空态布局、节点延续、滚轮与侧栏层级继续有效。检索 colorScheme、配色方案与主题方案无其他活跃同主题记录。

## Alternatives considered

- 仅隐藏配色入口，改动最少，也能保留恢复旧版的偏好；但旧存档及其他 Provider 仍可能套用旧颜色，不能消除冲突，因此移除偏好读取并统一来源。
- 让全部旧配色方案适配工作台能保留自定义能力；用户明确要求取消配色，继续维护方案矩阵会增加无需求的复杂度，因此不保留。
- 把消息区也压窄到 880px 可以直接统一两者；但会缩窄已有代码、表格和工具内容的阅读空间，因此仅让消息态编辑器恢复消息列的实际宽度。

## Consequences

外壳、正文、真实控件与浮层采用同一颜色来源，代价是不再提供自定义配色。themeStore 恢复时仅白名单合并 appearance 与 fontSize；存储键 pi-theme 保持兼容，新写入只保存这两项。首屏加载页也同步固定颜色，避免 React 挂载前后换成另一套底色。

Lobe 的默认算法会在主题派生阶段将 colorPrimary 覆盖成灰阶。workbenchTheme 通过统一的末级算法写入完整 primary 家族，并用公开 generateColorPalette 保留语义状态色，App / 预览 / harness 共用 WorkbenchThemeProvider；不能只传 token.colorPrimary 或只给外壳写颜色。

消息态恢复 CHAT_CONTENT_WIDTH，并保持输入列 8px padding + 编辑器 16px margin 与消息内容 24px padding 一致。实际滚动条宽度仍由既有 gutter 测量扣除；空态 880px 仅用于新对话，不压窄已有消息、代码和表格。

## Verification

- `npx vitest run` 定向验证 themeStore、AppearanceSettings、workbenchTheme、ThemeBridge、ChatView、ModuleRail：6 文件、65 项通过。旧存档恢复、外观入口删除、真实 Lobe 最终颜色与消息态列宽均先验证红灯再转绿；最终竖条移除后 ModuleRail 10 项单测再次通过。
- `npm run ui:check -- appearance-settings`：33 项通过，真实点击字号与三态外观、CDP 改变系统明暗，检查实际主题按钮、背景和 Popover 颜色与存储内容。
- `npm run ui:check -- workbench-layout`：75 项通过，包含图标栏 52 / 按钮 36 / 图标 18 / 模块间距 48px、选中无竖条、1800px 与 760px 窗口下输入卡和消息内容两边对齐、实际滚动条扣除、编辑器节点与草稿延续及空态滚轮。深浅色验证标题栏与图标栏同色、图标栏/会话列表/聊天区三色各异、浅色逐层变亮、选中淡底合成后可辨；见证据目录内 `ui-workbench-surface-hierarchy.log`。影响分析因 ThemeBridge 公共依赖列出全部场景，但新增变量只给图标栏消费，本次只跑 workbench-layout，未扩大为全量。
- 只运行上述 2 个相关场景，未执行其余 39 个场景。验证使用真实渲染组件与宿主桩，不代表主进程业务、安装包或发布验证。
- 证据与截图：`.agents/evidence/2026-10-30-single-workbench-theme/`。
