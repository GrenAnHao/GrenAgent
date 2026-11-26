import { Button, Input, Tooltip } from 'antd';
import { ArrowRight, Clock3, Folder, FolderPlus, LoaderCircle, Plus, RefreshCw, Search } from 'lucide-react';
import { memo, useMemo, useState, type MouseEvent } from 'react';
import { useSessionStore } from '../../store';
import { pathKey } from '../../lib/pathUtils';
import { formatRelative } from '../../lib/relativeTime';
import { directoryView, indexProgress, isIndexBusy, lastSync, type IndexEntry } from './useIndexDirectory';
import { recentIndexPaths } from './useIndexProjectCatalog';
import { browseStyles as s } from './codeBrowseStyles';
import type { ProjectOption } from './useProjectOptions';
import { MoreMenu } from './workbench/MoreMenu';

export function IndexBadge({ entry }: { entry?: IndexEntry }) {
  const v = directoryView(entry);
  return (
    <span className={s.badge} data-tone={v.color} title={v.banner?.message} data-index-badge>
      {v.label}
    </span>
  );
}

const filters = ['全部', '已索引', '需更新', '未索引'] as const;
type Filter = (typeof filters)[number];
const searchKey = (value: string) => value.trim().toLocaleLowerCase().replace(/\\/g, '/');

function staleReason(status: IndexEntry['status']) {
  if (!status) return '';
  if (status.pendingChanges && status.pendingChanges > 0)
    return status.pendingChanges.toLocaleString() + ' 个文件待更新';
  if (status.state === 'stale') return '索引版本较旧';
  if (status.state === 'partial') return '上次构建未完成';
  if (status.watcher?.degraded) return '文件监听不可用';
  return '上次同步未成功';
}

interface Actions {
  onSelect(path: string): void;
  onSync(path: string, rebuild?: boolean): void;
  onOpen(path: string): void;
  onRemove(path: string): void;
}

const ProjectCard = memo(function ProjectCard({
  option,
  entry,
  onSelect,
  onSync,
  onOpen,
  onRemove,
}: Actions & { option: ProjectOption; entry?: IndexEntry }) {
  const { cwd, name } = option;
  const { label, primary } = directoryView(entry);
  const status = entry?.status,
    busy = isIndexBusy(entry),
    unindexed = label === '未索引';
  const at = lastSync(status),
    reason = label === '需更新' ? staleReason(status) : '';
  const quick = unindexed ? '开始索引' : label === '需更新' ? '立即同步' : undefined;
  const when = at
    ? '同步于 ' + formatRelative(at)
    : unindexed
      ? '尚未同步'
      : status
        ? '无同步时间记录'
        : entry?.error
          ? '状态未能读取'
          : '正在检查状态';
  const foot = busy ? indexProgress(entry) : when + (reason ? ' · ' + reason : '');
  const launch = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onSync(cwd);
  };
  return (
    <article
      className={s.card}
      data-project-card={cwd}
      data-quick={quick ? 'true' : undefined}
      data-first-build={unindexed || undefined}
    >
      <button type="button" className={s.cardMain} aria-label={'打开项目 ' + name} onClick={() => onSelect(cwd)}>
        <span className={s.cardHead}>
          <span className={s.folderIcon}>
            <Folder size={18} />
          </span>
          <IndexBadge entry={entry} />
        </span>
        <strong title={name}>{name}</strong>
        <Tooltip title={cwd} placement="topLeft">
          <span className={s.cardPath} data-project-path>
            {cwd}
          </span>
        </Tooltip>
        <span className={s.cardMetrics} data-project-metrics>
          {unindexed
            ? '尚未建立代码图谱'
            : status?.indexed
              ? (['files', 'nodes', 'edges'] as const).map((k, i) => (
                  <span key={k}>
                    <b>{status[k]?.toLocaleString() ?? '—'}</b> {['文件', '节点', '边'][i]}
                  </span>
                ))
              : busy
                ? '正在建立代码图谱'
                : entry?.error
                  ? '索引统计暂不可用'
                  : '正在读取索引统计…'}
        </span>
        <span className={s.cardFoot}>
          {busy ? <LoaderCircle size={13} className={s.spin} /> : <Clock3 size={13} />}
          <span
            data-card-status
            title={busy ? foot : [at && new Date(at).toLocaleString(), reason].filter(Boolean).join(' · ') || foot}
          >
            {foot}
          </span>
          <ArrowRight size={15} data-card-arrow aria-hidden />
        </span>
      </button>
      <div className={s.cardMenu}>
        <MoreMenu
          quiet
          label={name + '的更多操作'}
          items={[
            { key: 'open', label: '在资源管理器中打开目录' },
            { key: 'rebuild', label: '立即重新索引', disabled: busy || primary === 'none' },
            { key: 'remove', label: '从列表中移除项目', danger: true, disabled: busy },
          ]}
          onSelect={(key) => {
            if (key === 'open') onOpen(cwd);
            else if (key === 'rebuild') onSync(cwd, true);
            else if (key === 'remove') onRemove(cwd);
          }}
        />
      </div>
      {quick && !busy && (
        <button type="button" className={s.quick} data-card-quick onClick={launch}>
          {quick}
          <ArrowRight size={12} />
        </button>
      )}
    </article>
  );
});

