/**
 * Versioned on-disk journal for one session project transfer operation.
 *
 * Layout (never inside a project directory, never a `.jsonl` file):
 *   <agentDir>/session-transfers/<operationId>/
 *     manifest.json   – version, phase, identity, family metadata, result
 *     before.json     – original whole-file snapshots (rollback source)
 *     after.json      – target whole-file images (committed source)
 *     registry.json   – record-level registry rows + CAS hashes
 *
 * Every write is temp-file + flush + rename in the same directory. The commit
 * decision is the atomic rename of `manifest.json` with `state: "committed"`.
 * Unknown versions, missing or checksum-mismatched images fail closed; they are
 * never interpreted as "no transfer happened".
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type TransferJournalState =
  | 'prepared'
  | 'applying'
  | 'committed'
  | 'opened'
  | 'rolled-back'
  | 'recovery-required';

export type JournalFaultHook = (point: string) => void | Promise<void>;

/** Renderer-visible journal phase (contract names it `SessionProjectTransferPhase`). */
export type TransferJournalPhase = 'previewed' | 'prepared' | 'applying' | 'committed' | 'opened' | 'recovery-required';

export interface TransferJournalFileImage {
  /** Canonical managed session path. */
  path: string;
  sha256: string;
  bytes: number;
  /** Whole original text, stored escaped inside JSON (never as JSONL). */
  content: string;
}

export interface TransferJournalAfterImage {
  path: string;
  beforeSha256: string;
  sha256: string;
  bytes: number;
  content: string;
}

export interface TransferJournalRegistryRecord {
  id: string;
  task: string;
  profile: string | null;
  model: string | null;
  thinkingLevel: string | null;
  status: string;
  output: string | null;
  error: string | null;
  exitCode: number | null;
  transcript: string | null;
  sessionPath: string | null;
  parentId: string | null;
  depth: number;
  jobId: string | null;
  bashState: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TransferJournalRegistry {
  version: 1;
  /** Rows that belong to this family, sorted by id. */
  rows: TransferJournalRegistryRecord[];
  /** Hash of the source rows at prepare time; forward apply CAS. */
  expectedSourceHash: string;
  /** Hash of the destination rows for the same ids; rollback CAS. */
  expectedTargetHash: string;
}

export interface TransferJournalFamilyMember {
  sessionPath: string;
  sessionId: string;
  parentSessionPath: string | null;
  agentId: string | null;
  mode: 'main' | 'one-shot' | 'continuable';
  depth: number;
  sha256: string;
  bytes: number;
}

export interface TransferJournalManifest {
  version: 1;
  kind: 'session-project-transfer';
  operationId: string;
  state: TransferJournalState;
  createdAt: number;
  updatedAt: number;
  sourceWorkspace: string;
  targetWorkspace: string;
  sessionId: string;
  sessionPath: string;
  leafId: string | null;
  revision: string;
  fingerprint: string;
  family: TransferJournalFamilyMember[];
  registryRecordCount: number;
  registryHash: string;
  /** Number of times a commit was accepted for this operation (diagnostics only). */
  commits: number;
  /** Post-commit completion marker; false until register/invalidate/open succeeded. */
  opened: boolean;
  /** Compact, body-free result/recovery record. */
  result?: Record<string, unknown>;
  failure?: string;
}

export interface TransferJournalPrepareInput {
  operationId: string;
  sourceWorkspace: string;
  targetWorkspace: string;
  sessionId: string;
  sessionPath: string;
  leafId: string | null;
  revision: string;
  fingerprint: string;
  family: TransferJournalFamilyMember[];
  registryHash: string;
  registryRecordCount: number;
  before: TransferJournalFileImage[];
  after: TransferJournalAfterImage[];
  registry: TransferJournalRegistry;
  now: number;
}

export interface LoadedJournal {
  operationId: string;
  manifest?: TransferJournalManifest;
  before?: TransferJournalFileImage[];
  after?: TransferJournalAfterImage[];
  registry?: TransferJournalRegistry;
  /** Present when the journal exists but cannot be trusted/recovered automatically. */
  problem?: string;
  /** Best-effort affected session paths, even when the manifest is unreadable. */
  sessionPaths: string[];
}

const OPERATION_ID = /^[0-9a-f-]{36}$/i;
const KEEPS_IMAGES = new Set<TransferJournalState>(['prepared', 'applying', 'committed']);

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

export class SessionProjectTransferJournal {
  private readonly root: string;

