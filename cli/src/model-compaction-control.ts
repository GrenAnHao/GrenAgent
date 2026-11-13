import { readFileSync } from 'node:fs';
import { SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { watchConfig } from '../../extensions/_shared/runtime-config.js';
import { MODEL_COMPACTION_KEY, modelBudgetKey, parseModelCompactionBudgets, type ModelCompactionBudgets, type BudgetSyncSession, type BudgetSyncResult } from '../../extensions/_shared/model-compaction-budgets.js';

type Session = Pick<AgentSession, 'settingsManager' | 'model' | 'dispose'> & Partial<Pick<AgentSession, 'agent' | 'setModel' | 'compact' | 'prompt' | 'sessionFile'>>;
const controls = new WeakMap<object, ModelCompactionControl>();
const activeControls = new Set<ModelCompactionControl>();

/** Read outside turn-local ALS snapshots: the application file is the authoritative live projection. */
export function readDesktopModelBudgets(): ModelCompactionBudgets {
  const path = process.env.PI_RUNTIME_CONFIG;
  const raw = path ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>)[MODEL_COMPACTION_KEY] : process.env[MODEL_COMPACTION_KEY];
  return parseModelCompactionBudgets(raw);
}

export class ModelCompactionControl {
  private readonly owned = new Set<string>();
  disposed = false;
  constructor(private readonly session: Session, private readonly cwd: string, private readonly agentDir: string) {}

  syncReceipt(read: () => ModelCompactionBudgets): BudgetSyncSession {
    const model = this.session.model;
    const identity = { workspace: this.cwd, sessionPath: this.session.sessionFile, provider: model?.provider, modelId: model?.id };
    try {
      if (!model) throw new Error('会话尚未选择模型，预算尚未同步。');
      this.apply(read());
      const effective = this.session.settingsManager.getCompactionSettings(model);
      return { ...identity, effective: { reserveTokens: effective.reserveTokens, keepRecentTokens: effective.keepRecentTokens } };
    } catch (error) { return { ...identity, error: error instanceof Error ? error.message : String(error) }; }
  }

  apply(budgets: ModelCompactionBudgets, model = this.session.model): void {
    if (this.disposed || !model) return;
    const key = modelBudgetKey(model.provider, model.id);
    if (!budgets[key] && !this.owned.has(key)) return;
    const baseline = SettingsManager.create(this.cwd, this.agentDir, { projectTrusted: this.session.settingsManager.isProjectTrusted() });
    const errors = baseline.drainErrors();
    if (errors.length) throw errors[0].error;
    const inherited = baseline.getCompactionSettings(model);
    const resolved = {
      reserveTokens: budgets[key]?.reserveTokens ?? inherited.reserveTokens,
      keepRecentTokens: budgets[key]?.keepRecentTokens ?? inherited.keepRecentTokens,
    };
    this.session.settingsManager.applyOverrides({ compaction: { modelOverrides: { [key]: resolved } } });
    this.owned.add(key);
  }
}

export function attachModelCompactionControl(
  session: Session, cwd: string, agentDir: string,
  options: { read?: () => ModelCompactionBudgets; watch?: (cb: () => void) => () => void } = {},
): ModelCompactionControl {
  const control = new ModelCompactionControl(session, cwd, agentDir);
  const read = options.read ?? readDesktopModelBudgets;
  const sync = () => control.apply(read());
  sync();
  controls.set(session, control);
  // No queued async mutation: applyOverrides and baseline reads are synchronous, so each entry is serialized.
  const off = (options.watch ?? watchConfig)(() => { try { sync(); } catch { /* explicit sync / preflight returns the error */ } });
  const prepare = session.agent?.prepareRequest;
  if (session.agent) session.agent.prepareRequest = async (request, signal) => {
    sync();
    const prepared = await prepare?.(request, signal);
    control.apply(read(), prepared?.model ?? request.model);
    return prepared || undefined;
  };
  const setModel = session.setModel?.bind(session);
  if (setModel) session.setModel = async (...args) => { await setModel(...args); sync(); };
  const compact = session.compact?.bind(session);
  if (compact) session.compact = async (...args) => { sync(); return compact(...args); };
  const prompt = session.prompt?.bind(session);
  if (prompt) session.prompt = async (...args) => { sync(); return prompt(...args); };
  const dispose = session.dispose.bind(session);
  session.dispose = () => { off(); control.disposed = true; controls.delete(session); activeControls.delete(control); dispose(); };
  // Keep the explicit sync path tied to the same read function as subscriptions and preflight.
  readers.set(control, read);
  activeControls.add(control);
  return control;
}

const readers = new WeakMap<ModelCompactionControl, () => ModelCompactionBudgets>();
export async function syncSessionModelCompactionBudget(session: Pick<AgentSession, 'settingsManager' | 'model'>): Promise<void> {
  const control = controls.get(session);
  if (control) control.apply(readers.get(control)!());
}

/** Main and embedded sessions share the same owner registry; workers expose this over their own RPC. */
export async function syncLocalModelCompactionBudgets(): Promise<BudgetSyncResult> {
  return { sessions: [...activeControls].map((control) => control.syncReceipt(readers.get(control)!)) };
}
