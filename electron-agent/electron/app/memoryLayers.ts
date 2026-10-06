import { z } from 'zod';
import type { MemoryRecord, MemoryScope, MemoryStore } from '../agentData/memoryStore';
import type { ManagedMemoryRecord } from '../agentData/memoryContracts';
import { memoryTerms, sharedCount } from './memoryTerms';

export const SCENE_SOURCE_PREFIX = 'scene:';
export const PERSONA_SOURCE = 'persona.md';
export const DEFAULT_MAX_SCENES = 15;
/** 主进程预筛：系统 worker 没有 read 工具（上游让模型按需读正文），只内联最相关的几个场景。 */
export const MAX_INLINE_SCENES = 3;

export type SceneAction = 'write' | 'delete';
export interface SceneDecision {
  filename: string;
  action: SceneAction;
  content?: string;
}
export interface ParsedMemoryScene {
  scenes: SceneDecision[];
  persona_update_request?: string;
}
export interface ParsedMemoryPersona {
  content: string;
}

const sceneItemSchema = z.object({
  filename: z.string().min(1),
  action: z.enum(['write', 'delete']).optional(),
  content: z.string().optional(),
});
const sceneOutputSchema = z.object({
  scenes: z.array(sceneItemSchema),
  persona_update_request: z.string().optional(),
}).strict();
const personaOutputSchema = z.object({
  content: z.string().min(1),
}).strict();

export function sceneSource(filename: string): string {
  return `${SCENE_SOURCE_PREFIX}${filename}`;
}

export function sceneFilenameFromSource(source?: string): string | undefined {
  if (!source?.startsWith(SCENE_SOURCE_PREFIX)) return undefined;
  const filename = source.slice(SCENE_SOURCE_PREFIX.length).trim();
  return filename || undefined;
}

export function sceneSummary(content: string): string {
  const match = content.match(/^summary:\s*(.+)$/m);
  const summary = match?.[1]?.trim();
  return summary || content.trim().slice(0, 80);
}

/** 场景数达到这个值才做共有词过滤：场景太少时「超过一半」没有统计意义。 */
const COMMON_TERM_MIN_SCENES = 4;

export function selectScenesToInline(
  scenes: Array<{ filename: string; summary: string }>,
  memories: Array<{ content: string; scene_name?: string }>,
  maxScenes: number,
): Set<string> {
  // 橙色预警只能 UPDATE、不能 CREATE，红色预警必须 MERGE：两种情况模型都需要看到全部正文。
  if (scenes.length >= maxScenes - 1) return new Set(scenes.map((scene) => scene.filename));
  const sceneTerms = scenes.map((scene) => new Set(memoryTerms(`${scene.filename} ${scene.summary}`, 400)));
  // 场景文件名常带共同前缀（「团队记忆-」），出现在超过一半场景里的词不区分场景，只会给每个场景垫一分。
  const common = commonTerms(sceneTerms);
  // 按条记忆分别算词：整批拼成一个查询再截断的话，批次累积得越多，靠后的记忆越参与不了选场景。
  const queries = memories.map((memory) => memoryTerms(`${memory.scene_name ?? ''} ${memory.content}`).filter((term) => !common.has(term)));
  return new Set(scenes
    .map((scene, index) => {
      let hits = 0;
      let score = 0;
      for (const query of queries) {
        const shared = sharedCount(query, sceneTerms[index]);
        if (shared > 0) hits++;
        score += shared;
      }
      return { filename: scene.filename, hits, score };
    })
    .filter((entry) => entry.hits > 0)
    // 被多少条记忆命中为第一排序键，不让单条长记忆的重叠词数主导；其次总得分，最后文件名。
    .sort((a, b) => b.hits - a.hits || b.score - a.score || a.filename.localeCompare(b.filename))
    .slice(0, MAX_INLINE_SCENES)
    .map((entry) => entry.filename));
}

