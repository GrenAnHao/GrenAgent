# 专业工作台验证

- `component-tests.log`：9 文件、103 项定向组件单测通过。
- `sidebar-ui.log`：session-row 68 项、sidebar-sections 59 项通过。
- `workbench-layout.log` / `workbench-layout-repeat.log`：完整外壳场景连续两次 48 项通过。
- `workbench-layout-short-red.log`：滚轮修复前的有效红灯；最终日志记录修复后 scrollTop 498→398。
- `affected-ui.log`：影响范围只读分析；共享主题被列为影响全部场景，实际未执行全量 UI。
- `workbench-layout-*.png`：真实渲染组件的浅色、深色、消息、窄屏及低矮窗口截图，宿主读写为桩。

早期 setup / initial-pass 日志保留排查过程；最终结论以上述最终日志为准。
