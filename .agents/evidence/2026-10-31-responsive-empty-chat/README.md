# 响应式居中空白页

- `unit-red.log` / `unit-green.log`：旧底部空态回归红灯；最终3文件、63项通过。
- `ui-red.log` / `ui-green.log`：单场景从43失败/201通过转为244全部通过，仅1/42场景。
- `affected-ui.log`：只做影响分析，未执行全量。
- `wide-light.png` / `narrow-light.png`：真实组件的宽窄浅色截图。
- `same-column-wide-window.png` / `same-column-small-window.png`：两种来源的600px实际聊天列，字号、卡片宽高与留白相同。

真实组件与存档逻辑参与验证，宿主读写为桩；不代表真实后端切会话或安装包验证。
