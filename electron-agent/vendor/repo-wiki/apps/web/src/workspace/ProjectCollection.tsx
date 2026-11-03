import { useMemo, useState } from "react";
import type { Project, WikiPage, Run } from "./api";
import type { HostProjectSummary } from "../../../../packages/contracts/src/host";
import { Icon } from "./Icons";
import "./collection.css";
import { knowledgeActivityKey, type KnowledgeActivity } from '../../../../../../src/features/repoWiki/knowledgeProjection';

export type KnowledgeKind = "wiki" | "cards";
export type KnowledgeSnapshot = {
  count?: number;
  identity?: Record<string, unknown>;
  last_run?: Record<string, any> | null;
  updated_at?: string | null;
};
/** Counts and snapshots are supplied by persisted backend records, never inferred from repository names. */
export type CollectionProject = Project & {
  page_count?: number;
  card_count?: number;
  cards?: WikiPage[];
  updated_at?: string | null;
  knowledge?: Partial<Record<KnowledgeKind, KnowledgeSnapshot>>;
  runs_by_kind?: Partial<
    Record<KnowledgeKind, Run & { target?: KnowledgeKind }>
  >;
};
export function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
export function projectTargetCount(
  project: CollectionProject,
  target: KnowledgeKind,
): number | undefined {
  const saved =
    finiteCount(project.knowledge?.[target]?.count) ??
    finiteCount(target === "wiki" ? project.page_count : project.card_count);
  if (saved !== undefined) return saved;
  const records = target === "wiki" ? project.pages : project.cards;
  return records
    ? records.filter((page) => page.status !== "archived").length
    : undefined;
}
export function formatTimestamp(
  value: unknown,
  includeTime = false,
): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    ...(includeTime
      ? ({ hour: "2-digit", minute: "2-digit", hour12: false } as const)
      : {}),
  }).format(date);
}
function updatedAt(project: CollectionProject): string | undefined {
  const valid = (value: unknown): value is string =>
    typeof value === "string" && Number.isFinite(Date.parse(value));
  const snapshots = [
    project.knowledge?.wiki?.updated_at,
    project.knowledge?.cards?.updated_at,
  ].filter(valid);
  const values = snapshots.length
    ? snapshots
    : [project.last_run?.completed_at, project.updated_at].filter(valid);
  return values.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
/** The service stores language variants separately; the collection shows one real variant per repository. */
export function groupCollectionProjects(
  projects: CollectionProject[],
  preferredProjectId?: string,
): CollectionProject[] {
  const groups = new Map<string, CollectionProject[]>();
  for (const project of projects) {
    const portablePath = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(project.path)
      ? project.path.replace(/\\/g, "/")
      : project.path;
    const key = portablePath.replace(/\/+$/, "") || portablePath;
    const group = groups.get(key) ?? [];
    group.push(project);
    groups.set(key, group);
  }
  return [...groups.values()].map(
    (group) =>
      [...group].sort((a, b) => {
        const languagePreference =
          Number(b.language.toLowerCase().startsWith("zh")) -
          Number(a.language.toLowerCase().startsWith("zh"));
        return (
          Number(b.id === preferredProjectId) - Number(a.id === preferredProjectId) ||
          languagePreference ||
          (Date.parse(updatedAt(b) ?? "") || 0) -
            (Date.parse(updatedAt(a) ?? "") || 0) ||
          a.id.localeCompare(b.id)
        );
      })[0]!,
  );
}
function generatedState(
  project: CollectionProject,
): "generated" | "ungenerated" | "unknown" {
  const wiki = projectTargetCount(project, "wiki"),
    cards = projectTargetCount(project, "cards");
  if ((wiki ?? 0) > 0 || (cards ?? 0) > 0) return "generated";
  return wiki === 0 && cards === 0 ? "ungenerated" : "unknown";
}
function LayoutIcon({ list }: { list?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      {list ? (
        <>
          <path d="M7 5h10M7 10h10M7 15h10" />
          <path d="M3 5h1M3 10h1M3 15h1" />
        </>
      ) : (
        <>
          <rect x="3" y="3" width="14" height="14" rx="1" />
          <path d="M3 10h14M10 3v14" />
        </>
      )}
    </svg>
  );
}
/** An original decorative source → knowledge motif, not project data or a control. */
function CollectionIllustration() {
  return (
    <div className="rw-collection-art" aria-hidden="true">
      <svg viewBox="0 0 440 230" fill="none" focusable="false">
        <ellipse cx="237" cy="120" rx="170" ry="95" className="rw-art-halo" />
        <path
          d="M139 115h50m26-5V66q0-12 12-12h31m-43 63v46q0 12 12 12h45"
          className="rw-art-link"
        />
        <circle cx="215" cy="114" r="22" className="rw-art-hub" />
        <g transform="translate(203 102)">
          <Icon name="branch" size={24} />
        </g>
        <g
          className="rw-art-source"
          transform="translate(28 57) rotate(-5 56 56)"
        >
          <rect width="112" height="112" rx="13" className="rw-art-paper" />
          <path d="M0 29h112" className="rw-art-divider" />
          <circle cx="14" cy="15" r="2.5" className="rw-art-dot" />
          <circle cx="24" cy="15" r="2.5" className="rw-art-dot" />
          <circle cx="34" cy="15" r="2.5" className="rw-art-dot" />
          <g transform="translate(15 43)">
            <Icon name="code" size={23} />
          </g>
          <text x="48" y="59" className="rw-art-code">
            src/
          </text>
          <path d="M17 81h55m-55 10h77" className="rw-art-lines" />
        </g>
        <g transform="translate(258 20) rotate(4 72 45)">
          <rect
            x="5"
            y="5"
            width="143"
            height="91"
            rx="12"
            className="rw-art-shadow"
          />
          <rect width="143" height="91" rx="12" className="rw-art-paper" />
          <rect
            x="13"
            y="14"
            width="31"
            height="31"
            rx="8"
            className="rw-art-icon-bg"
          />
          <g transform="translate(20 21)">
            <Icon name="book" size={17} />
          </g>
          <text x="54" y="35" className="rw-art-label">
            Wiki 文档
          </text>
          <path d="M16 61h111m-111 12h81" className="rw-art-lines" />
        </g>
        <g transform="translate(272 140) rotate(-3 65 34)">
          <rect
            x="5"
            y="5"
            width="132"
            height="69"
            rx="12"
            className="rw-art-shadow"
          />
          <rect width="132" height="69" rx="12" className="rw-art-paper" />
          <g transform="translate(15 18)">
            <Icon name="layers" size={23} />
          </g>
          <text x="48" y="35" className="rw-art-label">
            知识卡片
          </text>
          <path d="M48 49h65" className="rw-art-lines" />
        </g>
        <path
          d="M167 38v10m-5-5h10M172 186v8m-4-4h8"
          className="rw-art-spark"
        />
        <circle cx="413" cy="126" r="3" className="rw-art-dot" />
      </svg>
    </div>
  );
}
export type ProjectCollectionProps = {
  projects: CollectionProject[];
  loading: boolean;
  hostManaged?: boolean;
  hostProjects?: HostProjectSummary[];
  onSelectHost?: (project: HostProjectSummary) => void;
  preferredProjectId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRefresh: () => void;
  /** Live generation state keyed by knowledgeActivityKey(path); a running task overrides the saved state. */
  activity?: Record<string, KnowledgeActivity>;
};
export function ProjectCollection({
  projects,
  loading,
  onSelect,
  onCreate,
  onRefresh,
  hostManaged = false,
  preferredProjectId,
  hostProjects,
  onSelectHost,
  activity,
}: ProjectCollectionProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "generated" | "ungenerated">(
    "all",
  );
  const [view, setView] = useState<"grid" | "list">("grid");
  const repositories = useMemo(() => {
    const wiki = groupCollectionProjects(projects, preferredProjectId);
    // Host display identities remain separate from persisted Wiki IDs.
    return hostProjects
      ? hostProjects.map((host) => ({ key: host.key, name: host.name, path: host.path, host, wiki: wiki.find((item) => item.path === host.path) }))
      : wiki.map((item) => ({ key: item.id, name: item.name, path: item.path, host: undefined, wiki: item }));
  }, [projects, preferredProjectId, hostProjects]);
  const visible = useMemo(
    () =>
      repositories.filter((project) => {
        const needle = query.trim().toLocaleLowerCase();
        return (
          (!needle ||
            `${project.name} ${project.path}`
              .toLocaleLowerCase()
              .includes(needle)) &&
          (filter === "all" || (project.wiki ? generatedState(project.wiki) : "unknown") === filter)
        );
      }),
    [repositories, query, filter],
  );
  return (
    <section className="rw-project-collection" aria-label="Repo Wiki 项目集合">
      <header className="rw-collection-heading">
        <div>
          <span className="rw-collection-kicker">
            <Icon name="branch" size={15} />
            项目知识工作台
          </span>
          <h1>Gren RepoWiki</h1>
          <p>从源码到可维护的项目知识</p>
          {!hostManaged && <button
            type="button"
            className="rw-connect-project"
            onClick={onCreate}
          >
            <Icon name="plus" size={15} />
            连接仓库
          </button>}
        </div>
        <CollectionIllustration />
      </header>
      <div
        className="rw-collection-controls"
        role="group"
        aria-label="项目筛选与视图"
      >
        <div
          className="rw-project-filters"
          role="group"
          aria-label="项目生成状态筛选"
        >
          {(
            [
              ["all", "全部"],
              ["generated", "已生成"],
              ["ungenerated", "未生成"],
            ] as const
          ).map(([value, title]) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {title}
            </button>
          ))}
        </div>
        <label className="rw-collection-search">
          <Icon name="search" size={16} />
          <input
            aria-label="搜索 Repo Wiki 项目"
            placeholder="搜索项目名称或路径…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="rw-collection-view-actions">
          <button
            type="button"
            className="rw-collection-refresh"
            aria-label="刷新项目"
            title="刷新项目"
            disabled={loading}
            onClick={onRefresh}
          >
            <Icon name="refresh" size={16} />
          </button>
          <div
            className="rw-layout-switch"
            role="group"
            aria-label="项目显示方式"
          >
            <button
              type="button"
              aria-label="网格视图"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <LayoutIcon />
            </button>
            <button
              type="button"
              aria-label="列表视图"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <LayoutIcon list />
            </button>
          </div>
        </div>
      </div>
      {loading && !repositories.length ? (
        <p className="rw-collection-empty" role="status">
          正在读取本地项目…
        </p>
      ) : visible.length ? (
        <ul
          className={`rw-projects rw-projects-${view}`}
          aria-label="仓库项目"
          aria-busy={loading}
        >
          {visible.map((project) => {
            const wiki = project.wiki ? projectTargetCount(project.wiki, "wiki") : undefined,
              cards = project.wiki ? projectTargetCount(project.wiki, "cards") : undefined,
              state = project.wiki ? generatedState(project.wiki) : "unknown",
              updated = project.wiki ? updatedAt(project.wiki) : undefined,
              live = activity?.[knowledgeActivityKey(project.path)];
            return (
              <li key={project.key}>
                <button
                  type="button"
                  className={`rw-project-tile ${state}${live ? ` live ${live.tone}` : ""}`}
                  onClick={() => project.host ? onSelectHost?.(project.host) : project.wiki && onSelect(project.wiki.id)}
                  aria-label={`打开项目 ${project.name}`}
                >
                  <span className="rw-project-symbol">
                    <Icon name="branch" size={22} />
                  </span>
                  <span className="rw-project-info">
                    <strong title={project.name}>{project.name}</strong>
                    <span className="rw-project-counts">
                      <span
                        aria-label={`Wiki 文档 ${wiki ?? "数量未知"}`}
                        title="Wiki 文档"
                      >
                        <Icon name="file" size={14} />
                        {wiki ?? "—"}
                      </span>
                      <span
                        aria-label={`知识卡片 ${cards ?? "数量未知"}`}
                        title="知识卡片"
                      >
                        <Icon name="layers" size={14} />
                        {cards ?? "—"}
                      </span>
                    </span>
                  </span>
                  {live ? (
                    <span className={`rw-project-state live ${live.tone}`} data-testid="project-live-state" aria-live="polite">
                      {live.tone === "running" && <span className="rw-project-pulse" aria-hidden="true" />}
                      {live.label}
                    </span>
                  ) : (
                    <span className={`rw-project-state ${state}`}>
                      {state === "generated"
                        ? "已生成"
                        : state === "ungenerated"
                          ? "未生成"
                          : "待同步"}
                    </span>
                  )}
                  {live?.progress !== undefined && (
                    <span className="rw-project-progress" aria-hidden="true"><span style={{ width: `${live.progress}%` }} /></span>
                  )}
                  <span className="rw-project-update">
                    {live ? (
                      <span>{live.detail} <Icon name="arrow" size={14} /></span>
                    ) : state === "generated" ? (
                      <span title={formatTimestamp(updated, true)}>
                        {formatTimestamp(updated)
                          ? `更新于 ${formatTimestamp(updated)}`
                          : "尚无更新时间"}
                      </span>
                    ) : (
                      <span>
                        {project.wiki ? "去生成" : "打开后读取知识"} <Icon name="arrow" size={14} />
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rw-collection-empty" role="status">
          <Icon name="folder" size={28} />
          <p>{repositories.length ? "没有匹配的项目" : hostManaged ? "还没有打开的项目" : "还没有连接仓库"}</p>
          <span>
            {repositories.length
              ? "调整搜索词或生成状态筛选。"
              : hostManaged ? "在侧栏打开项目后，Wiki 与知识卡片会自动出现在这里。" : "连接本地 Git 仓库，开始生成 Wiki 与知识卡片。"}
          </span>
          {!repositories.length && !hostManaged && (
            <button
              type="button"
              className="rw-empty-connect"
              onClick={onCreate}
            >
              连接仓库 <Icon name="arrow" size={14} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
