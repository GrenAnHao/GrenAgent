/**
 * 会话跨项目迁移的 JSON-only 窄合同（renderer ↔ main ↔ agent-host）。
 *
 * 设计约束（见 openspec/changes/move-sessions-between-projects/design.md 第 3 节）：
 * - 来源 workspace 由调用它的 IPC 外部 `workspace` 参数决定；请求里同时显式携带 sourceWorkspace，
 *   两者必须一致，禁止用“当前前景会话”作为隐式来源或目标。
 * - preview 只接受 sessionPath + targetWorkspace；commit 只接受宿主题发的 ticket、operationId
 *   和预期的 identity/leaf/revision（null-root 合法）。renderer 不能提交 after-image、before-image、
 *   journal／manifest／backup 路径或来源证明，这些必须由宿主在 agent 数据目录内自行产生。
 * - status/retry-open 只接受 operationId + sessionPath，不允许借此传入新的目标或快照。
 * - 响应显式区分持久归属与 UI 打开状态：preview / no-op / busy / stale / opened /
 *   committed-needs-open / recovery-required。
 */

export type SessionProjectTransferAction = 'preview' | 'commit' | 'status' | 'retry-open';

/** 所有动作共有的定位信息：来源工作区显式给出，sessionPath 指向主会话。 */
interface SessionProjectTransferRequestBase {
  action: SessionProjectTransferAction;
  sourceWorkspace: string;
  sessionPath: string;
}

/** 预览：只允许显式 sessionPath + targetWorkspace，不创建 runtime、不登记目标项目。 */
export interface SessionProjectTransferPreviewRequest extends SessionProjectTransferRequestBase {
  action: 'preview';
  targetWorkspace: string;
}

/** 确认：目标由 ticket 绑定；预期身份、确认 leaf（null 表示空根）与 revision 必须回传。 */
export interface SessionProjectTransferCommitRequest extends SessionProjectTransferRequestBase {
  action: 'commit';
  operationId: string;
  ticket: string;
  expectedSessionId: string;
  expectedLeafId: string | null;
  expectedRevision: string;
}

/** 查询：按 operationId 返回同一操作的事实，不重新生成事务。 */
export interface SessionProjectTransferStatusRequest extends SessionProjectTransferRequestBase {
  action: 'status';
  operationId: string;
}

/** 已提交但打开失败后的幂等重开：不再次移动、不重写会话。 */
export interface SessionProjectTransferRetryOpenRequest extends SessionProjectTransferRequestBase {
  action: 'retry-open';
  operationId: string;
}

export type SessionProjectTransferRequest =
  | SessionProjectTransferPreviewRequest
  | SessionProjectTransferCommitRequest
  | SessionProjectTransferStatusRequest
  | SessionProjectTransferRetryOpenRequest;

/** journal 阶段。status 可返回 applying；renderer 只用它显示进度，不据此推断持久事实。 */
export type SessionProjectTransferPhase =
  | 'previewed'
  | 'prepared'
  | 'applying'
  | 'committed'
  | 'opened'
  | 'recovery-required';

export type SessionProjectTransferBusyReason =
  | 'turn-active'
  | 'turn-queued'
  | 'background-jobs'
  | 'subagent-unsettled'
  | 'pending-ui'
  | 'goal-running'
  | 'structure-recovery'
  | 'unknown';

export type SessionProjectTransferStaleReason =
  | 'ticket-expired'
  | 'ticket-unknown'
  | 'session-changed'
  | 'family-changed'
  | 'registry-changed'
  | 'target-changed'
  | 'source-changed';

/** 迁移族摘要：只回计数与警告，不回子级路径或历史正文。 */
export interface SessionProjectTransferFamilySummary {
  /** 主会话 + 可证明归属的子／孙会话。 */
  sessionCount: number;
  childSessionCount: number;
  subagentCount: number;
  /** 本次操作会搬的持久登记行数（子代理 catalog / metadata 等）。 */
  registryRecordCount: number;
}

/** 预览里给用户看的安全边界摘要；迁移本身绝不请求模型、不搬文件。 */
export interface SessionProjectTransferPolicySummary {
  fileTransfer: 'none';
  modelRequests: 0;
  permissionSource: 'target';
}

interface SessionProjectTransferAckBase {
  status: SessionProjectTransferAckStatus;
  sessionPath: string;
  sourceWorkspace: string;
  sessionId: string;
  phase?: SessionProjectTransferPhase;
  notice?: string;
}

export interface SessionProjectTransferPreviewAck extends SessionProjectTransferAckBase {
  status: 'preview';
  operationId: string;
  ticket: string;
  targetWorkspace: string;
  targetName?: string;
  leafId: string | null;
  revision: string;
  /** 宿主张的到期时间（epoch ms）；过期后 commit 返回 stale。 */
  expiresAt: number;
  family: SessionProjectTransferFamilySummary;
  policy: SessionProjectTransferPolicySummary;
  warnings?: string[];
}

/** realpath 后与来源等价：不写迁移记录、不重建会话。 */
export interface SessionProjectTransferNoOpAck extends SessionProjectTransferAckBase {
  status: 'no-op';
  reason: 'same-workspace';
  targetWorkspace: string;
}

export interface SessionProjectTransferBusyAck extends SessionProjectTransferAckBase {
  status: 'busy';
  busyReason: SessionProjectTransferBusyReason;
  detail?: string;
}

/** 预览后会话／族／登记／目标发生变化，必须重新预览。 */
export interface SessionProjectTransferStaleAck extends SessionProjectTransferAckBase {
  status: 'stale';
  staleReason: SessionProjectTransferStaleReason;
  operationId?: string;
  requiresPreview: true;
}