function commonTerms(sceneTerms: Array<Set<string>>): Set<string> {
  const common = new Set<string>();
  if (sceneTerms.length < COMMON_TERM_MIN_SCENES) return common;
  const frequency = new Map<string, number>();
  for (const terms of sceneTerms) for (const term of terms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  for (const [term, count] of frequency) if (count * 2 > sceneTerms.length) common.add(term);
  return common;
}

export function parseMemoryScene(output: unknown): ParsedMemoryScene {
  const parsed = sceneOutputSchema.safeParse(output);
  if (!parsed.success) throw new Error('memory scene output is invalid');
  const scenes = parsed.data.scenes.flatMap((item) => {
    const filename = sanitizeSceneFilename(item.filename);
    if (!filename) return [];
    const deleted = item.action === 'delete' || item.content?.trim() === '[DELETED]';
    if (deleted) return [{ filename, action: 'delete' as const }];
    const content = item.content?.trim();
    if (!content) return [];
    return [{ filename, action: 'write' as const, content: item.content! }];
  });
  const hint = parsed.data.persona_update_request?.trim();
  return hint ? { scenes, persona_update_request: hint } : { scenes };
}

export function parseMemoryPersona(output: unknown): ParsedMemoryPersona {
  const parsed = personaOutputSchema.safeParse(output);
  if (!parsed.success) throw new Error('memory persona output is invalid');
  return { content: parsed.data.content };
}

export function listGlobalLevel(store: Pick<MemoryStore, 'list'>, userId: string, level: 2 | 3): ManagedMemoryRecord[] {
  const items: ManagedMemoryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = store.list({ userId, filter: { scope: 'global' }, level, cursor, limit: 50 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export function applySceneDecisions(
  store: Pick<MemoryStore, 'list' | 'upsert' | 'remove'>,
  scope: MemoryScope,
  scenes: SceneDecision[],
): MemoryRecord[] {
  const existing = listGlobalLevel(store, scope.userId, 2);
  const byFilename = new Map<string, ManagedMemoryRecord>();
  for (const row of existing) {
    const filename = sceneFilenameFromSource(row.source);
    if (filename && !byFilename.has(filename)) byFilename.set(filename, row);
  }
  const writes: MemoryRecord[] = [];
  const globalScope = { ...scope, scope: 'global' as const, sessionId: undefined };
  for (const scene of scenes) {
    const current = byFilename.get(scene.filename);
    if (scene.action === 'delete') {
      if (current) {
        store.remove(scope, current.id);
        byFilename.delete(scene.filename);
      }
      continue;
    }
    if (!scene.content?.trim()) continue;
    const row = store.upsert(upsertScope(globalScope, current), {
      id: current?.id,
      level: 2,
      content: scene.content,
      source: sceneSource(scene.filename),
    });
    byFilename.set(scene.filename, row as ManagedMemoryRecord);
    writes.push(row);
  }
  return writes;
}

export function applyPersonaDecision(
  store: Pick<MemoryStore, 'list' | 'upsert'>,
  scope: MemoryScope,
  content: string,
): MemoryRecord {
  const existing = listGlobalLevel(store, scope.userId, 3).find((row) => row.source === PERSONA_SOURCE);
  return store.upsert(upsertScope({ ...scope, scope: 'global', sessionId: undefined }, existing), {
    id: existing?.id,
    level: 3,
    content,
    source: PERSONA_SOURCE,
  });
}

function sanitizeSceneFilename(value: string): string | undefined {
  const trimmed = value.trim().replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  if (!trimmed.toLowerCase().endsWith('.md')) return undefined;
  const normalized = trimmed.replace(/\s+/g, '-');
  if (!normalized || normalized === '.md') return undefined;
  return normalized;
}

function upsertScope(scope: MemoryScope, existing?: Pick<ManagedMemoryRecord, 'sourceWorkspace' | 'sourceProjectId' | 'sourceSessionId'>): MemoryScope {
  if (!existing) return scope;
  return {
    userId: scope.userId,
    workspace: existing.sourceWorkspace || scope.workspace,
    projectId: existing.sourceProjectId ?? scope.projectId,
    sessionId: existing.sourceSessionId,
    scope: 'global',
  };
}
