import type { L1Record } from '../agent/memoryExtraction';
import type { MemoryRecord, MemoryScope } from '../agentData/memoryStore';

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

/** 候选召回：按 content 走 store.search，取 topK。上游用向量+RRF；此处为阶段一的可用足量实现。 */
export function recallCandidates(store: { search: (scope: MemoryScope, query: string, limit?: number) => MemoryRecord[] }, scope: MemoryScope, content: string, topK = 5): MemoryRecord[] {
  return store.search(scope, content, topK);
}

export function applyDedupDecisions(
  target: DedupTarget,
  userId: string,
  decisions: DedupDecision[],
  records: Map<string, Pick<L1Record, 'content' | 'type' | 'priority'>>,
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
        content: decision.merged_content ?? record.content,
        type: decision.merged_type ?? record.type,
        priority: decision.merged_priority ?? record.priority,
        scene_name: '未分类',
        source_message_ids: [] as string[],
        metadata: {} as Record<string, unknown>,
      };
      writes.push(target.upsert(scope, { level: 1, content: JSON.stringify(merged), source }));
      continue;
    }

    const stored = {
      content: record.content,
      type: record.type,
      priority: record.priority,
      scene_name: '未分类',
      source_message_ids: [] as string[],
      metadata: {} as Record<string, unknown>,
    };
    writes.push(target.upsert(scope, { level: 1, content: JSON.stringify(stored), source }));
  }

  return writes;
}