  constructor(
    agentDir: string,
    private readonly faults?: JournalFaultHook,
  ) {
    this.root = join(agentDir, 'session-transfers');
  }

  dir(operationId: string): string {
    if (!OPERATION_ID.test(operationId)) throw new Error('INVALID_OPERATION_ID');
    return join(this.root, operationId);
  }

  async list(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries.filter((entry) => entry.isDirectory() && OPERATION_ID.test(entry.name)).map((entry) => entry.name).sort();
  }

  async load(operationId: string): Promise<LoadedJournal | undefined> {
    const dir = this.dir(operationId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const before = await this.readImages<TransferJournalFileImage>(dir, 'before.json');
    const after = await this.readImages<TransferJournalAfterImage>(dir, 'after.json');
    const registry = await this.readRegistry(dir);
    const sessionPaths = [
      ...new Set([
        ...(before.value ?? []).map((image) => image.path),
        ...(after.value ?? []).map((image) => image.path),
      ]),
    ];
    let manifest: TransferJournalManifest | undefined;
    let problem: string | undefined;
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      if (parsed?.version !== 1 || parsed?.kind !== 'session-project-transfer') {
        problem = 'unknown-journal-version';
      } else if (parsed.operationId !== operationId || typeof parsed.state !== 'string') {
        problem = 'invalid-journal-manifest';
      } else {
        manifest = parsed as unknown as TransferJournalManifest;
        if (manifest.sessionPath) sessionPaths.unshift(manifest.sessionPath);
        for (const member of manifest.family ?? []) sessionPaths.push(member.sessionPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problem = 'unreadable-journal-manifest';
      else if (names.some((name) => name.endsWith('.tmp'))) problem = 'incomplete-journal-preparation';
      else if (!before.value && !after.value) return undefined;
      else problem = 'missing-journal-manifest';
    }
    // Terminal states keep only the compact manifest: snapshots were already
    // consumed and removed after `opened` / `rolled-back`.
    const keepsImages = manifest ? KEEPS_IMAGES.has(manifest.state) : true;
    if (!problem && keepsImages) {
      if (!before.value) problem = 'missing-before-image';
      else if (!after.value) problem = 'missing-after-image';
      else if (!registry.value) problem = 'missing-registry-snapshot';
      else {
        const badBefore = before.value.find((image) => !validImage(image));
        const badAfter = after.value.find((image) => !validAfterImage(image));
        if (badBefore) problem = 'before-image-checksum-mismatch';
        else if (badAfter) problem = 'after-image-checksum-mismatch';
        else if (before.value.length !== after.value.length) problem = 'image-set-mismatch';
        else {
          const beforePaths = new Set(before.value.map((image) => image.path));
          if (after.value.some((image) => !beforePaths.has(image.path))) problem = 'image-set-mismatch';
        }
      }
    }
    return {
      operationId,
      ...(manifest ? { manifest } : {}),
      ...(before.value ? { before: before.value } : {}),
      ...(after.value ? { after: after.value } : {}),
      ...(registry.value ? { registry: registry.value } : {}),
      ...(problem ? { problem } : {}),
      sessionPaths: [...new Set(sessionPaths)],
    };
  }

  /** Drop the sensitive whole-file snapshots once a terminal result is durably recorded. */
  async pruneImages(operationId: string): Promise<void> {
    const dir = this.dir(operationId);
    await Promise.all(['before.json', 'after.json', 'registry.json'].map((name) => rm(join(dir, name), { force: true })));
  }

  async savePrepared(input: TransferJournalPrepareInput): Promise<void> {
    const dir = this.dir(input.operationId);
    await mkdir(dir, { recursive: true });
    await this.atomicJson(join(dir, 'before.json'), {
      version: 1,
      files: input.before,
    }, 'journal:before');
    await this.atomicJson(join(dir, 'after.json'), {
      version: 1,
      files: input.after,
    }, 'journal:after');
    await this.atomicJson(join(dir, 'registry.json'), input.registry, 'journal:registry');
    const manifest: TransferJournalManifest = {
      version: 1,
      kind: 'session-project-transfer',
      operationId: input.operationId,
      state: 'prepared',
      createdAt: input.now,
      updatedAt: input.now,
      sourceWorkspace: input.sourceWorkspace,
      targetWorkspace: input.targetWorkspace,
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      leafId: input.leafId,
      revision: input.revision,
      fingerprint: input.fingerprint,
      family: input.family,
      registryRecordCount: input.registryRecordCount,
      registryHash: input.registryHash,
      commits: 0,
      opened: false,
    };
    await this.writeManifest(manifest);
  }

  async transition(
    manifest: TransferJournalManifest,
    state: TransferJournalState,
    patch: Partial<Pick<TransferJournalManifest, 'result' | 'failure' | 'commits' | 'opened'>> = {},
    now = Date.now(),
  ): Promise<TransferJournalManifest> {
    const next: TransferJournalManifest = {
      ...manifest,
      ...patch,
      state,
      updatedAt: now,
    };
    await this.writeManifest(next);
    return next;
  }

  async remove(operationId: string): Promise<void> {
    await this.fault?.('journal:remove');
    await rm(this.dir(operationId), { recursive: true, force: true });
  }

  private async writeManifest(manifest: TransferJournalManifest): Promise<void> {
    await this.atomicJson(
      join(this.dir(manifest.operationId), 'manifest.json'),
      manifest,
      `manifest:${manifest.state}`,
    );
  }

  private async atomicJson(file: string, value: unknown, label: string): Promise<void> {
    const content = `${stableJson(value)}\n`;
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    await this.fault?.(`${label}:write-temp`);
    const handle = await open(temp, 'wx');
    try {
      await this.fault?.(`${label}:flush`);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.fault?.(`${label}:rename`);
    await rename(temp, file);
    await this.fault?.(`${label}:renamed`);
  }

  private async readImages<T>(dir: string, name: string): Promise<{ value?: T[] }> {
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>;
      if (parsed?.version !== 1 || !Array.isArray(parsed.files)) return {};
      return { value: parsed.files as T[] };
    } catch {
      return {};
    }
  }

  private async readRegistry(dir: string): Promise<{ value?: TransferJournalRegistry }> {
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'registry.json'), 'utf8')) as TransferJournalRegistry;
      if (parsed?.version !== 1 || !Array.isArray(parsed.rows)) return {};
      return { value: parsed };
    } catch {
      return {};
    }
  }

  private async fault(point: string): Promise<void> {
    await this.faults?.(point);
  }
}

