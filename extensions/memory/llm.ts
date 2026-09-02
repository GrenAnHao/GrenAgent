export { askLlm, parseJsonLoose, resolveModel } from '../_shared/llm.js';

export interface MemoryExtraction {
  l1?: unknown;
  l2?: string;
  l3?: string;
}
