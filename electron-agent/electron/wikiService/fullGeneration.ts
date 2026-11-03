import { randomUUID } from 'node:crypto';
import type { WikiOperation, WikiRunContext } from './contracts';
import { normalizeAuthorConfig, type AuthorPage } from './authorConfig';
import { assertCleanTarget, freezeRepository, pinPriorPublication } from './repository';
import { REFERENCE_PROFILE } from './referenceProfiles';
import type { ReferenceSection } from './reference/qoder-0.5.1/wikiTools';
import { parseReferenceOverview, parseReferencePlan, parseReferenceCatalogue, parseReferencePage, type ReferenceCatalogueNode, type ReferenceResult } from './referenceParsers';
import { referenceReadme, referenceValidFileCount, catalogueChildVariables, referenceCatalogueRetryInstruction, renderReferenceExecution, type ReferencePurpose } from './referencePrompts';
import { runWikiSession, type WikiRequestModel } from './sessionRuntime';

export interface Section { id: string; parentId: string; ordinal: number; sectionName: string; title: string; prompt: string; dependentFiles: string[]; meta: Record<string, unknown> }
interface Node extends ReferenceCatalogueNode { id: string; children: Node[]; template?: string }
async function pool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0; let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !failure) { const item = items[next++]; try { await run(item); } catch (e) { failure = e; } }
  }));
  if (failure) throw failure;
}
/** Ordinary item failures do not cancel unrelated sections; these conditions invalidate the whole run. */
export function throwIfGlobalFailure(error: unknown, signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? error;
  const code = error instanceof Error ? error.message : String(error);
  if (/^(STALE_FENCE|LEASE_EXPIRED|LEASE_BUSY|CONTROL_PENDING|SPENDING_LIMIT|SOURCE_SNAPSHOT_CHANGED|SNAPSHOT_CHANGED|SOURCE_CHANGED|MODEL_CHANGED|MODEL_UNAVAILABLE|AGENTDATA_NOT_READY|NATIVE_SCOPE_MISMATCH|NATIVE_LEASE_MISMATCH|NATIVE_NOT_ADMITTED|REQUEST_NOT_DISPATCHABLE|REQUEST_NOT_FOUND|NOT_ACTIVE|NATIVE_HOST_DISCONNECTED|BASELINE_CHANGED|COORDINATOR_CLOSED|CONTEXT_WINDOW_EXCEEDED)$/.test(code)) throw error;
}
/**
 * Turn an exhausted stage into a code that names the failure class. The native store keeps only a
 * bare upper-case code for `operation.error` (it rewrites anything else to RUN_FAILED), so an
 * opaque `<STAGE>_FAILED` used to erase whether the provider failed, the answer was truncated, or
 * the answer was well-formed but invalid. The checkpoint already holds the classified reason; this
 * only lifts that class into the code, never the model text.
 */
