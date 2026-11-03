# Agent Note: 附件 UI 场景复位不再改写权威存档

Status: implemented

## Problem

会话偏好改造把附件的 IndexedDB 权威记录从整表改为独立 owner 桶。收尾实跑 composer-chips 时 25 条通过、5 条失败：场景的 dropMemoryKeepStorage 先清 store（触发 persist 删除 owner 桶），然后只把旧整表镜像写回，无法撤销独立桶的删除遮罩，因此模拟重启把存档破坏了。这是 harness 场景复位假设过期，不是实际重载会主动清空存档。

## Decision

场景在清空内存的短作用域内临时把 persist storage 的 setItem 换成 no-op，finally 恢复原 adapter；随后使用真实 rehydrate 读取完整 IndexedDB 存档。测试不在生产代码里增加“清内存”方法，也不复制内部磁盘格式作为恢复协议。

## Alternatives considered

备份整表与所有 owner 记录后写回，最接近原 reset 写法；但绑定内部格式，下一次分桶/索引变化仍会失效，也可能覆盖测试期间的新写入。

把生产 store 加 resetMemoryOnly，调用最简单；但这个能力只供测试使用，应保留在 harness 场景里。

## Consequences

场景只在测试内部控制写入，生产 storage adapter 不改。真实图片预览、IndexedDB 去 URL、清内存后恢复两张图与粘贴块、内存优先与 X 移除保持。临时 storage 在 finally 恢复，后续断言继续走真实存储，不复制其内部格式。

## 验证

RED：npm run ui:check -- composer-chips，25 passed / 5 failed，见 `.agents/evidence/2026-10-28-session-preferences-behavior/ui-composer-chips-first.log`。

结果：通过。`cd electron-agent && npm run ui:check -- composer-chips`：30 passed / 0 failed，见 `.agents/evidence/2026-10-28-session-preferences-behavior/ui-composer-chips-green.log`。只修场景复位并点名复跑，没有为这条修复运行无关全量 UI。
