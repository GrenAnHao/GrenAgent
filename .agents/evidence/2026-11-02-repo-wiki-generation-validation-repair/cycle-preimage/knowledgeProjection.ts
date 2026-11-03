import type { KnowledgeActionInput, KnowledgeDomain, KnowledgePhase, KnowledgeRunState, RepoWikiKnowledgeSnapshot } from '../../../shared/knowledgeKernelContracts';

/**
 * Presentation of a KnowledgeKernel snapshot. The page has two modes, following the
 * Qoder knowledge center: a settled status card (content facts + one primary action)
 * and an in-progress card (stage title, description, progress + pause/cancel).
 */
export const knowledgeActionLabels: Record<KnowledgeActionInput['action'], string> = { pause: '暂停', resume: '继续', cancel: '取消', repair: '重试', reanalyse: '重新分析' };
const runLabels: Record<KnowledgeRunState, string> = { queued: '等待生成', running: '生成中', recovering: '恢复中', pause_requested: '暂停中', paused: '已暂停', blocked: '需要处理', completed: '已生成', failed: '生成失败', cancelled: '已取消' };
const settledStates = new Set<KnowledgeRunState>(['completed', 'failed', 'cancelled']);
const activeStates = new Set<KnowledgeRunState>(['queued', 'running', 'recovering', 'pause_requested']);
/** Before these phases the planned total is not frozen yet, so no denominator is shown. */
const unplannedPhases = new Set<KnowledgePhase>(['prepare', 'change_analysis', 'readme', 'overview', 'plan', 'catalogue']);

type StageCopy = { title: string; description: string };
const stageCopy = (domain: KnowledgeDomain, phase: KnowledgePhase): StageCopy => {
  const wiki = domain === 'wiki';
  switch (phase) {
    case 'readme': return { title: '读取 README 中', description: '正在整理项目说明，为源码分析准备输入' };
    case 'change_analysis': return { title: '分析变更中', description: wiki ? '正在对比源码差异，确定需要更新的文档' : '正在对比源码差异，确定需要更新的知识卡片' };
    case 'overview': return { title: '分析项目中', description: '正在阅读源码，梳理项目概览' };
    case 'plan': return { title: '规划中', description: wiki ? '正在规划文档结构' : '正在规划知识卡片' };
    case 'catalogue': return { title: '生成目录中', description: '正在生成文档目录结构' };
    case 'generate': return wiki ? { title: '生成文档中', description: '正在生成文档内容' } : { title: '生成卡片中', description: '正在生成知识卡片' };
    case 'relations': return { title: '整理关系中', description: '正在建立知识卡片之间的关系' };
    case 'validate':
    case 'publish': return { title: '整理中', description: wiki ? '正在校验并发布 Wiki' : '正在校验并发布知识卡片' };
    default: return { title: '初始化中', description: wiki ? '正在初始化分析' : '正在分析仓库结构' };
  }
};

const errorTexts: Record<string, string> = {
  GIT_DUBIOUS_OWNERSHIP: '仓库属于另一个 Windows 用户，Git 拒绝读取。执行 git config --global --add safe.directory <仓库路径> 信任后重试。',
  GIT_PROBE_FAILED: '无法读取仓库的 Git 信息，请确认 Git 可用、仓库没有损坏后重试。',
  SOURCE_COVERAGE_INCOMPLETE: '源码没有扫描完整（有文件无法读取或忽略规则无效），未开始生成。',
  SOURCE_IDENTITY_CHANGED: '生成期间分支或提交发生了变化，请重新生成。',
  SOURCE_MANIFEST_MISMATCH: '生成期间源码被修改，请重新生成。',
  MODEL_UNAVAILABLE: '系统知识模型不可用，请在设置中配置后重试。',
  INVALID_MODEL_JSON: '模型没有按要求返回 JSON（已自动要求重发一次仍不合格），请重试。',
  BUDGET_EXHAUSTED: '这一项用完了单项预算（模型轮数、工具次数或 token），已完成的部分已保留。点「重新分析」会用新的预算继续。',
  CATALOGUE_LIMIT: '目录达到当前任务的节点、层级或规划项上限，已完成的部分已保留。请在 Wiki 计划里缩小范围后重新分析。',
  MODEL_CHANGED: '知识模型配置已变化，请重新确认后生成。',
};
/** Kernel errors carry stable codes; translate the known ones and keep readable server text otherwise. */
export function knowledgeErrorText(error: { code?: string; message?: string } | undefined): string | undefined {
  if (!error) return undefined;
  const code = [error.message, error.code].find((value) => value && errorTexts[value]);
  if (code) return errorTexts[code];
  return error.message && !/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : `生成失败（${error.message || error.code}），请重试。`;
}

