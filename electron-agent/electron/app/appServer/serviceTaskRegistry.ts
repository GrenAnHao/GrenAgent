import { z } from 'zod';
import type { ServiceTaskCapability, ServiceTaskDefinition } from './types';

type Schema = { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } };
type RegisteredDefinition = ServiceTaskDefinition & { inputSchema: Schema; outputSchema: Schema };

const anyObject = z.record(z.string(), z.unknown());

export const BUILTIN_SERVICE_TASKS: ServiceTaskDefinition[] = [
  { kind: 'memory_extract', inputSchema: anyObject, outputSchema: anyObject, timeoutMs: 30_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'memory_deduplicate', inputSchema: anyObject, outputSchema: anyObject, timeoutMs: 30_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'memory_summarize', inputSchema: anyObject, outputSchema: anyObject, timeoutMs: 30_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'thread_title_generate', inputSchema: anyObject, outputSchema: anyObject, timeoutMs: 30_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'content_classify', inputSchema: anyObject, outputSchema: anyObject, timeoutMs: 30_000, maxAttempts: 2, capabilities: ['llm_completion'] },
  { kind: 'context_summarize', inputSchema: anyObject, outputSchema: anyObject, timeoutMs: 30_000, maxAttempts: 2, capabilities: ['llm_completion'] },
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
