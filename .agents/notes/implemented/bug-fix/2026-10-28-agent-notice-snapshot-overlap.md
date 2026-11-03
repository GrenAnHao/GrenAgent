# Agent Note: 快照与实时尾巴重叠时保留重复发送的代理消息

Status: implemented

## Problem

代理通信展示的边界验证发现：`mergeLiveTail` 对 notice 只用 `customType + content` 的存在性去重。后端快照只有第一次发送，而实时尾巴有两次同文发送时，第二次被吞掉。实时与历史的时间戳来自两次取时，不能要求严格相同来匹配同一消息。

## Decision

对 agent-message、job-done 和 subagent-settled 在快照与尾巴之间逐项配对已有通知，每个快照位置最多匹配一次。匹配项保留快照 id，补齐现有实时元数据；多出的尾巴条目照原序追加。普通注入通知的既有去重保持现状。

此修复服务于[子代理消息呈现](../feature/2026-10-28-subagent-message-rendering.md)，不改消息生产者、调度、存储协议。

## Alternatives considered

- 严格按 timestamp 去重。最强理由是可区分同文多次发送；不用，因为历史的落盘时间和实时消息时间不是同一次取时，会将同一事件重复展示。
- 继续按正文存在性去重。最强理由是可兼容旧历史没有 metadata 的记录；不用，因为一对多重叠时必然吞消息，需保留同文条目的数量。

## Consequences

快照一条、实时两条同文发送，合并后保留两条；重叠条目保留原 id、补齐元数据。普通 notice 沿用既有行为。

生产者没有稳定的实时 custom event id；完全同文同毫秒的独立发送仍无法在单一路径中可靠区分。此处只保留已在两份列表中可确认的发送数量，不猜测缺失事件。

## 验证

结果：通过。修复前 `cd electron-agent && npx vitest run src/stores/agentNoticeProjection.test.ts` 为 7 passed / 1 failed，预期两条实际一条，日志 `.agents/evidence/2026-10-28-subagent-message-rendering/snapshot-overlap-red.txt`。

修复后运行 `npx vitest run src/stores/agentNoticeProjection.test.ts src/stores/sessionMessageSync.test.ts src/features/chat/agentCommunicationModel.test.ts`，3 文件 22 项通过，日志 `projection-tests.txt`。最终 11 文件 208 项专项回归也包含这两份投影测试并通过，日志 `final-tests.txt`。证据均在 `.agents/evidence/2026-10-28-subagent-message-rendering/`。
