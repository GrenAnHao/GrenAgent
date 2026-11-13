import { SettingsManager } from '../../../cli/src/pi-sdk.js';
import { BUDGET_FIELDS, modelBudgetKey, type ModelBudgetState, type ModelBudgetRow, type BudgetSyncResult, type ModelCompactionPatch } from '../../../extensions/_shared/model-compaction-budgets.js';
import type { SettingsService } from './settingsService.js';

interface BudgetModel { provider: string; id: string; name?: string; contextWindow?: number }
/** Persistence and runtime receipts are separate: a failed session never rolls back a saved preference. */
export class ModelCompactionSettingsService {
  private lastSync: BudgetSyncResult = { sessions: [] };
  constructor(
    private readonly settings: SettingsService,
    private readonly cwd: string,
    private readonly agentDir: string,
    private readonly models: () => Promise<readonly BudgetModel[]>,
    private readonly synchronize: () => Promise<BudgetSyncResult>,
  ) {}

  async get(): Promise<ModelBudgetState> {
    const budgets = await this.settings.getModelCompactionBudgets();
    const baseline = SettingsManager.create(this.cwd, this.agentDir);
    const errors = baseline.drainErrors();
    if (errors.length) throw errors[0].error;
    const global = baseline.getGlobalSettings().compaction;
    const project = baseline.getProjectSettings().compaction;
    const rows: ModelBudgetRow[] = [];
    for (const model of await this.models()) {
      const key = modelBudgetKey(model.provider, model.id);
      const inherited = baseline.getCompactionSettings(model);
      const desktop = budgets[key] ?? {};
      const sources = Object.fromEntries(BUDGET_FIELDS.map((field) => [field,
        project?.modelOverrides?.[key]?.[field] !== undefined || global?.modelOverrides?.[key]?.[field] !== undefined ? 'model'
          : project?.[field] !== undefined || global?.[field] !== undefined ? 'ordinary' : 'default',
      ])) as ModelBudgetRow['sources'];
      rows.push({ key, provider: model.provider, modelId: model.id, name: model.name, contextWindow: model.contextWindow, matched: true,
        desktop, inherited: { reserveTokens: inherited.reserveTokens, keepRecentTokens: inherited.keepRecentTokens }, sources,
        effective: { reserveTokens: desktop.reserveTokens ?? inherited.reserveTokens, keepRecentTokens: desktop.keepRecentTokens ?? inherited.keepRecentTokens } });
    }
    const matched = new Set(rows.map((row) => row.key));
    for (const [key, desktop] of Object.entries(budgets)) if (!matched.has(key)) {
      rows.push({ key, matched: false, desktop });
    }
    return { rows, sync: this.lastSync };
  }

  async patch(provider: string, modelId: string, patch: ModelCompactionPatch): Promise<ModelBudgetState> {
    await this.settings.patchModelCompactionBudget(provider, modelId, patch);
    await this.retrySync();
    return this.savedState();
  }

  async clear(key: string): Promise<ModelBudgetState> {
    await this.settings.clearModelCompactionBudgetKey(key);
    await this.retrySync();
    return this.savedState();
  }

  async retrySync(): Promise<BudgetSyncResult> {
    try { this.lastSync = await this.synchronize(); }
    catch (error) { this.lastSync = { sessions: [{ workspace: 'agent-host', error: error instanceof Error ? error.message : String(error) }] }; }
    return this.lastSync;
  }

  private async savedState(): Promise<ModelBudgetState> {
    try { return await this.get(); }
    catch (error) { return { rows: [], sync: this.lastSync, error: `已保存；读取 Pi 继承值失败：${error instanceof Error ? error.message : String(error)}` }; }
  }
}
