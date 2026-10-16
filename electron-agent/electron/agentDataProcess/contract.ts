/**
 * 主进程 ↔ agentdata-host 子进程的方法与事件名。两边只从这里取名字；处理表按 Record<Method, Handler> 类型化，增删必须同改。
 * 见 .agents/notes/implemented/architecture/2026-10-16-agentdata-host-process.md。
 */

/** 主 → 子。admin.request 承载原来 requestAdmin 能到的全部方法（故意不在 socket 上的管理面）。 */
export const AGENTDATA_METHODS = [
  'agentdata.admin',
  'agentdata.registerWorkspace',
  'agentdata.resolveDiagnosticPath',
  'agentdata.registerKnownWorkspace',
  'agentdata.plugins.load',
  'agentdata.plugins.save',
  'host.shutdown',
] as const;
export type AgentDataProcessMethod = (typeof AGENTDATA_METHODS)[number];

/** 子 → 主。都是原来注入给运行时、必须留在主进程的能力。 */
export const AGENTDATA_HOST_METHODS = [
  'main.model.describe',
  'main.model.complete',
  'main.model.abort',
  'main.resolveSession',
  'main.method',
] as const;
export type AgentDataHostMethod = (typeof AGENTDATA_HOST_METHODS)[number];

/** 子 → 主事件：模型用量。保证在同一 requestId 的 main.model.complete 应答之前送达（同一条 IPC 通道，按序）。 */
export const AGENTDATA_MODEL_USAGE_CHANNEL = 'agentdata.model.usage';
export interface ModelUsageEvent { requestId: string; report: { model: string; usage: unknown } }

/** 子 → 主事件：诊断。sample 每 10 秒一次，写进 runtime-diag.jsonl（kind: 'agentdata-host-sample'）；其余原样转记。 */
export const AGENTDATA_DIAG_CHANNEL = 'agentdata.diag';

/** 启动参数：主进程经环境变量 AGENTDATA_HOST_CONFIG（JSON）传入。 */
export interface AgentDataHostConfig {
  dataPath: string;
  worksDir: string;
  listenPath: string;
  hostToken: string;
  /** 主进程已签发的工作区令牌（规范化工作区 → 令牌），重拉时带回去。 */
  workspaceTokens: Record<string, string>;
  /** 主进程已知的工作区（CodeGraph 的项目列表）。 */
  knownWorkspaces: string[];
  codeGraph: { hostEntry: string; workerEntry: string; jobGuardExe: string; execPath: string };
}
