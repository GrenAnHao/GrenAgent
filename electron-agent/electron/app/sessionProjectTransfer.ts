/**
 * Cross-project session ownership transfer owner (design §3, §4).
 *
 * Kept here (no renderer, no runtime construction):
 * - source main-session and target directory validation (realpath, managed-root
 *   bounds, symlinks, no-op, internal app-data roots rejected as targets);
 * - full-log family closure: every branch's `subagent_catalog` facts,
 *   `subagent_meta` parent pointers and *all* project registry rows (never the
 *   UI's limited list). `header.parentSession` is only a cross-check for proven
 *   children — a fork/clone-derived *visible main session* is never pulled in;
 * - content fingerprint (whole-file sha256 + confirmed leaf + registry rows) so a
 *   preview becomes stale on any same-size external edit;
 * - the transfer transaction engine: journal prepare, applying, per-file CAS
 *   replacement, record-level registry diff, committed decision, post-commit
 *   registration/open, pre-commit rollback and post-commit forward recovery.
 *
 * The host supplies runtime/registry/image/registration ports and maps the
 * compact results below onto the public `SessionProjectTransferAck` contract.
 * Nothing here starts a user model request or scans a real user session.
 */
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isSystemWorkerSessionLines } from './systemWorkerSession.js';
import { normalizeSessionOperationPath } from './sessionOperationLease.js';
import { sessionTransferBusyReason, type TransferActivityFacts } from './sessionProjectTransferActivity.js';
import {
  SessionProjectTransferJournal,
  sha256Text,
  stableJson,
  type JournalFaultHook,
  type TransferJournalAfterImage,
  type TransferJournalFamilyMember,
  type TransferJournalFileImage,
  type TransferJournalManifest,
  type TransferJournalPhase,
  type TransferJournalRegistry,
  type TransferJournalRegistryRecord,
  type TransferJournalState,
  type LoadedJournal,
} from './sessionProjectTransferJournal.js';
import type {
  SessionProjectTransferAck,
  SessionProjectTransferBusyAck,
  SessionProjectTransferBusyReason,
  SessionProjectTransferCommittedNeedsOpenAck,
  SessionProjectTransferNoOpAck,
  SessionProjectTransferOpenedAck,
  SessionProjectTransferPhase,
  SessionProjectTransferPreviewAck,
  SessionProjectTransferRecoveryRequiredAck,
  SessionProjectTransferStaleAck,
  SessionProjectTransferStaleReason,
} from './sessionProjectTransferContracts.js';

export type TransferRegistryRecord = TransferJournalRegistryRecord;

export interface TransferFamilyMember extends TransferJournalFamilyMember {
  /** realpath spelling; security/bounds/alias dedupe only. Writes keep `sessionPath`. */
  canonicalPath: string;
}

export interface TransferFamily {
  /** Canonical realpath of the request's source workspace. */
  sourceWorkspace: string;
  /** Request spelling, echoed back to the caller. */
  requestSourceWorkspace: string;
  /** Canonical realpath of the validated target directory. */
  targetWorkspace: string;
  sessionId: string;
  /** Stable absolute managed path spelling of the main session (never re-canonicalized). */
  sessionPath: string;
  leafId: string | null;
  revision: string;
  members: TransferFamilyMember[];
  registry: TransferRegistryRecord[];
  registryHash: string;
  fingerprint: string;
  warnings: string[];
}

export interface TransferRegistryDiff {
  operationId: string;
  sourceWorkspace: string;
  targetWorkspace: string;
  remove: TransferRegistryRecord[];
  create: TransferRegistryRecord[];
  expectedSourceHash: string;
  expectedTargetHash: string;
}

export interface TransferActivityPort {
  /** Preferred: aggregated facts for the whole family; the owner maps them to a reason. */
  facts?(input: { sourceWorkspace: string; family: TransferFamily }): Promise<TransferActivityFacts>;
  /** Alternative: the host already reduced the facts to a busy reason. */
  busy?(input: {
    sourceWorkspace: string;
    targetWorkspace: string;
    sessionPath: string;
    sessionId: string;
    family: TransferFamily;
    stage: 'preview' | 'commit';
  }): Promise<{ busyReason: SessionProjectTransferBusyReason; detail?: string } | undefined>;
}

export interface TransferRegistryPort {
  /** Every row in a project registry (no pagination / UI limit). */
  read(workspace: string): Promise<TransferRegistryRecord[]>;
  /** Transactional: verify both CAS hashes, delete `remove`, insert `create`. */
  apply(diff: TransferRegistryDiff): Promise<void>;
  /** Transactional inverse of apply, CAS-checked. */
  rollback(diff: TransferRegistryDiff): Promise<void>;
}

export interface TransferAfterImageBuilderPort {
  build(input: {
    operationId: string;
    sourceWorkspace: string;
    targetWorkspace: string;
    sessionId: string;
    sessionPath: string;
    leafId: string | null;
    members: TransferFamilyMember[];
    registry: TransferRegistryRecord[];
    files: Array<{ path: string; content: string; sha256: string }>;
    now: number;
  }): Promise<Array<{ path: string; content: string }>>;
}

export interface TransferOpenInput {
  operationId: string;
  targetWorkspace: string;
  sessionPath: string;
  sessionId: string;
  leafId: string | null;
  sourceWorkspace: string;
  /** Full family (main + children) for adapters that need provenance. */
  family: TransferFamily;
}

export interface TransferWritersPort {
  /** Drain/evict every live writer of the family; throw when release cannot be proven. */
  release(input: { family: TransferFamily; operationId?: string }): Promise<void>;
  /** Make the target a known project (idempotent). */
  registerProject(input: { operationId: string; targetWorkspace: string }): Promise<void>;
  /** Drop source/target list and session caches (idempotent). */
  invalidate(input: { operationId: string; workspaces: string[] }): Promise<void>;
  /** Open the same canonical path on the target; throw when runtime/position/project checks fail. */
  open(input: TransferOpenInput): Promise<void>;
}

export interface TransferPositionPort {
  /**
   * `undefined` = no persisted position; `null` = confirmed empty root.
   * Accepts either a bare leaf id or `{ leafId }`.
   */
  read(input: {
    sessionId: string;
    sessionPath: string;
  }): Promise<string | null | { leafId: string | null } | undefined>;
}

export interface TransferLeaseHandleLike {
  release(): Promise<void>;
  assertOwned?(): Promise<void>;
}

export interface TransferLeasePort {
  acquire(
    paths: readonly string[],
    options?: { owner?: string; allowBlocked?: boolean },
  ): Promise<TransferLeaseHandleLike | (() => Promise<void>)>;
  /** Optional read-only gate used by preview (busy when another writer/recovery holds the family). */
  checkAvailable?(paths: readonly string[]): Promise<void>;
}

export interface TransferPorts {
  lease?: TransferLeasePort;
  activity?: TransferActivityPort;
  registry?: TransferRegistryPort;
  images?: TransferAfterImageBuilderPort;
  writers?: TransferWritersPort;
  position?: TransferPositionPort;
}

export interface SessionProjectTransferOwnerOptions {
  agentDir: string;
  ports?: TransferPorts;
  ticketTtlMs?: number;
  faults?: JournalFaultHook;
  /** Clock override for deterministic ticket expiry tests. */
  clock?: () => number;
}

export interface TransferPreviewInput {
  sourceWorkspace: string;
  sessionPath: string;
  targetWorkspace: string;
}

export interface TransferCommitInput {
  operationId: string;
  ticket: string;
  expectedSessionId: string;
  expectedLeafId: string | null;
  /** Either `expectedRevision` (preview revision) or its alias `expectedFingerprint`. */
  expectedRevision?: string;
  expectedFingerprint?: string;
  /** Bound before any side effect when present; the host IPC supplies both. */
  sourceWorkspace?: string;
  sessionPath?: string;
}

export interface TransferLookupInput {
  operationId: string;
  sourceWorkspace?: string;
  sessionPath?: string;
}

/** Preview ack plus host-only family detail; still assignable to the public contract. */
export interface TransferPreviewAck extends SessionProjectTransferPreviewAck {
  /** Full closure (main + provable children) for adapters/tests. Not sent to renderer. */
  familyMembers?: TransferFamilyMember[];
  fingerprint?: string;
  /** Durable move state when the operation already exists. */
  phase?: SessionProjectTransferPhase;
}

/** Public ack union returned by commit/status/retry-open; assignable to the contract. */
export type TransferResult = SessionProjectTransferAck;

export interface TransferBlockedFamily {
  operationId: string;
  phase: TransferJournalPhase;
  sessionPaths: string[];
  sourceWorkspace?: string;
  targetWorkspace?: string;
  reason: string;
}

/** Raised when the family lease is no longer held; never roll back over another writer. */
export class TransferLeaseLostError extends Error {
  readonly code = 'TRANSFER_LEASE_LOST';
  constructor(message: string) {
    super(`TRANSFER_LEASE_LOST: ${message}`);
    this.name = 'TRANSFER_LEASE_LOST';
  }
}

export interface LeaseGuard {
  /** Fail closed when this writer no longer owns the family. */
  assert(): Promise<void>;
  release(): Promise<void>;
}

const NO_LEASE_GUARD: LeaseGuard = { assert: async () => undefined, release: async () => undefined };

export class SessionProjectTransferError extends Error {
  readonly code: string;
  readonly operationId?: string;
  constructor(code: string, message: string, operationId?: string) {
    super(`${code}: ${message}`);
    this.name = 'SessionProjectTransferError';
    this.code = code;
    if (operationId) this.operationId = operationId;
  }
}

interface PreviewTicket {
  operationId: string;
  ticket: string;
  expiresAt: number;
  fingerprint: string;
  revision: string;
  family: TransferFamily;
}

interface ParsedEntry {
  id: string;
  raw: string;
  value: Record<string, unknown>;
}

interface ParsedSession {
  header: Record<string, unknown> & { id: string };
  /** Tree entries (every line with an `id`). */
  entries: ParsedEntry[];
  /** On-disk version the document came from; v1 is canonicalized to ids. */
  version: 1 | 2 | 3;
  /**
   * Legal non-tree lines, kept byte-exact and in order. Today this is only the
   * legacy title line WorkspaceService appends: `{"type":"session_info","name":…}`
   * with no id/parent/timestamp. It is opaque metadata: it never joins the family
   * closure, is never a leaf, and is never rewritten.
   */
  opaque: string[];
}

interface FamilyItem {
  path: string;
  parentPath: string | null;
  expectedId: string | null;
  mode: 'main' | 'one-shot' | 'continuable';
  agentId: string | null;
  depth: number;
  /**
   * Proof that this path is a subagent session, required for non-main members.
   * `meta` = only its own `subagent_meta` (origin=subagent + matching parent)
   * proves it, because neither catalog nor registry still names it.
   */
  proof: 'root' | 'catalog' | 'registry' | 'meta';
}

interface NormalizedCommit {
  operationId: string;
  ticket: string;
  expectedSessionId: string;
  expectedLeafId: string | null;
  expectedRevision?: string;
  sourceWorkspace?: string;
  sessionPath?: string;
}

const DEFAULT_TICKET_TTL_MS = 5 * 60_000;
const INTERNAL_ROOTS = [
  'sessions',
  'works',
  'session-transfers',
  'session-operation-leases',
  'session-positions',
  'drafts',
  '.workflow-staging',
];

export class SessionProjectTransferOwner {
  private readonly agentDir: string;
  private readonly ports: TransferPorts;
  private readonly journal: SessionProjectTransferJournal;
  private readonly ticketTtlMs: number;
  private readonly clock: () => number;
  private readonly faults?: JournalFaultHook;
  private readonly tickets = new Map<string, PreviewTicket>();
  /**
   * Per-instance writer identity. Lease owner tokens must be unique per writer:
   * reentrancy is a same-process concern, and two owners in different processes
   * must contend even when they operate on the same operationId.
   */
  private readonly leaseWriterId = randomUUID().slice(0, 8);

  constructor(options: SessionProjectTransferOwnerOptions) {
    this.agentDir = resolve(options.agentDir);
    this.ports = options.ports ?? {};
    this.faults = options.faults;
    this.journal = new SessionProjectTransferJournal(this.agentDir, options.faults);
    this.ticketTtlMs = Math.max(options.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS, 1_000);
    this.clock = options.clock ?? Date.now;
  }

  // ---------------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------------

