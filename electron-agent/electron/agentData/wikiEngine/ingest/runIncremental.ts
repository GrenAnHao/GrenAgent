// Ported from TencentDB-Agent-Memory MemoryKnowledge (MIT).
/**
 * runIncremental.ts — stage1 parallel extract → cascade deletes → stage2 merge → overview.
 * Source table / FTS rebuild are owned by the caller (one write transaction).
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { classifySources, type SourceStatus } from '../indexDb';
import type { LlmClient } from '../llm';
import { createLogger } from '../logger';
import { deleteSourceFiles } from './cascade';
import { createLimit, getIngestConcurrency, type LimitFunction } from './concurrency';
import { commitCandidates, extractSource, scanExistingPages } from './index';
import { generateOverview } from './overview';

const log = createLogger('wiki-ingest-run');

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function findMdFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) files.push(...findMdFiles(full));
    else if (entry.endsWith('.md') || entry.endsWith('.txt')) files.push(full);
  }
  return files;
}

export interface ProcessedSource {
  filename: string;
  sha256: string;
  size: number;
  ok: boolean;
  error: string | null;
}

export interface IngestOutcome {
  results: Array<{ source: string; filesWritten: string[]; error: string | null }>;
  processed: ProcessedSource[];
  deletedSources: string[];
}

export async function runIngestIncremental(
  projectPath: string,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
  llm: LlmClient,
  globalLlmLimit?: LimitFunction,
): Promise<IngestOutcome> {
  const sourcesDir = join(projectPath, 'raw', 'sources');
  if (!existsSync(sourcesDir)) {
    log.warn('runIngest: raw/sources missing', { projectPath });
    return { results: [], processed: [], deletedSources: [...oldStates.keys()] };
  }

  const disk = findMdFiles(sourcesDir).map((abs) => {
    const content = readFileSync(abs, 'utf8');
    return {
      abs,
      filename: relative(sourcesDir, abs).replace(/\\/g, '/'),
      sha256: sha256(content),
      size: Buffer.byteLength(content, 'utf8'),
    };
  });

  const { toIngest, skipped, deleted } = classifySources(disk, oldStates);
  const skippedCount = skipped.length;
  const toIngestSet = new Set(toIngest);
  const toIngestDisk = disk.filter((d) => toIngestSet.has(d.filename));
  log.info('runIngest classify', {
    disk: disk.length,
    toIngest: toIngest.length,
    skipped: skipped.length,
    deleted: deleted.length,
  });

  const existingPages = scanExistingPages(projectPath);
  const wikiLimit = createLimit(getIngestConcurrency());

  let completed = 0;
  let failed = 0;

  const tasks = toIngestDisk.map((d) =>
    wikiLimit(async () => {
      try {
        const run = () =>
          extractSource(projectPath, d.abs, {}, existingPages, { llm, mode: 'two-stage' });
        const candidates = globalLlmLimit ? await globalLlmLimit(run) : await run();
        completed += 1;
        return { ...d, ok: true as const, candidates, error: null };
      } catch (err) {
        failed += 1;
        return {
          ...d,
          ok: false as const,
          candidates: new Map<string, string>(),
          error: String(err),
        };
      }
    }),
  );

  const extractResults = await Promise.all(tasks);

  if (deleted.length > 0) {
    try {
      deleteSourceFiles(
        projectPath,
        deleted.map((fn) => join(sourcesDir, fn)),
        { logReason: 'wiki/ingest/removed-source' },
      );
    } catch (err) {
      log.warn('cascade delete failed', { error: String(err) });
    }
  }

  const successResults = extractResults.filter((r) => r.ok);
  const allCandidates = successResults.map((r) => ({
    sourceFilename: r.filename,
    candidates: r.candidates,
  }));

  const { written, mergeErrors } = await commitCandidates(projectPath, allCandidates, llm, {
    globalLlmLimit,
    skipLog: allCandidates.length === 0,
  });

  const processed: ProcessedSource[] = extractResults.map((r) => {
    if (!r.ok) {
      return { filename: r.filename, sha256: r.sha256, size: r.size, ok: false, error: r.error };
    }
    const sourcePages = [...r.candidates.keys()];
    // 只看该源自己的 mergeErrors：每个候选路径都有合并错误才算失败。
    // locked 跳过不写 error → 仍算成功。不把别的源写同路径当成该源成功。
    const allMergeFailed =
      sourcePages.length > 0 &&
      sourcePages.every((p) =>
        mergeErrors.some((e) => e.source === r.filename && e.relPath === p),
      );
    return {
      filename: r.filename,
      sha256: r.sha256,
      size: r.size,
      ok: !allMergeFailed,
      error: allMergeFailed ? 'all candidates merge failed' : null,
    };
  });

  if (successResults.length > 0) {
    try {
      const runOverview = () => generateOverview(projectPath, llm);
      await (globalLlmLimit ? globalLlmLimit(runOverview) : runOverview());
    } catch (err) {
      log.warn('overview failed (non-fatal)', { error: String(err) });
    }
  }

  const results = extractResults.map((r) => {
    if (!r.ok) return { source: r.filename, filesWritten: [] as string[], error: r.error };
    const sourcePages = [...r.candidates.keys()];
    const filesWritten = sourcePages.filter((p) => written.includes(p));
    return { source: r.filename, filesWritten, error: null };
  });

  void completed;
  void failed;

  return { results, processed, deletedSources: deleted };
}