export type KnowledgeStatusTone = 'completed' | 'pending' | 'partial' | 'failed';
export type KnowledgePrimary = { kind: 'generate' | KnowledgeActionInput['action']; label: string; intent?: 'update' | 'generate' };

export function projectKnowledge(snapshot: RepoWikiKnowledgeSnapshot) {
  const run = snapshot.run, domain = snapshot.key.domain, content = snapshot.content;
  const settled = !run || settledStates.has(run.state);
  const inFlight = !!run && !settled;
  const planned = run?.counts.planned || content.expectedCount;
  const planKnown = planned > 0 && !(inFlight && unplannedPhases.has(run!.phase));
  const progress = run?.state === 'completed' ? 100 : planKnown && run ? Math.min(99, Math.floor(run.counts.prepared / planned * 100)) : undefined;
  const failed = run?.state === 'failed';
  const unit = domain === 'wiki' ? '篇' : '张';
  const activeItems = run && activeStates.has(run.state) ? run.activeItems ?? [] : [];
  const activeLabel = activeItems.length > 1 ? `处理中 ${activeItems.length} ${run?.phase === 'generate' ? unit : '项'}` : undefined;
  const currentItem = run && activeStates.has(run.state) ? run.activeItems === undefined ? run.currentItem : activeItems[0]?.title : undefined;

  // In-progress card: title / description / progress follow the current stage.
  let title = '', description = '';
  if (run && inFlight) {
    const stage = stageCopy(domain, run.phase);
    title = stage.title; description = stage.description;
    if (run.phase === 'generate' && planKnown) description = `${domain === 'wiki' ? '正在生成' : '正在生成卡片'}，已完成 ${Math.min(run.counts.prepared, planned)}/${planned}（${progress}%）${run.counts.failed ? `，失败 ${run.counts.failed}` : ''}`;
    if (run.state === 'queued') { title = '等待生成'; description = '等待开始分析'; }
    if (run.state === 'recovering') { title = '恢复中'; description = '应用重启后正在接回上次的进度'; }
    if (run.state === 'pause_requested') { title = '暂停中…'; description = '已请求暂停，当前步骤结束后停下'; }
    if (run.state === 'paused') { title = '生成已暂停'; description = '可从保存的进度继续'; }
    if (run.state === 'blocked') { title = '需要处理'; description = knowledgeErrorText(run.error) ?? '源码、计划或模型已变化，需要重新分析后继续'; }
  }

  // Settled card: one status line, like Qoder's generation status row.
  const partial = failed && (run!.counts.prepared > 0 || content.publishedCount > 0);
  const statusTone: KnowledgeStatusTone = failed ? (partial ? 'partial' : 'failed') : content.publishedCount ? (content.state === 'partial' ? 'partial' : 'completed') : 'pending';
  const statusLabel = failed ? (partial ? '部分完成' : '生成失败') : !content.publishedCount ? '未生成' : content.state === 'stale' ? '有可用更新' : content.state === 'partial' ? '部分完成' : '已生成';
  const hint = failed ? knowledgeErrorText(run!.error) ?? '生成失败，请重试。'
    : content.state === 'stale' ? `源码有新的变更，更新后可纳入最新内容。`
      : run?.state === 'cancelled' ? '上次生成已取消，已发布的内容保持不变。' : undefined;

  // Exactly one primary action, plus a secondary cancel while a run is live.
  const can = (action: KnowledgeActionInput['action']) => !!run?.capabilities[action];
  let primary: KnowledgePrimary | undefined;
  if (inFlight) {
    if (run!.state === 'paused' && can('resume')) primary = { kind: 'resume', label: '继续' };
    else if (run!.state === 'blocked' && can('reanalyse')) primary = { kind: 'reanalyse', label: '重新分析' };
    else if (can('pause')) primary = { kind: 'pause', label: '暂停' };
    else if (run!.state === 'pause_requested') primary = { kind: 'pause', label: '暂停中…' };
  } else if (failed && can('repair')) primary = { kind: 'repair', label: '重试' };
  else if (failed) primary = { kind: 'generate', label: '重试', intent: content.publishedCount ? 'update' : 'generate' };
  else primary = content.publishedCount ? { kind: 'generate', label: '更新', intent: 'update' } : { kind: 'generate', label: '生成', intent: 'generate' };
  const secondary = inFlight && can('cancel') ? { kind: 'cancel' as const, label: '取消' } : undefined;

  return {
    published: content.publishedCount, prepared: content.preparedCount, expected: planned, unit,
    activeItems, activeLabel, currentItem,
    runLabel: run ? runLabels[run.state] : '未生成',
    /** Stage the run is in (or stopped in), for task detail views. */
    phaseLabel: run ? stageCopy(domain, run.phase).title : undefined,
    preparedLabel: planKnown ? `${Math.min(content.preparedCount, planned)} / ${planned}` : `${content.preparedCount}（目录确定后显示总数）`,
    title, description, progress, inFlight,
    statusTone, statusLabel, hint,
    filesLabel: content.publishedCount || failed ? `${content.publishedCount} ${unit}已发布${failed && run!.counts.failed ? `，${run!.counts.failed} 失败` : ''}` : undefined,
    primary, secondary,
    /** Primary needs a run capability (pause/resume/...) or, for generate, a settled run and a ready model. */
    primaryDisabled: !primary || (primary.kind === 'generate' ? !(settled && snapshot.admission.state === 'ready') : !can(primary.kind)),
    errorText: knowledgeErrorText(run?.error),
    submitting: snapshot.action.state === 'submitting',
    hasDraft: content.preparedCount > 0 && !!run && run.state !== 'completed',
    polling: !!run && activeStates.has(run.state),
    canStart: settled && snapshot.admission.state === 'ready',
    generateLabel: primary && primary.kind === 'generate' ? primary.label : content.publishedCount ? '更新' : '生成',
    navLabel: inFlight ? runLabels[run!.state] : content.publishedCount ? '已生成' : '未生成',
  };
}
export function acceptKnowledgeSnapshot(current: RepoWikiKnowledgeSnapshot | null, next: RepoWikiKnowledgeSnapshot, projectId: string, language: string, domain: string): RepoWikiKnowledgeSnapshot | null {
  if (next.key.projectId !== projectId || next.key.language !== language || next.key.domain !== domain) return current;
  if (current?.run && next.run?.taskId === current.run.taskId && next.run.revision < current.run.revision) return current;
  return next;
}

