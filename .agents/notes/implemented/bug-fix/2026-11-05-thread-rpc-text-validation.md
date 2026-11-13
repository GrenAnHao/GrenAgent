# Agent Note: 回合正文与 RPC 标识符分别校验

Status: implemented

## Problem

`gren:invoke` 的 `INVALID_PARAMS: string parameter is required` 丢失了方法名和字段名。`turn.create.input` 还复用非空标识符校验，与 IPC 的 `readText` 和 ThreadStore 接受字符串正文的契约不一致，纯图片消息的空正文因此被拒绝。用户另报普通发消息及 Repo Wiki 生成失败；空正文仅是一条已定位路径，不能据此解释全部现场问题。

## Decision

回合正文只检查字符串类型，原样保留空串、空白及文本；ID、workspace、permissionProfile 仍要求非空。线程、回合、条目 RPC 的字符串参数错误直接指出方法与字段，不回显参数值。用真实 AgentDataService → socket → Runtime → SQLite 的定向测试验证；PiRuntimeService 的文字与纯图片用例仅替换模型 handle，不调用真实模型。

与[自有 Runtime](../../implemented/architecture/2026-08-31-self-owned-agent-data-runtime.md)部分重叠：保留其 RPC/线程存储边界，本篇仅限定参数语义。与[解耦评估](../../proposed/architecture/2026-11-03-agentdata-lightweight-decoupling-review.md)相邻，但不改变其待定架构和退役范围；不修改上述旧记录。

## Alternatives considered

- **发送层补占位文字**：让旧 RPC 无需修改即可接受纯图片。但会篡改用户输入，且其他调用方仍然踩到同一契约错误，故不采用。
- **所有字符串都允许空串**：实现最少，但会放松线程、回合和工作区的身份校验，故只放宽正文。

## Verification

- 修复前 `threadRpc.test.ts`：10 项中 8 项失败；空串、空白正文复现用户同样的 `INVALID_PARAMS: string parameter is required`，另外 6 项显示诊断缺失。
- 修复后 `npx vitest run electron/agentData/threadRpc.test.ts electron/agentData/runtime.test.ts electron/agentData/threadStore.test.ts electron/app/agentDataService.test.ts`：20 项通过。
- `npx vitest run electron/app/piRuntimeService.test.ts electron/agentData/threadRpc.test.ts`：128 项通过，含普通文字与纯图片穿过真实回合 RPC 到达模型 handle。
- `npm run test:repo-wiki-flow`：9 文件 49 项通过，含专用类型检查、确定性 provider 与真实 Wiki OS child 的生成、发布和读取。
- 对用户数据只读回放最近的 `CATALOGUE_CHILD_OUTPUT_INVALID` 任务 `4ba605e2-39df-41e1-9207-a54574589ab2`：checkpoint_history 内 3 条失败原文，当前解析器 3/3 通过；未改历史任务状态或重发模型请求。另一个项目的历史 `SOURCE_COVERAGE_INCOMPLETE` 属于源码扫描门控，未变更该规则。
- `npx electron-vite build --mode localrun` 通过，开发产物已更新。
- 主进程完整类型检查 `npx tsc -p tsconfig.node.json --noEmit` 失败：当前未提交重构已有 Runtime 重复方法、删除的 taskViewStore 引用及跨项目文件清单等错误。本次不顺带清理，不能据开发打包通过宣称完整类型门禁通过。根 `tsconfig.json` 无直接文件，不能替代此检查。

## Consequences

收益是纯图片不再被线程持久化层阻断，错误可以定位具体字段。代价是这些 RPC 校验错误的 message 更具体，错误码不变。这里只放宽正文，不改变发送层是否接纳完全空消息的规则。

普通文字失败尚未从现场复现，需用户重启开发构建后重试并提供具体字段错误；Repo Wiki 旧失败项需要用户显式 repair，离线链通过不等于真实模型恢复。当前工作区已有大量未提交重构，修复不回退或覆盖这些修改。未触发真实模型，也未重启用户应用。
