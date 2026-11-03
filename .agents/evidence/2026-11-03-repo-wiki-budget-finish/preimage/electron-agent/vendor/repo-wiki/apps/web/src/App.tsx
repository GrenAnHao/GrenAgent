import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  runtimeClient,
  requestViaClient,
  downloadMarkdown,
  type RepoWikiClient,
  pageUrl,
  request as defaultRequest,
  type Changes,
  type Project,
  type Run,
  type SourceRef,
  type WikiPage,
} from "./workspace/api";
import { Icon } from "./workspace/Icons";
import { Markdown, scrollToMarkdownHeading } from "./workspace/Markdown";
import { markdownFiles } from "./workspace/imports";
import { WikiTree } from "./workspace/WikiTree";
import { documentOutline } from "./workspace/documentOutline";
import { PlanEditor } from "./workspace/PlanEditor";
import { NativeWikiPanel } from "./workspace/NativeWikiPanel";
import { ProjectCollection } from "./workspace/ProjectCollection";
import { ProjectOverview } from "./workspace/GenerationOverview";
import type { RepoWikiHostContext } from "./RepoWikiPanel";
import { KnowledgeCardList } from "./workspace/KnowledgeCardList";
import { KnowledgeRunBanner } from "./workspace/KnowledgeRunStatus";
import type { MenuProps } from "antd";
import type { KnowledgeActionInput, RepoWikiKnowledgeSnapshot } from '../../../../../shared/knowledgeKernelContracts';
import { acceptKnowledgeSnapshot, knowledgeActivity, knowledgeActivityKey, projectKnowledge } from '../../../../../src/features/repoWiki/knowledgeProjection';

type Health = {
  status: string;
  backend?: string;
  service_pid?: number;
  demo_path?: string;
  provider?: Record<string, any>;
};
type SourceFile = {
  path: string;
  content: string;
  total_lines: number;
  start_line: number;
  end_line: number;
  hash?: string;
};
const pageLabels: Record<string, string> = {
  overview: "项目概览",
  architecture: "系统架构",
  "getting-started": "快速开始",
  "reading-guide": "阅读指南",
};
const statusText: Record<string, string> = {
  ready: "已同步",
  edited: "人工修订",
  conflict: "待解决冲突",
  archived: "已归档",
  pending: "待生成",
};
const count = (value: unknown) =>
  Array.isArray(value) ? value.length : typeof value === "number" ? value : 0;
const logicalDraftPageId = (id: string) => id.slice(id.indexOf(":") + 1);
type ContentMode = "wiki" | "cards";
type GenerationConsent = {
  projectId: string;
  target: ContentMode;
  force: boolean;
  epoch: number;
  action?: 'repair' | 'reanalyse';
  requestId?: string;
  modelIdentity?: string;
  modelDisplayName?: string;
  planToken?: string;
  taskId?: string;
  taskRevision?: number;
  reusableCount?: number;
  redoCount?: number;
};
const isActiveRun = (run: Run | null | undefined) =>
  !!run &&
  ["queued", "running", "pending", "cancel_requested"].includes(run.status);
const routeHash = (project: string, page: string, mode: ContentMode) =>
  project
    ? new URLSearchParams({
        project,
        mode,
        ...(page ? { page } : {}),
      }).toString()
    : "";
const initialHash = () => new URLSearchParams(window.location.hash.slice(1));

