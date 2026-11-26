import { useCallback, useEffect, useRef, useState } from 'react';
import { agentDataApi, type CodeGraphStatus } from '../../lib/agentData';
import { pathKey, pathsEquivalent } from '../../lib/pathUtils';
import { codeRequestError } from './CodeRelations';
import { codeIndexPresentation, codeIndexSyncActive, codeIndexWatcherPending } from './codeIndexPresentation';
import type { ProjectOption } from './useProjectOptions';

export interface IndexEntry {
  status?: CodeGraphStatus;
  error?: string;
  requested?: boolean;
  lastCheckedAt?: number;
  /** Keep a running card in the status filter from which the user started it. */
  syncFrom?: string;
}
type Entries = Record<string, IndexEntry>;
type Notice = (kind: 'success' | 'error' | 'info', text: string) => void;
const activeTask = (state?: string) =>
  state === 'pending' || state === 'running' || state === 'blocked' || state === 'paused';
export function isIndexBusy(entry?: IndexEntry) {
  return Boolean(
    entry?.requested ||
      activeTask(entry?.status?.manualTask?.state) ||
      entry?.status?.state === 'indexing' ||
      ['queued', 'syncing', 'rebuilding'].includes(entry?.status?.phase ?? ''),
  );
}
export function directoryView(entry?: IndexEntry) {
  const view = codeIndexPresentation({ status: entry?.status, error: entry?.error, checking: false });
  if (!entry?.error && isIndexBusy(entry)) return { ...view, label: '同步中', color: 'processing' as const };
  const task = entry?.status?.manualTask;
  if (
    !entry?.error &&
    !view.banner &&
    task?.state === 'failed' &&
    task.updatedAt > Math.max(lastSync(entry?.status) ?? 0, entry?.status?.lastSuccessAt ?? 0)
  ) {
    return {
      ...view,
      label: '索引失败',
      color: 'error' as const,
      banner: { type: 'error' as const, message: task.error || '上次同步失败，请重新同步。', sync: true },
    };
  }
  return view;
}
export function lastSync(status?: CodeGraphStatus) {
  // An explicit null means there is no verified completed build. Older status
  // providers can still supply the SDK's persisted per-file timestamp.
  if (!status?.indexed) return undefined;
  const partial = status.state === 'partial' || status.state === 'indexing' || status.state === 'failed';
  const at = status.syncedAt === undefined ? (partial ? undefined : status.lastIndexedAt) : status.syncedAt;
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : undefined;
}
export function indexProgress(entry?: IndexEntry) {
  if (entry?.error) return '暂时无法读取进度，正在重试';
  const s = entry?.status;
  const job = s?.manualTask;
  const p = activeTask(job?.state) && job?.stage ? job : s?.progress;
  const stage =
    p?.stage || (s?.phase === 'queued' ? '排队等待' : s?.phase === 'rebuilding' ? '正在重建索引' : '检查文件变更');
  if (stage === '扫描文件' && p?.total === undefined && typeof p?.processed === 'number' && p.processed > 0) {
    return stage + ' · 已发现 ' + p.processed.toLocaleString() + ' 个文件';
  }
  if (
    typeof p?.processed !== 'number' ||
    typeof p.total !== 'number' ||
    p.total <= 0 ||
    p.processed < 0 ||
    p.processed > p.total
  )
    return stage;
  const unit = ['扫描文件', '解析代码'].includes(stage) ? ' 文件' : '';
  return stage + ' · ' + p.processed.toLocaleString() + ' / ' + p.total.toLocaleString() + unit;
}

