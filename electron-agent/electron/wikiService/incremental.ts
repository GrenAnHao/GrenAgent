import { randomUUID } from 'node:crypto';
import type { WikiOperation, WikiRunContext } from './contracts';
import { REFERENCE_PROFILE } from './referenceProfiles';
import { parseReferenceCommitAnalysis, parseReferenceIncrementalCatalogue, parseReferencePage, type ReferenceSection } from './referenceParsers';
import { normalizeAuthorConfig } from './authorConfig';
import { gitDelta, freezeRepository, assertCleanTarget, sourceScope, pinPriorPublication, type GitDelta } from './repository';
import { executeItem, runFull, throwIfGlobalFailure } from './fullGeneration';
import { referenceCatalogueTree } from './reference/qoder-0.5.1/wikiTools';
import type { WikiRequestModel } from './sessionRuntime';

type Metrics = Pick<GitDelta, 'files' | 'applyCommits' | 'dropCommits' | 'changedCommits'> & { changedFileCount?: number };
export function deltaDecision(action: 'update' | 'sync', delta: Metrics, allowFull: boolean): 'reject' | 'full' | 'advance' | 'incremental' {
  const t = REFERENCE_PROFILE.git;
  if (delta.applyCommits > t.maxApplyCommits || delta.dropCommits > t.maxDropCommits || delta.changedCommits > t.maxChangedCommits || (delta.changedFileCount ?? delta.files.length) > t.maxChangedFiles) return action === 'sync' && allowFull ? 'full' : 'reject';
  return delta.files.length ? 'incremental' : 'advance';
}
export function descendantIds(sections: Array<{ id: string; parentId: string | null }>, ids: string[]): string[] {
  const deleted = new Set(ids); let changed = true;
  while (changed) { changed = false; for (const s of sections) if (s.parentId && deleted.has(s.parentId) && !deleted.has(s.id)) { deleted.add(s.id); changed = true; } }
  return sections.filter(s => deleted.has(s.id)).map(s => s.id);
}
async function pool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (next < items.length && !failure) { const item = items[next++]; try { await run(item); } catch (error) { failure = error; } } }));
  if (failure) throw failure;
}
export async function runIncremental(operation: WikiOperation, context: WikiRunContext, requestModel: WikiRequestModel): Promise<void> {
  const frozen = pinPriorPublication(operation, context);
  const repo = await freezeRepository(operation, context);
  const prior = frozen.source; if (!prior?.baseline) throw new Error('GIT_BASELINE_REQUIRED');
  if (!Array.isArray(prior.sourceManifest) || !prior.sourceScope) throw new Error('SOURCE_BASELINE_REQUIRED');
  if (JSON.stringify(prior.sourceScope) !== JSON.stringify(sourceScope(operation.plan))) throw new Error('SOURCE_SCOPE_CHANGED_REGENERATE_REQUIRED');
  const allowedPaths = new Set([...repo.manifest, ...prior.sourceManifest].map(file => file.path));
  await assertCleanTarget(operation.repositoryRoot, operation.targetCommit, allowedPaths);
  const priorSections = prior.catalogue as unknown as ReferenceSection[];
  const cp = (stage: string, id = '') => context.checkpoints().find(c => c.stage === stage && c.itemId === id && c.disposition === 'done');
  const repair = operation.action === 'repair';
  if (prior.coverage.partial && !repair) throw new Error('REPAIR_REQUIRED');
  const existingPlan = cp('incremental-plan')?.parsed as ReturnType<typeof planValue> | undefined;
  let delta: GitDelta | undefined;
  if (!existingPlan) {
    delta = await gitDelta(operation.repositoryRoot, prior.baseline, operation.targetCommit, allowedPaths);
    const decision = deltaDecision(operation.action === 'update' ? 'update' : 'sync', delta, operation.plan.allowFullFallback === true);
    if (decision === 'reject') throw new Error('INCREMENTAL_REGENERATE_REQUIRED');
    if (decision === 'full') return runFull(operation, context, requestModel);
    if (decision === 'advance') {
      if (prior.coverage.partial) throw new Error('REPAIR_REQUIRED');
      for (const section of priorSections) context.checkpoint({ stage: 'page', itemId: section.id, disposition: 'done', raw: '', parsed: prior.pages[section.id] });
      await freezeRepository(operation, context);
      await assertCleanTarget(operation.repositoryRoot, operation.targetCommit, allowedPaths);
      context.stage('advance'); context.publish({ catalogue: prior.catalogue, requiredStages: [], pages: priorSections.map(s => ({ id: s.id, disposition: 'done' })), deletedPageIds: [], baseline: operation.targetCommit, mode: 'incremental', expectedPriorPublicationId: frozen.expectedId }); return;
    }
  }
  if (existingPlan) delta = existingPlan.delta;
  const author = normalizeAuthorConfig(operation.author);
  const vars = { RepositoryName: repo.repositoryName, PreferredLanguage: operation.locale, FileChanges: delta?.fileChanges ?? '', WorkspaceTree: repo.tree, Catalog: referenceCatalogueTree(priorSections), Catalogue: JSON.stringify(priorSections), CommitMessages: delta?.commitMessages ?? '', CodingIntent: '', AuthorNotes: [...author.notes, ...author.constraints.map(Text => ({ Text }))] };
  let plan = existingPlan;
  if (!plan) {
    context.stage('commit-analysis');
    let summary = cp('commit-analysis')?.parsed as string | undefined;
    if (summary === undefined) summary = await executeItem(operation, context, requestModel, { stage: 'commit-analysis', itemId: '', purpose: 'wiki.incremental.commit-analysis', variables: vars, evaluate: text => ({ ok: true, value: parseReferenceCommitAnalysis(text) }) });
    if (summary === undefined) throw new Error('COMMIT_ANALYSIS_FAILED');
    context.stage('catalogue-analysis');
    const result = cp('catalogue-analysis')?.parsed as ReturnType<typeof planValue>['result'] | undefined ?? await executeItem(operation, context, requestModel, { stage: 'catalogue-analysis', itemId: '', purpose: 'wiki.incremental.catalogue-analysis', variables: { ...vars, CommitSummary: summary }, priorWiki: { catalogue: priorSections, pages: prior.pages }, evaluate: (text, final) => parseReferenceIncrementalCatalogue(text, priorSections, randomUUID, final) });
    if (!result) throw new Error('CATALOGUE_ANALYSIS_FAILED');
    plan = planValue(result, delta!); context.checkpoint({ stage: 'incremental-plan', itemId: '', disposition: 'done', raw: '', parsed: plan });
  }
  const deletes = descendantIds(priorSections, plan.result.delete.map(d => d.sectionId));
  let sections = [...priorSections.filter(s => !deletes.includes(s.id)), ...plan.result.add.filter(a => !priorSections.some(s => s.id === a.section.id)).map(a => a.section)];
  const changed = new Set([...plan.result.update.map(x => x.section.id), ...plan.result.add.map(x => x.section.id)]);
  for (const section of sections) if (!changed.has(section.id) && !cp('page', section.id)) context.checkpoint({ stage: 'page', itemId: section.id, disposition: 'done', raw: '', parsed: prior.pages[section.id] });
  const runOne = async (entry: { section: ReferenceSection; changeReason: string }, kind: 'update' | 'add') => {
    const s = entry.section; if (cp('page', s.id) && (!repair || !prior.coverage.failed.includes(s.id))) return;
    const stage = kind === 'update' ? 'page-update' : 'page-add';
    const previous = prior.pages[s.id] as { markdown?: string } | undefined;
    try {
      const result = cp(stage, s.id)?.parsed as { markdown: string } | undefined ?? await executeItem(operation, context, requestModel, { stage, itemId: s.id, purpose: kind === 'update' ? 'wiki.incremental.page-update' : 'wiki.incremental.page-add', variables: { ...vars, Prompt: s.prompt || entry.changeReason, Title: s.sectionName, Branch: 'main', Catalogue: repo.tree, WikiContent: previous?.markdown ?? '', ChangeReason: entry.changeReason, AuthorTemplate: '' }, evaluate: (text, final) => { const p = parseReferencePage(text, s.sectionName, final, kind); return p.ok ? { ok: true, value: { markdown: p.value } } : p; } });
      context.checkpoint({ stage: 'page', itemId: s.id, disposition: result ? 'done' : 'failed', raw: '', parsed: result ?? null, ...(result ? {} : { error: `${stage}_failed` }) });
    } catch (error) {
      throwIfGlobalFailure(error, context.signal);
      context.checkpoint({ stage: 'page', itemId: s.id, disposition: 'failed', raw: '', parsed: null, error: 'PAGE_EXECUTION_FAILED' });
    }
  };
  context.stage('page-update'); await pool(plan.result.update, REFERENCE_PROFILE.releaseConcurrency.pageUpdate, item => runOne(item, 'update'));
  context.stage('page-add'); await pool(plan.result.add, REFERENCE_PROFILE.releaseConcurrency.pageAdd, item => runOne(item, 'add'));
  const successfulUpdates = new Map(plan.result.update.filter(item => cp('page', item.section.id)).map(item => [item.section.id, item.section]));
  sections = sections.map(section => successfulUpdates.get(section.id) ?? section);
  const pages = sections.map(s => ({ id: s.id, disposition: cp('page', s.id) ? 'done' as const : 'failed' as const }));
  context.checkpoint({ stage: 'catalogue', itemId: '', disposition: 'done', raw: '', parsed: sections });
  await freezeRepository(operation, context);
  await assertCleanTarget(operation.repositoryRoot, operation.targetCommit, allowedPaths);
  context.publish({ catalogue: sections.map(s => ({ ...s })), requiredStages: ['incremental-plan', 'catalogue'], pages, deletedPageIds: deletes, baseline: operation.targetCommit, mode: 'incremental', expectedPriorPublicationId: frozen.expectedId });
}
function planValue(result: { update: Array<{ section: ReferenceSection; changeReason: string }>; add: Array<{ proposalId: string; section: ReferenceSection; changeReason: string }>; delete: Array<{ sectionId: string; changeReason: string }> }, delta: GitDelta) { return { result, delta }; }