  async preview(input: TransferPreviewInput): Promise<TransferResult> {
    const sessionPath = resolveRequiredPath(input.sessionPath, 'sessionPath');
    const sourceWorkspace = resolveRequiredPath(input.sourceWorkspace, 'sourceWorkspace');
    const targetInput = resolveRequiredPath(input.targetWorkspace, 'targetWorkspace');

    const target = await this.validateTarget(targetInput, sourceWorkspace);
    // A family already covered by an unfinished transaction (its header may have
    // moved to the target) must be recovered before another preview inspects it.
    await this.assertNoUnfinishedJournalForPaths([sessionPath]);
    const identity = await this.readMainIdentity(sessionPath, sourceWorkspace);
    if (target.sameWorkspace) {
      const noop: SessionProjectTransferNoOpAck = {
        status: 'no-op',
        reason: 'same-workspace',
        sessionPath: identity.sessionPath,
        sourceWorkspace: input.sourceWorkspace,
        sessionId: identity.sessionId,
        targetWorkspace: target.canonical,
      };
      return noop;
    }

    const position = await this.readPosition(identity.sessionId, identity.sessionPath);
    const family = await this.collectFamily({
      sourceWorkspace: identity.workspace,
      requestSourceWorkspace: input.sourceWorkspace,
      sessionPath: identity.sessionPath,
      sessionId: identity.sessionId,
      targetWorkspace: target.canonical,
      leafId: position.leafId,
      warnings: position.warnings,
    });

    await this.assertNoUnfinishedJournal(family);
    await this.ports.lease?.checkAvailable?.(this.leasePaths(family));

    const busy = await this.busyReason(family, 'preview');
    if (busy === undefined) {
      return this.busyAck(family, 'unknown', '无法确认会话活动状态');
    }
    if (busy) return this.busyAck(family, busy.busyReason, busy.detail);
    if (!this.ports.registry) {
      throw new SessionProjectTransferError('TRANSFER_REGISTRY_UNAVAILABLE', '无法读取子代理登记，拒绝推测迁移族');
    }
    if (!this.ports.images) {
      throw new SessionProjectTransferError('TRANSFER_IMAGE_BUILDER_UNAVAILABLE', '缺少会话 after-image 构造器');
    }
    await this.assertTargetRegistryConflicts(family);

    const operationId = randomUUID();
    const ticket = randomUUID();
    const expiresAt = this.clock() + this.ticketTtlMs;
    this.pruneTickets();
    this.tickets.set(operationId, {
      operationId,
      ticket,
      expiresAt,
      fingerprint: family.fingerprint,
      revision: family.revision,
      family,
    });

    const ack: TransferPreviewAck = {
      status: 'preview',
      operationId,
      ticket,
      sessionPath: family.sessionPath,
      sourceWorkspace: input.sourceWorkspace,
      sessionId: family.sessionId,
      targetWorkspace: family.targetWorkspace,
      targetName: basename(family.targetWorkspace) || family.targetWorkspace,
      leafId: family.leafId,
      revision: family.revision,
      expiresAt,
      family: {
        sessionCount: family.members.length,
        childSessionCount: family.members.filter((member) => member.mode !== 'main').length,
        subagentCount: new Set(family.registry.map((row) => row.id)).size,
        registryRecordCount: family.registry.length,
      },
      policy: { fileTransfer: 'none', modelRequests: 0, permissionSource: 'target' },
      ...(family.warnings.length > 0 ? { warnings: [...family.warnings] } : {}),
      familyMembers: family.members,
      fingerprint: family.fingerprint,
      phase: 'previewed',
    };
    return ack;
  }

  private busyAck(
    family: TransferFamily,
    busyReason: SessionProjectTransferBusyReason,
    detail?: string,
  ): SessionProjectTransferBusyAck {
    return {
      status: 'busy',
      busyReason,
      ...(detail ? { detail } : {}),
      sessionPath: family.sessionPath,
      sourceWorkspace: family.requestSourceWorkspace,
      sessionId: family.sessionId,
    };
  }

  // ---------------------------------------------------------------------------
  // Commit
  // ---------------------------------------------------------------------------

  async commit(raw: TransferCommitInput): Promise<TransferResult> {
    const input: NormalizedCommit = {
      operationId: requireOperationId(raw.operationId),
      ticket: requireNonEmpty(raw.ticket, 'ticket'),
      expectedSessionId: requireNonEmpty(raw.expectedSessionId, 'expectedSessionId'),
      expectedLeafId: raw.expectedLeafId ?? null,
      expectedRevision: raw.expectedRevision,
      ...(raw.expectedFingerprint ? { expectedRevision: raw.expectedFingerprint } : {}),
      ...(raw.sourceWorkspace ? { sourceWorkspace: resolveRequiredPath(raw.sourceWorkspace, 'sourceWorkspace') } : {}),
      ...(raw.sessionPath ? { sessionPath: resolveRequiredPath(raw.sessionPath, 'sessionPath') } : {}),
    };
    // Bind the request source before any side effect: a commit aimed at the wrong
    // session must not run another operation's ticket.
    const existing = await this.journal.load(input.operationId);
    if (existing) return this.finishExisting(input, existing);

    const preview = this.tickets.get(input.operationId);
    if (!preview) {
      const ack: SessionProjectTransferStaleAck = {
        status: 'stale',
        staleReason: 'ticket-unknown',
        requiresPreview: true,
        sessionPath: input.sessionPath ?? '',
        sourceWorkspace: input.sourceWorkspace ?? '',
        sessionId: input.expectedSessionId,
        operationId: input.operationId,
        notice: 'SESSION_TRANSFER_TICKET_UNKNOWN: 请重新预览',
      };
      return ack;
    }
    const bound = this.bindToTicket(input, preview.family);
    if (preview.ticket !== input.ticket) {
      return this.staleResult(preview.family, 'ticket-unknown', input.operationId);
    }
    if (this.clock() >= preview.expiresAt) {
      this.tickets.delete(input.operationId);
      return this.staleResult(preview.family, 'ticket-expired', input.operationId);
    }
    if (
      input.expectedSessionId !== preview.family.sessionId ||
      input.expectedLeafId !== preview.family.leafId ||
      (input.expectedRevision !== undefined && input.expectedRevision !== preview.revision)
    ) {
      return this.staleResult(preview.family, 'session-changed', input.operationId);
    }

    const guard = await this.acquireLease(this.leasePaths(preview.family), `transfer-${input.operationId}-${this.leaseWriterId}`);
    try {
      await guard.assert();
      // Re-scan inside the lease: the preview must still describe the same family.
      const fresh = await this.recollect(preview.family);
      if (fresh.fingerprint !== preview.fingerprint) {
        return this.staleResult(fresh, this.classifyStale(preview.family, fresh), input.operationId);
      }
      const busy = await this.busyReason(fresh, 'commit');
      if (busy === undefined || busy) {
        return this.busyAck(fresh, busy?.busyReason ?? 'unknown', busy?.detail ?? '无法确认会话活动状态');
      }

      const ack = await this.runCommit({
        operationId: input.operationId,
        family: fresh,
        requestWorkspace: bound.sourceWorkspace,
        guard,
      });
      if (ack) return ack;
      return this.resultForManifest(await this.requireManifest(input.operationId));
    } catch (error) {
      if (error instanceof TransferLeaseLostError) throw this.leaseLostError(input.operationId, error);
      throw error;
    } finally {
      await guard.release().catch(() => undefined);
    }
  }

  /**
   * Losing the lease mid-transaction is not a normal rollback: another writer may
   * already be applying its own changes. Persist `recovery-required` as evidence
   * and never restore before-images over data we no longer own.
   */
  private leaseLostError(operationId: string, error: TransferLeaseLostError): SessionProjectTransferError {
    return new SessionProjectTransferError('TRANSFER_RECOVERY_REQUIRED', error.message, operationId);
  }

  /** Bind an absent request source to the host-issued ticket (never to renderer data). */
  private bindToTicket(
    input: NormalizedCommit,
    family: TransferFamily,
  ): { sourceWorkspace: string } {
    if (input.sessionPath && !pathsSame(input.sessionPath, family.sessionPath)) {
      throw new SessionProjectTransferError('TRANSFER_SOURCE_MISMATCH', '会话与预览票据不一致', input.operationId);
    }
    if (
      input.sourceWorkspace &&
      !pathsSame(input.sourceWorkspace, family.requestSourceWorkspace) &&
      !pathsSame(input.sourceWorkspace, family.sourceWorkspace)
    ) {
      throw new SessionProjectTransferError('TRANSFER_SOURCE_MISMATCH', '来源项目与预览票据不一致', input.operationId);
    }
    return { sourceWorkspace: family.requestSourceWorkspace };
  }

