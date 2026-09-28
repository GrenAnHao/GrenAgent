import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { agentDataApi, type AgentJob, type TaskRef, type TaskView } from '../../lib/agentData';
import type { AgentDataTab } from './agentDataViewTypes';

interface AgentDataTaskMonitor {
  jobs: AgentJob[];
  tasks: TaskView[];
  nextCursor?: string;
  loadingMore: boolean;
  loadMore(): Promise<void>;
  error?: string;
  loading: boolean;
  loaded: boolean;
  refresh(): Promise<void>;
  track(ref: string | TaskRef): void;
  watchedTaskVersion: number;
  /** 服务端活动任务计数（含系统任务）；未获取时为 undefined。 */
  activeCount?: number;
}

interface MonitorRuntime {
  visible: boolean;
  view: AgentDataTab;
  focused: boolean;
  mounted: boolean;
  awake: boolean;
  generation: number;
  tasks: TaskView[];
  pages: number;
  activeCount?: number;
  nextCursor?: string;
  moreRequested: boolean;
  tracked: Map<string, { ref: TaskRef; view: AgentDataTab }>;
  settled: Set<string>;
  refreshAgain: boolean;
  inFlight?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

const Context = createContext<AgentDataTaskMonitor | undefined>(undefined);
const isActive = (task: TaskView) => ['pending', 'queued', 'running', 'blocked'].includes(task.status);
const taskKey = (ref: TaskRef) => `${ref.source}:${ref.id}`;
const canFetch = (state: MonitorRuntime) => state.mounted && state.visible && state.focused && !document.hidden;
const shouldPoll = (state: MonitorRuntime) => state.view === 'overview' || state.view === 'jobs'
  ? (state.activeCount === undefined ? state.tasks.some(isActive) : state.activeCount > 0) || state.tracked.size > 0
  : [...state.tracked.values()].some((tracked) => tracked.view === state.view);
function clearTimer(state: MonitorRuntime) {
  clearTimeout(state.timer);
  state.timer = undefined;
}

export function AgentDataTaskProvider({ visible, activeView, children }: { visible: boolean; activeView: AgentDataTab; children: ReactNode }) {
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [watchedTaskVersion, setWatchedTaskVersion] = useState(0);
  const [serverActiveCount, setServerActiveCount] = useState<number>();
  const runtime = useRef<MonitorRuntime>({
    visible, view: activeView, focused: false, mounted: false, awake: false, generation: 0,
    tasks: [], pages: 1, moreRequested: false, tracked: new Map(), settled: new Set(), refreshAgain: false,
  });

  const refresh = useCallback(async function refreshJobs(): Promise<void> {
    const state = runtime.current;
    state.refreshAgain = true;
    clearTimer(state);
    if (!canFetch(state)) return;
    if (state.inFlight) return state.inFlight;

    state.inFlight = (async () => {
      do {
        state.refreshAgain = false;
        const generation = state.generation;
        const isCurrent = () => state.mounted && generation === state.generation;
        // Snapshot before list(): a task created in flight belongs to the queued refresh.
        const trackedRefs = [...state.tracked.values()].map((tracked) => tracked.ref);
        const extend = state.moreRequested;
        state.moreRequested = false;
        const pageCount = state.pages + (extend ? 1 : 0);
        setLoading(true);
        setLoadingMore(extend);
        try {
          const nextTasks: TaskView[] = [];
          let cursor: string | undefined;
          let activeCount: number | undefined;
          let fetched = 0;
          do {
            if (!canFetch(state) || !isCurrent()) break;
            const page = await agentDataApi.tasks.list({ limit: 100, ...(cursor ? { cursor } : {}) });
            if (!isCurrent()) break;
            nextTasks.push(...page.items);
            activeCount = page.activeCount;
            cursor = page.nextCursor;
            fetched++;
          } while (cursor && fetched < pageCount);
          if (!isCurrent()) continue;
          const missing = new Set<string>();
          for (const ref of trackedRefs) {
            const key = taskKey(ref);
            if (nextTasks.some((task) => task.key === key)) continue;
            if (!canFetch(state) || !isCurrent()) break;
            const found = await agentDataApi.tasks.read(ref);
            if (!isCurrent()) break;
            if (found) nextTasks.push(found);
            else missing.add(key);
          }
          if (!isCurrent() || !canFetch(state)) continue;

          let finished = 0;
          for (const ref of trackedRefs) {
            const id = taskKey(ref);
            const observed = nextTasks.find((task) => task.key === id);
            if (!missing.has(id) && (!observed || isActive(observed))) continue;
            state.tracked.delete(id);
            if (!state.settled.has(id)) {
              state.settled.add(id);
              finished++;
            }
          }
          const unique = [...new Map(nextTasks.map((task) => [task.key, task])).values()];
          const previouslyActive = new Set(state.tasks.filter(isActive).map((task) => taskKey(task.ref)));
          for (const task of unique) {
            const key = taskKey(task.ref);
            if (isActive(task) || !previouslyActive.has(key) || state.settled.has(key)) continue;
            state.settled.add(key);
            finished++;
          }
          if (!finished && state.activeCount !== undefined && activeCount !== undefined
            && Number.isSafeInteger(state.activeCount) && Number.isSafeInteger(activeCount)
            && activeCount >= 0 && activeCount < state.activeCount) finished++;
          const nextJobs = unique.filter((task) => task.ref.source === 'user').map(projectJob);
          state.tasks = unique;
          state.activeCount = activeCount;
          state.pages = Math.max(1, fetched);
          state.nextCursor = cursor;
          setTasks(unique); setNextCursor(cursor);
          setServerActiveCount(activeCount !== undefined && Number.isSafeInteger(activeCount) && activeCount >= 0 ? activeCount : undefined);
          setJobs(nextJobs);
          setLoaded(true);
          setError(undefined);
          if (finished) setWatchedTaskVersion((version) => version + finished);
        } catch (cause) {
          if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          if (isCurrent()) { setLoading(false); setLoadingMore(false); }
        }
      } while (state.refreshAgain && canFetch(state));
    })();
    await state.inFlight;
    state.inFlight = undefined;
    if (!canFetch(state)) return;
    if (state.refreshAgain) await refreshJobs();
    else if (shouldPoll(state)) state.timer = setTimeout(() => { void refreshJobs(); }, 2000);
  }, []);

  const updateGate = useCallback(() => {
    const state = runtime.current;
    const awake = canFetch(state);
    if (awake === state.awake) return;
    state.awake = awake;
    if (awake) void refresh();
    else { state.generation++; clearTimer(state); }
  }, [refresh]);

  useEffect(() => {
    const state = runtime.current;
    state.mounted = true;
    state.generation++;
    state.focused = document.hasFocus();
    const onFocus = () => { state.focused = true; updateGate(); };
    const onBlur = () => { state.focused = false; updateGate(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', updateGate);
    updateGate();
    return () => {
      state.mounted = false;
      state.awake = false;
      state.generation++;
      clearTimer(state);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', updateGate);
    };
  }, [updateGate]);

  useEffect(() => {
    const state = runtime.current;
    const viewChanged = state.view !== activeView;
    const wasAwake = state.awake;
    state.visible = visible;
    state.view = activeView;
    updateGate();
    if (wasAwake && state.awake && viewChanged) {
      clearTimer(state);
      if (shouldPoll(state)) void refresh();
    }
  }, [visible, activeView, refresh, updateGate]);

  // Capture the initiating view even if an asynchronous create finishes in another view.
  const track = useCallback((input: string | TaskRef) => {
    const state = runtime.current;
    const ref: TaskRef = typeof input === 'string' ? { source: 'user', id: input } : input;
    const id = taskKey(ref);
    if (!state.settled.has(id)) state.tracked.set(id, { ref, view: activeView });
    void refresh();
  }, [activeView, refresh]);

  const loadMore = useCallback(async () => {
    const state = runtime.current;
    if (!canFetch(state) || state.inFlight || !state.nextCursor) return;
    state.moreRequested = true;
    await refresh();
  }, [refresh]);

  return <Context.Provider value={{ jobs, tasks, nextCursor, loadingMore, loadMore, error, loading, loaded, refresh, track, watchedTaskVersion, activeCount: serverActiveCount }}>{children}</Context.Provider>;
}

function projectJob(task: TaskView): AgentJob {
  const state: AgentJob['state'] = task.status === 'queued' ? 'pending' : task.status === 'blocked' ? 'running' : task.status;
  return { id: task.ref.id, kind: task.kind, workspace: task.workspace ?? '', state, progress: task.progress ?? 0,
    createdAt: task.createdAt, updatedAt: task.updatedAt, ...(task.error ? { error: task.error } : {}),
    ...(task.resource || task.cancellationRequested || task.stage || task.retryOf ? { metadata: {
      ...(task.resource ? { target: task.resource } : {}), ...(task.cancellationRequested ? { cancellationRequested: true } : {}),
      ...(task.stage ? { stage: task.stage } : {}), ...(task.retryOf ? { retryOf: task.retryOf } : {}),
    } } : {}),
  };
}

export function useAgentDataTaskMonitor(): AgentDataTaskMonitor {
  const monitor = useContext(Context);
  if (!monitor) throw new Error('useAgentDataTaskMonitor requires AgentDataTaskProvider');
  return monitor;
}
