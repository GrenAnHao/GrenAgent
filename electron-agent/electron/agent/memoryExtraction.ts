import { z } from 'zod';

export const L1_TYPES_WORK = ['work_fact', 'work_task', 'work_method', 'work_artifact'] as const;
export const L1_TYPES_CHAT = ['persona', 'episodic', 'instruction'] as const;
export type L1Type = (typeof L1_TYPES_WORK)[number] | (typeof L1_TYPES_CHAT)[number];

const l1RecordSchema = z.object({
  content: z.string().min(1),
  type: z.string(),
  priority: z.number().optional(),
  scene_name: z.string().optional(),
  source_message_ids: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface L1Record {
  content: string;
  type: L1Type;
  priority: number;
  scene_name: string;
  source_message_ids: string[];
  metadata: Record<string, unknown>;
}

export interface MemoryExtraction { l1?: L1Record[]; l2?: string; l3?: string }

/** 上游 scene-extraction 的默认情境名；L1 抽取未给场景时使用。 */
const DEFAULT_SCENE = '未分类';

export function parseMemoryExtraction(value: unknown, mode: 'work' | 'chat' = 'work'): MemoryExtraction {
  const allowed = new Set<string>(mode === 'chat' ? L1_TYPES_CHAT : L1_TYPES_WORK);
  const root = z.object({
    l1: z.array(l1RecordSchema).optional(),
    l2: z.string().optional(),
    l3: z.string().optional(),
  }).strict().safeParse(value);
  if (!root.success) throw new Error('memory extraction output is invalid');

  const l1 = root.data.l1
    ?.filter((raw) => allowed.has(raw.type))
    .map<L1Record>((raw) => ({
      content: raw.content.trim(),
      type: raw.type as L1Type,
      priority: Math.max(0, Math.min(100, Math.trunc(raw.priority ?? 50))),
      scene_name: raw.scene_name?.trim() || DEFAULT_SCENE,
      source_message_ids: raw.source_message_ids ?? [],
      metadata: raw.metadata ?? {},
    }))
    .filter((record) => record.content.length > 0);

  return {
    l1: l1 && l1.length > 0 ? l1 : undefined,
    l2: root.data.l2?.trim() || undefined,
    l3: root.data.l3?.trim() || undefined,
  };
}