/** Live generation state of one repository, as the project collection shows it on a card. */
export interface KnowledgeActivity { label: string; detail: string; tone: 'running' | 'paused' | 'attention' | 'failed'; progress?: number; updatedAt: number }
/** Cards are matched by workspace path; Windows paths compare case-insensitively with either slash. */
export function knowledgeActivityKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
/** Only runs that still need the user's eye: live, paused, blocked, or failed. */
export function knowledgeActivity(snapshot: RepoWikiKnowledgeSnapshot | null | undefined, updatedAt = 0): KnowledgeActivity | undefined {
  const run = snapshot?.run;
  if (!snapshot || !run || run.state === 'completed' || run.state === 'cancelled') return undefined;
  const view = projectKnowledge(snapshot);
  const tone: KnowledgeActivity['tone'] = run.state === 'failed' ? 'failed' : run.state === 'blocked' ? 'attention' : run.state === 'paused' || run.state === 'pause_requested' ? 'paused' : 'running';
  const label = tone === 'running' && view.progress !== undefined ? `${view.runLabel} ${view.progress}%` : view.runLabel;
  return { label, detail: view.inFlight ? view.title : view.statusLabel, tone, progress: view.inFlight ? view.progress : undefined, updatedAt: run.updatedAt ?? updatedAt };
}