function validImage(image: TransferJournalFileImage): boolean {
  return (
    typeof image?.path === 'string' &&
    typeof image.content === 'string' &&
    typeof image.sha256 === 'string' &&
    image.sha256 === sha256Text(image.content) &&
    image.bytes === Buffer.byteLength(image.content, 'utf8')
  );
}

function validAfterImage(image: TransferJournalAfterImage): boolean {
  return (
    typeof image?.path === 'string' &&
    typeof image.beforeSha256 === 'string' &&
    typeof image.content === 'string' &&
    typeof image.sha256 === 'string' &&
    image.sha256 === sha256Text(image.content) &&
    image.bytes === Buffer.byteLength(image.content, 'utf8')
  );
}

/**
 * Read-only projection of every unfinished transfer journal. The Electron main
 * process (WorkspaceService) has no owner instance, but still must know that a
 * family's header now lives in another project: after commit the file's cwd is
 * the target, so scanning records by the old workspace would miss it. This only
 * reads `manifest.json` — never images, never a session file.
 */
export interface TransferJournalBlock {
  operationId: string;
  phase: TransferJournalPhase;
  sessionPaths: string[];
  sourceWorkspace?: string;
  targetWorkspace?: string;
  reason: string;
}

export async function readTransferJournalBlocks(agentDir: string): Promise<TransferJournalBlock[]> {
  const journal = new SessionProjectTransferJournal(agentDir);
  const blocks: TransferJournalBlock[] = [];
  for (const operationId of await journal.list()) {
    let raw: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(await readFile(join(journal.dir(operationId), 'manifest.json'), 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest');
      raw = value as Record<string, unknown>;
    } catch {
      // Only a broken/missing manifest needs the expensive image fallback to locate
      // its family. Normal RPC/list gates never parse transcript backups.
      const loaded = await journal.load(operationId);
      if (!loaded) continue;
      blocks.push({ operationId, phase: 'recovery-required', sessionPaths: loaded.sessionPaths,
        reason: `迁移 journal 无法读取：${loaded.problem ?? 'unreadable-journal-manifest'}` });
      continue;
    }
    const paths = [raw.sessionPath, ...(Array.isArray(raw.family) ? raw.family.map(member =>
      member && typeof member === 'object' ? (member as { sessionPath?: unknown }).sessionPath : undefined) : [])];
    const sessionPaths = [...new Set(paths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0))];
    const scope = {
      ...(typeof raw.sourceWorkspace === 'string' ? { sourceWorkspace: raw.sourceWorkspace } : {}),
      ...(typeof raw.targetWorkspace === 'string' ? { targetWorkspace: raw.targetWorkspace } : {}),
    };
    const valid = raw.version === 1 && raw.kind === 'session-project-transfer' && raw.operationId === operationId &&
      typeof raw.sessionPath === 'string' && raw.sessionPath.trim().length > 0 &&
      typeof raw.sessionId === 'string' && raw.sessionId.trim().length > 0 &&
      typeof raw.sourceWorkspace === 'string' && raw.sourceWorkspace.trim().length > 0 &&
      typeof raw.targetWorkspace === 'string' && raw.targetWorkspace.trim().length > 0 &&
      (raw.leafId === null || typeof raw.leafId === 'string') && Array.isArray(raw.family) &&
      raw.family.every(member => member && typeof member === 'object' && typeof member.sessionPath === 'string' && member.sessionPath.trim().length > 0) &&
      ['prepared', 'applying', 'committed', 'opened', 'rolled-back', 'recovery-required'].includes(String(raw.state));
    if (!valid) {
      blocks.push({ operationId, phase: 'recovery-required', sessionPaths, ...scope, reason: '迁移 journal 版本或格式无法识别' });
      continue;
    }
    if (raw.state === 'rolled-back' || raw.state === 'opened' && raw.opened === true) continue;
    const phase = raw.state === 'opened' ? 'recovery-required' : raw.state as TransferJournalPhase;
    blocks.push({
      operationId, phase, sessionPaths, ...scope,
      reason: phase === 'committed' ? `会话已移动到目标项目，等待打开：${raw.failure ?? ''}`.trim()
        : phase === 'recovery-required' ? `迁移事务需要人工恢复：${raw.failure ?? 'unknown'}` : '存在未完成的迁移事务',
    });
  }
  return blocks;
}

/** Read one manifest without loading snapshots (status probes shared with main). */
export async function readTransferJournalManifest(
  agentDir: string,
  operationId: string,
): Promise<TransferJournalManifest | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(new SessionProjectTransferJournal(agentDir).dir(operationId), 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    if (parsed?.version !== 1 || parsed?.kind !== 'session-project-transfer') return undefined;
    return parsed as unknown as TransferJournalManifest;
  } catch {
    return undefined;
  }
}
