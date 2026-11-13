# 桌面 Pi 包更新契约

“配置目标”“磁盘安装”和“运行时已加载”是三种状态：

- 配置目标是 settings packages 中的 npm pin / git ref；升级可修改目标，修复不移动 pin。
- 磁盘安装来自真实 package.json version / 完整 git HEAD，不从进度消息推断。
- 运行时结果来自 operationId + 安装单元 + consumer generation 的逐项回执；安装成功不等于重载成功。

每条包声明以 scope、规范化项目路径和来源 identity 标识。user npm 的整个安装根是一个切换单元，project npm 亦然；git 按同 checkout。确认展示同单元的其他包和全部桌面内消费者，同根非目标包不因此获得版本升级授权。

桌面与 Gren CLI / 裸 SDK 继续共用现有目录，不迁移。只有新 upgrade / repair 操作要求用户明确确认所有外部 Pi / CLI 已退出，且完成前不会启动；外部不受桌面枚举或门控。这不是对任意外部进程的自动隔离承诺。未确认不准备 / 切换，应用内范围未知同样拒绝。旧 install/remove/setEnabled 参数和原使用条件保持，新增单元锁 / pending 门不代表旧接口暗中获得更新授权。

预览由主进程签发 previewId，绑定旧声明 / 实际安装 / 不可变目标 / 安装单元 / 消费者范围。apply 不接受客户端目标、文件路径或来源替换。取消零安装；旧 entry、实际安装或范围变化使确认失效。

操作状态定义：preparing / waiting-idle / ready-to-switch / switching / installed 是准备及磁盘进度；reload-pending / reload-failed / restart-required 是运行时状态。仅全范围新代资源回执通过才 complete；可信枚举为空时保留“安装完成，下次启动验证”。恢复需旧安装、旧 entry 及同范围旧代回执均可用，才 failed-restored；不能恢复则保留 backup 并显示 recovery-required。

本机恢复记录仅包含这次包 / 安装单元 / 声明 / 消费者数据。配置提交在与 SDK 相同的 settings.json.lock 协议里，只 CAS 目标 entry，调用公开 SettingsManager.fromStorage、flush、drainErrors 并读回；不保存或恢复整份用户 settings、auth 或 models。stage / backup 始终是安装单元相邻的同卷目录。

检查只查询静态 npm/git 元数据，不安装或加载包。说明只读真实包根内的有限文本，HTML / 图片 / 链接按纯文本展示，不自动发外部请求。正常安装脚本与资源加载可产生外部副作用，备份不能撤回这些副作用。