export function CodeProjectHome({
  options,
  entries,
  onAdd,
  onSyncAll,
  staleCount,
  ...actions
}: Actions & {
  options: ProjectOption[];
  entries: Record<string, IndexEntry>;
  onAdd(): void;
  onSyncAll(): void;
  staleCount: number;
}) {
  const sessions = useSessionStore((state) => state.allSessions);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('全部');
  const many = options.length > 6;
  const recent = useMemo(() => {
    const visits = new Map(recentIndexPaths().map((key, i) => [key, i]));
    const last = new Map<string, number>();
    for (const session of sessions) {
      if (!session.cwd || !session.timestamp) continue;
      const key = pathKey(session.cwd);
      last.set(key, Math.max(last.get(key) ?? 0, Date.parse(session.timestamp) || 0));
    }
    return [...options].sort((a, b) => {
      const x = pathKey(a.cwd),
        y = pathKey(b.cwd);
      return (visits.get(x) ?? Infinity) - (visits.get(y) ?? Infinity) || (last.get(y) ?? 0) - (last.get(x) ?? 0);
    });
  }, [options, sessions]);
  const term = searchKey(query);
  const visible = many
    ? recent.filter((p) => {
        const entry = entries[pathKey(p.cwd)];
        return (
          (filter === '全部' ||
            directoryView(entry).label === filter ||
            (isIndexBusy(entry) && entry?.syncFrom === filter)) &&
          (!term || searchKey(p.name).includes(term) || searchKey(p.cwd).includes(term))
        );
      })
    : recent;
  const bulk = (
    <Button
      data-sync-stale
      type="text"
      className={s.syncAll}
      icon={<RefreshCw size={14} />}
      disabled={!staleCount}
      onClick={onSyncAll}
    >
      同步全部待更新项目{staleCount > 0 ? ' (' + staleCount + ')' : ''}
    </Button>
  );
  return (
    <div className={s.home} data-project-scroll>
      <section className={s.homeInner} aria-label="最近项目">
        <div className={s.homeHead}>
          <h3>{options.length ? '最近项目' : '添加第一个项目'}</h3>
          <div className={s.homeActions}>
            {!many && staleCount > 0 && bulk}
            <Button type="primary" icon={<Plus size={16} />} onClick={onAdd}>
              添加本地项目
            </Button>
          </div>
        </div>
        {many && (
          <div className={s.filters}>
            <Input
              className={s.filterSearch}
              aria-label="搜索项目名称或路径"
              placeholder="搜索项目名称或路径"
              prefix={<Search size={15} />}
              allowClear
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className={s.filterPills} role="group" aria-label="索引状态筛选">
              {filters.map((item) => (
                <button
                  key={item}
                  type="button"
                  data-status-filter={item}
                  aria-pressed={filter === item}
                  onClick={() => setFilter(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            {bulk}
          </div>
        )}
        {visible.length ? (
          <div className={s.cards}>
            {visible.map((o) => (
              <ProjectCard key={pathKey(o.cwd)} option={o} entry={entries[pathKey(o.cwd)]} {...actions} />
            ))}
          </div>
        ) : options.length ? (
          <div className={s.noMatch}>
            <Search size={22} />
            <strong>没有匹配的项目</strong>
            <Button
              data-clear-filters
              type="link"
              onClick={() => {
                setQuery('');
                setFilter('全部');
              }}
            >
              清除筛选
            </Button>
          </div>
        ) : (
          <button className={s.dropArea} onClick={onAdd}>
            <FolderPlus size={30} />
            <strong>选择本地目录</strong>
            <span>添加后即可查看索引状态和源码。</span>
          </button>
        )}
      </section>
    </div>
  );
}