/** One read-only catalog for every surface. Reading status never activates a project's watcher. */
export function useIndexDirectory(
  options: ProjectOption[],
  project: string,
  visible: boolean,
  reload: number,
  notice: Notice,
) {
  const [entries, setEntries] = useState<Entries>({});
  const latest = useRef<Entries>({});
  const manual = useRef(new Map<string, string | null>());
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const selected = useRef(project);
  selected.current = project;
  const notify = useRef(notice);
  notify.current = notice;
  const live = useRef(true);
  const refresh = useRef<((workspace: string) => void) | null>(null);
  const catalog = JSON.stringify(options.map((o) => o.cwd));
  const write = useCallback((key: string, entry: IndexEntry) => {
    latest.current = { ...latest.current, [key]: entry };
    setEntries(latest.current);
  }, []);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    const paths: string[] = JSON.parse(catalog);
    const known = new Map(paths.map((path) => [pathKey(path), path]));
    let closed = false,
      running = 0;
    const queue = new Set<string>();
    const reading = new Set<string>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    function enqueue(path: string, first = false) {
      const key = pathKey(path);
      if (closed || !known.has(key) || reading.has(key)) return;
      clearTimeout(timers.get(key));
      if (first) {
        const rest = [...queue];
        queue.clear();
        queue.add(key);
        rest.forEach((k) => queue.add(k));
      } else queue.add(key);
      drain();
    }
    function drain() {
      while (!closed && running < 3 && queue.size) {
        const key = queue.values().next().value!;
        queue.delete(key);
        reading.add(key);
        running++;
        void read(key, known.get(key)!).finally(() => {
          running--;
          reading.delete(key);
          drain();
        });
      }
    }
    async function read(key: string, path: string) {
      const prev = latest.current[key]?.status;
      try {
        const status = await agentDataApi.code.status(path);
        if (closed) return;
        if (!pathsEquivalent(status.workspace, path)) throw new Error('返回的 CodeGraph 索引状态与当前项目不匹配');
        const task = status.manualTask;
        const requested = manual.current.get(key);
        const terminal =
          task &&
          !activeTask(task.state) &&
          (requested === task.id || (prev?.manualTask?.id === task.id && activeTask(prev.manualTask.state)));
        if (terminal) {
          manual.current.delete(key);
          const name =
            path
              .replace(/[\\/]+$/, '')
              .split(/[\\/]/)
              .pop() || path;
          notify.current(
            task.state === 'completed' ? 'success' : 'error',
            name + (task.state === 'completed' ? '：索引已同步' : '：' + (task.error || '同步已取消')),
          );
        }
        if (
          prev &&
          (lastSync(prev) !== lastSync(status) ||
            prev.generation !== status.generation ||
            (terminal && task.state === 'completed'))
        ) {
          setRevisions((old) => ({ ...old, [key]: (old[key] ?? 0) + 1 }));
        }
        const next = { status, lastCheckedAt: Date.now(), requested: manual.current.has(key) };
        write(
          key,
          isIndexBusy(next)
            ? { ...next, syncFrom: latest.current[key]?.syncFrom ?? directoryView(latest.current[key]).label }
            : next,
        );
      } catch (e) {
        if (!closed) write(key, { ...latest.current[key], error: codeRequestError(e) });
      }
      if (closed) return;
      const entry = latest.current[key];
      const fast =
        isIndexBusy(entry) ||
        codeIndexSyncActive(entry?.status) ||
        (key === pathKey(selected.current) && codeIndexWatcherPending(entry?.status));
      // Idle projects still discover a sync started elsewhere; don't poll them at progress speed.
      timers.set(
        key,
        setTimeout(() => enqueue(path), entry?.error ? 8000 : fast ? 1000 : 45_000),
      );
    }
    refresh.current = (path) => enqueue(path, true);
    if (selected.current) enqueue(selected.current, true);
    paths.forEach((path) => enqueue(path));
    return () => {
      closed = true;
      refresh.current = null;
      timers.forEach(clearTimeout);
    };
  }, [catalog, visible, reload, write]);
  useEffect(() => {
    if (project && visible) refresh.current?.(project);
  }, [project, visible]);

  const sync = useCallback(
    async (path: string, rebuild = false) => {
      const key = pathKey(path);
      if (!visible || !path || manual.current.has(key) || isIndexBusy(latest.current[key])) return;
      manual.current.set(key, null);
      write(key, { ...latest.current[key], requested: true, syncFrom: directoryView(latest.current[key]).label });
      try {
        const job = await agentDataApi.jobs.create({
          kind: 'codegraph.sync',
          workspace: path,
          ...(rebuild ? { rebuild: true as const } : {}),
        });
        if (!live.current) return;
        // A fast job can finish on the status channel before its create receipt arrives.
        if (manual.current.has(key)) manual.current.set(key, job.id);
        refresh.current?.(path);
      } catch (e) {
        if (!live.current) return;
        manual.current.delete(key);
        write(key, { ...latest.current[key], requested: false });
        notify.current(
          'error',
          path.split(/[\\/]/).pop() + '：无法开始同步：' + (e instanceof Error ? e.message : String(e)),
        );
      }
    },
    [visible, write],
  );
  return { entries, revision: revisions[pathKey(project)] ?? 0, sync };
}
