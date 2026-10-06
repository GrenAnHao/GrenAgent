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

export function selectScenesToInline(
  scenes: Array<{ filename: string; summary: string }>,
  memories: Array<{ content: string; scene_name?: string }>,
  maxScenes: number,
): Set<string> {
  // 橙色 / 红色预警时必须 MERGE，模型得看到所有正文才能挑合并对象。
  if (scenes.length >= maxScenes - 1) return new Set(scenes.map((scene) => scene.filename));
  const query = memoryTerms(memories.map((memory) => `${memory.scene_name ?? ''} ${memory.content}`).join('\n'), 96);
  return new Set(scenes
    .map((scene) => ({ filename: scene.filename, score: sharedCount(query, new Set(memoryTerms(`${scene.filename} ${scene.summary}`, 400))) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename))
    .slice(0, MAX_INLINE_SCENES)
    .map((entry) => entry.filename));
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
