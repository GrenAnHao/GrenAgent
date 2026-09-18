import { z } from 'zod';
import type { ServiceTaskCapability, ServiceTaskDefinition } from './types';

type Schema = { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } };
type RegisteredDefinition = ServiceTaskDefinition & { inputSchema: Schema; outputSchema: Schema };

const anyObject = z.record(z.string(), z.unknown());
const goalJudgeOutput = z.object({
  verdict: z.enum(['pass', 'fail']),
  reason: z.string().min(1).max(4000),
  missing: z.array(z.string().min(1).max(1000)),
  blockageFingerprint: z.string().max(400).optional(),
}).strict().refine((value) => value.verdict !== 'pass' || value.missing.length === 0, 'a passing judge cannot report missing items');

const l1RecordForRegistry = z.object({
  content: z.string().min(1),
  type: z.string().min(1),
  priority: z.number().optional(),
  scene_name: z.string().optional(),
  source_message_ids: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const memoryExtractionOutput = z.object({
  l1: z.array(l1RecordForRegistry).optional(),
  l2: z.string().optional(),
  l3: z.string().optional(),
}).strict();
export const memoryDedupOutput = z.array(z.object({
  record_id: z.string().min(1),
  action: z.enum(['store', 'update', 'merge', 'skip']),
  target_ids: z.array(z.string()).optional().default([]),
  merged_content: z.string().optional(),
  merged_type: z.string().optional(),
  merged_priority: z.number().optional(),
})).max(200);

export const BUILTIN_SERVICE_TASKS: ServiceTaskDefinition[] = [
  { kind: 'memory_extract', inputSchema: anyObject, outputSchema: memoryExtractionOutput, timeoutMs: 60_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'memory_deduplicate', inputSchema: anyObject, outputSchema: memoryDedupOutput, timeoutMs: 60_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'memory_summarize', inputSchema: anyObject, outputSchema: anyObject, timeoutMs: 30_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'thread_title_generate', inputSchema: anyObject, outputSchema: anyObject, timeoutMs: 30_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'content_classify', inputSchema: anyObject, outputSchema: anyObject, timeoutMs: 30_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'context_summarize', inputSchema: anyObject, outputSchema: anyObject, timeoutMs: 30_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'goal_judge', inputSchema: anyObject, outputSchema: goalJudgeOutput, timeoutMs: 60_000, maxAttempts: 1, capabilities: ['llm_completion'] },
  { kind: 'wiki_page_generate', inputSchema: anyObject, outputSchema: z.custom<unknown>(() => true), timeoutMs: 60_000, maxAttempts: 2, capabilities: ['llm_completion'] },
];

export class ServiceTaskRegistry {
  private readonly definitions = new Map<string, RegisteredDefinition>();

  constructor(definitions: ServiceTaskDefinition[] = BUILTIN_SERVICE_TASKS) {
    definitions.forEach((definition) => this.register(definition));
  }

  register(definition: ServiceTaskDefinition): void {
    if (!definition.kind.trim()) throw new Error('service task kind is required');
    if (this.definitions.has(definition.kind)) throw new Error(`service task kind already registered: ${definition.kind}`);
    if (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs < 1) throw new Error('service task timeout must be positive');
    if (!Number.isInteger(definition.maxAttempts) || definition.maxAttempts < 1) throw new Error('service task maxAttempts must be positive');
    const inputSchema = asSchema(definition.inputSchema);
    const outputSchema = asSchema(definition.outputSchema);
    this.definitions.set(definition.kind, { ...definition, inputSchema, outputSchema, capabilities: [...definition.capabilities] });
  }

  get(kind: string): ServiceTaskDefinition | undefined { return this.definitions.get(kind); }

  validate(kind: string, input: unknown): unknown {
    const definition = this.require(kind);
    const result = definition.inputSchema.safeParse(input);
    if (!result.success) throw new Error('service task input does not match schema');
    return result.data;
  }

  validateOutput(kind: string, output: unknown): unknown {
    const definition = this.require(kind);
    const result = definition.outputSchema.safeParse(output);
    if (!result.success) throw new Error('service task output does not match schema');
    return result.data;
  }

  assertCapabilities(kind: string, requested: ServiceTaskCapability[]): void {
    const definition = this.require(kind);
    if (requested.some((capability) => !definition.capabilities.includes(capability))) throw new Error('service task capability is not declared');
  }

  private require(kind: string): RegisteredDefinition {
    const definition = this.definitions.get(kind);
    if (!definition) throw new Error('service task kind is not registered');
    return definition;
  }
}

function asSchema(value: unknown): Schema {
  if (!value || typeof value !== 'object' || typeof (value as Schema).safeParse !== 'function') {
    return z.custom<unknown>(() => true);
  }
  return value as Schema;
}
