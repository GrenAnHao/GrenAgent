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

/**
 * 上游 parseExtractionResult（l1-extractor.ts:643-655）的字段默认值。
 * 缺 type 的记录不补默认值，会被 l1RecordSchema 的 type: z.string() 丢掉。上游默认 episodic，这里不跟，
 * 是为了不引入默认类型（episodic 在 chat 模式下是有效类型，默认它会把没写 type 的记录原样存进去）。
 * source_message_ids：单个字符串包成数组，数组里只留 string 和 number（number 转字符串），其余类型丢掉。
 */
function normalizeMemory(memory: unknown): unknown {
  if (!memory || typeof memory !== 'object' || Array.isArray(memory)) return memory;
  const rec = { ...(memory as Record<string, unknown>) };
  if (rec.priority !== undefined && typeof rec.priority !== 'number') {
    const numeric = typeof rec.priority === 'string' && rec.priority.trim() ? Number(rec.priority) : Number.NaN;
    rec.priority = Number.isFinite(numeric) ? numeric : 50;
  }
  if (typeof rec.source_message_ids === 'string') rec.source_message_ids = [rec.source_message_ids];
  else if (Array.isArray(rec.source_message_ids)) {
    rec.source_message_ids = rec.source_message_ids
      .filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
      .map(String);
  } else if (rec.source_message_ids !== undefined) delete rec.source_message_ids;
  if (rec.metadata !== undefined && (!rec.metadata || typeof rec.metadata !== 'object' || Array.isArray(rec.metadata))) rec.metadata = {};
  return rec;
}

/** 上游抽取输出是 scene 数组；摊成 Pi 的 {l1} 信封以便兼容旧路径。 */
export function flattenSceneExtraction(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const l1: Array<z.infer<typeof l1RecordSchema>> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const scene = item as Record<string, unknown>;
    const sceneName = typeof scene.scene_name === 'string' ? scene.scene_name : undefined;
    if (!Array.isArray(scene.memories)) continue;
    for (const memory of scene.memories) {
      const parsed = l1RecordSchema.safeParse(normalizeMemory(memory));
      if (!parsed.success) continue;
      l1.push({
        ...parsed.data,
        scene_name: parsed.data.scene_name?.trim() || sceneName,
      });
    }
  }
  return { l1 };
}

export function parseMemoryExtraction(value: unknown, mode: 'work' | 'chat' = 'work'): MemoryExtraction {
  const allowed = new Set<string>(mode === 'chat' ? L1_TYPES_CHAT : L1_TYPES_WORK);
  const root = z.object({
    l1: z.array(l1RecordSchema).optional(),
    l2: z.string().optional(),
    l3: z.string().optional(),
  }).strict().safeParse(flattenSceneExtraction(value));
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