function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
  error,
}: {
  title: string;
  error?: string;
  eyebrow?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const items = ref.current?.querySelectorAll<HTMLElement>(
          'button,input,select,textarea,[tabindex="0"]',
        );
        if (!items?.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-head">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {error && (
          <div className="modal-inline-error" role="alert">
            <Icon name="warning" size={16} />
            <span>{error}</span>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
export default function App({
  client: suppliedClient,
  syncLocation = true,
  workspacePath,
  onClose,
  registerNavigationGuard,
  hostContext,
  onSelectWorkspace,
  visible = true,
  integrated = false,
  onOpenTasks,
}: {
  client?: RepoWikiClient;
  syncLocation?: boolean;
  workspacePath?: string;
  hostContext?: RepoWikiHostContext;
  onSelectWorkspace?: (path: string, projectId?: string) => Promise<void>;
  onClose?: () => void;
  registerNavigationGuard?: (guard: () => boolean) => () => void;
  visible?: boolean;
  integrated?: boolean;
  onOpenTasks?: () => void;
} = {}) {
  const clientRef = useRef<RepoWikiClient | undefined>(
    suppliedClient ?? runtimeClient(),
  );
  const client = suppliedClient ?? clientRef.current;
  const request = useCallback(
    <T,>(path: string, method = "GET", body?: unknown): Promise<T> =>
      client
        ? requestViaClient<T>(client, path, method, body)
        : defaultRequest<T>(path, method, body),
    [client],
  );
  const [nativePanelOpen, setNativePanelOpen] = useState(false);
  const [hostCollection, setHostCollection] = useState(false);
  const [health, setHealth] = useState<Health | null>(null),
    [projects, setProjects] = useState<Project[]>([]),
    [projectId, setProjectId] = useState(
      syncLocation ? initialHash().get("project") || "" : "",
    ),
    [selectedId, setSelectedId] = useState(
      syncLocation ? initialHash().get("page") || "" : "",
    );
  useEffect(() => { setNativePanelOpen(false); }, [projectId]);
  const [contentMode, setContentMode] = useState<"wiki" | "cards">(
    syncLocation && initialHash().get("mode") === "cards" ? "cards" : "wiki",
  );
  const [openTabs, setOpenTabs] = useState<
    Array<{ id: string; mode: "wiki" | "cards" }>
  >(() => {
    const id = syncLocation ? initialHash().get("page") : null;
    return id
      ? [{ id, mode: initialHash().get("mode") === "cards" ? "cards" : "wiki" }]
      : [];
  });
  const selectedRef = useRef("");
  selectedRef.current = selectedId;
  const modeRef = useRef<ContentMode>(contentMode);
  modeRef.current = contentMode;
  const viewScope = useRef({
    key: routeHash(projectId, selectedId, contentMode),
    epoch: 0,
  });
  const renderKey = routeHash(projectId, selectedId, contentMode);
  if (viewScope.current.key !== renderKey)
    viewScope.current = { key: renderKey, epoch: viewScope.current.epoch + 1 };
  const hostKey = useRef(hostContext?.key);
  const hostToken = useRef(hostContext?.contextId);
  // Invalidate response scopes during render, before effects can resolve old I/O.
  const hostChanged = hostKey.current !== hostContext?.key || hostToken.current !== hostContext?.contextId;
  if (hostChanged) viewScope.current = { ...viewScope.current, epoch: viewScope.current.epoch + 1 };
  const draftCache = useRef(new Map<string, { draft: string; page: WikiPage; project: Project; pageId: string; mode: ContentMode }>());
  const mutationSerial = useRef(0);
  const [generationConsent, setGenerationConsent] =
    useState<GenerationConsent | null>(null);
  const captureScope = () => ({
    epoch: viewScope.current.epoch,
    projectId: projectRef.current,
    mode: modeRef.current,
    pageId: selectedRef.current,
  });
  const scopeCurrent = (scope: { epoch: number }) =>
    scope.epoch === viewScope.current.epoch;
  function beginMutation() {
    const serial = ++mutationSerial.current;
    setBusy(true);
    setError("");
    return serial;
  }
  function endMutation(serial: number) {
    if (serial === mutationSerial.current) setBusy(false);
  }

  const [project, setProject] = useState<Project | null>(null),
    [page, setPage] = useState<WikiPage | null>(null),
    [changes, setChanges] = useState<Changes>({}),
    [run, setRun] = useState<Run | null>(null);
  const runVersion = useRef(0);
  const [knowledge, setKnowledge] = useState<RepoWikiKnowledgeSnapshot | null>(null);
  const knowledgeRef = useRef(knowledge); knowledgeRef.current = knowledge;
  const refreshKnowledge = useRef<() => Promise<void>>(async () => {});
  const knowledgeScope = useRef('');
  useEffect(() => {
    const scope = JSON.stringify([projectId, contentMode, hostContext?.project?.language]);
    if (knowledgeScope.current !== scope) { knowledgeScope.current = scope; setKnowledge(null); }
    if (!client || !hostContext || !projectId || !visible) return;
    let alive = true, inFlight: Promise<void> | undefined, refreshAgain = false, timer: ReturnType<typeof setTimeout> | undefined;
    const language = hostContext.project?.language;
    const refresh = async () => {
      if (!alive || document.hidden) return;
      if (inFlight) { refreshAgain = true; return inFlight; }
      if (timer) clearTimeout(timer);
      const version = runVersion.current;
      inFlight = (async () => { try {
        const next = await client.invoke('knowledge', { project_id: projectId, target: contentMode }) as RepoWikiKnowledgeSnapshot;
        if (!alive || version !== runVersion.current || !next?.key) return;
        setKnowledge(previous => acceptKnowledgeSnapshot(previous, next, projectId, language || next.key.language, contentMode));
        if (projectKnowledge(next).polling) timer = setTimeout(() => { void refresh(); }, 2500);
      } catch (cause) { if (alive) setError((cause as Error).message); }
      finally { inFlight = undefined; if (refreshAgain && alive) { refreshAgain = false; void refresh(); } } })();
      return inFlight;
    };
    refreshKnowledge.current = refresh;
    const visibility = () => { if (document.hidden) { if (timer) clearTimeout(timer); } else void refresh(); };
    document.addEventListener('visibilitychange', visibility); void refresh();
    return () => { alive = false; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [client, projectId, contentMode, visible, hostContext?.project?.language]);
  const progressCursor = useRef({ instance: undefined as string | undefined, sequence: -1, currentRun: undefined as string | undefined, retiredRuns: new Set<string>() });
  function rememberRun(id: string | undefined) {
    const cursor = progressCursor.current;
    if (!id || id === cursor.currentRun) return;
    if (cursor.currentRun) cursor.retiredRuns.add(cursor.currentRun);
    cursor.currentRun = id;
  }
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [query, setQuery] = useState(""),
    [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<
      "import" | "markdown" | "plan" | "real" | "cancel" | "drafts" | null
    >(null),
    [importMode, setImportMode] = useState<"local" | "git">("local"),
    [repoPath, setRepoPath] = useState(""),
    [language, setLanguage] = useState("zh"),
    [planText, setPlanText] = useState(""),
    [provider, setProvider] = useState<"demo" | "real">(syncLocation ? "demo" : "real");
  const planStorageToken = useRef<string | undefined>(undefined);
  const [stagedDrafts, setStagedDrafts] = useState<Array<{ id: string; title: string; markdown: string; sources: SourceRef[] }>>([]);
  const [stagedDraftId, setStagedDraftId] = useState('');
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(""),
    [source, setSource] = useState<SourceFile | null>(null),
    [sourceLoading, setSourceLoading] = useState(false),
    [sourceError, setSourceError] = useState(""),
    [sourceOpen, setSourceOpen] = useState(false),
    [sourceStale, setSourceStale] = useState(false),
    [conflictTab, setConflictTab] = useState<"mine" | "generated" | "base">(
      "mine",
    );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const [inspectorOpen, setInspectorOpen] = useState(false),
    [inspectorTab, setInspectorTab] = useState<"outline" | "sources">(
      "outline",
    ),
    [menuOpen, setMenuOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null),
    documentRef = useRef<HTMLElement>(null),
    menuRef = useRef<HTMLDivElement>(null);
  const headingPrefix = `wiki-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const outline = useMemo(
    () =>
      documentOutline(page?.markdown || "", headingPrefix).filter(
        (item) =>
          !(item.level === 1 && item.line === 1 && item.title === page?.title),
      ),
    [page?.markdown, page?.title, headingPrefix],
  );
  const pendingHeading = useRef<string | null>(null);
  const [pendingWikiHeading, setPendingWikiHeading] = useState<{ pageId: string; hash: string } | null>(null);
  const [pendingDraftHeading, setPendingDraftHeading] = useState<{ pageId: string; hash: string } | null>(null);
  useEffect(() => {
    if (viewMode === "preview" && pendingHeading.current) {
      const target = pendingHeading.current;
      pendingHeading.current = null;
      requestAnimationFrame(() =>
        documentRef.current
          ?.querySelector<HTMLElement>(`[id="${target}"]`)
          ?.scrollIntoView({ block: "start" }),
      );
    }
  }, [viewMode]);
  useEffect(() => {
    if (!pendingWikiHeading) return;
    if (pendingWikiHeading.pageId !== selectedId) {
      setPendingWikiHeading(null);
      return;
    }
    if (viewMode !== "preview" || page?.id !== pendingWikiHeading.pageId) return;
    const { pageId, hash } = pendingWikiHeading;
    const frame = requestAnimationFrame(() => {
      scrollToMarkdownHeading(documentRef.current?.querySelector(".markdown"), hash);
      setPendingWikiHeading((current) => current?.pageId === pageId && current.hash === hash ? null : current);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingWikiHeading, selectedId, page?.id, page?.markdown, viewMode]);
  useEffect(() => {
    if (!pendingDraftHeading) return;
    if (stagedDraftId !== pendingDraftHeading.pageId || modal !== "drafts") {
      setPendingDraftHeading(null);
      return;
    }
    const { pageId, hash } = pendingDraftHeading;
    const frame = requestAnimationFrame(() => {
      scrollToMarkdownHeading(document.querySelector('[aria-label="未发布草稿正文"] .markdown'), hash);
      setPendingDraftHeading((current) => current?.pageId === pageId && current.hash === hash ? null : current);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingDraftHeading, stagedDraftId, modal]);
  function scrollToHeading(id: string) {
    if (editing) return;
    if (viewMode === "source") {
      pendingHeading.current = id;
      setViewMode("preview");
    } else
      documentRef.current
        ?.querySelector<HTMLElement>(`[id="${id}"]`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuRef.current
          ?.querySelector<HTMLButtonElement>(".more-button")
          ?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);
  function handleMenuKeys(event: React.KeyboardEvent) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)',
      ) || [],
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next].focus();
  }
  function menuAction(action: () => unknown) {
    setMenuOpen(false);
    menuRef.current?.querySelector<HTMLButtonElement>(".more-button")?.focus();
    setError("");
    void action();
  }
  async function exportWiki() {
    try {
      await downloadMarkdown(projectId, client, contentMode);
      notify("Markdown ZIP 已导出，包含三方合并所需的 manifest。");
    } catch (error) {
      setError((error as Error).message);
    }
  }
  const sourceRequest = useRef(0),
    directoryInput = useRef<HTMLInputElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    editRef = useRef(false),
    projectRef = useRef("");
  editRef.current = editing;
  projectRef.current = projectId;
  const wikiPages = project?.pages || [],
    cards = project?.cards || [];
  const pages = contentMode === "cards" ? cards : wikiPages;
  const currentMeta = [...wikiPages, ...cards].find((p) => p.id === selectedId);
  // Completed global runs can belong to a different branch. The backend's
  // per-kind matrix is authoritative for the selected branch/language.
  const currentIdentity = project?.identity;
  const matchingActiveRun =
    isActiveRun(run) &&
    (run?.target || "wiki") === contentMode &&
    (!run?.identity ||
      !currentIdentity ||
      (run.identity.branch === currentIdentity.branch &&
        run.identity.language === currentIdentity.language));
  const targetRun =
    (matchingActiveRun
      ? run
      : (project?.runs_by_kind?.[contentMode] ??
        ((run?.target || "wiki") === contentMode ? run : null))) || null;
  // Inside GrenAgent the KnowledgeKernel snapshot is the only run authority; the
  // legacy `run` view remains for the standalone app only.
  const kernelMode = !!hostContext;
  const activeRun = kernelMode ? !!knowledge && projectKnowledge(knowledge).inFlight : isActiveRun(run);
  const kernelCanStart = !kernelMode || (!!knowledge && projectKnowledge(knowledge).canStart);
  // Collection cards: the host task list covers every project; the open project's own snapshot is fresher.
  const collectionActivity = useMemo(() => {
    const map = { ...(hostContext?.activity ?? {}) };
    const path = hostContext?.project?.path;
    if (!path || !knowledge) return map;
    const key = knowledgeActivityKey(path), live = knowledgeActivity(knowledge);
    if (live) map[key] = live;
    else if (knowledge.run && (map[key]?.updatedAt ?? 0) <= (knowledge.run.updatedAt ?? 0)) delete map[key];
    return map;
  }, [hostContext?.activity, hostContext?.project?.path, knowledge]);
  const watchStatus =
    project?.watch_status_by_kind?.[contentMode] ?? project?.watch_status;
  const changedCount =
    count(changes.changed) + count(changes.added) + count(changes.deleted);
  const conflicts = pages.filter((p) => p.status === "conflict").length;
  const notify = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(""), 4500);
  };
  const reloadList = useCallback(async () => {
    const epoch = viewScope.current.epoch;
    const list = await request<Project[]>("/projects");
    if (epoch === viewScope.current.epoch) setProjects(list);
    return list;
  }, [request]);
  const reloadProject = useCallback(
    async (id = projectRef.current) => {
      if (!id) return;
      const detail = await request<Project>(`/projects/${id}`);
      if (projectRef.current === id) setProject(detail);
      return detail;
    },
    [request],
  );
  const readRun = useMemo(() => {
    const pending = new Map<string, Promise<Run>>();
    return (id: string) => {
      const existing = pending.get(id);
      if (existing) return existing;
      const promise = request<Run>(`/projects/${id}/runs/latest`);
      pending.set(id, promise);
      void promise.finally(() => { if (pending.get(id) === promise) pending.delete(id); }).catch(() => {});
      return promise;
    };
  }, [request]);
  useEffect(() => {
    if (hostContext) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    Promise.all([request<Health>("/health"), reloadList()])
      .then(([status, list]) => {
        if (!active) return;
        setHealth(status);
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [request, reloadList, hostContext?.status, hostContext?.revision]);
  function routeTo(
    nextProject: string,
    nextPage: string,
    nextMode: ContentMode,
    push = true,
  ) {
    const key = routeHash(nextProject, nextPage, nextMode);
    if (viewScope.current.key !== key) {
      viewScope.current = { key, epoch: viewScope.current.epoch + 1 };
      mutationSerial.current++;
      setBusy(false);
      setModal(null);
      setGenerationConsent(null);
      setError("");
      setNotice("");
      sourceRequest.current++;
      setSourceOpen(false);
      setSource(null);
      setInspectorOpen(false);
      setMenuOpen(false);
      if (projectRef.current !== nextProject) setOpenTabs([]);
      setPage(null);
    }
    projectRef.current = nextProject;
    selectedRef.current = nextPage;
    modeRef.current = nextMode;
    setProjectId(nextProject);
    setSelectedId(nextPage);
    setContentMode(nextMode);
    setEditing(false);
    if (syncLocation && push && window.location.hash.slice(1) !== key)
      history.pushState(
        null,
        "",
        window.location.pathname +
          window.location.search +
          (key ? "#" + key : ""),
      );
  }
  useLayoutEffect(() => {
    if (!hostContext) return;
    const changingWorkspace = hostKey.current !== hostContext.key;
    const changingContext = hostToken.current !== hostContext.contextId;
    const id = hostContext.projectId || '';
    if (changingWorkspace || changingContext || id !== projectRef.current) {
      if (editRef.current && page && project) draftCache.current.set(projectRef.current, {
        draft, page, project, pageId: selectedRef.current, mode: modeRef.current,
      });
      hostKey.current = hostContext.key;
      hostToken.current = hostContext.contextId;
      routeTo('', '', 'wiki', false);
      setProject(null); setRun(null); setChanges({});
      if (changingWorkspace) { setProjects([]); setHostCollection(false); }
      if (id) {
        const cached = draftCache.current.get(id);
        routeTo(id, cached?.pageId || '', cached?.mode || 'wiki', false);
      }
    }
  }, [hostContext?.key, hostContext?.contextId, hostContext?.status, hostContext?.projectId]);

  useEffect(() => {
    if (!syncLocation) return;
    const handle = () => {
      const next = initialHash(),
        nextProject = next.get("project") || "",
        nextPage = next.get("page") || "",
        nextMode = next.get("mode") === "cards" ? "cards" : "wiki";
      const key = routeHash(nextProject, nextPage, nextMode);
      if (key === viewScope.current.key) return;
      if (editRef.current && !window.confirm("当前编辑尚未保存，确认离开？")) {
        history.replaceState(
          null,
          "",
          window.location.pathname +
            window.location.search +
            (viewScope.current.key ? "#" + viewScope.current.key : ""),
        );
        return;
      }
      routeTo(nextProject, nextPage, nextMode, false);
      if (nextPage)
        setOpenTabs((previous) =>
          previous.some((tab) => tab.id === nextPage && tab.mode === nextMode)
            ? previous
            : [...previous.slice(-7), { id: nextPage, mode: nextMode }],
        );
    };
    window.addEventListener("hashchange", handle);
    window.addEventListener("popstate", handle);
    return () => {
      window.removeEventListener("hashchange", handle);
      window.removeEventListener("popstate", handle);
    };
  }, [syncLocation]);
  useEffect(() => {
    if (!syncLocation) return;
    const hash = routeHash(projectId, selectedId, contentMode);
    if (window.location.hash.slice(1) !== hash)
      history.replaceState(
        null,
        "",
        window.location.pathname +
          window.location.search +
          (hash ? "#" + hash : ""),
      );
  }, [projectId, selectedId, syncLocation, contentMode]);
  useEffect(() => {
    if (!projectId) {
      setProject(null);
      setPage(null);
      setRun(null);
      setChanges({});
      return;
    }
    const cached = hostContext ? draftCache.current.get(projectId) : undefined;
    setPage(cached?.page || null);
    setProject(cached?.project || (hostContext?.project?.id === projectId ? hostContext.project : null));
    setEditing(!!cached);
    if (cached) { setDraft(cached.draft); editRef.current = true; }
    setRun(null);
    setChanges({});
    setSourceOpen(false);
    setSource(null);
    sourceRequest.current++;
    setInspectorOpen(false);
    setViewMode("preview");
    setQuery("");
    let active = true;
    const refresh = async () => {
      const version = runVersion.current;
      try {
        const [detail, delta, job] = await Promise.all([
          hostContext?.project?.id === projectId ? Promise.resolve(hostContext.project) : request<Project>(`/projects/${projectId}`),
          request<Changes>(
            `/projects/${projectId}/changes?target=${contentMode}`,
          ),
          kernelMode ? Promise.resolve(null) : readRun(projectId).catch(() => null),
        ]);
        if (!active) return;
        setProject(detail);
        setChanges(delta);
        if (version === runVersion.current) { rememberRun(job?.id); setRun(job); }
        const all = [...(detail.pages || []), ...(detail.cards || [])];
        if (!editRef.current) {
          setOpenTabs((previous) =>
            previous.filter((tab) => all.some((p) => p.id === tab.id)),
          );
          if (
            selectedRef.current &&
            !all.some((p) => p.id === selectedRef.current)
          ) {
            routeTo(projectId, "", contentMode, false);
          }
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    refresh();
    return () => { active = false; };
  }, [projectId, request, readRun, contentMode, kernelMode]);
  // Events are authoritative. Only a live run gets a serial, lightweight fallback poll.
  useEffect(() => {
    if (!visible || !projectId || kernelMode || !isActiveRun(run)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = runVersion.current;
      try {
        const job = await readRun(projectId);
        if (!active) return;
        if (version === runVersion.current) { rememberRun(job?.id); setRun(job); }
        if (version !== runVersion.current || isActiveRun(job)) timer = setTimeout(() => { void poll(); }, 2500);
      } catch { if (active) timer = setTimeout(() => { void poll(); }, 2500); }
    };
    timer = setTimeout(() => { void poll(); }, 2500);
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, readRun, isActiveRun(run), visible, kernelMode]);
  useEffect(() => {
    if (!visible || !projectId || kernelMode) return;
    let active = true;
    const version = runVersion.current;
    void readRun(projectId).then((job) => {
      if (active && version === runVersion.current) { rememberRun(job?.id); setRun(job); }
    }).catch(() => {});
    return () => { active = false; };
  }, [visible, projectId, readRun, kernelMode]);
  useEffect(() => {
    if (!client) return;
    const cursor = { instance: undefined as string | undefined, sequence: -1, currentRun: undefined as string | undefined, retiredRuns: new Set<string>() };
    progressCursor.current = cursor;
    return client.subscribe((event) => {
      if (event.project_id !== projectRef.current) return;
      if (event.instance_id && cursor.instance && event.instance_id !== cursor.instance) return;
      if (typeof event.sequence === 'number' && event.sequence <= cursor.sequence) return;
      if (event.run.id && cursor.retiredRuns.has(event.run.id)) return;
      if (event.instance_id) cursor.instance = event.instance_id;
      if (typeof event.sequence === 'number') cursor.sequence = event.sequence;
      rememberRun(event.run.id);
      runVersion.current++;
      const nextKnowledge = (event as unknown as { knowledge?: RepoWikiKnowledgeSnapshot }).knowledge;
      if (nextKnowledge) setKnowledge(previous => acceptKnowledgeSnapshot(previous, nextKnowledge, projectRef.current, hostContext?.project?.language || nextKnowledge.key.language, modeRef.current));
      void refreshKnowledge.current();
      setRun(event.run as Run);
      if (!isActiveRun(event.run)) {
        const epoch = viewScope.current.epoch;
        void reloadProject(event.project_id).catch(() => {});
        void request<Changes>(`/projects/${event.project_id}/changes?target=${modeRef.current}`)
          .then((delta) => { if (epoch === viewScope.current.epoch) setChanges(delta); }).catch(() => {});
      }
    });
  }, [client]);
  const pageRevision = currentMeta?.revision;
  useEffect(() => {
    if (!projectId || !currentMeta || editRef.current) return;
    let active = true;
    request<WikiPage>(pageUrl(projectId, selectedId))
      .then((p) => {
        if (active && !editRef.current) setPage(p);
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [projectId, selectedId, pageRevision, currentMeta?.status, request]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (!editing && !draftCache.current.size) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [editing]);
  function leaveEdit(): boolean {
    if (busy) return false;
    if (editing && !window.confirm("当前编辑尚未保存。确认离开并放弃修改？"))
      return false;
    setEditing(false);
    draftCache.current.delete(projectRef.current);
    return true;
  }
  useEffect(() => registerNavigationGuard?.(() => {
    if (busy) return false;
    if ((editing || draftCache.current.size) && !window.confirm("当前编辑尚未保存。确认离开并放弃修改？")) return false;
    draftCache.current.clear();
    setEditing(false);
    return true;
  }), [registerNavigationGuard, editing, busy]);
  function navigate(id: string, targetMode: "wiki" | "cards" = contentMode) {
    if (!leaveEdit()) return;
    const actualMode = cards.some((item) => item.id === id)
      ? "cards"
      : wikiPages.some((item) => item.id === id)
        ? "wiki"
        : targetMode;
    routeTo(projectId, id, actualMode);
    setOpenTabs((previous) => {
      const existing = previous.some(
        (tab) => tab.id === id && tab.mode === actualMode,
      );
      return existing
        ? previous
        : [...previous.slice(-7), { id, mode: actualMode }];
    });
    setViewMode("preview");
    setMobileNav(false);
    setInspectorOpen(false);
    documentRef.current?.scrollTo?.({ top: 0 });
  }
  function goOverview(nextMode: "wiki" | "cards" = contentMode) {
    if (!leaveEdit()) return;
    routeTo(projectId, "", nextMode);
    setMobileNav(false);
  }
  function switchMode(nextMode: "wiki" | "cards") {
    if (nextMode !== contentMode) goOverview(nextMode);
  }
  function switchProject(id: string) {
    if (!leaveEdit()) return;
    if (hostContext && onSelectWorkspace) {
      const selected = projects.find((item) => item.id === id);
      if (id === hostContext.projectId) routeTo(id, '', 'wiki');
      else if (selected) void onSelectWorkspace(selected.path, selected.id).catch((error) => setError(error.message));
      return;
    }
    routeTo(id, "", "wiki");
    setViewMode("preview");
    setMobileNav(false);
  }
  function returnCollection() {
    if (!leaveEdit()) return;
    if (hostContext) { setHostCollection(true); return; }
    routeTo("", "", "wiki");
    void reloadList().catch((error) => setError(error.message));
  }
  function closeTab(id: string, mode: "wiki" | "cards") {
    const active = selectedId === id && contentMode === mode;
    if (active && !leaveEdit()) return;
    const index = openTabs.findIndex(
        (tab) => tab.id === id && tab.mode === mode,
      ),
      next = openTabs.filter((tab) => tab.id !== id || tab.mode !== mode);
    setOpenTabs(next);
    if (active) {
      const replacement = next[Math.min(index, next.length - 1)];
      if (replacement) {
        routeTo(projectId, replacement.id, replacement.mode);
      } else {
        routeTo(projectId, "", contentMode);
      }
      setViewMode("preview");
      setInspectorOpen(false);
    }
  }
  function navigateFromMarkdown(id: string, hash?: string) {
    navigate(id);
    setPendingWikiHeading(hash ? { pageId: id, hash } : null);
  }
  function navigateDraftFromMarkdown(id: string, hash?: string) {
    const target = stagedDrafts.find((item) => logicalDraftPageId(item.id) === id);
    if (!target) return;
    setStagedDraftId(target.id);
    setPendingDraftHeading(hash ? { pageId: target.id, hash } : null);
  }
  function handleTabKeys(event: React.KeyboardEvent, index: number) {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next =
        openTabs[
          (index + (event.key === "ArrowRight" ? 1 : -1) + openTabs.length) %
            openTabs.length
        ];
      if (next) navigate(next.id, next.mode);
    }
  }
  async function switchLanguage(nextLanguage: string) {
    if (!project || nextLanguage === project.language || busy) return;
    if (
      editing &&
      !window.confirm("当前编辑尚未保存。确认切换文档语言并放弃修改？")
    )
      return;
    const scope = captureScope(),
      serial = beginMutation();
    setError("");
    try {
      if (hostContext?.onLanguage) {
        draftCache.current.delete(projectId);
        setEditing(false); editRef.current = false;
        await hostContext.onLanguage(nextLanguage);
        return;
      }
      const next = await request<Project>("/projects", "POST", {
        path: project.path,
        language: nextLanguage,
      });
      if (hostContext && onSelectWorkspace && scopeCurrent(scope)) await onSelectWorkspace(next.path, next.id);
      if (!scopeCurrent(scope)) return;
      await reloadList();
      if (!scopeCurrent(scope)) return;
      setEditing(false);
      routeTo(next.id, "", scope.mode);
      setOpenTabs([]);
      setLanguage(nextLanguage);
      setViewMode("preview");
      notify("已切换文档语言空间；不会自动调用模型。");
    } catch (error) {
      if (scopeCurrent(scope)) setError((error as Error).message);
    } finally {
      endMutation(serial);
    }
  }
  async function createRepo(path = repoPath, mode = importMode) {
    if (!path.trim()) return;
    const scope = captureScope(),
      serial = beginMutation();
    setError("");
    try {
      const result = await request<Project>(
        mode === "git" ? "/clone" : "/projects",
        "POST",
        mode === "git"
          ? { url: path.trim(), language }
          : { path: path.trim(), language },
      );
      await reloadList();
      if (!scopeCurrent(scope)) return;
      routeTo(result.id, "", "wiki");
      setOpenTabs([]);
      setModal(null);
      setRepoPath("");
      notify("仓库已连接，可以开始生成 Wiki");
    } catch (e) {
      if (scopeCurrent(scope)) setError((e as Error).message);
    } finally {
      endMutation(serial);
    }
  }
  async function generate(confirm = false, force = false) {
    if (!project || busy || activeRun && !(confirm && generationConsent?.action) || editing) return;
    // The kernel requires the frozen model identity and plan token from a snapshot.
    if (kernelMode && !knowledgeRef.current) return;
    const scope = captureScope();
    const intent = confirm
      ? generationConsent
      : {
          projectId: project.id,
          target: contentMode,
          force,
          epoch: scope.epoch,
          requestId: crypto.randomUUID(),
          modelIdentity: knowledgeRef.current?.admission.modelIdentity,
          modelDisplayName: knowledgeRef.current?.admission.modelDisplayName,
          planToken: knowledgeRef.current?.admission.planToken,
        };
    if (
      !intent ||
      intent.projectId !== project.id ||
      intent.target !== contentMode ||
      !scopeCurrent(intent)
    ) {
      setModal(null);
      setGenerationConsent(null);
      return;
    }
    if (provider === "real" && !confirm) {
      setGenerationConsent(intent);
      setMenuOpen(false);
      setModal("real");
      return;
    }
    const serial = beginMutation();
    const version = runVersion.current;
    try {
      if (intent.action) {
        if (!client) throw new Error('Repo Wiki connection unavailable');
        if (!knowledgeRef.current?.run) throw new Error('任务状态已变化，请关闭确认窗口后重试。');
        const next = await client.invoke('action', { project_id: intent.projectId, task_id: intent.taskId!, action: intent.action, expected_revision: intent.taskRevision!, request_id: intent.requestId!, confirm_external: true, expected_model_identity: intent.modelIdentity, expected_plan_token: intent.planToken }) as RepoWikiKnowledgeSnapshot;
        if (scopeCurrent(scope)) { runVersion.current++; rememberRun(next.run?.taskId); setKnowledge(next); setModal(null); setGenerationConsent(null); }
        return;
      }
      const result = await request<{ run_id: string; status: string }>(
        `/projects/${intent.projectId}/generate`,
        "POST",
        {
          provider: confirm ? "real" : provider,
          target: intent.target,
          force: intent.force,
          confirm_external: confirm,
          ...(knowledgeRef.current ? { intent: intent.force ? 'regenerate' : knowledgeRef.current.content.publishedCount ? 'update' : 'generate', request_id: intent.requestId, expected_model_identity: intent.modelIdentity, expected_plan_token: intent.planToken } : {}),
        },
      );
      if (!scopeCurrent(scope)) return;
      if (knowledgeRef.current) { runVersion.current++; rememberRun(result.run_id); await refreshKnowledge.current(); }
      else if (version === runVersion.current) {
        rememberRun(result.run_id);
        setRun({
        id: result.run_id,
        target: intent.target,
        identity: project.identity,
        status: result.status,
        progress: 0,
        message: "任务已加入队列",
        events: [],
        });
      }
      setModal(null);
      setGenerationConsent(null);
    } catch (e) {
      if (scopeCurrent(scope)) setError((e as Error).message);
    } finally {
      endMutation(serial);
    }
  }
  async function knowledgeAction(action: KnowledgeActionInput['action']) {
    const current = knowledgeRef.current;
    if (!current?.run || !client || busy || !current.run.capabilities[action]) return;
    if (action === 'repair' || action === 'reanalyse') {
      setGenerationConsent({ projectId, target: contentMode, force: false, epoch: viewScope.current.epoch, action, requestId: crypto.randomUUID(), modelIdentity: current.admission.modelIdentity, modelDisplayName: current.admission.modelDisplayName, planToken: current.admission.planToken, taskId: current.run.taskId, taskRevision: current.run.revision, reusableCount: current.run.counts.prepared, redoCount: current.run.counts.failed + current.run.counts.blocked }); setModal('real'); setMenuOpen(false); return;
    }
    const scope = captureScope(), serial = beginMutation();
    try {
      const next = await client.invoke('action', { project_id: projectId, task_id: current.run.taskId, action, expected_revision: current.run.revision, request_id: crypto.randomUUID(), expected_plan_token: current.admission.planToken }) as RepoWikiKnowledgeSnapshot;
      if (scopeCurrent(scope)) { runVersion.current++; rememberRun(next.run?.taskId); setKnowledge(next); await refreshKnowledge.current(); }
    } catch (cause) { if (scopeCurrent(scope)) setError((cause as Error).message); }
    finally { endMutation(serial); }
  }
  async function previewKnowledgeDrafts() {
    const current = knowledgeRef.current;
    if (!client || !current?.run || busy) return;
    const scope = captureScope(), serial = beginMutation();
    try {
      const drafts = await client.invoke('drafts', { project_id: projectId, task_id: current.run.taskId });
      if (!scopeCurrent(scope) || drafts.taskId !== current.run.taskId) return;
      setStagedDrafts(drafts.items); setStagedDraftId(drafts.items[0]?.id || ''); setModal('drafts');
    } catch (cause) { if (scopeCurrent(scope)) setError((cause as Error).message); }
    finally { endMutation(serial); }
  }
  async function cancelGeneration() {
    if (knowledgeRef.current) { await knowledgeAction('cancel'); setModal(null); return; }
    if (!project || !activeRun) return;
    const scope = captureScope(),
      serial = beginMutation();
    try {
      await request(`/projects/${scope.projectId}/cancel`, "POST", {});
      if (!scopeCurrent(scope)) return;
      setRun((previous) =>
        previous
          ? {
              ...previous,
              status: "cancel_requested",
              message: "已请求取消，等待当前请求结束…",
            }
          : previous,
      );
      setModal(null);
      notify("已请求取消：当前请求可能仍会完成，后续页面不会继续生成");
    } catch (e) {
      if (scopeCurrent(scope)) setError((e as Error).message);
    } finally {
      endMutation(serial);
    }
  }
  async function openSource(ref: SourceRef) {
    const requestId = ++sourceRequest.current;
    setSourceOpen(true);
    setSourceLoading(true);
    setSource(null);
    setSourceError("");
    setSourceStale(false);
    try {
      const params = new URLSearchParams({
        path: ref.path,
        start_line: String(ref.start_line),
        end_line: String(ref.end_line),
      });
      const result = await request<SourceFile>(
        `/projects/${projectId}/source?${params}`,
      );
      if (requestId !== sourceRequest.current) return;
      const originalHash =
        ref.hash || page?.sources.find((item) => item.path === ref.path)?.hash;
      setSource(result);
      setSourceStale(
        !!originalHash && !!result.hash && originalHash !== result.hash,
      );
    } catch (e) {
      if (requestId === sourceRequest.current)
        setSourceError((e as Error).message);
    } finally {
      if (requestId === sourceRequest.current) setSourceLoading(false);
    }
  }
  async function savePage() {
    if (!page) return;
    const scope = captureScope(),
      serial = beginMutation();
    try {
      const conflict = page.status === "conflict";
      const endpoint = conflict
        ? `/projects/${projectId}/resolve/${page.id.split("/").map(encodeURIComponent).join("/")}`
        : pageUrl(projectId, page.id);
      const result = await request<WikiPage>(
        endpoint,
        conflict ? "POST" : "PUT",
        { markdown: draft, expected_revision: page.revision, expected_storage_token: page.storage_token },
      );
      if (!scopeCurrent(scope)) return;
      setPage(result);
      setEditing(false);
      draftCache.current.delete(scope.projectId);
      await reloadProject(scope.projectId);
      if (!scopeCurrent(scope)) return;
      notify(
        conflict
          ? "冲突已解决，人工内容已保留"
          : "修改已保存，下次生成将进行三方合并",
      );
    } catch (e) {
      if (scopeCurrent(scope)) setError((e as Error).message);
    } finally {
      endMutation(serial);
    }
  }
  async function savePlan() {
    const scope = captureScope(),
      serial = beginMutation();
    try {
      const parsed = JSON.parse(planText);
      const updated = await request<Project>(
        `/projects/${projectId}/plan`,
        "PUT",
        { plan: parsed, expected_plan_storage_token: planStorageToken.current },
      );
      if (!scopeCurrent(scope)) return;
      setProject(updated);
      setModal(null);
      notify("Wiki 计划已保存，下次生成时生效");
    } catch (e) {
      if (scopeCurrent(scope)) setError((e as Error).message);
    } finally {
      endMutation(serial);
    }
  }
  async function toggleWatch() {
    if (!project) return;
    const scope = captureScope(),
      serial = beginMutation();
    try {
      const updated = await request<Project>(
        `/projects/${projectId}/watch`,
        "PUT",
        { enabled: !project.watch },
      );
      if (!scopeCurrent(scope)) return;
      setProject(updated);
      notify(
        updated.watch
          ? syncLocation ? "变更监听已开启：离线演示自动同步，真实模型只检测变化" : "变更监听已开启：只检测源码变化，不自动调用模型"
          : "变更监听已关闭",
      );
    } catch (e) {
      if (scopeCurrent(scope)) setError((e as Error).message);
    } finally {
      endMutation(serial);
    }
  }
  async function importMarkdown(files: FileList | null) {
    if (!files?.length) return;
    const scope = captureScope(),
      serial = beginMutation();
    try {
      const entries = await markdownFiles(files);
      if (!scopeCurrent(scope)) return;
      await request(`/projects/${scope.projectId}/import`, "POST", {
        files: entries,
        target: scope.mode,
      });
      if (!scopeCurrent(scope)) return;
      await reloadProject(scope.projectId);
      if (!scopeCurrent(scope)) return;
      if (scope.pageId) {
        const importedPage = await request<WikiPage>(
          pageUrl(scope.projectId, scope.pageId),
        );
        if (!scopeCurrent(scope)) return;
        setPage(importedPage);
      }
      setModal(null);
      notify("Markdown 已导入为人工修订，不会覆盖生成基线");
    } catch (e) {
      if (scopeCurrent(scope)) setError((e as Error).message);
    } finally {
      endMutation(serial);
      if (fileInput.current) fileInput.current.value = "";
      if (directoryInput.current) directoryInput.current.value = "";
    }
  }
  useEffect(() => {
    if (!sourceOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSourceOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sourceOpen]);
  const runResult =
    targetRun?.result ||
    project?.knowledge?.[contentMode]?.last_run ||
    (contentMode === "wiki" ? project?.last_run : undefined);
  const startEdit = () => {
    if (page) {
      setDraft(page.markdown);
      setEditing(true);
      setConflictTab("mine");
    }
  };
  const progressPercent = Math.max(
    0,
    Math.min(
      100,
      Math.round(run?.progress || 0),
    ),
  );
  const documentIdentity =
    page?.identity ||
    project?.knowledge?.[contentMode]?.identity ||
    project?.identity;
  const branch = String(documentIdentity?.branch || "本地工作区");
  const commit = String(documentIdentity?.commit || "").slice(0, 7);
  const sourceCount = count(
    project?.stats?.files ||
      project?.stats?.file_count ||
      project?.stats?.total_files,
  );
  const sourceLines = count(
    project?.stats?.lines || project?.stats?.total_lines,
  );
  const syncTime = page?.updated_at
    ? new Date(page.updated_at).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  // Host overview "more" menu: the less common actions next to the single primary button.
  const kernelMoreMenu: MenuProps | undefined = project ? {
    items: [
      { key: 'regenerate', label: '全量重新生成（不复用缓存）', disabled: busy || !!activeRun || editing || !kernelCanStart },
      { type: 'divider' },
      { key: 'plan', label: `${contentMode === 'cards' ? '卡片' : 'Wiki'} 计划` },
      { key: 'watch', label: project.watch ? '关闭源码变更检测' : '开启源码变更检测' },
      { type: 'divider' },
      { key: 'import', label: '导入 Markdown 修订' },
      { key: 'export', label: `导出${contentMode === 'cards' ? '知识卡片' : ' Wiki'} ZIP`, disabled: !pages.length },
    ],
    onClick: ({ key }) => {
      if (key === 'regenerate') void generate(false, true);
      else if (key === 'plan') { planStorageToken.current = project.plan_storage_token; setPlanText(JSON.stringify(project.plan || {}, null, 2)); setModal('plan'); }
      else if (key === 'watch') void toggleWatch();
      else if (key === 'import') setModal('markdown');
      else if (key === 'export') void exportWiki();
    },
  } : undefined;
  const actionMenu = project ? (
    <div className="more-menu-anchor" ref={menuRef}>
      <button
        type="button"
        className={`icon-button more-button ${menuOpen ? "active" : ""}`}
        aria-label="更多 Wiki 操作"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((value) => !value)}
      >
        <span aria-hidden="true">···</span>
      </button>
      {menuOpen && (
        <div
          className="more-menu"
          role="menu"
          aria-label="Wiki 操作"
          onKeyDown={handleMenuKeys}
        >
          <div className="menu-section-label">
            生成来源 · 每次真实请求须确认
          </div>
          {hostContext ? <div className="menu-section-label">使用系统知识调度</div> : <label className="menu-provider">
            <Icon name="spark" size={14} />
            <select
              aria-label="生成模式"
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value as "demo" | "real")
              }
            >
              {syncLocation && <option value="demo">离线规则演示</option>}
              <option value="real">真实模型 API</option>
            </select>
          </label>}
          <div className="menu-separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              menuAction(() => {
                planStorageToken.current = project.plan_storage_token;
                setPlanText(JSON.stringify(project.plan || {}, null, 2));
                setModal("plan");
              })
            }
          >
            <Icon name="settings" size={15} />
            Wiki 计划<span>范围与页面目标</span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={project.watch}
            onClick={() => menuAction(toggleWatch)}
          >
            <Icon name="activity" size={15} />
            自动检测源码变更{project.watch && <Icon name="check" size={14} />}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy || !!activeRun || editing || !kernelCanStart}
            onClick={() => menuAction(() => generate(false, true))}
          >
            <Icon name="spark" size={15} />
            全量重新生成（绕过缓存）
          </button>
          <div className="menu-separator" />
          <div className="menu-section-label">Markdown 同步 · 不调用模型</div>
          <button
            type="button"
            role="menuitem"
            onClick={() => menuAction(() => setModal("markdown"))}
          >
            <Icon name="upload" size={15} />
            导入 Markdown 修订
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!pages.length}
            onClick={() => menuAction(exportWiki)}
          >
            <Icon name="download" size={15} />
            导出{contentMode === "cards" ? "知识卡片" : "Wiki"} ZIP
          </button>
          <div className="menu-separator" />
          <button
            type="button"
            role="menuitem"
            disabled={!page}
            onClick={() =>
              menuAction(() => {
                setInspectorOpen(true);
                setInspectorTab("sources");
              })
            }
          >
            <Icon name="code" size={15} />
            查看源码依据<span>{page?.sources?.length || 0}</span>
          </button>
          {!hostContext && <button
            type="button"
            role="menuitem"
            onClick={() => menuAction(() => setModal("import"))}
          >
            <Icon name="plus" size={15} />
            连接另一个仓库
          </button>}
        </div>
      )}
    </div>
  ) : null;
  return (
    <div
      className="repo-wiki-root"
      data-embedded={!syncLocation}
      ref={panelRef}
    >
      {nativePanelOpen && client && projectId && <NativeWikiPanel key={projectId} client={client} projectId={projectId} onClose={() => { const scope = captureScope(); setNativePanelOpen(false); void reloadProject().catch(cause => { if (scopeCurrent(scope)) setError(cause instanceof Error ? cause.message : String(cause)); }); }} />}
      {onClose && !integrated && (
        <header className="panel-titlebar">
          <div className="panel-name"><Icon name="branch" size={16} /><strong>Repo Wiki</strong></div>
          <button type="button" className="icon-button" aria-label="关闭 Repo Wiki，返回对话" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </header>
      )}
      {error && !modal && (
        <div className="notice-bar error-bar" role="alert">
          <Icon name="warning" size={15} />
          <span>{error}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭错误"
            onClick={() => setError("")}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      )}
      {hostContext?.error && projectId && project && !hostChanged && (
        <div className="notice-bar error-bar" role="alert"><span>{hostContext.error}</span>
          <button type="button" className="button" aria-label="重试 Repo Wiki" onClick={hostContext.onRetry}>重试</button>
        </div>
      )}
      {hostContext && (hostChanged || !projectId || !project) && !hostCollection && hostContext.currentSummary ? (
        <div className="rw-host-preparation">
          <section className="project-breadcrumb-bar" aria-label="当前宿主项目">
            <div className="project-breadcrumb">
              <button type="button" onClick={returnCollection} aria-label="返回 Repo Wiki 项目集合">Repo Wiki</button><span>/</span>
              <strong>{hostContext.currentSummary.name}</strong>
            </div>
            <span className="offline-tag">使用系统知识调度</span>
          </section>
          <div className="rw-host-preparation-status" role="status">
            {!hostContext.error && <span className="spinner" />}
            <span>{hostContext.error || '正在准备当前项目知识…'}</span>
            {hostContext.error && <button type="button" className="button" aria-label="重试 Repo Wiki" onClick={hostContext.onRetry}>重试</button>}
          </div>
          <ProjectCollection projects={[]} hostManaged hostProjects={hostContext.projects} loading={false}
            onSelect={() => {}} onSelectHost={(item) => { setHostCollection(false); void onSelectWorkspace?.(item.path).catch((e) => setError(e.message)); }}
            onCreate={() => {}} onRefresh={() => hostContext.onRetry?.()} activity={collectionActivity} />
        </div>
      ) : (hostContext ? hostCollection || !projectId : !projectId) ? (
        <ProjectCollection
          hostManaged={!!hostContext}
          hostProjects={hostContext?.projects}
          onSelectHost={(item) => {
            setHostCollection(false);
            if (item.path === workspacePath && hostContext?.project) { routeTo(hostContext.project.id, '', 'wiki'); return; }
            void onSelectWorkspace?.(item.path).catch((error) => setError(error.message));
          }}
          preferredProjectId={hostContext?.projectId || undefined}
          projects={hostContext?.project ? [hostContext.project, ...projects.filter((item) => item.id !== hostContext.project!.id)] : projects}
          loading={loading}
          onSelect={switchProject}
          onCreate={() => {
            setError("");
            if (workspacePath) {
              setImportMode("local");
              setRepoPath(workspacePath);
            }
            setModal("import");
          }}
          onRefresh={() => hostContext ? hostContext.onRetry?.() : void reloadList().catch((error) => setError(error.message))}
          activity={collectionActivity}
        />
      ) : (
        <>
          <header className="project-breadcrumb-bar">
            <div className="project-breadcrumb">
              <button
                type="button"
                onClick={returnCollection}
                aria-label="返回 Repo Wiki 项目集合"
              >
                Repo Wiki
              </button>
              <span>/</span>
              <strong>
                {project?.name ||
                  projects.find((item) => item.id === projectId)?.name ||
                  "正在加载…"}
              </strong>
              {selectedId && actionMenu}
            </div>
            <div className="project-top-actions">
              {client && contentMode === "wiki" && <button type="button" className="button subtle small" aria-label="原版 Wiki 生成" onClick={() => setNativePanelOpen(true)}>原版 Wiki</button>}
              <span className="offline-tag">
                {hostContext ? "使用系统知识调度" : provider === "demo" ? "离线规则演示" : "真实模型 · 需授权"}
              </span>
              {onOpenTasks && <button type="button" className="button subtle small" aria-label="查看生成任务" onClick={onOpenTasks}>
                <Icon name="activity" size={14} />{knowledge?.run ? `生成任务 · ${projectKnowledge(knowledge).runLabel}` : activeRun ? "生成任务 · 运行中" : "生成任务"}
              </button>}
              {selectedId && (
                <button
                  type="button"
                  className="button subtle small"
                  title="增量重新生成：复用未变更内容的缓存。需要绕过缓存请使用更多菜单中的全量重新生成。"
                  disabled={busy || !!activeRun || editing || !kernelCanStart}
                  onClick={() => generate()}
                >
                  {activeRun
                    ? "生成中…"
                    : knowledge
                      ? projectKnowledge(knowledge).generateLabel
                      : contentMode === "cards"
                        ? "重新生成卡片"
                        : "重新生成"}
                </button>
              )}
              <button
                type="button"
                className="icon-button mobile-menu"
                aria-label="打开导航"
                onClick={() => setMobileNav((value) => !value)}
              >
                <Icon name="menu" size={16} />
              </button>
              <button
                type="button"
                className="icon-button sidebar-toggle"
                aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
                aria-pressed={sidebarCollapsed}
                onClick={() => setSidebarCollapsed((value) => !value)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="2.5" y="3" width="15" height="14" rx="1" />
                  <path d="M7 3v14" />
                </svg>
              </button>
            </div>
          </header>
          <div
            className={`project-workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
          >
            {mobileNav && (
              <div className="nav-shade" onClick={() => setMobileNav(false)} />
            )}
            <aside
              className={`wiki-explorer ${mobileNav ? "open" : ""}`}
              aria-label="Wiki 导航"
            >
              <div className="sidebar-search-row">
                <div className="tree-search">
                  <Icon name="search" size={14} />
                  <input
                    aria-label={
                      contentMode === "cards"
                        ? "搜索知识卡片"
                        : "搜索 Wiki 页面"
                    }
                    placeholder={
                      contentMode === "cards"
                        ? "搜索知识卡片"
                        : "搜索 Wiki 页面"
                    }
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {query && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="清空搜索"
                      onClick={() => setQuery("")}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
                <div
                  className="knowledge-mode"
                  role="group"
                  aria-label="知识类型"
                >
                  <button
                    type="button"
                    className={contentMode === "wiki" ? "active" : ""}
                    aria-label="Wiki 文档"
                    aria-pressed={contentMode === "wiki"}
                    title="Wiki 文档"
                    onClick={() => switchMode("wiki")}
                  >
                    <Icon name="branch" size={17} />
                  </button>
                  <button
                    type="button"
                    className={contentMode === "cards" ? "active" : ""}
                    aria-label="知识卡片"
                    aria-pressed={contentMode === "cards"}
                    title="知识卡片"
                    onClick={() => switchMode("cards")}
                  >
                    <Icon name="layers" size={17} />
                  </button>
                </div>
              </div>
              <div className="tree-scroll">
                {contentMode === "wiki" ? (
                  <>
                    <button
                      type="button"
                      className={`knowledge-overview-link ${!selectedId ? "active" : ""}`}
                      onClick={() => goOverview("wiki")}
                    >
                      <Icon name="branch" size={16} />
                      <strong>Repo Wiki 概览</strong>
                      <span>{knowledge ? projectKnowledge(knowledge).navLabel : wikiPages.length ? "已生成" : "未生成"}</span>
                    </button>
                    {wikiPages.length ? (
                      <WikiTree
                        pages={wikiPages}
                        catalogue={project?.native_catalogue}
                        selectedId={selectedId}
                        query={query}
                        onSelect={(id) => navigate(id, "wiki")}
                      />
                    ) : (
                      <div className="tree-placeholder">
                        <p>生成后，项目文档将在这里显示。</p>
                      </div>
                    )}
                  </>
                ) : (
                  <KnowledgeCardList
                    cards={cards}
                    selectedId={selectedId}
                    query={query}
                    onSelect={(id) => navigate(id, "cards")}
                    onOverview={() => goOverview("cards")}
                    overviewSelected={!selectedId}
                  />
                )}
              </div>
            </aside>
            <main className="wiki-reader">
              {openTabs.length > 0 && (
                <div
                  className="document-tabs"
                  role="tablist"
                  aria-label="打开的文档"
                >
                  {openTabs.map((tab, index) => {
                    const metadata = [...wikiPages, ...cards].find(
                      (item) => item.id === tab.id,
                    );
                    return (
                      <div
                        className={`document-tab ${selectedId === tab.id && contentMode === tab.mode ? "active" : ""}`}
                        key={`${tab.mode}:${tab.id}`}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={
                            selectedId === tab.id && contentMode === tab.mode
                          }
                          tabIndex={selectedId === tab.id ? 0 : -1}
                          onKeyDown={(event) => handleTabKeys(event, index)}
                          onClick={() => navigate(tab.id, tab.mode)}
                          title={metadata?.title || tab.id}
                        >
                          <Icon
                            name={tab.mode === "cards" ? "layers" : "branch"}
                            size={14}
                          />
                          <span>{metadata?.title || tab.id}</span>
                          {selectedId === tab.id && editing && (
                            <i className="unsaved-dot" />
                          )}
                        </button>
                        <button
                          type="button"
                          className="tab-close"
                          aria-label={`关闭文档 ${metadata?.title || tab.id}`}
                          onClick={() => closeTab(tab.id, tab.mode)}
                        >
                          <Icon name="close" size={11} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {pages.length > 0 && changedCount > 0 && !activeRun && (
                <div className="notice-bar change-bar">
                  <Icon name="branch" size={14} />
                  <span>
                    源码有 {changedCount} 处变更
                    {count(changes.affected_pages)
                      ? `，影响 ${count(changes.affected_pages)} 篇${contentMode === "cards" ? "卡片" : "文档"}`
                      : ""}
                    。重新生成后才会更新内容。
                  </span>
                  <button
                    type="button"
                    disabled={busy || editing}
                    onClick={() => generate()}
                  >
                    更新
                    <Icon name="arrow" size={13} />
                  </button>
                </div>
              )}
              {knowledge?.run && selectedId && (projectKnowledge(knowledge).inFlight || knowledge.run.state === 'failed') && (
                <KnowledgeRunBanner knowledge={knowledge} busy={busy} onAction={action => { void knowledgeAction(action); }} />
              )}
              {!kernelMode && activeRun && (
                <div className="generation-banner" role="status">
                  <div>
                    <span className="spinner" />
                    <strong>
                      {run?.status === "cancel_requested"
                        ? "正在安全停止，等待当前请求结束…"
                        : `${run?.target === "cards" ? "知识卡片" : "Wiki"} · ${run?.message || "正在生成…"}`}
                    </strong>
                    <span className="progress-number">{progressPercent}%</span>
                    {run?.status !== "cancel_requested" &&
                      run?.cancelable !== false && (
                        <button
                          type="button"
                          className="cancel-run"
                          onClick={() => setModal("cancel")}
                        >
                          <Icon name="close" size={12} />
                          停止
                        </button>
                      )}
                  </div>
                  {integrated && <p className="generation-detail">
                    {(run?.page_id || run?.current_page) && <span>当前文档：{run.page_id || run.current_page}</span>}
                    <span>{run?.status === 'cancel_requested' ? '正在停止后续生成，已保存的文档会保留。' : '任务在后台继续，离开页面不受影响；重启应用后自动续跑。'}</span>
                  </p>}
                  <div className="progress-track">
                    <span style={{ width: `${progressPercent}%` }} />
                  </div>
                </div>
              )}
              {!kernelMode && targetRun?.status === "failed" && (
                <div className="notice-bar error-bar">
                  <Icon name="warning" size={15} />
                  <div>
                    <strong>生成失败，已有内容未被覆盖。</strong>
                    <p>{targetRun.error || targetRun.message}</p>
                  </div>
                  <button
                    type="button"
                    disabled={busy || editing || !!activeRun}
                    onClick={() => generate()}
                  >
                    重试
                  </button>
                </div>
              )}
              {!kernelMode && (targetRun?.status === "canceled" ||
                targetRun?.status === "interrupted") && (
                <div className="notice-bar neutral-bar">
                  <Icon name="clock" size={14} />
                  <span>
                    {targetRun.status === "canceled"
                      ? "本次生成已取消，已有内容与人工修订已保留。"
                      : "上次生成已中断，已有内容已保留。"}
                  </span>
                </div>
              )}
              {watchStatus?.status === "error" && (
                <div className="notice-bar error-bar">
                  <Icon name="warning" size={14} />
                  <span>变更检测异常：{watchStatus.message}</span>
                </div>
              )}
              {!project ? (
                <div className="document-empty">
                  <span className="spinner" />
                  <p>正在读取项目知识库…</p>
                </div>
              ) : !selectedId && kernelMode && !knowledge ? (
                <section className="document-empty" aria-label={contentMode === "cards" ? "知识卡片概览" : "Repo Wiki 概览"} aria-busy="true">
                  <span className="spinner" />
                  <p>正在读取生成状态…</p>
                </section>
              ) : !selectedId ? (
                <div className="overview-scroll">
                  <ProjectOverview
                    project={project}
                    mode={contentMode}
                    run={targetRun}
                    busy={busy || (!kernelMode && !!activeRun)}
                    provider={provider}
                    onLanguage={switchLanguage}
                    onGenerate={() => generate()}
                    onCancel={() => setModal("cancel")}
                    menu={actionMenu}
                    knowledge={knowledge}
                    moreMenu={kernelMoreMenu}
                    onKnowledgeAction={action => { void knowledgeAction(action); }}
                    onPreviewDraft={() => { void previewKnowledgeDrafts(); }}
                    onNativeOpen={() => setNativePanelOpen(true)}
                  />
                </div>
              ) : (
                <>
                  <div className="document-meta-toolbar">
                    <div className="commit-metadata">
                      <span>
                        <Icon name="branch" size={12} />
                        {branch}
                      </span>
                      <span>
                        <Icon name="clock" size={12} />
                        Commit: {commit || "未提交"}
                      </span>
                      <span>最近更新 {syncTime || "—"}</span>
                    </div>
                    <div className="document-view-controls">
                      <div
                        className="view-toggle"
                        role="group"
                        aria-label="文档显示方式"
                      >
                        <button
                          type="button"
                          aria-label="预览"
                          className={
                            viewMode === "preview" && !editing ? "active" : ""
                          }
                          aria-pressed={viewMode === "preview" && !editing}
                          disabled={editing}
                          onClick={() => setViewMode("preview")}
                        >
                          <svg
                            width="17"
                            height="17"
                            viewBox="0 0 20 20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <path d="M1.5 10s2.5-6 8.5-6 8.5 6 8.5 6-2.5 6-8.5 6-8.5-6-8.5-6Z" />
                            <circle cx="10" cy="10" r="2.5" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          aria-label="源码"
                          className={
                            viewMode === "source" && !editing ? "active" : ""
                          }
                          aria-pressed={viewMode === "source" && !editing}
                          disabled={editing}
                          onClick={() => setViewMode("source")}
                        >
                          <Icon name="code" size={17} />
                        </button>
                      </div>
                      <button
                        type="button"
                        className={`icon-button toc-trigger ${inspectorOpen ? "active" : ""}`}
                        aria-label={
                          inspectorOpen ? "关闭页内目录" : "打开页内目录"
                        }
                        aria-expanded={inspectorOpen}
                        onClick={() => {
                          setInspectorOpen((value) => !value);
                          setInspectorTab("outline");
                        }}
                      >
                        <Icon name="menu" size={17} />
                      </button>
                    </div>
                  </div>
                  <div
                    className={`reader-layout ${inspectorOpen ? "with-outline" : ""}`}
                  >
                    <section
                      className="document-scroll"
                      ref={documentRef}
                      aria-label="Wiki 文档"
                    >
                      {!page ? (
                        <div className="document-empty">
                          <span className="spinner" />
                          <p>正在读取文档…</p>
                        </div>
                      ) : (
                        <>
                          <div className="document-heading">
                            <div className="document-title-line">
                              <h1>{page.title}</h1>
                              <span className={`status-pill ${page.status}`}>
                                {statusText[page.status] || page.status}
                              </span>
                            </div>
                            <div className="document-edit-actions">
                              {editing ? (
                                <>
                                  <span>Markdown · 版本 {page.revision}</span>
                                  <button
                                    type="button"
                                    className="button subtle small"
                                    disabled={busy}
                                    onClick={() => {
                                      if (
                                        draft === page.markdown ||
                                        window.confirm("放弃尚未保存的修改？")
                                      )
                                        setEditing(false);
                                    }}
                                  >
                                    取消
                                  </button>
                                  <button
                                    type="button"
                                    className="button primary small"
                                    disabled={busy}
                                    onClick={savePage}
                                  >
                                    <Icon name="check" size={13} />
                                    保存
                                    {page.status === "conflict" ? "并解决" : ""}
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="button subtle small"
                                  onClick={startEdit}
                                >
                                  <Icon name="edit" size={13} />
                                  {page.status === "conflict"
                                    ? "解决冲突"
                                    : "编辑文档"}
                                </button>
                              )}
                            </div>
                          </div>
                          {page.status === "conflict" && !editing && (
                            <div className="conflict-banner">
                              <Icon name="warning" size={17} />
                              <div>
                                <strong>生成内容与人工修订发生重叠。</strong>
                                <p>
                                  你的版本已保留。请对照共同基线和新版本，确认最终内容。
                                </p>
                              </div>
                              <button
                                type="button"
                                className="button small"
                                onClick={startEdit}
                              >
                                审阅冲突
                              </button>
                            </div>
                          )}
                          {page.coverage?.partial && (
                            <div className="coverage-banner">
                              <Icon name="warning" size={14} />
                              <span>
                                部分覆盖：本页提供{" "}
                                {page.coverage.provided_files}/
                                {page.coverage.available_files} 个文件，
                                {page.coverage.truncated_files?.length || 0}{" "}
                                个文件有截断。
                              </span>
                            </div>
                          )}
                          {editing ? (
                            <div className="editor-area">
                              {page.status === "conflict" && (
                                <>
                                  <div
                                    className="conflict-tabs"
                                    role="tablist"
                                    aria-label="冲突版本对照"
                                  >
                                    <button
                                      type="button"
                                      role="tab"
                                      aria-selected={conflictTab === "mine"}
                                      className={
                                        conflictTab === "mine" ? "active" : ""
                                      }
                                      onClick={() => setConflictTab("mine")}
                                    >
                                      我的修订 · 可编辑
                                    </button>
                                    <button
                                      type="button"
                                      role="tab"
                                      aria-selected={
                                        conflictTab === "generated"
                                      }
                                      className={
                                        conflictTab === "generated"
                                          ? "active"
                                          : ""
                                      }
                                      onClick={() =>
                                        setConflictTab("generated")
                                      }
                                    >
                                      新生成版本
                                    </button>
                                    <button
                                      type="button"
                                      role="tab"
                                      aria-selected={conflictTab === "base"}
                                      className={
                                        conflictTab === "base" ? "active" : ""
                                      }
                                      onClick={() => setConflictTab("base")}
                                    >
                                      共同基线
                                    </button>
                                  </div>
                                  {conflictTab !== "mine" && (
                                    <div className="comparison-note">
                                      只读对照，切回「我的修订」整合后保存。
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (
                                            window.confirm(
                                              "用此版本替换当前编辑草稿？",
                                            )
                                          ) {
                                            setDraft(
                                              conflictTab === "generated"
                                                ? page.pending_markdown || ""
                                                : page.baseline || "",
                                            );
                                            setConflictTab("mine");
                                          }
                                        }}
                                      >
                                        以此版本作为草稿
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}
                              <textarea
                                className="markdown-editor"
                                aria-label="Markdown 编辑器"
                                spellCheck={false}
                                readOnly={conflictTab !== "mine"}
                                value={
                                  conflictTab === "mine"
                                    ? draft
                                    : conflictTab === "generated"
                                      ? page.pending_markdown || ""
                                      : page.baseline || ""
                                }
                                onChange={(event) =>
                                  setDraft(event.target.value)
                                }
                              />
                              <div className="editor-foot">
                                <span>UTF-8 · 人工修订保护</span>
                                <span>
                                  {draft.length.toLocaleString()} 字符
                                </span>
                              </div>
                            </div>
                          ) : viewMode === "source" ? (
                            <div className="raw-source-view">
                              <div className="raw-source-caption">
                                <Icon name="code" size={13} />
                                {page.id}.md
                                <span>只读预览 · 点击「编辑文档」修改</span>
                              </div>
                              <pre aria-label="Markdown 源码">
                                {page.markdown
                                  .split("\n")
                                  .map((line, index) => (
                                    <div key={index}>
                                      <span>{index + 1}</span>
                                      <code>{line || " "}</code>
                                    </div>
                                  ))}
                              </pre>
                            </div>
                          ) : (
                            <article className="document-content">
                              <Markdown
                                value={page.markdown}
                                nativeCitations={contentMode === "wiki" && page.inputManifest?.engine === 'qoder-wiki-local-v1'}
                                onSource={openSource}
                                onPage={navigateFromMarkdown}
                                currentPageId={page.id}
                                headingPrefix={headingPrefix}
                                leadingTitle={page.title}
                              />
                              {page.sources?.length > 0 && (
                                <section
                                  className="chapter-sources"
                                  aria-label="本页来源"
                                >
                                  <h2>本页来源</h2>
                                  <ul>
                                    {page.sources.map((ref, index) => (
                                      <li key={`${ref.path}:${index}`}>
                                        <button
                                          type="button"
                                          onClick={() => openSource(ref)}
                                        >
                                          {ref.path}:{ref.start_line}–
                                          {ref.end_line}
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                </section>
                              )}
                              <footer className="document-foot">
                                <Icon name="lock" size={12} />
                                <span>
                                  引用路径与行号经过校验；事实理解仍需人工审阅。
                                </span>
                              </footer>
                            </article>
                          )}
                        </>
                      )}
                    </section>
                    {inspectorOpen && page && (
                      <aside className="floating-outline" aria-label="文档信息">
                        <div className="outline-header">
                          <strong>
                            {inspectorTab === "outline"
                              ? "页内目录"
                              : "源码依据"}
                          </strong>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="关闭信息面板"
                            onClick={() => setInspectorOpen(false)}
                          >
                            <Icon name="close" size={13} />
                          </button>
                        </div>
                        {inspectorTab === "outline" ? (
                          <nav className="outline-list" aria-label="页内目录">
                            {outline.length ? (
                              outline.map((item) => (
                                <button
                                  type="button"
                                  key={item.id}
                                  disabled={editing}
                                  style={{
                                    paddingLeft:
                                      14 + Math.max(0, item.level - 1) * 14,
                                  }}
                                  onClick={() => scrollToHeading(item.id)}
                                >
                                  {item.title}
                                </button>
                              ))
                            ) : (
                              <p className="inspector-empty">
                                当前文档没有章节标题。
                              </p>
                            )}
                          </nav>
                        ) : (
                          <div className="evidence-list">
                            {page.sources?.map((ref, index) => (
                              <button
                                type="button"
                                key={`${ref.path}:${index}`}
                                onClick={() => openSource(ref)}
                              >
                                <Icon name="code" size={14} />
                                <span>
                                  <strong>{ref.path.split("/").pop()}</strong>
                                  <small>{ref.path}</small>
                                  <em>
                                    L{ref.start_line}–L{ref.end_line}
                                  </em>
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </aside>
                    )}
                  </div>
                </>
              )}
            </main>
          </div>
        </>
      )}
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={15} />
          {notice}
        </div>
      )}
      <input
        type="file"
        ref={fileInput}
        multiple
        accept=".md,.json,text/markdown,application/json"
        className="hidden"
        onChange={(e) => importMarkdown(e.target.files)}
      />
      <input
        type="file"
        ref={(node) => {
          directoryInput.current = node;
          node?.setAttribute("webkitdirectory", "");
        }}
        multiple
        className="hidden"
        onChange={(e) => importMarkdown(e.target.files)}
      />
      {modal === "markdown" && (
        <Modal
          error={error}
          title="导入 Markdown 修订"
          eyebrow="SAFE ROUND-TRIP SYNC"
          onClose={() => !busy && setModal(null)}
        >
          <p className="modal-description">
            先导出 Wiki ZIP
            并解压，在你喜欢的编辑器里修改，再导入整个目录。请保留{" "}
            <code>.repowiki-manifest.json</code>，用于检测导出之后发生的修订。
          </p>
          <div className="import-options">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => directoryInput.current?.click()}
            >
              <Icon name="folder" />
              选择已解压目录
              <Icon name="arrow" size={15} />
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="file" />
              选择页面与 manifest 文件
            </button>
          </div>
          <p className="field-hint">
            目录方式保留 modules/
            等嵌套路径。只接受现有页面；路径越界、重名与合并冲突会拒绝整次导入，不会部分覆盖。
          </p>
          {busy && (
            <div className="import-working">
              <span className="spinner" />
              正在校验并导入…
            </div>
          )}
        </Modal>
      )}
      {modal === "import" && (
        <Modal
          error={error}
          title="连接一个代码仓库"
          eyebrow="BUILD YOUR KNOWLEDGE"
          onClose={() => !busy && setModal(null)}
        >
          <p className="modal-description">
            从你电脑上的项目开始，或克隆一个 Git
            仓库。连接后不会自动调用大模型。
          </p>
          <div className="segmented">
            <button
              type="button"
              className={importMode === "local" ? "active" : ""}
              onClick={() => setImportMode("local")}
            >
              <Icon name="folder" size={16} />
              本地目录
            </button>
            <button
              type="button"
              className={importMode === "git" ? "active" : ""}
              onClick={() => setImportMode("git")}
            >
              <Icon name="git" size={16} />
              Git 仓库
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              createRepo();
            }}
          >
            <label className="field-label" htmlFor="repo-path">
              {importMode === "local" ? "项目目录" : "HTTPS 仓库地址"}
            </label>
            <input
              id="repo-path"
              className="text-input"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder={
                importMode === "local"
                  ? "/path/to/your/project"
                  : "https://github.com/owner/repository"
              }
              required
              autoFocus
            />
            <p className="field-hint">
              {importMode === "local"
                ? "请输入运行后端的这台电脑可访问的项目路径。"
                : "支持 GitHub / GitLab / Bitbucket。不要把访问令牌写进 URL。"}
            </p>
            {workspacePath && (
              <button type="button" className="demo-path-button" onClick={() => {
                setImportMode("local");
                setRepoPath(workspacePath);
              }}>
                <Icon name="folder" size={16} />使用当前工作区<Icon name="arrow" size={15} />
              </button>
            )}
            <label className="field-label" htmlFor="language">
              文档语言
            </label>
            <select
              id="language"
              className="text-input"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select>
            {syncLocation && health?.demo_path && (
              <button
                type="button"
                className="demo-path-button"
                onClick={() => {
                  setImportMode("local");
                  setRepoPath(health.demo_path!);
                }}
              >
                <Icon name="spark" size={16} />
                填入离线示例项目
                <Icon name="arrow" size={15} />
              </button>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={busy || !repoPath.trim()}
              >
                {busy ? (
                  <span className="spinner" />
                ) : (
                  <Icon name="plus" size={16} />
                )}
                连接仓库
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "plan" && (
        <Modal
          error={error}
          title="Wiki 计划"
          eyebrow="SCOPE & PAGE GOALS"
          wide
          onClose={() => !busy && setModal(null)}
        >
          <p className="modal-description">
            控制扫描范围、页面目标与页面间依赖。配置仅影响下一次生成，不直接改写现有内容。
          </p>
          <div className="plan-help">
            <code>include / exclude</code> 文件通配符 ·{" "}
            <code>pages[].patterns</code> 页面源码范围 · <code>depends_on</code>{" "}
            页面依赖
          </div>
          <PlanEditor value={planText} onChange={setPlanText} />
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => setModal(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={savePlan}
            >
              <Icon name="check" size={16} />
              保存计划
            </button>
          </div>
        </Modal>
      )}
      {modal === "cancel" && (
        <Modal
          error={error}
          title="停止本次生成？"
          eyebrow="CANCEL GENERATION"
          onClose={() => !busy && setModal(null)}
        >
          <div className="confirmation-warning">
            <Icon name="warning" size={22} />
            <p>
              取消后不会继续生成后续页面，已有 Wiki
              与人工修订会保留。当前正在进行的模型请求可能仍需等待完成，且可能已经产生费用；取消无法撤回已发送的源码。
            </p>
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              继续生成
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={cancelGeneration}
            >
              确认停止
              <Icon name="close" size={15} />
            </button>
          </div>
        </Modal>
      )}
      {modal === "real" && (
        <Modal
          error={error}
          title={generationConsent?.action === 'repair' ? '确认修复失败项？' : generationConsent?.action === 'reanalyse' ? '确认重新分析？' : '允许发送源码到模型服务？'}
          eyebrow="EXTERNAL REQUEST CONFIRMATION"
          onClose={() => !busy && setModal(null)}
        >
          <div className="confirmation-warning">
            <Icon name="warning" size={22} />
            <p>
              此次生成会将扫描范围内的源码片段发送到你配置的模型服务，可能产生费用。请确认你有权分享这些代码。
            </p>
          </div>
          {generationConsent?.force && (
            <p className="confirmation-warning">
              本次为全量重新生成，将绕过已有模型结果缓存，可能产生更多费用。
            </p>
          )}
          <dl className="provider-details">
            <div>
              <dt>生成目标</dt>
              <dd>
                {project?.name} ·{" "}
                {generationConsent?.target === "cards"
                  ? "知识卡片"
                  : "Wiki 文档"}{" "}
                · {generationConsent?.action === 'repair' ? '修复失败项' : generationConsent?.action === 'reanalyse' ? '重新分析' : generationConsent?.force ? "全量" : "增量（复用未变缓存）"}
              </dd>
            </div>
            <div>
              <dt>生成模式</dt>
              <dd>真实模型 API</dd>
            </div>
            <div>
              <dt>{hostContext ? "模型配置" : "服务端配置"}</dt>
              <dd>
                {generationConsent?.modelDisplayName || generationConsent?.modelIdentity || (hostContext
                  ? "使用系统知识模型，生成时检查配置"
                  : health?.provider?.real_configured || health?.provider?.configured
                    ? "已配置"
                    : "以服务端环境变量为准")}
              </dd>
            </div>
            <div>
              <dt>自动调用</dt>
              <dd>真实模型不会由监听器自动调用</dd>
            </div>
          </dl>
          {generationConsent?.action && <p>语言：{project?.language}；已完成 {generationConsent.reusableCount} 项，失败或受阻 {generationConsent.redoCount} 项。已保存成果通过校验后复用，其余继续处理。</p>}
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => generate(true)}
            >
              确认并生成
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </Modal>
      )}
      {modal === 'drafts' && <Modal title="未发布草稿" eyebrow="DRAFT PREVIEW" error={error} onClose={() => setModal(null)}>
        <p>以下成果尚未发布，正式文档保持可读。</p>
        <nav aria-label="未发布草稿目录">{stagedDrafts.map(item => <button className="button" type="button" aria-pressed={item.id === stagedDraftId} key={item.id} onClick={() => { setStagedDraftId(item.id); setPendingDraftHeading(null); }}>{item.title}</button>)}</nav>
        {stagedDrafts.length ? <article aria-label="未发布草稿正文"><Markdown value={stagedDrafts.find(item => item.id === stagedDraftId)?.markdown || ''} onSource={ref => { setModal(null); void openSource(ref); }} onPage={navigateDraftFromMarkdown} currentPageId={logicalDraftPageId(stagedDraftId)} headingPrefix="draft-heading" /></article> : <p>当前没有可预览的正文成果。</p>}
      </Modal>}
      {sourceOpen && (
        <div
          className="source-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSourceOpen(false);
          }}
        >
          <section
            className="source-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="源码引用"
          >
            <header>
              <div>
                <span className="eyebrow">SOURCE EVIDENCE</span>
                <h2>
                  <Icon name="code" />
                  {source?.path || "源码引用"}
                </h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭源码"
                onClick={() => setSourceOpen(false)}
              >
                <Icon name="close" />
              </button>
            </header>
            {sourceLoading ? (
              <div className="source-placeholder">
                <span className="spinner" />
                正在读取实际源码…
              </div>
            ) : sourceError ? (
              <div className="source-placeholder error-text">{sourceError}</div>
            ) : source ? (
              <>
                <div className="source-meta">
                  <span>工作区当前文件 · 只读</span>
                  <span>
                    L{source.start_line}–L{source.end_line} / 共{" "}
                    {source.total_lines} 行
                  </span>
                </div>
                {sourceStale && (
                  <div className="source-stale">
                    <Icon name="warning" size={15} />
                    源文件已变化，此引用基于旧版本，请重新生成 Wiki 后核验行号。
                  </div>
                )}
                <div className="source-code">
                  {source.content.split("\n").map((line, i) => (
                    <div key={i}>
                      <span>{source.start_line + i}</span>
                      <code>{line || " "}</code>
                    </div>
                  ))}
                </div>
                <div className="source-drawer-foot">
                  <Icon name="lock" size={14} />
                  引用范围由生成引擎校验，源码不会在此处被修改。
                </div>
              </>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}

