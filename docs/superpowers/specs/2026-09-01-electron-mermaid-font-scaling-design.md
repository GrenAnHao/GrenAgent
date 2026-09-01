# Electron Mermaid 字体缩放修复设计

## 背景

Electron 聊天页通过 `@lobehub/ui` 的 `ThemeProvider` 注入全局 `font-size-adjust: from-font`。`beautiful-mermaid` 先按 SVG 用户坐标计算节点和文字尺寸，LobeHub Mermaid 再用 `width: 100%` 将宽图缩放到消息容器。SVG 文本继承全局 `font-size-adjust` 后没有与节点几何保持相同比例，长标签溢出并互相重叠。

实测同一节点在当前页面中的边框宽度为 `120.9px`，文字宽度为 `305.5px`。将 SVG 文本的 `font-size-adjust` 改为 `none` 后，文字宽度降为 `113.3px`，重新落入节点边框。

## 决策

只修改 Electron 的 `src/features/chat/Mermaid.tsx`。在 Mermaid 图表框内部设置 `font-size-adjust: none`，由 SVG `<text>` 继承该值。保留 LobeHub Mermaid、`beautiful-mermaid`、主题字体和现有导出流程。

该规则不放到全局样式中，避免改变普通正文、输入框和其他回退字体的排版。Tauri 组件不在本次范围内。

## 代码范围

- 修改 `electron-agent/src/features/chat/Mermaid.tsx` 的 `diagramFrame` 样式。
- 修改 `electron-agent/src/features/chat/Mermaid.test.tsx`，增加局部字体调整回归测试。
- 不修改依赖版本、Mermaid 源码清洗、导出 SVG/PNG 或错误处理。

## 测试

1. 在现有 Mermaid 适配测试中渲染组件，定位 LobeHub Mermaid 外层的图表框，断言其计算样式为 `font-size-adjust: none`。测试先在现状下失败，再由最小样式改动通过。
2. 运行 Electron Mermaid 单测文件。
3. 运行 Electron TypeScript 构建。
4. 在浏览器中渲染现有宽图复现数据，确认长标签的屏幕宽度不超过对应节点边框，并检查截图中无文字重叠。

## 成功标准

- 截图中的宽流程图文字随 SVG `viewBox` 同比例缩放。
- Mermaid 之外的页面排版不变。
- 现有 Mermaid 解析、错误卡片、完整功能模式和导出行为保持不变。
