/**
 * Electron 主进程访问 Pi SDK 的唯一入口。
 *
 * cli/ 与 extensions/ 各带一份 @earendil-works 声明副本；ModelRuntime / AgentSession
 * 是带 private 成员的类，跨副本传递会触发 TS 名义类型不兼容。electron/ 一律从本文件
 * 取值与类型，使其解析到 cli 副本，与 cli 代码共用同一份声明。
 *
 * 对应上游版本：pi-coding-agent@0.85.1
 */
export {
  ModelRuntime,
  SessionManager,
  createAgentSessionRuntime,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

export type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  ExtensionUIContext,
  JsonAgentSessionEvent,
  PromptOptions,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