  /** Returns a result only when the commit deliberately stops (stale); otherwise records committed. */
  private async runCommit(input: {
    operationId: string;
    family: TransferFamily;
    requestWorkspace: string;
    guard: LeaseGuard;
  }): Promise<TransferResult | undefined> {
    const { operationId, family, guard } = input;
    const now = this.clock();
    const before = await this.snapshotFiles(family);
    const registryRows = await this.requireRegistry(family.sourceWorkspace);
    const familyRows = selectFamilyRows(registryRows, family);
    const targetRows = await this.requireRegistry(family.targetWorkspace);
    const targetById = new Map(targetRows.map((row) => [row.id, row]));
    for (const row of familyRows) {
      const existing = targetById.get(row.id);
      if (existing && !sameRecord(existing, row)) {
        throw new SessionProjectTransferError('TRANSFER_REGISTRY_CONFLICT', `目标登记 ${row.id} 与迁移记录冲突`, operationId);
      }
    }
    const diff: TransferRegistryDiff = {
      operationId,
      sourceWorkspace: family.sourceWorkspace,
      targetWorkspace: family.targetWorkspace,
      remove: familyRows,
      create: familyRows,
      expectedSourceHash: sha256Text(stableJson(familyRows)),
      expectedTargetHash: sha256Text(
        stableJson(targetRows.filter((row) => familyRows.some((moved) => moved.id === row.id))),
      ),
    };
    const builder = this.ports.images;
    if (!builder) {
      throw new SessionProjectTransferError('TRANSFER_IMAGE_BUILDER_UNAVAILABLE', '缺少会话 after-image 构造器', operationId);
    }
    const produced = await builder.build({
      operationId,
      sourceWorkspace: family.sourceWorkspace,
      targetWorkspace: family.targetWorkspace,
      sessionId: family.sessionId,
      sessionPath: family.sessionPath,
      leafId: family.leafId,
      members: family.members,
      registry: familyRows,
      files: before.map((image) => ({ path: image.path, content: image.content, sha256: image.sha256 })),
      now,
    });
    const after = await this.validateAfterImages(before, produced, family);

    const registrySnapshot: TransferJournalRegistry = {
      version: 1,
      rows: familyRows,
      expectedSourceHash: diff.expectedSourceHash,
      expectedTargetHash: diff.expectedTargetHash,
    };

    // Preparation mutex: a concurrent recovery in another process must not treat
    // this half-written journal as abandoned. The sentinel is per operation (not
    // a project-wide shutdown) and is held for the whole write sequence.
    const prepare = await this.tryPrepareLease(operationId);
    if (!prepare) {
      throw new SessionProjectTransferError(
        'SESSION_TRANSFER_RECOVERY_PENDING',
        '同一迁移正在另一进程准备，请稍后重试',
        operationId,
      );
    }
    try {
      await this.journal.savePrepared({
        operationId,
        sourceWorkspace: family.sourceWorkspace,
        targetWorkspace: family.targetWorkspace,
        sessionId: family.sessionId,
        sessionPath: family.sessionPath,
        leafId: family.leafId,
        revision: family.revision,
        fingerprint: family.fingerprint,
        family: family.members.map(({ canonicalPath: _canonical, ...member }) => member),
        registryHash: family.registryHash,
        registryRecordCount: familyRows.length,
        before,
        after,
        registry: registrySnapshot,
        now,
      });
    } catch (error) {
      // Only the prepare-lease holder may clean up its own partial journal.
      await this.journal.remove(operationId).catch(() => undefined);
      throw new SessionProjectTransferError('TRANSFER_JOURNAL_PREPARE_FAILED', String(error), operationId);
    } finally {
      await prepare.release().catch(() => undefined);
    }

    let manifest = await this.requireManifest(operationId);
    manifest = await this.journal.transition(manifest, 'applying', {}, this.clock());

    const writers = this.ports.writers;
    if (!writers) {
      await this.rollback(manifest, '缺少运行态释放端口');
      throw new SessionProjectTransferError('TRANSFER_WRITERS_UNAVAILABLE', '缺少运行态释放端口', operationId);
    }
    try {
      await writers.release({ family, operationId });
    } catch (error) {
      if (isSimulatedCrash(error)) throw error;
      await this.rollback(manifest, `释放旧写者失败：${String(error)}`);
      throw new SessionProjectTransferError('TRANSFER_RELEASE_FAILED', String(error), operationId);
    }

    // Release drained the old writer; confirm we still own the family before any
    // modification, then re-CAS the whole family.
    await guard.assert();
    // `session_shutdown` may legitimately append while the old writer drains.
    // Re-CAS before modifying anything: an externally grown source is stale, is
    // left byte-exact, and must be previewed again (never overwritten by before).
    const drift = await this.detectDrift(before);
    if (drift) {
      const stale = await this.journal.transition(manifest, 'rolled-back', {
        opened: false,
        failure: `release-drift:${drift}`,
        result: { status: 'rolled-back', reason: 'source-changed', drifted: drift },
      }, this.clock());
      await this.journal.pruneImages(stale.operationId).catch(() => undefined);
      return this.staleResult(family, 'source-changed', operationId, input.requestWorkspace);
    }

    try {
      await this.applyImages(manifest, before, after, guard);
      await this.applyRegistry(manifest, diff, guard);
      await this.verifyTargetState(manifest, after);
    } catch (error) {
      // A simulated process death (fault-injection hook) bypasses rollback exactly
      // like a killed process: cold-start recovery must resolve it from the journal.
      if (isSimulatedCrash(error)) throw error;
      if (error instanceof TransferLeaseLostError) {
        // We no longer own the family. Do not transition the journal (a newer
        // owner may already have recorded committed/opened/rolled-back) and do
        // not roll back over data we cannot prove we own. The existing
        // prepared/applying state already blocks the family; the rightful owner
        // re-reads the manifest under its own lease and decides.
        throw this.leaseLostError(operationId, error);
      }
      if (error instanceof SessionProjectTransferError && error.code === 'TRANSFER_RECOVERY_REQUIRED') {
        await this.failClosed(manifest, String(error));
        throw error;
      }
      const rolled = await this.rollback(manifest, String(error));
      if (rolled) {
        return {
          ...this.staleResult(family, 'source-changed', operationId, input.requestWorkspace),
          notice: `移动未提交，原会话保持在源项目：${String(error)}`,
        };
      }
      throw new SessionProjectTransferError('TRANSFER_RECOVERY_REQUIRED', String(error), operationId);
    }

    // Durable commit point: atomic manifest replacement with state=committed.
    // A lost lease must not be recorded as a committed move, and the family must
    // stay visibly blocked rather than looking like an ordinary rollback.
    try {
      await guard.assert();
    } catch (error) {
      if (error instanceof TransferLeaseLostError) throw this.leaseLostError(operationId, error);
      throw error;
    }
    manifest = await this.journal.transition(manifest, 'committed', {}, this.clock());
    try {
      await this.completeCommitted(manifest, guard);
    } catch (error) {
      if (error instanceof TransferLeaseLostError) throw this.leaseLostError(operationId, error);
      throw error;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Status / retry-open
  // ---------------------------------------------------------------------------

  async status(raw: TransferLookupInput | string): Promise<TransferResult> {
    const input = normalizeLookup(raw);
    const loaded = await this.journal.load(input.operationId);
    if (!loaded) {
      return this.unknownOperationAck(input);
    }
    this.bindLookup(input, loaded);
    if (loaded.problem || !loaded.manifest) {
      return this.unreadableJournalAck(input, loaded);
    }
    const manifest = loaded.manifest;
    if (manifest.state === 'prepared' || manifest.state === 'applying') {
      return {
        status: 'busy',
        busyReason: 'structure-recovery',
        detail: '迁移事务尚未完成，等待恢复',
        sessionPath: manifest.sessionPath,
        sourceWorkspace: manifest.sourceWorkspace,
        sessionId: manifest.sessionId,
        phase: manifest.state,
      };
    }
    return this.resultForManifest(manifest);
  }

  async retryOpen(raw: TransferLookupInput | string): Promise<TransferResult> {
    const input = normalizeLookup(raw);
    const loaded = await this.journal.load(input.operationId);
    if (!loaded) {
      return this.unknownOperationAck(input);
    }
    this.bindLookup(input, loaded);
    if (loaded.problem || !loaded.manifest) {
      return this.unreadableJournalAck(input, loaded);
    }
    const state = loaded.manifest.state;
    if (state !== 'committed' && state !== 'opened' && state !== 'recovery-required') {
      return this.staleResult(this.familyFromManifest(loaded.manifest), 'source-changed', input.operationId);
    }
    await this.recoverOperation(input.operationId);
    const refreshed = await this.journal.load(input.operationId);
    if (!refreshed?.manifest) {
      throw new SessionProjectTransferError('TRANSFER_RECOVERY_FAILED', '无法重新读取迁移 journal', input.operationId);
    }
    return this.resultForManifest(refreshed.manifest);
  }

  /** Read-only probe: is this operation committed (moved) but still unopened? */
  async needsOpen(operationId: string): Promise<boolean> {
    const loaded = await this.journal.load(requireOperationId(operationId));
    return loaded?.manifest?.state === 'committed' && loaded.manifest.opened !== true;
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  /** Cold-start gate: finish every journal before workspace auto-resume opens paths. */
  /**
   * Finish pending journals.
   *
   * `operationIds` lets the host retry only the operations it decided are due
   * (for example after its own "attempted once" bookkeeping); omitting it keeps
   * the cold-start behaviour of visiting every journal. Unknown ids are ignored,
   * so a host filter can never widen into an unbounded retry of a fixed failure.
   */
  async recoverAll(operationIds?: readonly string[]): Promise<void> {
    const ids = operationIds ? [...new Set(operationIds)] : await this.journal.list();
    for (const operationId of ids) {
      if (!/^[0-9a-f-]{36}$/i.test(operationId)) continue;
      await this.recoverOperation(operationId).catch(() => undefined);
    }
  }

  /**
   * Every family with an unfinished journal: prepared (not yet applied),
   * applying, committed-but-unopened and recovery-required. Main-process
   * deletion/cleanup must consult this because a committed family's header no
   * longer names the source project.
   */
  async blockedFamilies(): Promise<TransferBlockedFamily[]> {
    const result: TransferBlockedFamily[] = [];
    for (const operationId of await this.journal.list()) {
      const loaded = await this.journal.load(operationId);
      if (!loaded) continue;
      if (loaded.problem || !loaded.manifest) {
        result.push({
          operationId,
          phase: 'recovery-required',
          sessionPaths: loaded.sessionPaths,
          reason: `迁移 journal 无法读取：${loaded.problem ?? 'unknown'}`,
        });
        continue;
      }
      const manifest = loaded.manifest;
      if (manifest.state === 'opened' || manifest.state === 'rolled-back') continue;
      result.push({
        operationId,
        phase: manifest.state,
        sessionPaths: uniquePaths([manifest.sessionPath, ...manifest.family.map((member) => member.sessionPath)]),
        sourceWorkspace: manifest.sourceWorkspace,
        targetWorkspace: manifest.targetWorkspace,
        reason:
          manifest.state === 'committed'
            ? '会话已移动到目标项目，等待打开'
            : manifest.state === 'recovery-required'
              ? `迁移事务需要人工恢复：${manifest.failure ?? 'unknown'}`
              : '存在未完成的迁移事务',
      });
    }
    return result;
  }

  /**
   * Port for `SessionOperationLeaseCoordinator.setBlockerProbe`. Accepts either
   * the lease query (`{ paths, workspaces }`) or a bare path list.
   *
   * Workspaces matter because after `applying` the family's header already names
   * the target project: a source-project cleanup that only scans session paths
   * would miss it. Matching the moved family also returns `familyPaths` so the
   * caller can take leases on those paths for the whole project operation.
   */
  async blocked(
    query: readonly string[] | { paths?: readonly string[]; workspaces?: readonly string[] },
  ): Promise<Array<{ path?: string; familyPaths?: string[]; reason: string; operationId?: string }>> {
    const families = await this.blockedFamilies();
    if (families.length === 0) return [];
    const requested: { paths?: readonly string[]; workspaces?: readonly string[] } = Array.isArray(query)
      ? { paths: query as readonly string[] }
      : (query as { paths?: readonly string[]; workspaces?: readonly string[] });
    const keys = new Map<string, string>();
    for (const path of requested.paths ?? []) keys.set(await normalizeSessionOperationPath(path), path);
    const workspaceKeys = new Set<string>();
    for (const workspace of requested.workspaces ?? []) workspaceKeys.add(await normalizeSessionOperationPath(workspace));
    const hits: Array<{ path?: string; familyPaths?: string[]; reason: string; operationId?: string }> = [];
    const seen = new Set<string>();
    for (const family of families) {
      const familyMatches =
        (family.sourceWorkspace !== undefined && workspaceKeys.has(await normalizeSessionOperationPath(family.sourceWorkspace))) ||
        (family.targetWorkspace !== undefined && workspaceKeys.has(await normalizeSessionOperationPath(family.targetWorkspace)));
      if (workspaceKeys.size > 0 && familyMatches) {
        hits.push({
          familyPaths: family.sessionPaths,
          reason: family.reason,
          operationId: family.operationId,
        });
        continue;
      }
      for (const sessionPath of family.sessionPaths) {
        const key = await normalizeSessionOperationPath(sessionPath);
        const original = keys.get(key);
        if (!original || seen.has(key)) continue;
        seen.add(key);
        hits.push({ path: original, reason: family.reason, operationId: family.operationId });
      }
    }
    return hits;
  }

  private async recoverOperation(operationId: string): Promise<void> {
    const loaded = await this.journal.load(operationId);
    if (!loaded) return;
    if (loaded.problem || !loaded.manifest) {
      // Both shapes mean "preparation never produced a manifest". An unreadable
      // manifest is NOT a shell: it may describe a live operation, so it stays
      // blocking.
      if (
        loaded.problem === 'incomplete-journal-preparation' ||
        loaded.problem === 'missing-journal-manifest'
      ) {
        await this.discardIncompletePreparation(operationId);
      }
      return;
    }
    const manifest = loaded.manifest;
    // Terminal states are durable facts, not pending work: `opened` (even with
    // snapshots left by a crash between the opened rename and pruneImages) and
    // `rolled-back` must return the original result without re-validating the
    // session. A later move may legitimately have changed the header again
    // (B→C), and re-checking an old after-image would wrongly demote it to
    // recovery-required or replay a stale registry diff.
    if (manifest.state === 'opened' || manifest.state === 'rolled-back') {
      if (loaded.before || loaded.after || loaded.registry) {
        await this.journal.pruneImages(manifest.operationId).catch(() => undefined);
      }
      return;
    }
    // Recovery is a writer: without an exclusive lease it must not touch anything.
    // The journal probe stays in place, so the family remains blocked until the
    // owner of the lock finishes or exits.
    const guard = await this.tryRecoveryLease(manifest);
    if (!guard) return;
    try {
      await guard.assert();
      if (manifest.state === 'prepared' || manifest.state === 'applying') {
        await this.rollback(manifest, 'cold-start rollback', loaded, guard);
        return;
      }
      if (manifest.state === 'committed' || manifest.state === 'recovery-required') {
        await this.recoverCommitted(manifest, loaded, guard);
      }
    } catch (error) {
      // Same rule as commit: no journal write without ownership. Recovery simply
      // stops; the family stays blocked by whatever state the rightful owner left.
      if (error instanceof TransferLeaseLostError) return;
      throw error;
    } finally {
      await guard.release().catch(() => undefined);
    }
  }

  /**
   * Per-operation preparation sentinel. Not a project stop: it only serialises the
   * journal write sequence against a concurrent recovery's cleanup of the same
   * operation. Uses the same lease coordinator as family locks so main and host
   * agree, but on a stable synthetic path that never names a session.
   */
  private async tryPrepareLease(operationId: string): Promise<LeaseGuard | undefined> {
    try {
      return await this.acquireLease(
        [join(this.agentDir, 'session-transfers', operationId, 'prepare')],
        `prepare-${operationId}-${this.leaseWriterId}`,
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Remove a journal that is only an incomplete preparation (snapshots present,
   * manifest missing). The decision is re-validated under the prepare lease: if a
   * concurrent process finished the manifest in the meantime, we must leave the
   * live operation alone and let normal recovery handle it.
   */
  private async discardIncompletePreparation(operationId: string): Promise<void> {
    const prepare = await this.tryPrepareLease(operationId);
    if (!prepare) return;
    try {
      const fresh = await this.journal.load(operationId);
      if (!fresh) return;
      if (fresh.manifest) {
        // The writer won the race and produced a complete journal: never delete it.
        if (fresh.manifest.state === 'prepared' || fresh.manifest.state === 'applying') {
          // Leave it for the normal family-lease recovery path.
        }
        return;
      }
      if (fresh.problem !== 'incomplete-journal-preparation' && fresh.problem !== 'missing-journal-manifest') {
        return;
      }
      await this.journal.remove(operationId).catch(() => undefined);
    } finally {
      await prepare.release().catch(() => undefined);
    }
  }

  private async tryRecoveryLease(manifest: TransferJournalManifest): Promise<LeaseGuard | undefined> {
    try {
      return await this.acquireLease(
        [manifest.sessionPath, ...manifest.family.map((member) => member.sessionPath)],
        `recover-${manifest.operationId}-${this.leaseWriterId}`,
      );
    } catch {
      return undefined;
    }
  }

  private async recoverCommitted(
    manifest: TransferJournalManifest,
    loaded: LoadedJournal,
    guard: LeaseGuard,
  ): Promise<void> {
    if (!loaded.after || !loaded.registry) return;
    // Committed files may legally have grown (real SDK session_start appends).
    // Only a complete-line prefix of the durable after-image is trusted; the file
    // is never rewritten from the journal after commit.
    const mismatch = await this.verifyCommittedPrefix(loaded.after);
    if (mismatch) {
      await this.failClosed(manifest, mismatch);
      return;
    }
    const diff: TransferRegistryDiff = {
      operationId: manifest.operationId,
      sourceWorkspace: manifest.sourceWorkspace,
      targetWorkspace: manifest.targetWorkspace,
      remove: loaded.registry.rows,
      create: loaded.registry.rows,
      expectedSourceHash: loaded.registry.expectedSourceHash,
      expectedTargetHash: loaded.registry.expectedTargetHash,
    };
    await guard.assert();
    await this.replayRegistry(diff);
    if (manifest.state === 'opened' && manifest.opened) return;
    await this.completeCommitted(manifest, guard);
  }

  private async completeCommitted(manifest: TransferJournalManifest, guard: LeaseGuard): Promise<void> {
    const writers = this.ports.writers;
    try {
      await guard.assert();
      if (!writers) throw new Error('缺少项目登记/打开端口');
      await writers.registerProject({ operationId: manifest.operationId, targetWorkspace: manifest.targetWorkspace });
      await writers.invalidate({
        operationId: manifest.operationId,
        workspaces: [manifest.sourceWorkspace, manifest.targetWorkspace],
      });
      await writers.open({
        operationId: manifest.operationId,
        targetWorkspace: manifest.targetWorkspace,
        sessionPath: manifest.sessionPath,
        sessionId: manifest.sessionId,
        leafId: manifest.leafId,
        sourceWorkspace: manifest.sourceWorkspace,
        family: this.familyFromManifest(manifest),
      });
      // Opening may take long enough to lose the heartbeat: never claim "opened"
      // from a writer that no longer owns the family.
      await guard.assert();
      const opened = await this.journal.transition(manifest, 'opened', {
        opened: true,
        result: { status: 'opened', targetWorkspace: manifest.targetWorkspace },
      }, this.clock());
      await this.journal.pruneImages(opened.operationId).catch(() => undefined);
    } catch (error) {
      // A lease lost here still means the durable fact is `committed`; recovery /
      // retry-open will finish it once ownership is re-established.
      if (error instanceof TransferLeaseLostError) throw error;
      // Commit already happened: never rewrite session files again; report the
      // durable fact and let retry-open finish registration/open idempotently.
      await this.journal.transition(manifest, 'committed', {
        opened: false,
        result: { status: 'committed-needs-open', reason: String(error), targetWorkspace: manifest.targetWorkspace },
      }, this.clock());
    }
  }

  // ---------------------------------------------------------------------------
  // Rollback / fail closed
  // ---------------------------------------------------------------------------

  private async rollback(
    manifest: TransferJournalManifest,
    reason: string,
    loaded?: LoadedJournal,
    guard?: LeaseGuard,
  ): Promise<boolean> {
    const snapshot = loaded ?? (await this.journal.load(manifest.operationId));
    if (!snapshot?.before || !snapshot.after || !snapshot.registry) {
      await this.failClosed(manifest, `回滚快照缺失: ${reason}`);
      return false;
    }
    const afterByPath = new Map(snapshot.after.map((image) => [image.path, image]));
    let conflict: string | undefined;
    for (const image of snapshot.before) {
      const after = afterByPath.get(image.path);
      if (!after) {
        conflict = `missing-after:${image.path}`;
        break;
      }
      const current = await readFile(image.path, 'utf8').catch(() => '');
      const currentSha = sha256Text(current);
      if (currentSha === image.sha256) continue;
      if (currentSha !== after.sha256) {
        // External writer touched this file: never overwrite unknown data.
        conflict = `cas-conflict:${image.path}`;
        break;
      }
    }
    if (conflict) {
      await this.failClosed(manifest, conflict);
      return false;
    }
    try {
      const diff: TransferRegistryDiff = {
        operationId: manifest.operationId,
        sourceWorkspace: manifest.sourceWorkspace,
        targetWorkspace: manifest.targetWorkspace,
        remove: snapshot.registry.rows,
        create: snapshot.registry.rows,
        expectedSourceHash: snapshot.registry.expectedSourceHash,
        expectedTargetHash: snapshot.registry.expectedTargetHash,
      };
      await guard?.assert();
      if (this.ports.registry) await this.ports.registry.rollback(diff);
      for (const image of [...snapshot.before].reverse()) {
        await guard?.assert();
        const after = afterByPath.get(image.path)!;
        const current = await readFile(image.path, 'utf8').catch(() => '');
        if (sha256Text(current) === image.sha256) continue;
        if (sha256Text(current) !== after.sha256) throw new Error(`cas-conflict:${image.path}`);
        await this.writeAtomic(image.path, image.content, `rollback:${basename(image.path)}`, after.sha256, guard);
      }
      const rolled = await this.journal.transition(manifest, 'rolled-back', {
        opened: false,
        failure: reason,
        result: { status: 'rolled-back', reason, targetWorkspace: manifest.targetWorkspace },
      }, this.clock());
      await this.journal.pruneImages(rolled.operationId).catch(() => undefined);
      return true;
    } catch (error) {
      await this.failClosed(manifest, `回滚失败: ${String(error)}`);
      return false;
    }
  }

  private async failClosed(manifest: TransferJournalManifest, reason: string): Promise<void> {
    await this.journal
      .transition(manifest, 'recovery-required', {
        opened: false,
        failure: reason,
        result: { status: 'recovery-required', reason, targetWorkspace: manifest.targetWorkspace },
      }, this.clock())
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Transaction primitives
  // ---------------------------------------------------------------------------

  private async applyImages(
    manifest: TransferJournalManifest,
    before: TransferJournalFileImage[],
    after: TransferJournalAfterImage[],
    guard: LeaseGuard,
  ): Promise<void> {
    const beforeByPath = new Map(before.map((image) => [image.path, image]));
    for (const [index, image] of after.entries()) {
      // Each replacement is a separate write window: re-verify ownership first so
      // a compromised lock stops before touching the next file.
      await guard.assert();
      const original = beforeByPath.get(image.path);
      if (!original || original.sha256 !== image.beforeSha256) {
        throw new SessionProjectTransferError('TRANSFER_RECOVERY_REQUIRED', `before image 不一致: ${image.path}`, manifest.operationId);
      }
      const current = await readFile(image.path, 'utf8').catch(() => '');
      const currentSha = sha256Text(current);
      if (currentSha === image.sha256) continue;
      if (currentSha !== original.sha256) {
        throw new SessionProjectTransferError('TRANSFER_RECOVERY_REQUIRED', `外部写入与快照不符: ${image.path}`, manifest.operationId);
      }
      await this.faultPoint(`write:${index}:before`);
      await this.writeAtomic(image.path, image.content, `transfer:${index}`, original.sha256, guard);
      await this.faultPoint(`write:${index}:after`);
    }
  }

  private async applyRegistry(
    manifest: TransferJournalManifest,
    diff: TransferRegistryDiff,
    guard: LeaseGuard,
  ): Promise<void> {
    const registry = this.ports.registry;
    if (!registry) throw new SessionProjectTransferError('TRANSFER_REGISTRY_UNAVAILABLE', '缺少登记端口', manifest.operationId);
    await guard.assert();
    await this.faultPoint('registry:apply');
    await registry.apply(diff);
    await this.faultPoint('registry:applied');
    const rows = await registry.read(manifest.targetWorkspace);
    for (const expected of diff.create) {
      const actual = rows.find((row) => row.id === expected.id);
      if (!actual || !sameRecord(actual, expected)) {
        throw new SessionProjectTransferError('TRANSFER_RECOVERY_REQUIRED', `目标登记回读不一致: ${expected.id}`, manifest.operationId);
      }
    }
    await this.faultPoint('registry:verified');
  }

  private async replayRegistry(diff: TransferRegistryDiff): Promise<void> {
    const registry = this.ports.registry;
    if (!registry) throw new Error('缺少登记端口');
    const targetRows = await registry.read(diff.targetWorkspace);
    const missing = diff.create.filter((expected) => {
      const actual = targetRows.find((row) => row.id === expected.id);
      return !actual || !sameRecord(actual, expected);
    });
    if (missing.length === 0) return;
    await registry.apply({ ...diff, remove: [], create: missing });
  }

  private async verifyTargetState(manifest: TransferJournalManifest, after: TransferJournalAfterImage[]): Promise<void> {
    for (const image of after) {
      const current = await readFile(image.path, 'utf8').catch(() => '');
      if (sha256Text(current) !== image.sha256) {
        throw new SessionProjectTransferError('TRANSFER_RECOVERY_REQUIRED', `目标状态校验失败: ${image.path}`, manifest.operationId);
      }
      const header = parseHeader(current);
      if (!header || header.id !== headerIdOf(image.content) || !pathsSame(String(header.cwd ?? ''), manifest.targetWorkspace)) {
        throw new SessionProjectTransferError('TRANSFER_RECOVERY_REQUIRED', `目标 header 未指向目标项目: ${image.path}`, manifest.operationId);
      }
    }
    await this.faultPoint('target:verified');
  }

  private async verifyCommittedPrefix(after: TransferJournalAfterImage[]): Promise<string | undefined> {
    for (const image of after) {
      const current = await readFile(image.path, 'utf8').catch(() => '');
      if (!isCompletePrefix(current, image.content)) return `committed-file-mismatch:${image.path}`;
      const header = parseHeader(current);
      if (!header || header.id !== headerIdOf(image.content)) return `committed-header-mismatch:${image.path}`;
      if (!pathsSame(String(header.cwd ?? ''), String(headerCwdOf(image.content) ?? ''))) {
        return `committed-header-target-mismatch:${image.path}`;
      }
    }
    return undefined;
  }

  private async detectDrift(before: TransferJournalFileImage[]): Promise<string | undefined> {
    for (const image of before) {
      const current = await readFile(image.path, 'utf8').catch(() => '');
      if (sha256Text(current) !== image.sha256) return image.path;
    }
    return undefined;
  }

  private async validateAfterImages(
    before: TransferJournalFileImage[],
    produced: Array<{ path: string; content: string }>,
    family: TransferFamily,
  ): Promise<TransferJournalAfterImage[]> {
    const byPath = new Map(produced.map((image) => [resolve(image.path), image.content]));
    if (byPath.size !== produced.length) {
      throw new SessionProjectTransferError('TRANSFER_INVALID_AFTER_IMAGE', 'after-image 路径重复');
    }
    const after: TransferJournalAfterImage[] = [];
    for (const image of before) {
      const content = byPath.get(resolve(image.path));
      if (content === undefined) {
        throw new SessionProjectTransferError('TRANSFER_INVALID_AFTER_IMAGE', `缺少 after-image: ${image.path}`);
      }
      byPath.delete(resolve(image.path));
      const header = parseHeader(content);
      if (!header || typeof header.id !== 'string' || header.id !== headerIdOf(image.content)) {
        throw new SessionProjectTransferError('TRANSFER_INVALID_AFTER_IMAGE', `after-image 改写了会话身份: ${image.path}`);
      }
      if (!pathsSame(String(header.cwd ?? ''), family.targetWorkspace)) {
        throw new SessionProjectTransferError('TRANSFER_INVALID_AFTER_IMAGE', `after-image 未指向目标项目: ${image.path}`);
      }
      await assertHistoryPreserved(image.content, content, image.path);
      after.push({
        path: image.path,
        beforeSha256: image.sha256,
        content,
        sha256: sha256Text(content),
        bytes: Buffer.byteLength(content, 'utf8'),
      });
    }
    if (byPath.size > 0) throw new SessionProjectTransferError('TRANSFER_INVALID_AFTER_IMAGE', 'after-image 包含族外文件');
    return after.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  private async snapshotFiles(family: TransferFamily): Promise<TransferJournalFileImage[]> {
    const images: TransferJournalFileImage[] = [];
    for (const member of family.members) {
      const content = await readFile(member.sessionPath, 'utf8');
      const sha = sha256Text(content);
      if (sha !== member.sha256) {
        throw new SessionProjectTransferError(
          'SESSION_TRANSFER_CHANGED_DURING_SCAN',
          `会话在扫描后发生变化: ${member.sessionPath}`,
        );
      }
      images.push({ path: member.sessionPath, sha256: sha, bytes: Buffer.byteLength(content, 'utf8'), content });
    }
    return images.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  private async writeAtomic(file: string, content: string, label: string, expectedSha256: string, guard?: LeaseGuard): Promise<void> {
    const temp = join(
      dirname(file),
      `.${basename(file)}.${label.replace(/[^a-zA-Z0-9_-]/g, '_')}.${randomUUID()}.tmp`,
    );
    try {
      await this.faultPoint(`${label}:write-temp`);
      const handle = await open(temp, 'wx');
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.faultPoint(`${label}:flush`);
      // Snapshot comparison before a potentially large temp write is not enough:
      // check again at the replacement boundary, including ownership of the lease.
      await guard?.assert();
      const current = await readFile(file, 'utf8');
      if (sha256Text(current) !== expectedSha256) {
        throw new SessionProjectTransferError('TRANSFER_RECOVERY_REQUIRED', `替换前发现外部写入: ${file}`);
      }
      await guard?.assert();
      await rename(temp, file);
      await this.faultPoint(`${label}:rename`);
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private async faultPoint(point: string): Promise<void> {
    await this.faults?.(point);
  }

  // ---------------------------------------------------------------------------
  // Source/target validation
  // ---------------------------------------------------------------------------

  private async readMainIdentity(
    sessionPath: string,
    sourceWorkspace: string,
  ): Promise<{ sessionId: string; sessionPath: string; workspace: string }> {
    const sessionsRoot = await this.managedSessionsRoot();
    const absolute = await this.validatedSessionFile(sessionPath, sessionsRoot);
    const content = await readFile(absolute, 'utf8');
    const header = parseHeader(content);
    if (!header || typeof header.id !== 'string' || !header.id.trim() || typeof header.timestamp !== 'string') {
      throw new SessionProjectTransferError('SESSION_TRANSFER_BAD_HEADER', '会话缺少合法 header');
    }
    if (typeof header.cwd !== 'string' || !pathsSame(header.cwd, sourceWorkspace)) {
      throw new SessionProjectTransferError('SESSION_WORKSPACE_MISMATCH', '会话不属于给定来源项目');
    }
    if (hasSubagentMeta(content)) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_SUBAGENT_SOURCE', '子代理会话不能作为迁移来源');
    }
    if (isSystemWorkerSessionLines(content.split(/\r?\n/))) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_HIDDEN_SOURCE', '隐藏系统会话不能移动');
    }
    if (await this.isArchived(absolute)) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_ARCHIVED_SOURCE', '已归档会话不能移动');
    }
    return { sessionId: header.id, sessionPath: absolute, workspace: header.cwd };
  }

  private async validateTarget(
    targetInput: string,
    sourceWorkspace: string,
  ): Promise<{ canonical: string; sameWorkspace: boolean }> {
    let info;
    try {
      // Never create the directory: a picker path that does not exist is invalid.
      info = await stat(targetInput);
    } catch {
      throw new SessionProjectTransferError('SESSION_TRANSFER_TARGET_INVALID', `目标目录不可访问: ${targetInput}`);
    }
    if (!info.isDirectory()) throw new SessionProjectTransferError('SESSION_TRANSFER_TARGET_INVALID', '目标不是目录');
    const canonical = await realpath(targetInput).catch(() => {
      throw new SessionProjectTransferError('SESSION_TRANSFER_TARGET_INVALID', '无法解析目标真实路径');
    });
    if (await this.isInternalRoot(canonical)) {
      // Sessions/works/staging/lease roots are app data, not local projects: `works`
      // would be classified as scratch and could never be registered as a project.
      throw new SessionProjectTransferError('SESSION_TRANSFER_TARGET_INVALID', '目标不能是应用内部数据目录');
    }
    const sourceCanonical = await realpath(sourceWorkspace).catch(() => resolve(sourceWorkspace));
    if (pathsSame(canonical, sourceCanonical) || pathsSame(canonical, sourceWorkspace)) {
      return { canonical, sameWorkspace: true };
    }
    return { canonical, sameWorkspace: false };
  }

  private async isInternalRoot(candidate: string): Promise<boolean> {
    if (pathsSame(candidate, this.agentDir)) return true;
    for (const name of INTERNAL_ROOTS) {
      const root = await realpath(join(this.agentDir, name)).catch(() => resolve(join(this.agentDir, name)));
      if (pathsSame(candidate, root) || isUnderPath(root, candidate)) return true;
    }
    return false;
  }

  private async managedSessionsRoot(): Promise<string> {
    const root = await realpath(join(this.agentDir, 'sessions')).catch(() => undefined);
    if (!root) throw new SessionProjectTransferError('SESSION_TRANSFER_SESSIONS_ROOT_MISSING', '托管会话目录不存在');
    return root;
  }

  private async validatedSessionFile(sessionPath: string, sessionsRoot: string): Promise<string> {
    const absolute = resolve(sessionPath);
    if (!absolute.toLowerCase().endsWith('.jsonl')) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_INVALID_SESSION_PATH', '会话路径必须是 .jsonl');
    }
    let canonical: string;
    try {
      canonical = await realpath(absolute);
    } catch {
      throw new SessionProjectTransferError('SESSION_TRANSFER_SESSION_MISSING', `会话文件不存在: ${absolute}`);
    }
    if (!isUnderPath(sessionsRoot, canonical)) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_OUT_OF_BOUNDS', '会话文件不在托管会话根内');
    }
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_SYMLINK_SESSION', '会话文件不能是符号链接');
    }
    return absolute;
  }

  private async readPosition(
    sessionId: string,
    sessionPath: string,
  ): Promise<{ leafId: string | null; warnings: string[] }> {
    if (!this.ports.position) return { leafId: null, warnings: ['leaf-unconfirmed'] };
    const record = await this.ports.position.read({ sessionId, sessionPath });
    if (record === undefined) return { leafId: null, warnings: ['leaf-unconfirmed'] };
    const leafId = record && typeof record === 'object' ? record.leafId : record;
    return { leafId: leafId ?? null, warnings: [] };
  }

  private async assertNoUnfinishedJournal(family: TransferFamily): Promise<void> {
    await this.assertNoUnfinishedJournalForPaths(family.members.map((member) => member.sessionPath));
  }

  private async assertNoUnfinishedJournalForPaths(paths: string[]): Promise<void> {
    const keys = new Set(paths.map((path) => lowerPath(path)));
    for (const operationId of await this.journal.list()) {
      const loaded = await this.journal.load(operationId);
      if (!loaded) continue;
      const affected = loaded.sessionPaths.some((path) => keys.has(lowerPath(path)));
      const unfinished =
        !loaded.manifest || (loaded.manifest.state !== 'opened' && loaded.manifest.state !== 'rolled-back');
      if (affected && unfinished) {
        throw new SessionProjectTransferError('SESSION_TRANSFER_RECOVERY_PENDING', '该会话族有未完成的迁移事务', operationId);
      }
    }
  }

  private async assertTargetRegistryConflicts(family: TransferFamily): Promise<void> {
    if (family.registry.length === 0) return;
    const targetRows = await this.requireRegistry(family.targetWorkspace);
    const targetById = new Map(targetRows.map((row) => [row.id, row]));
    for (const row of family.registry) {
      const existing = targetById.get(row.id);
      if (existing && !sameRecord(existing, row)) {
        throw new SessionProjectTransferError('TRANSFER_REGISTRY_CONFLICT', `目标项目已有冲突登记: ${row.id}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Family closure
  // ---------------------------------------------------------------------------

  private async recollect(previous: TransferFamily): Promise<TransferFamily> {
    const position = await this.readPosition(previous.sessionId, previous.sessionPath);
    return this.collectFamily({
      sourceWorkspace: previous.sourceWorkspace,
      requestSourceWorkspace: previous.requestSourceWorkspace,
      sessionPath: previous.sessionPath,
      sessionId: previous.sessionId,
      targetWorkspace: previous.targetWorkspace,
      leafId: position.leafId,
      warnings: position.warnings,
    });
  }

  /**
   * Closure rules (design §2: metadata participates in the full closure):
   * - the root is the requested visible main session;
   * - a child enters through a `subagent_catalog` fact appended after the last
   *   `subagent_catalog_base`, through an all-rows registry row whose `parentId`
   *   is already a family member, or through its own `subagent_meta` whose
   *   `origin === 'subagent'` and whose parent pointer names a family member;
   * - `header.parentSession` alone is never a discovery edge. A fork/clone-derived
   *   visible main session that only records a parent stays in its own project
   *   (warning `root-has-parent`), and a child that only has a header parent and
   *   no meta/catalog/registry proof is rejected as unproven;
   * - meta-discovered children must prove settlement (a settled registry row, or
   *   `subagent_meta` for a completable one-shot / drainable continuable). If the
   *   family cannot decide, the whole transfer is refused instead of silently
   *   dropping history;
   * - missing/unreadable children, cycles, ambiguous parents and unsettled
   *   subagents fail closed.
   */
  private async collectFamily(input: {
    sourceWorkspace: string;
    requestSourceWorkspace: string;
    sessionPath: string;
    sessionId: string;
    targetWorkspace: string;
    leafId: string | null;
    warnings: string[];
  }): Promise<TransferFamily> {
    const sessionsRoot = await this.managedSessionsRoot();
    const warnings = [...input.warnings];
    const mainContent = await readFile(input.sessionPath, 'utf8');
    const mainParsed = await parseSessionDocument(mainContent, input.sessionPath);
    if (mainParsed.header.id !== input.sessionId) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_CHANGED_DURING_SCAN', '主会话身份已变化');
    }
    let leafId = input.leafId;
    if (leafId !== null && !mainParsed.entries.some((entry) => entry.id === leafId)) {
      warnings.push('leaf-not-found');
      leafId = null;
    }
    const registrySource = await this.requireRegistry(input.sourceWorkspace);

    const members = new Map<string, TransferFamilyMember>();
    const bySessionId = new Map<string, string>();
    const registryIds = new Set<string>();
    const queue: FamilyItem[] = [
      {
        path: input.sessionPath,
        parentPath: null,
        expectedId: input.sessionId,
        mode: 'main',
        agentId: null,
        depth: 0,
        proof: 'root',
      },
    ];
    const enqueued = new Set([lowerPath(input.sessionPath)]);

    const addChild = (item: FamilyItem, parentKey: string): void => {
      const key = lowerPath(item.path);
      if (key === parentKey) {
        throw new SessionProjectTransferError('SESSION_TRANSFER_CYCLE', `子代理族出现循环: ${item.path}`);
      }
      if (members.has(key) || enqueued.has(key)) return;
      // Walk the declared parent chain to catch longer cycles (A→B→A).
      let cursor: string | null = parentKey;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        if (cursor === key) {
          throw new SessionProjectTransferError('SESSION_TRANSFER_CYCLE', `子代理族出现循环: ${item.path}`);
        }
        seen.add(cursor);
        cursor = members.get(cursor)?.parentSessionPath ? lowerPath(members.get(cursor)!.parentSessionPath!) : null;
      }
      enqueued.add(key);
      queue.push(item);
    };

    // Drain the queue; metadata-only discovery may enqueue more children, so the
    // whole closure runs to a fixpoint instead of a single pass.
    for (;;) {
    while (queue.length > 0) {
      const item = queue.shift()!;
      const absolute = await this.validatedSessionFile(item.path, sessionsRoot);
      const key = lowerPath(absolute);
      if (members.has(key)) continue;
      const content = await readFile(absolute, 'utf8');
      const parsed = await parseSessionDocument(content, absolute);
      const header = parsed.header;
      if (item.expectedId && header.id !== item.expectedId) {
        throw new SessionProjectTransferError('SESSION_TRANSFER_IDENTITY_MISMATCH', `子会话身份与登记不符: ${absolute}`);
      }
      const existingKey = bySessionId.get(header.id);
      if (existingKey && existingKey !== key) {
        throw new SessionProjectTransferError('SESSION_TRANSFER_DUPLICATE_SESSION_ID', `重复的会话 ID: ${header.id}`);
      }
      const meta = lastSubagentMeta(parsed.entries);
      const headerParent =
        typeof header.parentSession === 'string' && header.parentSession.trim() ? resolve(header.parentSession) : null;
      const metaParent =
        typeof meta?.parentSession === 'string' && meta.parentSession.trim() ? resolve(meta.parentSession) : null;

      if (item.mode === 'main') {
        if (meta || hasSubagentMeta(content)) {
          throw new SessionProjectTransferError('SESSION_TRANSFER_SUBAGENT_SOURCE', '来源是子代理会话');
        }
        if (headerParent) {
          // A fork/clone-derived *visible main* session keeps its own identity. It is
          // never discovered as a child of the recorded parent (that parent and its
          // other children stay in their own project), but it may itself be moved.
          warnings.push('root-has-parent');
        }
        if (isSystemWorkerSessionLines(content.split(/\r?\n/))) {
          throw new SessionProjectTransferError('SESSION_TRANSFER_HIDDEN_SOURCE', '隐藏系统会话不能移动');
        }
        if (await this.isArchived(absolute)) {
          throw new SessionProjectTransferError('SESSION_TRANSFER_ARCHIVED_SOURCE', '已归档会话不能移动');
        }
        if (!pathsSame(String(header.cwd ?? ''), input.sourceWorkspace)) {
          throw new SessionProjectTransferError('SESSION_WORKSPACE_MISMATCH', '会话不属于来源项目');
        }
      } else {
        const registryRow = item.agentId ? registrySource.find((row) => row.id === item.agentId) : undefined;
        // A metadata-discovered child proves itself with its own `subagent_meta`
        // (origin=subagent + matching family parent), which discovery already
        // validated; re-check here so a forged queue entry cannot slip through.
        const metaProven =
          item.proof === 'meta' &&
          meta !== undefined &&
          meta.origin === 'subagent' &&
          nonEmptyString(meta.agentId) === item.agentId;
        const proven = item.proof === 'catalog' || (item.proof === 'registry' && registryRow !== undefined) || metaProven;
        if (!proven) {
          throw new SessionProjectTransferError('SESSION_TRANSFER_UNPROVEN_CHILD', `无法证明子代理归属: ${absolute}`);
        }
        if (metaParent && headerParent && !pathsSame(metaParent, headerParent)) {
          throw new SessionProjectTransferError('SESSION_TRANSFER_BROKEN_LINK', `父会话指针不一致: ${absolute}`);
        }
        const declaredParent = metaParent ?? headerParent;
        if (!declaredParent) {
          throw new SessionProjectTransferError('SESSION_TRANSFER_BROKEN_LINK', `子会话缺少父指针: ${absolute}`);
        }
        const parentKey = item.parentPath ? lowerPath(item.parentPath) : lowerPath(declaredParent);
        const parent = members.get(parentKey);
        if (!parent) {
          throw new SessionProjectTransferError('SESSION_TRANSFER_BROKEN_LINK', `父会话不在迁移族内: ${absolute}`);
        }
        if (item.proof === 'catalog' && !pathsSame(declaredParent, parent.sessionPath)) {
          // The catalog fact was copied by a fork/clone seed: the child declares a
          // parent outside this family. Skip it. If the declared parent *is* part of
          // the same closure, the pointers disagree — that is a real cycle/broken
          // link and must fail closed.
          if (enqueued.has(lowerPath(declaredParent)) || members.has(lowerPath(declaredParent))) {
            throw new SessionProjectTransferError(
              'SESSION_TRANSFER_CYCLE',
              `子代理父链指向族内另一会话: ${absolute}`,
            );
          }
          warnings.push('catalog-fact-outside-family');
          continue;
        }
        if (meta?.parentSessionId) {
          const idKey = bySessionId.get(String(meta.parentSessionId));
          if (idKey && idKey !== parentKey) {
            throw new SessionProjectTransferError('SESSION_TRANSFER_BROKEN_LINK', `父会话 ID 与路径不一致: ${absolute}`);
          }
        }
        if (headerParent && !pathsSame(headerParent, parent.sessionPath)) {
          throw new SessionProjectTransferError('SESSION_TRANSFER_BROKEN_LINK', `header 父路径不在迁移族内: ${absolute}`);
        }
        if (registryRow) {
          if (registryRow.sessionPath && !pathsSame(registryRow.sessionPath, absolute)) {
            throw new SessionProjectTransferError('TRANSFER_REGISTRY_CONFLICT', `登记路径与子会话不一致: ${registryRow.id}`);
          }
          if (registryRow.parentId) {
            const rowParentKey = bySessionId.get(registryRow.parentId);
            if (!rowParentKey || rowParentKey !== parentKey) {
              throw new SessionProjectTransferError('TRANSFER_REGISTRY_CONFLICT', `登记父级与子会话不一致: ${registryRow.id}`);
            }
          }
          if (registryRow.status === 'running') {
            throw new SessionProjectTransferError('SESSION_TRANSFER_UNSETTLED_SUBAGENT', `子代理尚未结算: ${registryRow.id}`);
          }
        }
      }

      const mode: TransferFamilyMember['mode'] =
        item.mode === 'main' ? 'main' : isResumableMeta(meta) ? 'continuable' : 'one-shot';
      const parent = item.parentPath ? members.get(lowerPath(item.parentPath)) : undefined;
      const member: TransferFamilyMember = {
        sessionPath: absolute,
        canonicalPath: await realpath(absolute),
        sessionId: header.id,
        parentSessionPath: parent?.sessionPath ?? null,
        agentId: nonEmptyString(meta?.agentId) ?? item.agentId,
        mode,
        depth: typeof meta?.depth === 'number' && Number.isFinite(meta.depth) ? meta.depth : item.depth,
        sha256: sha256Text(content),
        bytes: Buffer.byteLength(content, 'utf8'),
      };
      members.set(key, member);
      bySessionId.set(header.id, key);

      for (const row of registrySource) {
        if (row.sessionPath && pathsSame(row.sessionPath, absolute)) registryIds.add(row.id);
        if (row.parentId === header.id) registryIds.add(row.id);
        if (member.agentId && row.id === member.agentId) registryIds.add(row.id);
      }

      for (const child of catalogChildren(parsed.entries, absolute)) {
        addChild(
          {
            path: resolve(child.sessionPath),
            parentPath: absolute,
            expectedId: child.childId,
            mode: child.mode,
            agentId: child.childId,
            depth: member.depth + 1,
            proof: 'catalog',
          },
          key,
        );
      }
      for (const row of registrySource) {
        if (row.parentId !== header.id) continue;
        registryIds.add(row.id);
        if (!row.sessionPath) continue;
        if (row.status === 'running') {
          throw new SessionProjectTransferError('SESSION_TRANSFER_UNSETTLED_SUBAGENT', `子代理尚未结算: ${row.id}`);
        }
        addChild(
          {
            path: resolve(row.sessionPath),
            parentPath: absolute,
            expectedId: row.id,
            mode: 'one-shot',
            agentId: row.id,
            depth: member.depth + 1,
            proof: 'registry',
          },
          key,
        );
      }
    }

    // Reverse `subagent_meta` discovery: a real child whose catalog fact and
    // registry row are both gone still proves itself with `subagent_meta`. Only
    // metadata that *names a family member* may add a candidate — never a header
    // parent, so a visible fork/clone main session is not dragged in.
    const beforeDiscovery = members.size;
    await this.discoverByMetadata({ sessionsRoot, members, bySessionId, enqueued, queue, addChild, registrySource, registryIds, warnings });
    // New metadata children keep the closure open; a pass that found nothing ends it.
    if (queue.length > 0 || members.size > beforeDiscovery) continue;
    break;
    }

    // Every registry row that names a family session must also move; every row
    // spawned by a family session must point at an existing closure file.
    for (const row of registrySource) {
      const pathKey = row.sessionPath ? lowerPath(resolve(row.sessionPath)) : undefined;
      const parentKey = row.parentId ? bySessionId.get(row.parentId) : undefined;
      if (pathKey && members.has(pathKey)) registryIds.add(row.id);
      if (parentKey) {
        registryIds.add(row.id);
        if (row.sessionPath && !members.has(pathKey!)) {
          throw new SessionProjectTransferError('SESSION_TRANSFER_BROKEN_LINK', `登记指向缺失的子会话: ${row.id}`);
        }
        if (row.status === 'running') {
          throw new SessionProjectTransferError('SESSION_TRANSFER_UNSETTLED_SUBAGENT', `子代理尚未结算: ${row.id}`);
        }
      }
    }

    const registry = registrySource
      .filter((row) => registryIds.has(row.id))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    for (const row of registry) {
      if (!row.sessionPath) continue;
      const member = members.get(lowerPath(resolve(row.sessionPath)));
      if (member && member.agentId && member.agentId !== row.id) {
        throw new SessionProjectTransferError('TRANSFER_REGISTRY_CONFLICT', `子会话与登记 ID 冲突: ${row.id}`);
      }
    }

    const sortedMembers = [...members.values()].sort((left, right) =>
      left.sessionPath < right.sessionPath ? -1 : left.sessionPath > right.sessionPath ? 1 : 0,
    );
    const registryHash = sha256Text(stableJson(registry));
    const revision = `rev-${sha256Text(
      stableJson({
        leafId,
        files: sortedMembers.map((member) => ({ path: lowerPath(member.sessionPath), sha256: member.sha256 })),
        registry: registryHash,
        target: lowerPath(input.targetWorkspace),
      }),
    ).slice(0, 24)}`;
    const fingerprint = sha256Text(
      stableJson({
        version: 1,
        sessionId: input.sessionId,
        leafId,
        target: lowerPath(input.targetWorkspace),
        files: sortedMembers.map((member) => ({ path: lowerPath(member.sessionPath), sha256: member.sha256 })),
        registry: registryHash,
      }),
    );
    return {
      sourceWorkspace: await realpath(input.sourceWorkspace).catch(() => resolve(input.sourceWorkspace)),
      requestSourceWorkspace: input.requestSourceWorkspace,
      targetWorkspace: input.targetWorkspace,
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      leafId,
      revision,
      members: sortedMembers,
      registry,
      registryHash,
      fingerprint,
      warnings,
    };
  }

  /**
   * Metadata-only discovery (design §2).
   *
   * Scans managed JSONL files that are not family members yet, reading only the
   * latest `subagent_meta` of each. A candidate is added only when all of these
   * hold:
   * - `origin === 'subagent'` and a non-empty `agentId`;
   * - the declared parent (`parentSession` path and/or `parentSessionId`) names an
   *   existing family member;
   * - the declared parent path and the header parent (if any) do not contradict it;
   * - settlement can be proven: a settled registry row for the agentId, or meta
   *   that is not `tornDown`/`cancelled`-style unknown. Otherwise the transfer is
   *   refused (`SESSION_TRANSFER_UNSETTLED_SUBAGENT`) rather than losing history.
   *
   * Unrelated corrupt/short-lived session files are skipped: a single unreadable
   * managed file must never block an unrelated transfer.
   */
  private async discoverByMetadata(context: {
    sessionsRoot: string;
    members: Map<string, TransferFamilyMember>;
    bySessionId: Map<string, string>;
    enqueued: Set<string>;
    queue: FamilyItem[];
    addChild: (item: FamilyItem, parentKey: string) => void;
    registrySource: TransferRegistryRecord[];
    registryIds: Set<string>;
    warnings: string[];
  }): Promise<void> {
    const { sessionsRoot, members, bySessionId, enqueued, queue, addChild, registrySource, registryIds, warnings } = context;
    let candidates: Array<{ path: string; meta: Record<string, unknown> }> = [];
    try {
      candidates = await this.scanSessionMetadata(sessionsRoot);
    } catch {
      return;
    }
    let progressed = true;
    // A meta child may itself have a meta child (grandchild); iterate to a fixpoint.
    while (progressed) {
      progressed = false;
      for (const candidate of candidates) {
        const key = lowerPath(candidate.path);
        if (members.has(key) || enqueued.has(key)) continue;
        const meta = candidate.meta;
        if (meta.origin !== 'subagent') continue;
        const agentId = nonEmptyString(meta.agentId);
        if (!agentId) continue;
        const declaredParent =
          typeof meta.parentSession === 'string' && meta.parentSession.trim()
            ? resolve(meta.parentSession)
            : typeof meta.parentSessionId === 'string' && meta.parentSessionId.trim()
              ? bySessionId.get(meta.parentSessionId.trim())
              : undefined;
        if (!declaredParent) continue;
        const parentKey = lowerPath(declaredParent);
        const parent = members.get(parentKey) ?? members.get(bySessionId.get(String(meta.parentSessionId ?? '')) ?? '');
        if (!parent) continue;
        const registryRow = registrySource.find((row) => row.id === agentId);
        if (registryRow) {
          registryIds.add(registryRow.id);
          if (registryRow.status === 'running') {
            throw new SessionProjectTransferError(
              'SESSION_TRANSFER_UNSETTLED_SUBAGENT',
              `子代理尚未结算: ${registryRow.id}`,
            );
          }
          if (registryRow.sessionPath && !pathsSame(registryRow.sessionPath, candidate.path)) {
            throw new SessionProjectTransferError(
              'TRANSFER_REGISTRY_CONFLICT',
              `登记路径与 metadata 子会话不一致: ${registryRow.id}`,
            );
          }
        } else if (meta.tornDown === true) {
          // Torn down after settling: still part of history, but we cannot prove a
          // live runtime exists, so there is nothing to drain.
        } else if (meta.mode !== 'one-shot' && meta.mode !== 'continuable') {
          throw new SessionProjectTransferError(
            'SESSION_TRANSFER_UNPROVEN_CHILD',
            `仅 metadata 的子代理模式未知，无法证明结算: ${candidate.path}`,
          );
        }
        addChild(
          {
            path: candidate.path,
            parentPath: parent.sessionPath,
            expectedId: agentId,
            mode: meta.mode === 'continuable' ? 'continuable' : 'one-shot',
            agentId,
            depth: parent.depth + 1,
            proof: 'meta',
          },
          parentKey,
        );
        warnings.push('metadata-only-child');
        progressed = true;
      }
    }
  }

  /**
   * Latest `subagent_meta` per managed session file, cheaply: only files whose raw
   * text mentions the marker are parsed, and only their last marker line is
   * decoded. Never fails the whole transfer because one unrelated file is corrupt.
   */
  private async scanSessionMetadata(sessionsRoot: string): Promise<Array<{ path: string; meta: Record<string, unknown> }>> {
    const { readdir } = await import('node:fs/promises');
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && path.toLowerCase().endsWith('.jsonl')) files.push(path);
      }
    };
    await walk(sessionsRoot);
    const candidates: Array<{ path: string; meta: Record<string, unknown> }> = [];
    for (const path of files) {
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      if (!content.includes('"customType":"subagent_meta"') && !content.includes('"customType": "subagent_meta"')) continue;
      let meta: Record<string, unknown> | undefined;
      for (const line of content.split(String.fromCharCode(10))) {
        if (!line.includes('subagent_meta')) continue;
        try {
          const entry = JSON.parse(line) as { type?: unknown; customType?: unknown; data?: unknown };
          if (entry?.type !== 'custom' || entry.customType !== 'subagent_meta') continue;
          if (!entry.data || typeof entry.data !== 'object' || Array.isArray(entry.data)) continue;
          meta = entry.data as Record<string, unknown>;
        } catch {
          /* one corrupt line must not hide the rest of this file */
        }
      }
      if (meta) candidates.push({ path, meta });
    }
    return candidates;
  }

  // ---------------------------------------------------------------------------
  // Existing journal handling
  // ---------------------------------------------------------------------------

  private async finishExisting(input: NormalizedCommit, loaded: LoadedJournal): Promise<TransferResult> {
    this.bindLookup(input, loaded);
    if (loaded.problem || !loaded.manifest) return this.unreadableJournalAck(input, loaded);
    const manifest = loaded.manifest;
    if (manifest.state === 'rolled-back') {
      return this.staleResult(this.familyFromManifest(manifest), 'source-changed', manifest.operationId);
    }
    if (manifest.state === 'recovery-required') return this.resultForManifest(manifest);
    // Repeat commit / lost receipt: recover and return the same recorded fact,
    // never rebuilding images or re-appending entries.
    await this.recoverOperation(manifest.operationId);
    const refreshed = await this.journal.load(manifest.operationId);
    if (!refreshed?.manifest) {
      throw new SessionProjectTransferError('TRANSFER_RECOVERY_FAILED', '无法重新读取迁移 journal', manifest.operationId);
    }
    return this.resultForManifest(refreshed.manifest);
  }

  private bindLookup(
    input: { sourceWorkspace?: string; sessionPath?: string },
    loaded: LoadedJournal,
  ): void {
    const manifest = loaded.manifest;
    const paths = manifest ? [manifest.sessionPath] : loaded.sessionPaths;
    if (input.sessionPath && paths.length > 0 && !paths.some((candidate) => pathsSame(candidate, input.sessionPath!))) {
      throw new SessionProjectTransferError('TRANSFER_SOURCE_MISMATCH', '操作不属于给定的会话', loaded.operationId);
    }
    if (manifest && input.sourceWorkspace && !pathsSame(manifest.sourceWorkspace, input.sourceWorkspace)) {
      throw new SessionProjectTransferError('TRANSFER_SOURCE_MISMATCH', '操作不属于给定的来源项目', loaded.operationId);
    }
  }

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------

  private resultForManifest(manifest: TransferJournalManifest): TransferResult {
    const base = {
      operationId: manifest.operationId,
      sessionPath: manifest.sessionPath,
      sourceWorkspace: manifest.sourceWorkspace,
      sessionId: manifest.sessionId,
      phase: journalPhaseOf(manifest.state),
    };
    if (manifest.state === 'opened') {
      const ack: SessionProjectTransferOpenedAck = {
        status: 'opened',
        targetWorkspace: manifest.targetWorkspace,
        leafId: manifest.leafId,
        ...base,
        phase: 'opened',
      };
      return ack;
    }
    if (manifest.state === 'committed') {
      const reason =
        typeof manifest.result?.reason === 'string' ? manifest.result.reason : '目标运行环境尚未打开';
      const ack: SessionProjectTransferCommittedNeedsOpenAck = {
        status: 'committed-needs-open',
        targetWorkspace: manifest.targetWorkspace,
        reason,
        retryable: true,
        ...base,
        phase: 'committed',
      };
      return ack;
    }
    if (manifest.state === 'recovery-required') {
      const ack: SessionProjectTransferRecoveryRequiredAck = {
        status: 'recovery-required',
        targetWorkspace: manifest.targetWorkspace,
        recoveryReason: manifest.failure ?? '迁移事务损坏',
        blocked: ['send', 'delete', 'list', 'resume'],
        ...base,
        phase: 'recovery-required',
      };
      return ack;
    }
    const ack: SessionProjectTransferStaleAck = {
      status: 'stale',
      staleReason: 'source-changed',
      requiresPreview: true,
      notice: manifest.failure ?? '上一次移动未提交，源会话保持原归属',
      ...base,
      ...(journalPhaseOf(manifest.state) ? { phase: journalPhaseOf(manifest.state) } : {}),
    };
    return ack;
  }

  private staleResult(
    family: TransferFamily,
    staleReason: SessionProjectTransferStaleReason,
    operationId: string,
    sourceWorkspace?: string,
  ): TransferResult {
    const ack: SessionProjectTransferStaleAck = {
      status: 'stale',
      staleReason,
      requiresPreview: true,
      operationId,
      sessionPath: family.sessionPath,
      sourceWorkspace: sourceWorkspace ?? family.requestSourceWorkspace,
      sessionId: family.sessionId,
      notice: `SESSION_TRANSFER_STALE: ${staleReason}`,
    };
    return ack;
  }

  private classifyStale(previous: TransferFamily, fresh: TransferFamily): SessionProjectTransferStaleReason {
    if (previous.sessionId !== fresh.sessionId || previous.leafId !== fresh.leafId) return 'session-changed';
    if (previous.targetWorkspace !== fresh.targetWorkspace) return 'target-changed';
    if (previous.registryHash !== fresh.registryHash) return 'registry-changed';
    if (previous.members.length !== fresh.members.length) return 'family-changed';
    return 'source-changed';
  }

  private familyFromManifest(manifest: TransferJournalManifest): TransferFamily {
    return {
      sourceWorkspace: manifest.sourceWorkspace,
      requestSourceWorkspace: manifest.sourceWorkspace,
      targetWorkspace: manifest.targetWorkspace,
      sessionId: manifest.sessionId,
      sessionPath: manifest.sessionPath,
      leafId: manifest.leafId,
      revision: manifest.revision,
      members: manifest.family.map((member) => ({ ...member, canonicalPath: member.sessionPath })),
      registry: [],
      registryHash: manifest.registryHash,
      fingerprint: manifest.fingerprint,
      warnings: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  /**
   * `undefined` = activity state unknown (fail closed); `null` = idle;
   * otherwise the reason to reject the transfer.
   */
  private async busyReason(
    family: TransferFamily,
    stage: 'preview' | 'commit',
  ): Promise<{ busyReason: SessionProjectTransferBusyReason; detail?: string } | null | undefined> {
    const activity = this.ports.activity;
    if (!activity) return undefined;
    if (activity.facts) {
      const reason = sessionTransferBusyReason(await activity.facts({ sourceWorkspace: family.sourceWorkspace, family }));
      return reason ? { busyReason: 'unknown', detail: reason } : null;
    }
    if (activity.busy) {
      return (
        (await activity.busy({
          sourceWorkspace: family.sourceWorkspace,
          targetWorkspace: family.targetWorkspace,
          sessionPath: family.sessionPath,
          sessionId: family.sessionId,
          family,
          stage,
        })) ?? null
      );
    }
    return undefined;
  }

  private unknownOperationAck(input: TransferLookupInput): TransferResult {
    const ack: SessionProjectTransferStaleAck = {
      status: 'stale',
      staleReason: 'ticket-unknown',
      requiresPreview: true,
      operationId: input.operationId,
      sessionPath: input.sessionPath ?? '',
      sourceWorkspace: input.sourceWorkspace ?? '',
      sessionId: '',
      notice: 'SESSION_TRANSFER_UNKNOWN_OPERATION',
    };
    return ack;
  }

  private unreadableJournalAck(input: TransferLookupInput, loaded: LoadedJournal): TransferResult {
    const ack: SessionProjectTransferRecoveryRequiredAck = {
      status: 'recovery-required',
      operationId: input.operationId,
      sessionPath: loaded.manifest?.sessionPath ?? input.sessionPath ?? loaded.sessionPaths[0] ?? '',
      sourceWorkspace: input.sourceWorkspace ?? loaded.manifest?.sourceWorkspace ?? '',
      sessionId: loaded.manifest?.sessionId ?? '',
      ...(loaded.manifest ? { targetWorkspace: loaded.manifest.targetWorkspace } : {}),
      recoveryReason: loaded.problem ?? 'journal-unreadable',
      blocked: ['send', 'delete', 'list', 'resume'],
      diagnosticId: input.operationId,
    };
    return ack;
  }

  private async requireManifest(operationId: string): Promise<TransferJournalManifest> {
    const loaded = await this.journal.load(operationId);
    if (!loaded?.manifest) {
      throw new SessionProjectTransferError('TRANSFER_JOURNAL_MISSING', '迁移 journal 缺失', operationId);
    }
    return loaded.manifest;
  }

  private async requireRegistry(workspace: string): Promise<TransferRegistryRecord[]> {
    const registry = this.ports.registry;
    if (!registry) throw new SessionProjectTransferError('TRANSFER_REGISTRY_UNAVAILABLE', '缺少登记端口');
    return registry.read(workspace);
  }

  private leasePaths(family: TransferFamily): string[] {
    return [family.sessionPath, ...family.members.map((member) => member.sessionPath)];
  }

  private async acquireLease(paths: string[], owner: string): Promise<LeaseGuard> {
    const lease = this.ports.lease;
    if (!lease) return NO_LEASE_GUARD;
    const handle = await lease.acquire(paths, { owner, allowBlocked: true });
    if (typeof handle === 'function') return { release: handle, assert: async () => undefined };
    return {
      release: async () => {
        await handle.release();
      },
      // Heartbeat failure / external lock removal must stop writes, not merely be
      // reported at the end. The coordinator also refuses after `release`.
      assert: async () => {
        if (!handle.assertOwned) return;
        try {
          await handle.assertOwned();
        } catch (error) {
          throw new TransferLeaseLostError(String(error));
        }
      },
    };
  }

  private async isArchived(sessionPath: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(join(this.agentDir, 'archived-sessions.json'), 'utf8')) as {
        sessions?: unknown;
      };
      if (!Array.isArray(parsed.sessions)) return false;
      return parsed.sessions.some((path) => typeof path === 'string' && pathsSame(path, sessionPath));
    } catch {
      return false;
    }
  }

  private pruneTickets(): void {
    const now = this.clock();
    for (const [operationId, ticket] of this.tickets) {
      if (now >= ticket.expiresAt) this.tickets.delete(operationId);
    }
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

function normalizeLookup(raw: TransferLookupInput | string): TransferLookupInput {
  if (typeof raw === 'string') return { operationId: requireOperationId(raw) };
  return {
    operationId: requireOperationId(raw.operationId),
    ...(raw.sourceWorkspace ? { sourceWorkspace: resolveRequiredPath(raw.sourceWorkspace, 'sourceWorkspace') } : {}),
    ...(raw.sessionPath ? { sessionPath: resolveRequiredPath(raw.sessionPath, 'sessionPath') } : {}),
  };
}

function resolveRequiredPath(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SessionProjectTransferError('TRANSFER_INVALID_REQUEST', `${field} required`);
  }
  if (!isAbsolutePath(value)) throw new SessionProjectTransferError('TRANSFER_INVALID_REQUEST', `${field} must be absolute`);
  return resolve(value);
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SessionProjectTransferError('TRANSFER_INVALID_REQUEST', `${field} required`);
  }
  return value;
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

function requireOperationId(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new SessionProjectTransferError('TRANSFER_INVALID_REQUEST', 'operationId must be a uuid');
  }
  return value;
}

/** Journal states are a superset of the renderer phase; `rolled-back` has no phase. */
function journalPhaseOf(state: TransferJournalState): TransferJournalPhase | undefined {
  return state === 'rolled-back' ? undefined : state;
}

/** Only an injected fault hook can raise this; production paths never construct it. */
function isSimulatedCrash(error: unknown): boolean {
  return Boolean(error) && (error as { name?: unknown }).name === 'TRANSFER_SIMULATED_CRASH';
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = lowerPath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}

/**
 * On-disk versions a transfer may read: 1, 2, 3 (missing means v1 compatibility).
 *
 * v2/v3 already carry entry ids, so their before/after images are compared
 * byte-exactly. v1 has no ids: the *only* canonical id assignment is the shared
 * `readTransferSession(raw)` algorithm (deterministic sha256 of raw+index, header
 * upgraded to v2). Core never invents ids with the SDK's random generator and
 * never narrows v1 to "unsupported".
 *
 * Unknown versions (0, 4, 99, non-numeric) fail closed: their line shape cannot
 * be interpreted safely.
 */
export function sessionTransferVersion(header: Record<string, unknown>): 1 | 2 | 3 {
  const version = header.version;
  if (version === undefined) return 1;
  if (version === 1 || version === 2 || version === 3) return version;
  throw new SessionProjectTransferError(
    'SESSION_TRANSFER_UNKNOWN_VERSION',
    `未知的会话版本 ${String(version)}；为避免误读历史，迁移拒绝该文件`,
  );
}

export interface CanonicalSessionDocument {
  header: Record<string, unknown> & { id: string };
  entries: Array<Record<string, unknown> & { id: string }>;
}

/** Resolve the shared canonicalizer lazily; core never duplicates the v1 id algorithm. */
async function readCanonicalSession(raw: string): Promise<CanonicalSessionDocument> {
  const module = (await import('./sessionProjectTransferHistory.js').catch(() => undefined)) as
    | { readTransferSession?: (raw: string) => CanonicalSessionDocument }
    | undefined;
  if (typeof module?.readTransferSession !== 'function') {
    throw new SessionProjectTransferError(
      'SESSION_TRANSFER_CANONICALIZER_UNAVAILABLE',
      'v1 会话需要共享的 readTransferSession 规范化（唯一 ID 算法）后才能迁移',
    );
  }
  return module.readTransferSession(raw);
}

function displayPath(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '');
}

function lowerPath(path: string): string {
  return displayPath(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function pathsSame(left: string, right: string): boolean {
  return lowerPath(left) === lowerPath(right);
}

function isUnderPath(root: string, candidate: string): boolean {
  const parent = lowerPath(root);
  const child = lowerPath(candidate);
  return child === parent || child.startsWith(`${parent}/`);
}

function parseHeader(content: string): Record<string, unknown> | null {
  const first = content.split('\n', 1)[0]?.replace(/\r$/, '') ?? '';
  try {
    const parsed = JSON.parse(first) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const header = parsed as Record<string, unknown>;
    return header.type === 'session' ? header : null;
  } catch {
    return null;
  }
}

function headerIdOf(content: string): string | null {
  const header = parseHeader(content);
  return header && typeof header.id === 'string' ? header.id : null;
}

function headerCwdOf(content: string): string | null {
  const header = parseHeader(content);
  return header && typeof header.cwd === 'string' ? header.cwd : null;
}

function parseSessionContent(content: string, label: string): ParsedSession {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new SessionProjectTransferError('SESSION_TRANSFER_BAD_HEADER', `空会话文件: ${label}`);
  let header: Record<string, unknown>;
  try {
    const parsed = JSON.parse(lines[0].replace(/\r$/, '')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    header = parsed as Record<string, unknown>;
  } catch {
    throw new SessionProjectTransferError('SESSION_TRANSFER_BAD_HEADER', `会话头损坏: ${label}`);
  }
  if (header.type !== 'session' || typeof header.id !== 'string' || !header.id.trim()) {
    throw new SessionProjectTransferError('SESSION_TRANSFER_BAD_HEADER', `会话头缺少身份: ${label}`);
  }
  const entries: ParsedEntry[] = [];
  const opaque: string[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < lines.length; index += 1) {
    const raw = lines[index].replace(/\r$/, '');
    if (!raw.trim()) continue;
    let value: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
      value = parsed as Record<string, unknown>;
    } catch {
      throw new SessionProjectTransferError('SESSION_TRANSFER_CORRUPT_SESSION', `会话行损坏: ${label}:${index + 1}`);
    }
    if (typeof value.id !== 'string' || !value.id) {
      if (isLegacyTitleLine(value)) {
        // WorkspaceService.setSessionDisplayName appends this shape directly (no id).
        // Accept it as opaque metadata instead of rejecting an otherwise valid saved
        // session whose title was edited.
        opaque.push(raw);
        continue;
      }
      throw new SessionProjectTransferError('SESSION_TRANSFER_CORRUPT_SESSION', `会话条目缺少 ID: ${label}:${index + 1}`);
    }
    if (seen.has(value.id)) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_CORRUPT_SESSION', `会话条目 ID 重复: ${value.id}`);
    }
    seen.add(value.id);
    entries.push({ id: value.id, raw, value });
  }
  return {
    header: header as ParsedSession['header'],
    entries,
    opaque,
    version: header.version === 2 ? 2 : 3,
  };
}

/**
 * The exact legacy title line written by `WorkspaceService.setSessionDisplayName`:
 * `{type:'session_info', name: <non-empty string>}` and nothing tree-bearing.
 * Any other id-less line stays a corrupt session (never a guessed tree node).
 */
function isLegacyTitleLine(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== 2) return false;
  if (!keys.includes('type') || !keys.includes('name')) return false;
  return value.type === 'session_info' && typeof value.name === 'string' && value.name.trim().length > 0;
}

/**
 * Parse a session for closure/fingerprint purposes.
 *
 * - v3/v2: strict line parse; every tree line keeps its own id and raw bytes.
 * - v1: delegate to the shared canonicalizer (deterministic ids, header→v2).
 *   The before-image remains the *raw* bytes; only ids/leaf/fingerprint use the
 *   canonical document, and the after-image must match that canonical history.
 */
async function parseSessionDocument(content: string, label: string): Promise<ParsedSession> {
  const header = peekHeader(content, label);
  const version = sessionTransferVersion(header);
  if (version !== 1) return parseSessionContent(content, label);
  const document = await readCanonicalSession(content);
  if (document.header.id !== header.id) {
    throw new SessionProjectTransferError('SESSION_TRANSFER_IDENTITY_MISMATCH', `v1 规范化改变了会话 ID: ${label}`);
  }
  const entries: ParsedEntry[] = document.entries.map((entry) => ({
    id: entry.id,
    raw: JSON.stringify(entry),
    value: entry,
  }));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_CORRUPT_SESSION', `v1 规范化后条目 ID 重复: ${entry.id}`);
    }
    seen.add(entry.id);
  }
  return { header: document.header, entries, opaque: [], version };
}

function peekHeader(content: string, label: string): Record<string, unknown> & { id: string } {
  const first = content.split(String.fromCharCode(10), 1)[0]?.replace(new RegExp(String.fromCharCode(13) + '$'), '') ?? '';
  let header: Record<string, unknown>;
  try {
    const parsed = JSON.parse(first) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    header = parsed as Record<string, unknown>;
  } catch {
    throw new SessionProjectTransferError('SESSION_TRANSFER_BAD_HEADER', `会话头损坏: ${label}`);
  }
  if (header.type !== 'session' || typeof header.id !== 'string' || !header.id.trim()) {
    throw new SessionProjectTransferError('SESSION_TRANSFER_BAD_HEADER', `会话头缺少身份: ${label}`);
  }
  return header as Record<string, unknown> & { id: string };
}

function hasSubagentMeta(content: string): boolean {
  return /"customType"\s*:\s*"subagent_meta"/.test(content);
}

function lastSubagentMeta(entries: ParsedEntry[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const entry of entries) {
    if (entry.value.type !== 'custom' || entry.value.customType !== 'subagent_meta') continue;
    const data = entry.value.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_CORRUPT_META', '子代理 metadata 损坏');
    }
    found = data as Record<string, unknown>;
  }
  return found;
}

function isResumableMeta(meta: Record<string, unknown> | undefined): boolean {
  return !!meta && meta.mode === 'continuable' && meta.tornDown !== true;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function catalogChildren(
  entries: ParsedEntry[],
  label: string,
): Array<{ childId: string; sessionPath: string; mode: 'one-shot' | 'continuable' }> {
  // A forked child seeds the parent's catalog before `subagent_catalog_base`;
  // only facts appended after the last base belong to this session.
  let start = 0;
  entries.forEach((entry, index) => {
    if (entry.value.type === 'custom' && entry.value.customType === 'subagent_catalog_base') start = index + 1;
  });
  const children: Array<{ childId: string; sessionPath: string; mode: 'one-shot' | 'continuable' }> = [];
  for (const entry of entries.slice(start)) {
    if (entry.value.type !== 'custom' || entry.value.customType !== 'subagent_catalog') continue;
    const data = entry.value.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_CORRUPT_CATALOG', `子代理 catalog 损坏: ${label}`);
    }
    const fact = data as Record<string, unknown>;
    if (
      fact.version !== 0 ||
      typeof fact.childId !== 'string' ||
      !fact.childId.trim() ||
      typeof fact.sessionPath !== 'string' ||
      !fact.sessionPath.trim() ||
      (fact.mode !== 'one-shot' && fact.mode !== 'continuable')
    ) {
      throw new SessionProjectTransferError('SESSION_TRANSFER_CORRUPT_CATALOG', `子代理 catalog 损坏: ${label}`);
    }
    children.push({ childId: fact.childId, sessionPath: fact.sessionPath, mode: fact.mode });
  }
  return children;
}

function selectFamilyRows(rows: TransferRegistryRecord[], family: TransferFamily): TransferRegistryRecord[] {
  const ids = new Set(family.members.map((member) => member.sessionId));
  const paths = new Set(family.members.map((member) => lowerPath(member.sessionPath)));
  const agentIds = new Set(family.members.flatMap((member) => (member.agentId ? [member.agentId] : [])));
  return rows
    .filter(
      (row) =>
        ids.has(row.id) ||
        agentIds.has(row.id) ||
        (row.parentId !== null && ids.has(row.parentId)) ||
        (row.sessionPath !== null && paths.has(lowerPath(row.sessionPath))),
    )
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function sameRecord(left: TransferRegistryRecord, right: TransferRegistryRecord): boolean {
  return stableJson(left) === stableJson(right);
}

/**
 * History preservation across a transfer after-image.
 *
 * The comparison runs on the canonical form of both sides:
 * - v3/v2: the canonical entries are the original lines, so any rewrite of an
 *   existing entry (id, parent, content, unknown retained fields, signatures) is
 *   rejected byte for byte.
 * - v1: the only legitimate id assignment is the shared `readTransferSession`
 *   algorithm (deterministic sha256 of the *before* raw + index, header→v2). Its
 *   seed is the before bytes, so re-deriving ids from the after bytes would
 *   "change" them on every move; instead the after-image must carry exactly the
 *   before-derived ids in order, and every original field must be unchanged.
 *   `id`/`parentId` are the only fields a v1 upgrade may add.
 * - v2: the SDK's `hookMessage → custom` role rename is part of the canonical
 *   form on both sides, so it is not misreported as a rewrite.
 * - Opaque legacy title lines must survive unchanged, in order.
 */
async function assertHistoryPreserved(before: string, after: string, label: string): Promise<void> {
  const beforeDoc = await parseSessionDocument(before, label);
  const afterDoc = await parseSessionDocument(after, label);
  const beforeById = new Map(beforeDoc.entries.map((entry) => [entry.id, entry]));

  if (beforeDoc.version === 1) {
    // Positional comparison: the derived ids are seeded from the before bytes.
    if (afterDoc.entries.length < beforeDoc.entries.length) {
      throw new SessionProjectTransferError('TRANSFER_INVALID_AFTER_IMAGE', `after-image 丢历史条目 (${label})`);
    }
    for (const [index, original] of beforeDoc.entries.entries()) {
      const moved = afterDoc.entries[index]!;
      if (moved.id !== original.id) {
        throw new SessionProjectTransferError(
          'TRANSFER_INVALID_AFTER_IMAGE',
          `after-image 改写了 v1 条目的规范化 ID: ${original.id} (${label})`,
        );
      }
      const originalFields = stripUpgradeFields(original.value);
      const movedFields = stripUpgradeFields(moved.value);
      if (stableJson(originalFields) !== stableJson(movedFields)) {
        throw new SessionProjectTransferError(
          'TRANSFER_INVALID_AFTER_IMAGE',
          `after-image 改写了 v1 历史条目: ${original.id} (${label})`,
        );
      }
    }
  } else {
    const seen = new Set<string>();
    for (const entry of afterDoc.entries) {
      const original = beforeById.get(entry.id);
      if (!original) continue;
      if (original.raw !== entry.raw) {
        throw new SessionProjectTransferError(
          'TRANSFER_INVALID_AFTER_IMAGE',
          `after-image 改写了历史条目: ${entry.id} (${label})`,
        );
      }
      seen.add(entry.id);
    }
    if (seen.size !== beforeById.size) {
      throw new SessionProjectTransferError('TRANSFER_INVALID_AFTER_IMAGE', `after-image 丢历史条目 (${label})`);
    }
  }

  if (beforeDoc.opaque.length !== afterDoc.opaque.length) {
    throw new SessionProjectTransferError(
      'TRANSFER_INVALID_AFTER_IMAGE',
      `after-image 改写或丢失了旧版标题等非树元数据 (${label})`,
    );
  }
  for (const [index, line] of beforeDoc.opaque.entries()) {
    if (afterDoc.opaque[index] !== line) {
      throw new SessionProjectTransferError(
        'TRANSFER_INVALID_AFTER_IMAGE',
        `after-image 改写或丢失了旧版标题等非树元数据 (${label})`,
      );
    }
  }
}

/** Fields a v1→v2 structural upgrade may legitimately add to an existing row. */
function stripUpgradeFields(entry: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, parentId: _parentId, ...rest } = entry;
  return rest;
}

/**
 * Committed recovery accepts append-only growth: a real SDK open legally appends
 * system/custom/native-model entries, and a crash before the opened receipt must
 * not be mistaken for a mismatch. Only a complete whole-line prefix is trusted.
 */
function isCompletePrefix(current: string, expected: string): boolean {
  if (current === expected) return true;
  if (!current.startsWith(expected)) return false;
  if (!expected.endsWith('\n')) return false;
  const rest = current.slice(expected.length);
  return rest.length === 0 || rest.endsWith('\n');
}

/** Re-exported for adapters/tests that need durable state names. */
export type { TransferJournalState, TransferJournalManifest, TransferJournalRegistryRecord };
