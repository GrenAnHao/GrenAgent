# Agent Note: 同项目正在跑的会话各自留一个 handle

Status: implemented

## Problem

同项目多份会话原来共用一个 `WorkspaceHandle`。切换只改前景 id，真正的 `switchSession` 会换掉这份运行时里的 jsonl。只要有交互回合没结束，替换命令就抛 `SESSION_BUSY`。界面却已经把选中会话改掉了，流式事件仍按 workspace 灌进同一份消息，于是切来切去都是同一段对话，也不能一边跑一边开另一个会话。

## Decision

前景会话正在跑时，`agent_switch_session` / `agent_new_session` 不再改它，而是再开一个 handle 并把它设为前景。目标会话如果已经有 handle，只切换前景。空闲时仍在同一个 handle 上 `switchSession`。渲染层按 `sessionPath` 把别的会话的事件写进该会话自己的缓存，不写进当前画面。fork / rewind 仍会改正在跑的那份，继续拒绝。关掉项目时，MCP、IM 和子代理控制面要等该项目最后一个 handle 释放才拆。

### 涉及文件

- `electron-agent/electron/agent/agentHost.ts`
- `electron-agent/electron/app/piRuntimeService.ts`
- `electron-agent/src/stores/agent.ts`

### 来源

- `docs/decisions/electron-agent/2026-09-30-same-project-concurrent-sessions.md`

## Alternatives considered

- 继续一个项目一个 handle，切换失败时只把界面 id 改回去：能消掉报错文案，但跑着的会话仍然挡住另一个会话，冲突还在。
- 每个 jsonl 永远各开一个 handle：空闲会话来回切会反复构造 runtime、重载扩展，而空闲时 `switchSession` 已经够用。
- 忙的时候直接 `switchSession` 把正在跑的回合换掉：另一个会话能打开，正在跑的那份被拆掉，和「同时用」相反。

## Consequences

- 同一项目里可以同时有多个活着的 handle。一个 handle 构造失败只拆它自己。
- 没有 `openAdditional` 的宿主仍对忙中的替换命令抛 `SESSION_BUSY`，避免在唯一的 handle 上把正在跑的会话换掉。
- 后台会话的流式更新留在前端缓存里，切回去才显示；侧边栏用全部在跑的会话路径，而不是每个项目只记一条。

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
