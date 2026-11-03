# 独立审查与收敛记录

两份初审由只读 reviewer 检查生命周期与后端；最后一位 reviewer 对修复点做定向复核。审查不重跑已有测试，测试结果由主线程逐一收集日志核对。

## 已处理

| 发现 | 处理与证据 |
| --- | --- |
| 删除 A 后自动切换链在 await 窗口抢回 B | 有候选时复用 handleOpenSession 的 token/回滚流程；无候选直接进入正常新草稿，使用默认初始化，不再 getState(workspace) 猜后端临时空会话。 |
| 取消弹层后切走的发送绕过 lane/侧栏/命令回执 | 执行性命令先处理；detached 请求仍经原路径 lane，侧栏传第四参原 path。新增 3 条 RED，最终主线程 155 条通过。 |
| 未绑定草稿的等待态进入旧会话 shadow | 真实 agent store RED 复现；leaveView 只停靠 loadedSessionPath，不使用调用方上次路径作草稿归属。 |
| 旧整表附件未编辑过的桶未迁移 | RED 复现镜像覆盖后丢桶；getItem 将 legacy-only owner 以原子 setItemIfAbsent 迁为独立记录。 |
| 重复打开空项目/已使用 scratch 的身份 | 当前空项目恢复原草稿 ID；显式“新建”仍按已批准规格生成新 ID；works 已有 session 时不再把 draftId 当未使用 scratch。 |
| SDK model getter 不能赋值回滚 | 改为写 session.state.model；真实 SessionManager 故障注入验证 live/getState/reopen 一致。 |
| SDK 先改内存再 I/O 抛错留下脏 canonical | 精确回滚失败条目与索引/leaf，auth 预校验、canonical 先写、live 失败恢复。真实故障注入而非只 mock append 直接 throw。 |
| 模型切换后有效思考未重套 | model-only patch 也按保存请求重算 effective；非推理钳 off，不改 high。真实 SDK 路径通过。 |
| 原生显式模型切换被 canonical 吞掉 | shared parser 识别显式原生模型，主线程又在实际 Gren 工厂入口补 RED→GREEN，最终 8 条通过。 |
| prompt 守卫漏 steer/follow_up | PROMPT_COMMANDS 全部经过模型可用性守卫；目录移除不再自动选首项。 |
| 排队 handle 被换会话、并发非前景加载 | 捕获身份、固定 session/manager，必要时按原 path 复建并去重；替换/释放等待在途写。 |
| 同一会话其它窗口的 model/thinking 不刷新 | 进入/重挂刷新＋并发合并、提交后 session-preferences 广播、revision/pending 字段保护。 |
| 展开 setter 不兼容原 React 函数式调用 | 单独回归笔记，布尔/函数式输入均支持，toggle 读最新值；真实 UI 与 96 条组件/store 回归通过。 |

最后定向 reviewer 的源码结论是修复闭环。其无法读取部分相对路径日志，因此通过数由主线程实际 job_output / 本目录文件确认，不把 reviewer 的未取证项包装成其验证结果。

## 裁定与边界

- 显式“新建”产生新身份是规格要求；“重新打开当前空项目”恢复原身份，两者区分。
- 无项目剩余会话时回到正常草稿，而非接管后端释放 handle 产生的 SDK 默认空会话，保证项目/应用默认初始化一致。
- 纯偏好编辑可能保留额外非前景 handle，生命周期仍归 workspace，未引入独立窗口引用计数或新的 dock 跨窗口合并系统。
- 没有为未暴露的 SDK 树内导航新增一套会话身份语义；已覆盖产品使用的 fork/clone/rewind 新分支文件路径。
- 同一未落盘 draft 多窗口并发字段冲突为后写覆盖；已建会话走宿主字段级提交。同一 draft 的冲突编辑没有端到端验证。
- 原生 thinking 事件信息不足时保守保留请求值；输入栏精确 setter、SDK 1.3.0 故障回滚与模型目录失效路径均有定向证据。
- 不宣称全工程 tsc 或 main 全量通过；本轮新增类型问题已修，工程既有诊断/失败保留在日志。
