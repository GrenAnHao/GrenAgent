# Ultra 独立审查

只读审阅者：sa-1d7293f9。审阅模式/路由/生命周期/规则/设置及 SDK 能力面，未修改文件、未运行测试。审阅依据为本轮决策笔记和工作树当前实现；已有未提交的 CodeGraph/Fast/提前启动删除等改动不归本轮审查。

结论：除集成期间已发现并修复的项目外，无新增可证实的 Critical / Important。

确认并已修复：普通与 Ultra 配置隔离；完整授权后启动；逐节点推理校验；Plan 未确认不进 Ultra；子域固定及缺历史模型时拒绝自动换模；父回调 SDK 身份优先于发送方 ALS；坏规则模式不扩到所有模式；只清理规则自身路径；规则 Markdown 同时复制到 main/chunks。

审阅者特别核查 parent-host.sendMessage / settlement 的调用上下文，确认父回调可能携带子 ALS。修复使用 SDK 自身 sessionManager 判断根会话，只有缺少会话对象才从 ALS/env 推断子域；parent-callback-red.log 与 parent-domain-final.log 记录了失败及修复验证。

两条 Minor 的裁决：

- provider 过滤建议：规范 provider/id 即使 id 内含 / 或 :，按第一个 / 取 provider 仍是正确的，所述规范路由触发条件不成立。手写非规范 bare-id 的别名配合 provider filter 可能漏列，是可选发现过滤的边缘情况，留待后续；UI 保存的是规范路由，实际派工解析不受影响。
- 显式 model 错误来源建议：当前显式值解析失败会立即报错，并不会回退到角色模型；`model (Ultra)` 正确指出调用参数来源。无需按不存在的回退路径改文案。

本次不继续扩展架构或修无关模块，所有实际阻塞项以回归与 SDK/UI 运行证据关闭。