export function stageFailureCode(context: WikiRunContext, stage: string, itemId: string, fallback: string): string {
  const previous = [...context.checkpoints()].reverse().find(checkpoint => checkpoint.stage === stage && checkpoint.itemId === itemId && checkpoint.disposition === 'failed');
  const reason = String(previous?.error ?? '');
  const prefix = fallback.replace(/_FAILED$/, '');
  if (reason === 'MODEL_ERROR') return `${prefix}_MODEL_ERROR`;
  if (reason.startsWith('model_output_length') || reason === 'model_output_length') return `${prefix}_OUTPUT_TRUNCATED`;
  if (reason) return `${prefix}_OUTPUT_INVALID`;
  return fallback;
}
export async function runPagePool(ids: string[], completed: Set<string>, concurrency: number, run: (id: string, round: 1 | 2) => Promise<boolean>): Promise<{ failed: string[] }> {
  let failed: string[] = [];
  await pool(ids.filter(id => !completed.has(id)), concurrency, async id => { if (await run(id, 1)) completed.add(id); else failed.push(id); });
  if (ids.length && !completed.size && failed.length) throw new Error(`page: all ${failed.length} documents failed`);
  const first = failed; failed = [];
  await pool(first, concurrency, async id => { if (await run(id, 2)) completed.add(id); else failed.push(id); });
  return { failed };
}
export async function executeItem<T>(operation: WikiOperation, context: WikiRunContext, requestModel: WikiRequestModel, input: { stage: string; itemId: string; purpose: ReferencePurpose; variables: Record<string, unknown>; evaluate(text: string, final: boolean): ReferenceResult<T>; child?: boolean; executionRound?: 1 | 2; priorWiki?: { catalogue: ReferenceSection[]; pages: Record<string, unknown> } }): Promise<T | undefined> {
  let lastError = '', retryInstruction: string | undefined;
  const delay = REFERENCE_PROFILE.retryDelayMs;
  const delays: Record<string, number> = { overview: delay.overview, plan: delay.plan, 'catalogue-root': delay.catalogue, 'catalogue-child': delay.catalogue, page: delay.page, 'commit-analysis': delay.commitAnalysis, 'catalogue-analysis': delay.catalogueAnalysis, 'page-update': delay.pageUpdate, 'page-add': delay.pageAdd };
  const attemptKey = `${operation.id}:${input.itemId}:${input.executionRound ?? 1}`;
  const attemptState = context.checkpoints().find(c => c.stage === `${input.stage}:attempt` && c.itemId === attemptKey);
  const priorAttempt = attemptState?.parsed as { attempt: number; status?: 'inflight' | 'failed' | 'done'; sessionRestartCount?: number } | undefined;
  const resumedInflight = priorAttempt?.status === 'inflight';
  const firstAttempt = priorAttempt ? Number(priorAttempt.attempt) + (resumedInflight ? 0 : 1) : 1;
  const sessionRestartCount = (priorAttempt?.sessionRestartCount ?? 0) + (resumedInflight ? 1 : 0);
  const repairCandidate = (error: string) => error === 'no valid JSON found in documentation_structure tag' || error.startsWith('failed to parse JSON structure: SyntaxError');
  const previous = context.checkpoints().find(c => c.stage === input.stage && c.itemId === input.itemId && c.disposition === 'failed');
  if (firstAttempt > 1 && previous) { lastError = previous.error ?? ''; if (input.stage.startsWith('catalogue') && input.stage !== 'catalogue-analysis') retryInstruction = referenceCatalogueRetryInstruction(previous.raw, lastError, repairCandidate(lastError)); }
  for (let attempt = firstAttempt; attempt <= REFERENCE_PROFILE.maxAttempts; attempt++) {
    context.signal.throwIfAborted();
    context.checkpoint({ stage: `${input.stage}:attempt`, itemId: attemptKey, disposition: 'done', raw: '', parsed: { attempt, status: 'inflight', sessionRestartCount } });
    const rendered = renderReferenceExecution(input.purpose, { ...input.variables, ...(lastError && input.stage === 'catalogue-analysis' ? { ValidationError: lastError } : {}) }, { child: input.child, retryInstruction });
    let raw = '';
    try {
      const output = await runWikiSession({ operation, signal: context.signal, ...rendered, usage: context.usage, requestModel, trace: { stage: input.stage, itemId: input.itemId, runId: operation.runId ?? '', attempt, round: input.executionRound ?? 1, sessionRestartCount }, event: context.event, manifest: context.checkpoints().find(c => c.stage === 'source' && c.disposition === 'done')?.parsed as Array<{ path: string; hash: string }>, priorWiki: input.priorWiki });
      raw = output.text;
      if (output.stopReason === 'error') { context.checkpoint({ stage: input.stage, itemId: input.itemId, disposition: 'failed', raw, parsed: null, attempt, error: 'MODEL_ERROR' }); context.checkpoint({ stage: `${input.stage}:attempt`, itemId: attemptKey, disposition: 'done', raw: '', parsed: { attempt, status: 'failed', sessionRestartCount } }); return undefined; }
      const parsed: ReferenceResult<T> = (input.stage === 'plan' || input.stage.startsWith('catalogue')) && output.stopReason === 'length' ? { ok: false, error: 'model_output_' + output.stopReason } : input.evaluate(raw, attempt === REFERENCE_PROFILE.maxAttempts);
      if (parsed.ok) { context.checkpoint({ stage: input.stage, itemId: input.itemId, disposition: 'done', raw, parsed: parsed.value, attempt }); context.checkpoint({ stage: `${input.stage}:attempt`, itemId: attemptKey, disposition: 'done', raw: '', parsed: { attempt, status: 'done', sessionRestartCount } }); return parsed.value; }
      lastError = parsed.error;
      if (input.stage.startsWith('catalogue') && input.stage !== 'catalogue-analysis') retryInstruction = referenceCatalogueRetryInstruction(raw, lastError, repairCandidate(lastError));
    } catch (error) {
      if (error instanceof Error && error.message === 'SPENDING_LIMIT') context.checkpoint({ stage: `${input.stage}:attempt`, itemId: attemptKey, disposition: 'done', raw: '', parsed: { attempt: attempt - 1, status: 'failed', sessionRestartCount } });
      context.signal.throwIfAborted();
      if (!(error instanceof Error && 'retryable' in error && error.retryable === true)) { context.checkpoint({ stage: `${input.stage}:attempt`, itemId: attemptKey, disposition: 'done', raw: '', parsed: { attempt, status: 'failed', sessionRestartCount } }); throw error; }
      lastError = error.message;
    } finally {
      context.event({ kind: 'session-finish', stage: input.stage, itemId: input.itemId, runId: operation.runId ?? '', attempt, round: input.executionRound ?? 1, sessionRestartCount });
    }
    context.checkpoint({ stage: input.stage, itemId: input.itemId, disposition: 'failed', raw, parsed: null, attempt, error: lastError });
    context.checkpoint({ stage: `${input.stage}:attempt`, itemId: attemptKey, disposition: 'done', raw: '', parsed: { attempt, status: 'failed', sessionRestartCount } });
    context.signal.throwIfAborted();
    if (attempt < REFERENCE_PROFILE.maxAttempts) await new Promise<void>((resolve, reject) => { const onAbort = () => { clearTimeout(timer); reject(context.signal.reason); }; const timer = setTimeout(() => { context.signal.removeEventListener('abort', onAbort); resolve(); }, delays[input.stage] ?? 0); context.signal.addEventListener('abort', onAbort, { once: true }); });
  }
  return undefined;
}
export function sectionsFromTree(nodes: Node[]): Section[] {
  const result: Section[] = [];
  function visit(items: Node[], parentId: string) { items.forEach((n, ordinal) => { result.push({ id: n.id, parentId, ordinal, sectionName: n.name, title: n.title, prompt: n.prompt, dependentFiles: n.dependent_file, meta: { has_children: n.has_children, children_plan: n.children_plan, ...(n.template ? { template: n.template } : {}) } }); visit(n.children, n.id); }); }
  visit(nodes, ''); return result;
}
function assign(nodes: ReferenceCatalogueNode[]): Node[] { return nodes.map(n => ({ ...n, id: randomUUID(), children: assign(n.children) })); }
function authorNodes(pages: AuthorPage[]): Node[] { return pages.map(p => ({ id: p.id, name: p.title, title: p.title, prompt: p.prompt, dependent_file: [], has_children: p.children.length ? 'yes' : 'no', children_plan: '', children: authorNodes(p.children), template: p.template })); }
export async function runFull(operation: WikiOperation, context: WikiRunContext, requestModel: WikiRequestModel): Promise<void> {
  const prior = pinPriorPublication(operation, context);
  const author = normalizeAuthorConfig(operation.author), repo = await freezeRepository(operation, context);
  await assertCleanTarget(operation.repositoryRoot, operation.targetCommit, new Set(repo.manifest.map(file => file.path)));
  const checkpoint = (stage: string, itemId = '') => context.checkpoints().find(c => c.stage === stage && c.itemId === itemId && c.disposition === 'done');
  if (!checkpoint('readme')) context.checkpoint({ stage: 'readme', itemId: '', disposition: 'done', raw: repo.readme, parsed: { present: repo.readmePresent } });
  const notes = [...author.notes, ...author.constraints.map(Text => ({ Text }))];
  const variables = { RepositoryName: repo.repositoryName, PreferredLanguage: operation.locale, CodeFiles: repo.tree, Catalogue: repo.tree, ValidFileCount: referenceValidFileCount(repo.tree), ReadmeContent: referenceReadme(repo.readme), AuthorNotes: notes };
  let tree: Node[]; let requiredStages: string[];
  if (author.mode === 'pages') {
    tree = authorNodes(author.pages); requiredStages = ['readme', 'catalogue'];
    if (!checkpoint('catalogue')) context.checkpoint({ stage: 'catalogue', itemId: '', disposition: 'done', raw: '', parsed: { tree, expanded: [], seq: 1 } });
  } else {
    context.stage('overview');
    let overview = checkpoint('overview')?.parsed as string | undefined;
    if (!overview) overview = await executeItem(operation, context, requestModel, { stage: 'overview', itemId: '', purpose: 'wiki.full.overview', variables, evaluate: parseReferenceOverview });
    if (!overview) throw new Error(stageFailureCode(context, 'overview', '', 'OVERVIEW_FAILED'));
    context.stage('plan');
    let plan = checkpoint('plan')?.parsed as string | undefined;
    if (plan === undefined) plan = await executeItem(operation, context, requestModel, { stage: 'plan', itemId: '', purpose: 'wiki.full.catalogue-plan', variables: { ...variables, OverviewContent: overview }, evaluate: parseReferencePlan });
    if (plan === undefined) throw new Error(stageFailureCode(context, 'plan', '', 'PLAN_FAILED'));
    const catalogueVars = { ...variables, Think: plan, OverviewContent: overview };
    context.stage('catalogue');
    let state = checkpoint('catalogue')?.parsed as { tree: Node[]; expanded: string[]; seq: number } | undefined;
    if (!state) {
      const result = checkpoint('catalogue-root')?.parsed as { items: ReferenceCatalogueNode[]; rawJson: string } | undefined ?? await executeItem(operation, context, requestModel, { stage: 'catalogue-root', itemId: '', purpose: 'wiki.full.catalogue', variables: catalogueVars, evaluate: parseReferenceCatalogue });
      if (!result || !result.items.length) throw new Error(stageFailureCode(context, 'catalogue-root', '', 'CATALOGUE_FAILED'));
      state = { tree: assign(result.items), expanded: [], seq: 1 };
      context.checkpoint({ stage: 'catalogue', itemId: '', disposition: 'done', raw: '', parsed: state });
    }
    const active = state;
    for (;;) {
      const candidates: Array<{ node: Node; depth: number; path: string }> = [];
      const walk = (nodes: Node[], depth: number, prefix: string) => nodes.forEach(node => { const path = prefix ? `${prefix}/${node.name}` : node.name; if (node.has_children.toLowerCase() === 'yes' && depth + 1 < REFERENCE_PROFILE.maxDepth && !active.expanded.includes(node.id)) candidates.push({ node, depth, path }); walk(node.children, depth + 1, path); });
      walk(active.tree, 0, ''); if (!candidates.length) break;
      const min = Math.min(...candidates.map(c => c.depth));
      await pool(candidates.filter(c => c.depth === min), REFERENCE_PROFILE.releaseConcurrency.catalogue, async c => {
        const result = checkpoint('catalogue-child', c.node.id)?.parsed as { items: ReferenceCatalogueNode[]; rawJson: string } | undefined ?? await executeItem(operation, context, requestModel, { stage: 'catalogue-child', itemId: c.node.id, purpose: 'wiki.full.catalogue', variables: { ...catalogueVars, ...catalogueChildVariables(c.node as unknown as Record<string, unknown> & { children: unknown[] }, c.path, c.depth) }, child: true, evaluate: parseReferenceCatalogue });
        if (!result) throw new Error(stageFailureCode(context, 'catalogue-child', c.node.id, 'CATALOGUE_CHILD_FAILED'));
        c.node.children = assign(result.items); active.expanded.push(c.node.id); active.seq++;
        context.checkpoint({ stage: 'catalogue', itemId: '', disposition: 'done', raw: '', parsed: active });
      });
    }
    tree = active.tree; requiredStages = ['readme', 'overview', 'plan', 'catalogue'];
  }
  const sections = sectionsFromTree(tree), byId = new Map(sections.map(s => [s.id, s]));
  const done = new Set(context.checkpoints().filter(c => c.stage === 'page' && c.disposition === 'done').map(c => c.itemId));
  context.stage('page', { total: sections.length });
  const outcome = await runPagePool(sections.map(s => s.id), done, REFERENCE_PROFILE.releaseConcurrency.page, async (id, round) => {
    const s = byId.get(id)!;
    try {
      const content = await executeItem(operation, context, requestModel, { stage: 'page', itemId: id, executionRound: round, purpose: 'wiki.full.page', variables: { ...variables, Prompt: s.prompt, Title: s.sectionName, Branch: 'main', Catalogue: repo.tree, CodingIntent: '', AuthorTemplate: s.meta.template ?? '' }, evaluate: (raw, final) => { const parsed = parseReferencePage(raw, s.sectionName, final); return parsed.ok ? { ok: true, value: { markdown: parsed.value } } : parsed; } });
      return content !== undefined;
    } catch (error) {
      throwIfGlobalFailure(error, context.signal);
      context.checkpoint({ stage: 'page', itemId: id, disposition: 'failed', raw: '', parsed: null, error: 'PAGE_EXECUTION_FAILED' });
      return false;
    }
  });
  await freezeRepository(operation, context);
  await assertCleanTarget(operation.repositoryRoot, operation.targetCommit, new Set(repo.manifest.map(file => file.path)));
  context.publish({ catalogue: sections.map(s => ({ ...s })), requiredStages, pages: sections.map(s => ({ id: s.id, disposition: outcome.failed.includes(s.id) ? 'failed' : 'done' })), deletedPageIds: [], baseline: operation.targetCommit, mode: 'full', expectedPriorPublicationId: prior.expectedId });
}


