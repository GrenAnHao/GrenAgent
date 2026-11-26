/**
 * Real-file fixtures for session project transfer tests: a temp agentDir with a
 * managed sessions root, two temp "projects", hand-written Pi JSONL sessions
 * (main + catalog/meta/registry-proven children) and injectable ports that
 * behave like the production adapters without SQLite or a real SDK runtime.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sha256Text, stableJson } from './sessionProjectTransferJournal.js';
import type {
  TransferAfterImageBuilderPort,
  TransferFamily,
  TransferRegistryDiff,
  TransferRegistryPort,
  TransferRegistryRecord,
  TransferWritersPort,
} from './sessionProjectTransfer.js';
import { sessionTransferBusyReason, type TransferActivityFacts } from './sessionProjectTransferActivity.js';

export interface FixtureFile {
  path: string;
  lines: Array<Record<string, unknown>>;
}

export function entry(id: string, parentId: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-11-17T00:00:00.000Z',
    message: { role: 'user', content: `text-${id}`, timestamp: 1 },
    ...extra,
  };
}

export function header(id: string, cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'session', version: 3, id, timestamp: '2026-11-17T00:00:00.000Z', cwd, ...extra };
}

export function catalog(
  id: string,
  parentId: string | null,
  childId: string,
  sessionPath: string,
  mode: 'one-shot' | 'continuable' = 'one-shot',
): Record<string, unknown> {
  return {
    type: 'custom',
    id,
    parentId,
    timestamp: '2026-11-17T00:00:00.000Z',
    customType: 'subagent_catalog',
    data: { version: 0, childId, sessionPath, childCreatedAt: 1, mode, label: childId },
  };
}

export function subagentMeta(
  id: string,
  parentId: string | null,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return { type: 'custom', id, parentId, timestamp: '2026-11-17T00:00:00.000Z', customType: 'subagent_meta', data };
}

export function sessionText(headerLine: Record<string, unknown>, lines: Array<Record<string, unknown>>): string {
  return `${[headerLine, ...lines].map((line) => JSON.stringify(line)).join('\n')}\n`;
}

export async function writeFixture(file: FixtureFile): Promise<string> {
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, sessionText(file.lines[0], file.lines.slice(1)), 'utf8');
  return file.path;
}

export function row(id: string, overrides: Partial<TransferRegistryRecord> = {}): TransferRegistryRecord {
  return {
    id,
    task: `task-${id}`,
    profile: null,
    model: 'fixture/model',
    thinkingLevel: 'medium',
    status: 'done',
    output: `output-${id}`,
    error: null,
    exitCode: 0,
    transcript: `{"type":"message"}\n`,
    sessionPath: null,
    parentId: null,
    depth: 1,
    jobId: null,
    bashState: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

export class FakeRegistry implements TransferRegistryPort {
  readonly applied: TransferRegistryDiff[] = [];
  readonly rolledBack: TransferRegistryDiff[] = [];
  applyCount = 0;
  failApply?: (diff: TransferRegistryDiff) => void;
  failRollback?: (diff: TransferRegistryDiff) => void;

  constructor(private readonly rows: Map<string, TransferRegistryRecord[]>) {}

  async read(workspace: string): Promise<TransferRegistryRecord[]> {
    return (this.rows.get(workspace) ?? []).map((item) => ({ ...item }));
  }

  /** Directly replace rows without a migration diff (simulates an external writer). */
  mutate(workspace: string, next: TransferRegistryRecord[]): void {
    this.set(workspace, next.map((item) => ({ ...item })));
  }

  private set(workspace: string, next: TransferRegistryRecord[]): void {
    this.rows.set(workspace, next);
  }

  async apply(diff: TransferRegistryDiff): Promise<void> {
    this.applyCount += 1;
    if (this.failApply) this.failApply(diff);
    const source = this.rows.get(diff.sourceWorkspace) ?? [];
    const sourceHash = sha256Text(stableJson(source.filter((item) => diff.remove.some((moved) => moved.id === item.id))));
    if (sourceHash !== diff.expectedSourceHash) throw new Error('registry cas mismatch (source)');
    const target = this.rows.get(diff.targetWorkspace) ?? [];
    const targetHash = sha256Text(stableJson(target.filter((item) => diff.remove.some((moved) => moved.id === item.id))));
    if (targetHash !== diff.expectedTargetHash) throw new Error('registry cas mismatch (target)');
    this.set(diff.sourceWorkspace, source.filter((item) => !diff.remove.some((moved) => moved.id === item.id)));
    const without = target.filter((item) => !diff.create.some((created) => created.id === item.id));
    this.set(diff.targetWorkspace, [...without, ...diff.create.map((item) => ({ ...item }))]);
    this.applied.push(diff);
  }

  async rollback(diff: TransferRegistryDiff): Promise<void> {
    if (this.failRollback) this.failRollback(diff);
    const target = this.rows.get(diff.targetWorkspace) ?? [];
    this.set(diff.targetWorkspace, target.filter((item) => !diff.remove.some((moved) => moved.id === item.id)));
    const source = this.rows.get(diff.sourceWorkspace) ?? [];
    const without = source.filter((item) => !diff.create.some((created) => created.id === item.id));
    this.set(diff.sourceWorkspace, [...without, ...diff.create.map((item) => ({ ...item }))]);
    this.rolledBack.push(diff);
  }
}

/** Rewrites only the header cwd and appends target working-directory/preferences metadata. */
export const rewriteHeaderCwd: TransferAfterImageBuilderPort = {
  async build({ targetWorkspace, files }) {
    return files.map((file) => {
      const lines = file.content.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
      const headerLine = JSON.stringify({ ...parsed, cwd: targetWorkspace });
      return {
        path: file.path,
        content: `${[headerLine, ...lines.slice(1)].join('\n')}\n`,
      };
    });
  },
};

export class FakeWriters implements TransferWritersPort {
  readonly released: TransferFamily[] = [];
  readonly registered: string[] = [];
  readonly invalidated: string[][] = [];
  readonly opened: string[] = [];
  failOpen = false;
  failRelease = false;

  async release(input: { family: TransferFamily }): Promise<void> {
    this.released.push(input.family);
    if (this.failRelease) throw new Error('release failed');
  }

  async registerProject(input: { targetWorkspace: string }): Promise<void> {
    this.registered.push(input.targetWorkspace);
  }

  async invalidate(input: { workspaces: string[] }): Promise<void> {
    this.invalidated.push(input.workspaces);
  }

  async open(input: { sessionPath: string }): Promise<void> {
    this.opened.push(input.sessionPath);
    if (this.failOpen) throw new Error('target runtime failed to open');
  }
}

export class FakeActivity {
  factsOverride?: Partial<TransferActivityFacts>;
  fail = false;

  async facts(): Promise<TransferActivityFacts> {
    if (this.fail) throw new Error('activity probe unavailable');
    const facts: TransferActivityFacts = {
      sessionId: 'main',
      entries: [],
      session: { isIdle: true, isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
      hasPendingUi: () => false,
      activeTurn: false,
      queuedTurns: 0,
      preferenceWritePending: false,
      structuralOperationPending: false,
      hasLiveJobs: false,
      ...this.factsOverride,
    };
    return facts;
  }

}

export function busyOf(facts: TransferActivityFacts): string | undefined {
  return sessionTransferBusyReason(facts);
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export function registryRowsMap(entries: Record<string, TransferRegistryRecord[]>): Map<string, TransferRegistryRecord[]> {
  return new Map(Object.entries(entries).map(([key, value]) => [key, value.map((item) => ({ ...item }))]));
}
