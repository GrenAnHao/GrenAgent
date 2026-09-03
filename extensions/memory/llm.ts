export { askLlm, parseJsonLoose, resolveModel, type AskFn } from '../_shared/llm.js';

export interface MemoryExtraction {
  l1?: unknown;
  l2?: string;
  l3?: string;
}
