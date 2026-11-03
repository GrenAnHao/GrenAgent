# 移除 Brainstorm 产品模式验证

- `extensions-final.log`：12 文件、164 项通过；包含共享偏好、模式、Plan/Ultra、Fable、规则与提示词 metadata。
- `shared-red.log` / `shared-green.log`：完整快照兼容与严格新 patch 的红绿验证。
- `extensions-red.log` / `extensions-green.log`：扩展入口与命令删除的红绿验证。
- `host-tests.log`：主进程/规则服务/真实 SDK 会话偏好集成，3 文件、147 项通过。
- `compat-renderer-red.log` / `compat-renderer-green.log`：旧快照、状态、草稿与无 revision 回执，4 文件、73 项通过。
- `ui-renderer-green.log`：模式选择器/模式 store/命令名，3 文件、29 项通过。
- `ui-check.log`：ultra-mode 75 项、session-preferences 171 项通过，仅此 2 个 UI 场景。
- `ultra-mode-modes.png`：真实模式选择器截图，宿主读写为桩。

早期 renderer-red.log / renderer-green.log 曾被并行兼容测试同名覆盖；兼容测试已另存 compat-renderer-*。选择器原红灯仅有会话工具输出记录（4 失败、25 通过），未回退源码补造日志。最终 renderer 绿色结果以 ui-renderer-green.log 为准。
