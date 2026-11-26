import { useMemo, useState } from 'react';
import { Checkbox, Input, Pagination } from 'antd';
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from 'lucide-react';
import { cx } from 'antd-style';
import { cleanUsageTitle, type SessionUsage } from '../../lib/usageReport';
import { openWorkbenchSession } from '../../lib/openWorkbenchSession';
import { isUnder } from '../../lib/pathUtils';
import { useSessionStore } from '../../store';
import { friendlyTime } from '../sessions/useConversations';
import { exactUsageTokens, formatTableCost, formatUsageCount, formatUsageTokens } from './usageFormat';
import styles from './UsagePanel.module.css';

type SortKey = 'time' | 'tokens' | 'cost';
const columns = [['time', '时间'], ['tokens', 'Token'], ['cost', '费用']] as const;
const pageSize = 15;
const searchKey = (text: string) => text.trim().normalize('NFKC').toLocaleLowerCase();
const byDate = (a: number | null, b: number | null, ascending = false) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : (ascending ? a - b : b - a);

export function RecentUsageSessions({ sessions }: { sessions: SessionUsage[] }) {
  const allSessions = useSessionStore(s => s.allSessions);
  const worksDir = useSessionStore(s => s.worksDir);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'time', asc: false });
  const [page, setPage] = useState(1);
  const rows = useMemo(() => {
    const directory = new Map(allSessions.map(s => [s.path, s]));
    return sessions.map(s => {
      const listed = directory.get(s.path);
      const cwd = listed?.cwd ?? s.cwd;
      const global = s.projectId === 'global' || (!s.projectId && (!cwd || (!!worksDir && isUnder(cwd, worksDir))));
      const project = global ? '全局对话' : cleanUsageTitle(cwd?.split(/[\\/]/).filter(Boolean).at(-1)) || cwd || '未知项目';
      const title = cleanUsageTitle(listed?.name) || cleanUsageTitle(s.name) || (global ? friendlyTime(s.timestamp) : '新对话');
      const ms = s.timestamp ? Date.parse(s.timestamp) : NaN;
      return { ...s, project, title, cwd, time: Number.isFinite(ms) ? ms : null, key: searchKey(title),
        openCwd: listed && !listed.archived ? cwd : null,
        unavailable: listed?.archived ? '已归档，可在归档列表只读查看' : '会话已不在侧栏，保留用量记录' };
    });
  }, [sessions, allSessions, worksDir]);

  const matches = useMemo(() => {
    const needle = searchKey(query);
    const items = rows.filter(r => (!hideEmpty || r.tokens !== 0 || r.cost !== 0) && r.key.includes(needle));
    items.sort((a,b) => {
      const primary = sort.key === 'time' ? byDate(a.time, b.time, sort.asc) : (a[sort.key] - b[sort.key]) * (sort.asc ? 1 : -1);
      return primary || byDate(a.time, b.time) || a.id.localeCompare(b.id);
    });
    return items;
  }, [rows, hideEmpty, query, sort]);
  const current = Math.min(page, Math.max(1, Math.ceil(matches.length / pageSize)));
  const cycle = (key: SortKey) => { setSort(s => ({ key, asc: s.key === key && !s.asc })); setPage(1); };

  return <section className={styles.card} aria-label="最近会话">
    <div className={styles.recentHead}>
      <h2 className={styles.cardTitle}>最近会话 <span className={styles.count}>{formatUsageCount(matches.length)}</span></h2>
      <div className={styles.recentTools}>
        <Checkbox checked={hideEmpty} title="空对话指 Token 和费用均为零" onChange={e => { setHideEmpty(e.target.checked); setPage(1); }}>隐藏 0 Token 空对话</Checkbox>
        <Input className={styles.search} size="small" allowClear prefix={<Search size={13} aria-hidden/>}
          aria-label="搜索会话名称" placeholder="搜索会话名称" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}/>
      </div>
    </div>
    <div className={styles.recentScroll}><table className={cx(styles.table, styles.recentTable)} aria-label="会话用量">
      <thead><tr><th scope="col" className={styles.th}>会话</th>
        {columns.map(([key,label]) => {
          const active = key === sort.key, Icon = active ? (sort.asc ? ArrowUp : ArrowDown) : ChevronsUpDown;
          return <th scope="col" key={key} className={key === 'time' ? styles.th : styles.thRight}
            aria-sort={active ? (sort.asc ? 'ascending' : 'descending') : undefined}>
            <button type="button" className={styles.sort} aria-label={'按' + label + '排序'} data-usage-sort={key} onClick={() => cycle(key)}>
              {label}<Icon size={12} aria-hidden/></button>
          </th>;
        })}
      </tr></thead>
      <tbody>{matches.slice((current - 1) * pageSize, current * pageSize).map(r => {
        const open = r.openCwd ? () => openWorkbenchSession(r.openCwd!, r.path) : undefined;
        return <tr key={r.path} data-usage-session={r.id} className={open ? styles.tr : undefined} onClick={open}>
          <td className={styles.td}><div className={styles.sessionIdentity}>
            <span className={styles.projectBadge} title={r.cwd || r.project}>{r.project}</span>
            {open ? <button className={styles.sessionLink} type="button" title={r.title}
              onClick={e => { e.stopPropagation(); open(); }}>{r.title}</button>
              : <span className={styles.sessionName} title={r.title + ' · ' + r.unavailable}>{r.title}</span>}
          </div></td>
          <td className={styles.td}>{r.time === null ? '—' : new Date(r.time).toLocaleString()}</td>
          <td className={cx(styles.tdRight, 'font-mono')} title={exactUsageTokens(r.tokens)}>{formatUsageTokens(r.tokens)}</td>
          <td className={cx(styles.tdRight, r.cost === 0 && styles.zero)}>{formatTableCost(r.cost)}</td>
        </tr>;
      })}
      {!matches.length && <tr><td colSpan={4} className={styles.noRows}>{query.trim() ? '没有匹配的会话' : rows.length ? '没有非空会话' : '暂无会话'}</td></tr>}
      </tbody>
    </table></div>
    {matches.length > pageSize && <div className={styles.pager}><Pagination aria-label="最近会话分页" size="small"
      current={current} total={matches.length} pageSize={pageSize} showSizeChanger={false} onChange={setPage}/></div>}
  </section>;
}