export interface SessionProjectTransferOpenedAck extends SessionProjectTransferAckBase {
  status: 'opened';
  operationId: string;
  targetWorkspace: string;
  leafId: string | null;
}

/** 已完成持久提交，但目标 runtime／项目登记／列表投影没打开成功；可 retry-open。 */
export interface SessionProjectTransferCommittedNeedsOpenAck extends SessionProjectTransferAckBase {
  status: 'committed-needs-open';
  operationId: string;
  targetWorkspace: string;
  /** 宿主诊断码或短消息，不含历史正文与恢复快照路径。 */
  reason: string;
  retryable: true;
}

/** 外部写入或损坏使前后镜像都无法匹配：保留证据，阻塞受影响族的相关操作。 */
export interface SessionProjectTransferRecoveryRequiredAck extends SessionProjectTransferAckBase {
  status: 'recovery-required';
  operationId?: string;
  targetWorkspace?: string;
  recoveryReason: string;
  blocked: Array<'send' | 'delete' | 'list' | 'resume'>;
  /** 宿主内部诊断标识；不暴露 journal／备份路径。 */
  diagnosticId?: string;
}

export type SessionProjectTransferAckStatus =
  | 'preview'
  | 'no-op'
  | 'busy'
  | 'stale'
  | 'opened'
  | 'committed-needs-open'
  | 'recovery-required';

export type SessionProjectTransferAck =
  | SessionProjectTransferPreviewAck
  | SessionProjectTransferNoOpAck
  | SessionProjectTransferBusyAck
  | SessionProjectTransferStaleAck
  | SessionProjectTransferOpenedAck
  | SessionProjectTransferCommittedNeedsOpenAck
  | SessionProjectTransferRecoveryRequiredAck;

/** 内部 agent-host RPC：冷恢复未完成事务。不暴露为 renderer 命令。 */
export type SessionProjectTransferRecoveryPort = () => Promise<void>;

const ACTIONS: readonly SessionProjectTransferAction[] = ['preview', 'commit', 'status', 'retry-open'];

const ALLOWED_FIELDS: Readonly<Record<SessionProjectTransferAction, readonly string[]>> = {
  preview: ['action', 'sourceWorkspace', 'sessionPath', 'targetWorkspace'],
  commit: [
    'action', 'sourceWorkspace', 'sessionPath', 'operationId', 'ticket',
    'expectedSessionId', 'expectedLeafId', 'expectedRevision',
  ],
  status: ['action', 'sourceWorkspace', 'sessionPath', 'operationId'],
  'retry-open': ['action', 'sourceWorkspace', 'sessionPath', 'operationId'],
};

/**
 * renderer 明确不得提供的宿主材料。after-image／backup 路径一旦被接受，就等于让渲染层
 * 指定“迁移后的事实”或覆盖来源，绕过宿主的 CAS 与 journal，因此按字段名直接拒绝。
 */
const FORBIDDEN_FIELD = /(after|before)[-_]?image|backup|journal|manifest|snapshot|rollback|recovery|evidence/i;

function fail(message: string): never {
  throw new Error(message);
}

/** 路径比较键：分隔符统一、去尾斜杠、大小写不敏感（与既有 IPC 路径等价比法一致）。 */
export function transferWorkspaceKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

/**
 * 来源工作区以 IPC 外部 workspace 参数为准；请求体里的 sourceWorkspace 只用于确认。
 * 不一致时在进入迁移 owner 前拒绝，错误码与宿主保持一致。
 */
export function assertTransferSourceWorkspace(routingWorkspace: string, claimedSourceWorkspace: string): void {
  if (transferWorkspaceKey(routingWorkspace) !== transferWorkspaceKey(claimedSourceWorkspace)) {
    fail('SESSION_TRANSFER_SOURCE_MISMATCH');
  }
}

function readString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim()) fail(`${key} must be a non-empty string`);
  return value;
}

function readLeaf(raw: Record<string, unknown>): string | null {
  const value = raw.expectedLeafId;
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) fail('expectedLeafId must be a session entry id or null');
  return value;
}

/**
 * 解析并校验 renderer 发来的迁移请求。只做形状／字段白名单校验；
 * 来源托管根、符号链接、目标真实目录、身份与指纹由宿主迁移 owner 复核。
 */
export function parseSessionProjectTransferRequest(raw: Record<string, unknown>): SessionProjectTransferRequest {
  const action = raw.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action as SessionProjectTransferAction)) {
    fail('Invalid session project transfer action');
  }
  const typedAction = action as SessionProjectTransferAction;
  const allowed = ALLOWED_FIELDS[typedAction];
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_FIELD.test(key)) fail(`Session transfer rejects renderer-supplied ${key}`);
    if (!allowed.includes(key)) fail(`Unexpected session project transfer field: ${key}`);
  }

  const base = {
    action: typedAction,
    sourceWorkspace: readString(raw, 'sourceWorkspace'),
    sessionPath: readString(raw, 'sessionPath'),
  };

  if (typedAction === 'preview') {
    return { ...base, action: 'preview', targetWorkspace: readString(raw, 'targetWorkspace') };
  }
  if (typedAction === 'commit') {
    return {
      ...base,
      action: 'commit',
      operationId: readString(raw, 'operationId'),
      ticket: readString(raw, 'ticket'),
      expectedSessionId: readString(raw, 'expectedSessionId'),
      expectedLeafId: readLeaf(raw),
      expectedRevision: readString(raw, 'expectedRevision'),
    };
  }
  return {
    ...base,
    action: typedAction,
    operationId: readString(raw, 'operationId'),
  };
}
