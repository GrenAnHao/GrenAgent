import { describe, expect, it } from 'vitest';
import { metadata } from './contracts.test';
import { DEFAULT_KNOWLEDGE_EXECUTION_POLICY, resolveKnowledgeUnitBudget } from './executionPolicy';

describe('frozen execution profiles', () => {
  it('keeps legacy unit budgets unchanged and chooses frozen purpose-specific budgets', () => {
    const old = metadata(); old.budgets.unit.maxModelRequests = 7;
    expect(resolveKnowledgeUnitBudget(old, 'page').maxModelRequests).toBe(7);
    const current = { ...metadata(), executionPolicy: structuredClone(DEFAULT_KNOWLEDGE_EXECUTION_POLICY) };
    expect(['overview', 'plan', 'catalogue', 'page', 'module-card', 'repository-card', 'relations'].map(kind => {
      const unit = resolveKnowledgeUnitBudget(current, kind as any);
      return [unit.maxModelRequests, unit.maxToolCalls, unit.maxTotalTokens, unit.maxReadBytes, unit.activeTimeMs];
    })).toEqual([[12,40,200000,2097152,600000],[6,16,120000,1048576,300000],[8,24,160000,1048576,300000],[20,60,300000,2097152,600000],[20,60,300000,2097152,600000],[12,32,200000,2097152,600000],[8,24,160000,1048576,300000]]);
  });
  it('rejects missing purpose and malformed or unknown policies', () => {
    const current = { ...metadata(), executionPolicy: structuredClone(DEFAULT_KNOWLEDGE_EXECUTION_POLICY) };
    expect(() => resolveKnowledgeUnitBudget(current, undefined)).toThrow();
    expect(() => resolveKnowledgeUnitBudget({ ...current, executionPolicy: { ...current.executionPolicy, version: 3 } } as any, 'page')).toThrow();
    const incomplete = structuredClone(current) as any; delete incomplete.executionPolicy.profiles.page;
    expect(() => resolveKnowledgeUnitBudget(incomplete, 'overview')).toThrow();
  });
});
