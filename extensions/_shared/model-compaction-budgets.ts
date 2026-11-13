/** Desktop-only preference. SDK settings.json remains an independent inheritance source. */
export const MODEL_COMPACTION_KEY = 'PI_MODEL_COMPACTION_OVERRIDES';
export const BUDGET_FIELDS = ['reserveTokens', 'keepRecentTokens'] as const;
export type BudgetField = typeof BUDGET_FIELDS[number];
export type ModelCompactionBudget = Partial<Record<BudgetField, number>>;
export type ModelCompactionBudgets = Record<string, ModelCompactionBudget>;
export type ModelCompactionPatch = Partial<Record<BudgetField, number | null>>;
export interface BudgetSyncSession {
  workspace: string;
  sessionPath?: string;
  provider?: string;
  modelId?: string;
  effective?: ModelCompactionBudget;
  error?: string;
}
export interface BudgetSyncResult { sessions: BudgetSyncSession[] }
export interface ModelBudgetRow {
  key: string;
  provider?: string;
  modelId?: string;
  name?: string;
  contextWindow?: number;
  matched: boolean;
  desktop: ModelCompactionBudget;
  inherited?: Required<ModelCompactionBudget>;
  sources?: Record<BudgetField, 'model' | 'ordinary' | 'default'>;
  effective?: Required<ModelCompactionBudget>;
}
export interface ModelBudgetState { rows: ModelBudgetRow[]; sync: BudgetSyncResult; error?: string }

export function modelBudgetKey(provider: string, modelId: string): string {
  if (!provider || !modelId) throw new Error('供应商与模型 ID 不能为空');
  return `${provider}/${modelId}`;
}

export function validateBudgetPatch(value: unknown): asserts value is ModelCompactionPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型预算必须是对象');
  for (const [key, number] of Object.entries(value)) {
    if (!(BUDGET_FIELDS as readonly string[]).includes(key)) throw new Error(`未知预算字段：${key}`);
    if (number !== null && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)) {
      throw new Error(`${key} 必须是非负安全整数 token，或 null（清除覆盖）`);
    }
  }
}

export function parseModelCompactionBudgets(raw: string | undefined): ModelCompactionBudgets {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型预算表必须是对象');
  for (const [key, value] of Object.entries(parsed)) {
    validateBudgetPatch(value);
    if (Object.values(value).some((item) => item === null)) throw new Error(`预算记录 ${key} 不能包含 null`);
  }
  return parsed as ModelCompactionBudgets;
}

export function patchModelBudget(budgets: ModelCompactionBudgets, key: string, patch: ModelCompactionPatch): ModelCompactionBudgets {
  validateBudgetPatch(patch);
  const next = { ...budgets };
  const entry = { ...next[key] };
  for (const field of BUDGET_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    if (patch[field] === null) delete entry[field];
    else entry[field] = patch[field]!;
  }
  if (Object.keys(entry).length) next[key] = entry;
  else delete next[key];
  return next;
}
