import type { GrenRuntimeBridge } from '../../../../vendor/repo-wiki/packages/renderer/src/index';
import type { ProgressEvent, Project, Run, WikiPage } from '../../../../vendor/repo-wiki/packages/contracts/src/index';
import type { RepoWikiKnowledgeSnapshot } from '../../../../shared/knowledgeKernelContracts';

export const fixtureWorkspace = 'D:\\Projects\\Forest';
export const nextFixtureWorkspace = 'D:\\Projects\\Next';
export const scratchFixtureWorkspace = 'D:\\Pi\\works\\conversation-draft';
let fixtureSerial = 0;
const timestamp = '2026-10-31T10:00:00.000Z';

/** Deterministic main I/O only. All navigation, editing and subscription logic stays in the real UI/client. */
export function createRepoWikiRuntimeFixture(onCall: (command: string) => void = () => {}) {
  const fixtureKey = ++fixtureSerial;
  const overview: WikiPage = {
    id: 'overview', title: '项目概览', markdown: '# 项目概览\n\n真实阅读正文。\n\n## 数据流\n\n[源码依据](source:src/index.ts#L1-L3)',
    baseline: '# 项目概览', pending_markdown: null, status: 'ready', revision: 1, storage_token: 'a'.repeat(64),
    sources: [{ path: 'src/index.ts', start_line: 1, end_line: 3, hash: 'source-v1' }], dependencies: [],
    updated_at: timestamp,
  };
  const card: WikiPage = {
    ...overview, id: 'cards/boundary', title: '进程边界', kind: 'card', category: '架构', summary: '独立进程的职责',
    markdown: '# 进程边界\n\n卡片正文与 Wiki 分开保存。',
  };
  const project: Project = {
    plan_storage_token: 'b'.repeat(64), id: 'forest', name: 'Forest', path: fixtureWorkspace, language: 'zh', watch: false,
    pages: [overview], cards: [card], page_count: 1, card_count: 1,
    identity: { branch: 'main', language: 'zh', commit: '123456789abcdef' },
    plan: { pages: [{ id: 'overview', title: '项目概览', patterns: ['src/**'] }] },
    knowledge: {
      wiki: { count: 1, identity: {}, last_run: null, updated_at: timestamp, namespace: 'wiki', status: 'ready' },
      cards: { count: 1, identity: {}, last_run: null, updated_at: timestamp, namespace: 'cards', status: 'ready' },
    },
  };
  const enableLinkFixture = () => {
    const sibling: WikiPage = {
      ...overview, id: 'chapters/sibling', title: '同层目标',
      markdown: '# 同层目标\n\n同层页面已打开。', sources: [],
    };
    const guide: WikiPage = {
      ...overview, id: 'guide-name', title: '使用指南',
      markdown: '# 使用指南\n\n[再次定位](#detail)\n\n' + Array.from({ length: 8 }, (_, i) => `前置说明 ${i + 1}。`).join('\n\n') + '\n\n## Detail\n\n跨页 hash 已到位。',
      sources: [],
    };
    project.pages = [
      { ...overview, markdown: `${overview.markdown}\n\n[链接检查](chapters/start.md)` },
      { ...overview, id: 'chapters/start', title: '章节起点', markdown: '[同层页面](./sibling.md)\n\n[跨级并定位](../guide%2Dname.md?view=reader#detail)\n\n[源码例子](source:src/index.ts#L1-L3)\n\n\`[不是链接](./missing.md)\`\n\n\`\`\`md\n[仍不是链接](./missing.md)\n\`\`\`', sources: [] },
      sibling,
      guide,
    ];
    project.page_count = project.pages.length;
  };
  // There is deliberately no preloaded Wiki registry: main imports opened roots.
  const openedRoots = new Set([fixtureWorkspace, nextFixtureWorkspace]);
  const wikiProjects = new Map<string, Project>();
  const variants = new Map<string, Project>();
  const hiddenProjectIds = new Set<string>();
  const allProjects = () => [...wikiProjects.values(), ...variants.values()].filter((item) => openedRoots.has(item.path));
  let projectRevision = 1;
  let snapshotState: 'pending' | 'ready' = 'ready';
  const hostSnapshot = () => ({ revision: projectRevision, state: snapshotState, projects: [...openedRoots].map((path) => ({ key: path, path, name: path.split(/[\\/]/).at(-1)! })) });
  const hydrate = (root: string, language: string) => {
    const existing = allProjects().find((item) => item.path === root && item.language === language);
    if (existing) return existing;
    const item = clone(project);
    const name = root.split(/[\\/]/).at(-1)!;
    const baseId = root === fixtureWorkspace ? 'forest' : root === nextFixtureWorkspace ? 'next' : name.toLowerCase();
    Object.assign(item, { id: language === 'zh' ? baseId : `${baseId}-${language}`, name, path: root, language, identity: { ...(item.identity as Record<string, unknown>), language } });
    if (language === 'zh') wikiProjects.set(root, item); else variants.set(item.id, item);
    return item;
  };
  const listeners = new Set<(event: ProgressEvent & { context_id: string }) => void>();
  const workspaceListeners = new Set<(event: { context_id: string; projects: ReturnType<typeof hostSnapshot> }) => void>();
  let activeLanguage = 'zh';
  let activeViewId: string | undefined;
  let activeWorkspace: string | null | undefined;
  let contextId = '';
  let activeProjectId: string | null = null;
  let contextSerial = 0;
  let sequence = 0;
  let childInstance = 'fixture-child';

  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const holds = new Map<string, { block: Promise<void>; started: () => void }>();
  let run: Run = { status: 'idle', target: 'wiki' };
  let knowledge: RepoWikiKnowledgeSnapshot | null = null;
  const knowledgeResponses: RepoWikiKnowledgeSnapshot[] = [];
  const runs = new Map<string, Run>();
  const projectRuns = () => [...runs.entries()].filter(([, item]) => item.id).map(([projectId, item]) => {
    const owner = allProjects().find((project) => project.id === projectId);
    return { ref: { source: 'user' as const, id: `repo-${item.id}` }, key: `user:repo-${item.id}`, kind: 'repoWiki.generate', label: 'Repo Wiki 文档生成',
      status: item.status === 'canceled' ? 'cancelled' : item.status === 'idle' ? 'pending' : item.status === 'cancel_requested' ? 'running' : item.status,
      workspace: owner?.path || fixtureWorkspace, resource: { type: 'repoWiki', id: owner?.path || fixtureWorkspace, language: owner?.language || 'zh' }, resourceName: owner?.name || 'Forest',
      progress: item.progress, stage: '正在生成', message: item.message, currentPage: item.page_id || item.current_page || 'overview', cancellationRequested: item.status === 'cancel_requested',
      knowledge: deriveKnowledge(projectId, (item.target as 'wiki' | 'cards') || 'wiki'),
      createdAt: Date.parse(timestamp), updatedAt: Date.parse(timestamp), capabilities: { cancel: item.status === 'running', retry: ['failed', 'cancelled', 'canceled'].includes(item.status), remove: ['failed', 'completed', 'cancelled', 'canceled'].includes(item.status) } };
  });
  // Production hosts always answer `knowledge`; the fixture projects its run log the same way.
  const runRevisions = new Map<string, number>();
  let knowledgeRevision = 0;
  const kernelStates: Record<string, NonNullable<RepoWikiKnowledgeSnapshot['run']>['state']> = { queued: 'queued', running: 'running', cancel_requested: 'running', completed: 'completed', failed: 'failed', canceled: 'cancelled', cancelled: 'cancelled', interrupted: 'paused' };
  const plannedUnits = 20;
  const deriveKnowledge = (projectId: string, domain: 'wiki' | 'cards', item = runs.get(projectId)): RepoWikiKnowledgeSnapshot => {
    const owner = allProjects().find((entry) => entry.id === projectId) || project;
    const state = item?.id && (item.target || 'wiki') === domain ? kernelStates[item.status] : undefined;
    const prepared = state === 'completed' ? plannedUnits : Math.max(0, Math.min(plannedUnits, Math.round((item?.progress || 0) / (100 / plannedUnits))));
    return { version: 1, key: { workspaceInstanceId: 'fixture-instance', projectId: owner.id, portableProjectId: owner.id, branch: 'main', language: owner.language, domain },
      content: { state: 'available', publishedCount: (domain === 'wiki' ? owner.pages : owner.cards)?.length || 0, preparedCount: state ? prepared : 0, expectedCount: plannedUnits, updatedAt: Date.parse(timestamp) },
      run: state && item ? { taskId: item.id!, revision: runRevisions.get(item.id!) || 0, phase: 'generate', state, ...(item.page_id || item.current_page ? { currentItem: String(item.page_id || item.current_page) } : {}),
        counts: { planned: plannedUnits, prepared, failed: state === 'failed' ? 1 : 0, blocked: 0, published: state === 'completed' ? plannedUnits : 0 },
        capabilities: { pause: state === 'running' && item.status !== 'cancel_requested', resume: state === 'paused', cancel: ['running', 'queued', 'paused'].includes(state) && item.status !== 'cancel_requested', repair: state === 'failed' || state === 'cancelled', reanalyse: false },
        ...(state === 'failed' ? { error: { code: 'FIXTURE_FAILED', message: String(item.error || item.message || '生成失败'), retriable: true } } : {}) } : null,
      action: { state: 'idle' }, admission: { state: 'ready', modelIdentity: 'fixture/knowledge@digest', modelDisplayName: 'Fixture 知识模型', planToken: 'frozen-plan' } };
  };
  const currentKnowledge = (domain: 'wiki' | 'cards') => knowledge ?? deriveKnowledge(activeProjectId || project.id, domain);
  let subscribeCount = 0;
  let releaseCount = 0;
  let saveError = false;
  let activationFailed = false;
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const emit = (next: Run) => {
    run = clone(next);
    if (run.id) runRevisions.set(run.id, ++knowledgeRevision);
    runs.set(activeProjectId || project.id, clone(run));
    const snapshot = currentKnowledge((run.target as 'wiki' | 'cards') || 'wiki');
    for (const listener of listeners) listener({ project_id: activeProjectId || project.id, context_id: contextId, instance_id: childInstance, sequence: ++sequence, time: timestamp, run: knowledge ? { ...clone(run), id: knowledge.run?.taskId, status: knowledge.run?.state || 'idle', target: knowledge.key.domain } : clone(run), knowledge: clone(snapshot) } as ProgressEvent & { context_id: string });
  };
  /** Default server answer to a kernel action when no deterministic response was queued. */
  const applyAction = (action: string, domain: 'wiki' | 'cards') => {
    if (action === 'cancel') emit({ ...run, status: 'canceled', message: '已取消生成' });
    else if (action === 'pause') emit({ ...run, status: 'interrupted' });
    else if (action === 'resume') emit({ ...run, status: 'running' });
    else if (action === 'repair' || action === 'reanalyse') emit({ id: `${run.id}-repair`, target: domain, status: 'running', message: '正在修复失败项', current_page: run.current_page || run.page_id, progress: 10 });
    return currentKnowledge(domain);
  };
  const bridge: GrenRuntimeBridge = {
    async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ command, args: clone(args) });
      onCall(command);
      const held = holds.get(command);
      holds.delete(command);
      let result: unknown;
      if (command === 'open_workspace') return { sessionFile: null } as T;
      if (command.startsWith('agentData_')) {
        if (command === 'agentData_status') return { state: 'ready', version: 1 } as T;
        if (command === 'agentData_wiki_list' || command === 'agentData_code_projects') return [] as T;
        if (command === 'agentData_overview') return { recentPages: [], errors: [] } as T;
        if (command === 'agentData_tasks_list') return { items: projectRuns(), activeCount: projectRuns().filter((task) => task.status === 'running').length } as T;
        const task = projectRuns().find((task) => task.ref.id === args.id);
        if (command === 'agentData_tasks_read') return (task ? { ...task, inputSummary: { workspace: task.workspace, language: task.resource.language, target: [...runs.values()].find((item) => `repo-${item.id}` === task.ref.id)?.target || 'wiki' }, events: [] } : undefined) as T;
        if (command === 'agentData_tasks_previewRetry') return { ref: task?.ref, label: task?.label, resource: task?.resource, callsModel: true, model: 'fixture/knowledge' } as T;
        if (command === 'agentData_tasks_retry') {
          if (args.expectedModel !== 'fixture/knowledge') throw new Error('模型配置已变化');
          emit({ id: 'retried-run', target: 'wiki', status: 'running', message: '正在重试生成', progress: 30 }); return projectRuns().find((task) => task.ref.id === 'repo-retried-run') as T;
        }
        if (command === 'agentData_admin_jobs_cancel') { emit({ ...run, status: 'canceled', message: '已取消生成' }); return task as T; }
        throw new Error(`Unstubbed AgentData I/O: ${command}`);
      }
      if (command === 'repoWiki_release') {
        held?.started(); if (held) await held.block;
        const released = args.__repoWikiContext === contextId;
        if (released) { activeWorkspace = undefined; activeViewId = undefined; contextId = ''; activeProjectId = null; }
        return { released } as T;
      }
      if (command === 'repoWiki_hostProjects') {
        const result = clone(hostSnapshot()); held?.started(); if (held) await held.block;
        return result as T;
      }
      if (command === 'repoWiki_activate') {
        if (activationFailed && args.retry !== true) throw new Error('Repo Wiki 子进程恢复次数已耗尽');
        if (activationFailed && args.retry === true) { activationFailed = false; contextId = `fixture-context-${fixtureKey}-${++contextSerial}`; }
        const workspace = args.workspace as string | null;
        const selected = typeof args.project_id === 'string' ? allProjects().find((item) => item.id === args.project_id && item.path === workspace) : undefined;
        const language = typeof args.language === 'string' ? args.language : selected?.language || (workspace === activeWorkspace ? activeLanguage : 'zh');
        if (workspace !== activeWorkspace || language !== activeLanguage || args.view_id !== activeViewId) { activeWorkspace = workspace; activeLanguage = language; activeViewId = args.view_id as string | undefined; activeProjectId = null; contextId = `fixture-context-${fixtureKey}-${++contextSerial}`; sequence = 0; }
        const result = clone({ workspace, language, project_id: activeProjectId, status: !workspace || workspace === scratchFixtureWorkspace ? 'empty' : openedRoots.has(workspace) ? 'bound' : 'pending', context_id: contextId, projects_revision: projectRevision });
        held?.started(); if (held) await held.block;
        return result as T;
      }
      if (args.__repoWikiContext !== contextId) throw new Error('Stale Repo Wiki context');
      if (args.project_id && args.project_id !== activeProjectId) throw new Error('Forbidden Wiki project context');
      const selectedProject = allProjects().find((item) => item.id === args.project_id) || project;
      switch (command) {
        case 'repoWiki_knowledge': result = currentKnowledge(args.target === 'cards' ? 'cards' : 'wiki'); break;
        case 'repoWiki_drafts': result = { taskId: knowledge?.run?.taskId, items: [
          { id: 'generate:chapters/start', title: '架构草稿', markdown: '# 架构草稿\n\n这是尚未发布的阶段成果。\n\n[同层草稿](./sibling.md)\n\n[跨页草稿](../guide%2Dname.md?view=reader#detail)\n\n[正式概览](../overview.md)', sources: [] },
          { id: 'generate:chapters/sibling', title: '同层草稿', markdown: '# 同层草稿\n\n同层草稿已打开。', sources: [] },
          { id: 'generate:guide-name', title: '指南草稿', markdown: '# 指南草稿\n\n前置说明。\n\n## Detail\n\n草稿 hash 已定位。', sources: [] },
        ] }; break;
        case 'repoWiki_action': {
          const next = knowledgeResponses.shift();
          if (next) { knowledge = clone(next); result = next; break; }
          if (knowledge) throw new Error('No deterministic knowledge action response');
          result = applyAction(args.action as string, run.target === 'cards' ? 'cards' : 'wiki'); break;
        }
        case 'repoWiki_health': result = { status: 'ok', version: '3', backend: 'node', provider: { configured: true }, local_only: true }; break;
        case 'repoWiki_hydrate': {
          if (!activeWorkspace || !openedRoots.has(activeWorkspace)) throw new Error('Forbidden Wiki path');
          const item = hydrate(activeWorkspace, activeLanguage); activeProjectId = item.id;
          run = clone(runs.get(item.id) || { status: 'idle', target: 'wiki' });
          result = { context_id: contextId, project: item }; break;
        }
        case 'repoWiki_projects': result = allProjects().filter((item) => !hiddenProjectIds.has(item.id)); break;
        case 'repoWiki_project': result = selectedProject; break;
        case 'repoWiki_changes': result = {}; break;
        case 'repoWiki_run': result = run; break;
        case 'repoWiki_create': {
          if (args.path !== activeWorkspace) throw new Error('Forbidden Wiki path');
          let variant = allProjects().find((item) => item.path === args.path && item.language === args.language);
          if (!variant) { const base = wikiProjects.get(args.path as string) || project; variant = clone(base); Object.assign(variant, { id: `${base.id}-${args.language}`, language: args.language, identity: { ...(variant.identity as Record<string, unknown>), language: args.language } }); variants.set(variant.id, variant); }
          if (activeProjectId !== variant.id) { contextId = `fixture-context-${fixtureKey}-${++contextSerial}`; sequence = 0; run = { status: 'idle', target: 'wiki' }; }
          activeProjectId = variant.id;
          result = variant;
          for (const listener of workspaceListeners) listener({ context_id: contextId, projects: hostSnapshot() });
          break;
        }
        case 'repoWiki_page': result = [...(selectedProject.pages || []), ...(selectedProject.cards || [])].find((page) => page.id === args.slug); break;
        case 'repoWiki_edit':
        case 'repoWiki_resolve': {
          if (saveError) throw new Error('保存失败，请重试');
          const page = [...(selectedProject.pages || []), ...(selectedProject.cards || [])].find((page) => page.id === args.slug)!;
          if (args.expected_storage_token !== page.storage_token) throw new Error('文档已在外部修改，请保留草稿后重新读取');
          Object.assign(page, { markdown: args.markdown, status: 'edited', revision: page.revision + 1, storage_token: 'c'.repeat(64) });
          result = page;
          break;
        }
        case 'repoWiki_source': result = { path: args.path, content: 'export const forest = true;\n// source\n', start_line: 1, end_line: 3, total_lines: 3, hash: 'source-v1' }; break;
        case 'repoWiki_generate':
          if (knowledgeResponses.length) knowledge = clone(knowledgeResponses.shift()!);
          emit({ id: 'run-1', status: 'running', target: args.target as 'wiki' | 'cards', provider: args.provider as string, progress: 20, cancelable: true, message: '正在生成正文' });
          result = knowledge?.run ? { run_id: knowledge.run.taskId, task_id: knowledge.run.taskId, status: knowledge.run.state, target: knowledge.key.domain } : { run_id: 'run-1', task_id: 'repo-run-1', status: 'running', target: args.target };
          break;
        case 'repoWiki_cancel': result = { run_id: run.id, status: 'cancel_requested' }; break;
        case 'repoWiki_watch': project.watch = args.enabled as boolean; result = project; break;
        case 'repoWiki_plan':
          if (args.expected_plan_storage_token !== selectedProject.plan_storage_token) throw new Error('计划已在外部修改，请保留草稿后重新读取');
          selectedProject.plan = args.plan; selectedProject.plan_storage_token = 'e'.repeat(64); result = selectedProject; break;
        case 'repoWiki_export': result = { 'overview.md': overview.markdown }; break;
        default: throw new Error(`Unstubbed main I/O: ${command}`);
      }
      const response = clone(result);
      held?.started();
      if (held) await held.block;
      return response as T;
    },
    async subscribe<T>(event: string, handler: (event: { payload: T }) => void) {
      if (event === 'repoWiki://workspaces') {
        const listener = (payload: { context_id: string; projects: ReturnType<typeof hostSnapshot> }) => handler({ payload: payload as T });
        workspaceListeners.add(listener);
        return () => { workspaceListeners.delete(listener); };
      }
      if (event !== 'repoWiki://progress') throw new Error(`Unstubbed subscription: ${event}`);
      subscribeCount++;
      const listener = (payload: ProgressEvent) => handler({ payload: payload as T });
      listeners.add(listener);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseCount++;
        listeners.delete(listener);
      };
    },
  };
  return {
    bridge, calls, emit,
    enableLinkFixture,
    setKnowledge: (next: RepoWikiKnowledgeSnapshot | null) => { knowledge = clone(next); },
    /** The snapshot the host would project for `item`, without changing the fixture's server state. */
    knowledgeFor: (item: Run) => deriveKnowledge(activeProjectId || project.id, (item.target as 'wiki' | 'cards') || 'wiki', clone(item)),
    queueKnowledgeResponse: (next: RepoWikiKnowledgeSnapshot) => knowledgeResponses.push(clone(next)),
    emitKnowledge: (next: RepoWikiKnowledgeSnapshot) => { knowledge = clone(next); for (const listener of listeners) listener({ project_id: activeProjectId || project.id, context_id: contextId, instance_id: childInstance, sequence: ++sequence, time: timestamp, run: { id: next.run?.taskId, status: next.run?.state || 'idle', target: next.key.domain }, knowledge: clone(next) } as ProgressEvent & { context_id: string }); },
    holdNext: (command: string) => {
      let release!: () => void, notifyStarted!: () => void;
      const block = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
      holds.set(command, { block, started: notifyStarted });
      return { release, started };
    },
    restartChild: () => {
      const previous = contextId;
      contextId = `fixture-context-${fixtureKey}-${++contextSerial}`;
      childInstance = `fixture-child-${contextSerial}`;
      sequence = 0;
      for (const listener of workspaceListeners) listener({ context_id: contextId, projects: hostSnapshot() });
      return previous;
    },
    hideProjectsFromList: (ids: string[]) => { hiddenProjectIds.clear(); ids.forEach((id) => hiddenProjectIds.add(id)); },
    setHostSnapshotState: (state: 'pending' | 'ready') => { snapshotState = state; },
    setOpenedRoots: (roots: string[]) => { ++projectRevision; openedRoots.clear(); roots.forEach((root) => openedRoots.add(root)); for (const listener of workspaceListeners) listener({ context_id: contextId, projects: hostSnapshot() }); },
    emitRaw: (event: Partial<ProgressEvent> & { context_id?: string; knowledge?: RepoWikiKnowledgeSnapshot }) => { for (const listener of listeners) listener({ project_id: project.id, context_id: contextId, time: timestamp, run: clone(run), ...event } as ProgressEvent & { context_id: string }); },
    externalPageEdit: () => { for (const item of allProjects()) for (const page of item.pages || []) page.storage_token = 'd'.repeat(64); },
    externalPlanEdit: () => { for (const item of allProjects()) item.plan_storage_token = 'f'.repeat(64); },
    setActivationFailure: (failed: boolean) => { activationFailed = failed; },
    setSaveError: (value: boolean) => { saveError = value; },
    snapshot: () => ({ listeners: listeners.size, workspaceListeners: workspaceListeners.size, openedRoots: [...openedRoots], wikiProjects: allProjects().map((item) => item.id), activeProjectId, contextId, childInstance, subscribeCount, releaseCount, overview: clone(wikiProjects.get(fixtureWorkspace)?.pages?.[0] || overview), run: clone(run), calls: clone(calls) }),
  };
}
