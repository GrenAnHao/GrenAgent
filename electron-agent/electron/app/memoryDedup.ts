import type { L1Record } from '../agent/memoryExtraction';
import type { MemoryRecord, MemoryScope } from '../agentData/memoryStore';
import { memoryTerms, sharedCount } from './memoryTerms';

export interface DedupDecision {
  record_id: string;
  action: 'store' | 'update' | 'merge' | 'skip';
  target_ids: string[];
  merged_content?: string;
  merged_type?: string;
  merged_priority?: number;
}

export interface DedupTarget {
  upsert: (scope: MemoryScope, input: { level: 1; content: string; source?: string }) => MemoryRecord;
  remove: (scope: MemoryScope, id: string) => void;
}

/** 上游用向量 top-K（l1-dedup.ts）。Pi 没有 embedding，用关键词重叠近似：重叠率低于此值的不算候选。 */
export const MIN_RECALL_OVERLAP = 0.3;
/** 比例之外的命中数下限：查询词多时共享一个短语（如 4 字词组切出 3 个二元组）不足以说明说的是同一件事。词数不足 3 个时按词数算。 */
export const MIN_RECALL_SHARED = 3;
/** 查询词上限，和 store.searchL1ByTerms 的取词上限保持一致。 */
const MAX_QUERY_TERMS = 64;

function l1Text(content: string): string {
  try {
    const parsed = JSON.parse(content) as { content?: unknown };
    return typeof parsed.content === 'string' ? parsed.content : content;
  } catch {
    return content;
  }
}

/** 候选至少要共享的词数：比例下限、命中数下限取大者。SQL 子串命中 >= 词集合命中，所以用它做粗筛下限不会漏真候选。 */
export function minSharedTerms(termCount: number): number {
  return Math.max(1, Math.min(MIN_RECALL_SHARED, termCount), Math.ceil(MIN_RECALL_OVERLAP * termCount - 1e-9));
}

export function recallCandidates(
  store: { searchL1ByTerms: (scope: MemoryScope, terms: string[], limit?: number, minShared?: number) => MemoryRecord[] },
  scope: MemoryScope,
  content: string,
  topK = 5,
): MemoryRecord[] {
  const terms = memoryTerms(content, MAX_QUERY_TERMS);
  if (terms.length === 0) return [];
  const minShared = minSharedTerms(terms.length);
  return store.searchL1ByTerms(scope, terms, 50, minShared)
    .map((hit) => {
      const shared = sharedCount(terms, new Set(memoryTerms(l1Text(hit.content), 400)));
      return { hit, shared, score: shared / terms.length };
    })
    .filter((entry) => entry.shared >= minShared && entry.score >= MIN_RECALL_OVERLAP)
    .sort((a, b) => b.score - a.score || b.hit.updatedAt - a.hit.updatedAt)
    .slice(0, topK)
    .map((entry) => entry.hit);
}

export function applyDedupDecisions(
  target: DedupTarget,
  userId: string,
  decisions: DedupDecision[],
  records: Map<string, Pick<L1Record, 'content' | 'type' | 'priority' | 'scene_name' | 'source_message_ids' | 'metadata'>>,
  source: string,
  scope: MemoryScope = { userId, workspace: '' },
): MemoryRecord[] {
  const byId = new Map(decisions.map((decision) => [decision.record_id, decision]));
  const writes: MemoryRecord[] = [];

  for (const [recordId, record] of records) {
    const decision = byId.get(recordId) ?? { record_id: recordId, action: 'store' as const, target_ids: [] };
    if (decision.action === 'skip') continue;

    if (decision.action === 'update' || decision.action === 'merge') {
      for (const id of decision.target_ids) target.remove(scope, id);
      const merged = {
        content: decision.merged_content?.trim() || record.content,
        type: decision.merged_type ?? record.type,
        priority: decision.merged_priority ?? record.priority,
        scene_name: record.scene_name || '未分类',
        source_message_ids: record.source_message_ids ?? [],
        metadata: record.metadata ?? {},
      };
      writes.push(target.upsert(scope, { level: 1, content: JSON.stringify(merged), source }));
      continue;
    }

    const stored = {
      content: record.content,
      type: record.type,
      priority: record.priority,
      scene_name: record.scene_name || '未分类',
      source_message_ids: record.source_message_ids ?? [],
      metadata: record.metadata ?? {},
    };
    writes.push(target.upsert(scope, { level: 1, content: JSON.stringify(stored), source }));
  }

  return writes;
}
