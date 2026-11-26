import { Input, Segmented, Switch, Tooltip } from 'antd';
import { FileText, Search, TriangleAlert } from 'lucide-react';
import type { RuleInfo, RuleScope } from '../../lib/promptLibraryIo';
import { MODE_LABELS } from '../../stores/modeStore';
import { libraryStyles as library } from './libraryStyles';
import { ruleStyles as s } from './ruleStyles';

export type RuleFilter = 'all' | RuleScope;
export const scopeLabel = { all: '全部', global: '全局', project: '项目' };
export const modeSummary = (rule: Pick<RuleInfo, 'modes'>) =>
  rule.modes?.length ? rule.modes.map(mode => MODE_LABELS[mode]).join('、') : '全部模式';

/** 同名项目目录也不能只靠悬停区分：只给冲突的项目名追加必要的上级目录。 */
export function repositoryLabels(rules: RuleInfo[]) {
  const roots = new Set(rules.flatMap(rule => rule.builtinProject ? [rule.builtinProject] : []));
  const suffixCounts = new Map<string, number>();
  const parts = [...roots].map(root => [root, root.split(/[\\/]/).filter(Boolean)] as const);
  for (const [, segments] of parts) {
    for (let i = 0; i < segments.length; i++) {
      const suffix = segments.slice(i).join(' / ');
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
    }
  }
  return new Map(parts.map(([root, segments]) => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const suffix = segments.slice(i).join(' / ');
      if (suffixCounts.get(suffix) === 1) return [root, suffix];
    }
    return [root, root];
  }));
}

// Keep the native separator and the identifying end of the path; CSS clips from the head if still tight.
function shortDirectory(path: string) {
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  const root = path.startsWith('\\\\') ? '\\\\' + parts[0] + separator : /^[A-Z]:$/i.test(parts[0]) ? parts[0] + separator : separator;
  return root + '…' + separator + parts.slice(-2).join(separator);
}

interface CatalogProps {
  query: string;
  onQuery: (query: string) => void;
  filter: RuleFilter;
  onFilter: (filter: RuleFilter) => void;
  projects: Map<string, string>;
  matches: RuleInfo[];
  visible: RuleInfo[];
  selected?: RuleInfo;
  busy: boolean;
  onSelect: (rule: RuleInfo) => void;
  onToggle: (rule: RuleInfo, enabled: boolean) => void;
}

export function RuleCatalog({ query, onQuery, filter, onFilter, projects, matches, visible, selected, busy, onSelect, onToggle }: CatalogProps) {
  const global = matches.filter(r => r.scope === 'global').length;
  const counts = { all: matches.length, global, project: matches.length - global };
  return <div className={library.list} data-testid="rule-list" data-library-list>
    <div className={s.controls}>
      <Input allowClear prefix={<Search size={14} />} placeholder="搜索项目、规则或正文" aria-label="搜索规则"
        data-testid="rule-search" value={query} onChange={e => onQuery(e.target.value)} disabled={busy} />
      <Segmented<RuleFilter> block size="small" value={filter} disabled={busy} onChange={onFilter}
        options={(['all', 'global', 'project'] as const).map(value => ({ value,
          label: <span data-testid={'rule-filter-' + value}>{scopeLabel[value]} ({counts[value]})</span>
        }))} />
    </div>
    <div className={library.rows} data-testid="rule-list-scroll">
      {!visible.length && <div className={library.empty}>{query.trim() ? '没有匹配的规则' : '还没有规则'}</div>}
      {(['custom', 'builtin'] as const).map(kind => {
        const rows = visible.filter(r => Boolean(r.builtinProject) === (kind === 'builtin'));
        if (!rows.length) return null;
        return <div key={kind}>
          {filter === 'all' && <h4 className={s.group}>{kind === 'custom' ? '自定义规则' : '仓库内置约定'}</h4>}
          {rows.map(rule => {
            const key = rule.scope + '-' + rule.id;
            const active = rule === selected;
            const project = rule.builtinProject;
            return <div key={key} className={library.rowWrap} data-testid={'rule-item-' + key} data-active={active} data-enabled={rule.enabled}>
              <span className={s.leading}>{project ? <FileText size={16} aria-hidden /> :
                <Switch size="small" checked={rule.enabled} disabled={busy || !!rule.error} aria-label={'启用' + rule.title}
                  data-testid={'rule-toggle-' + key} onChange={checked => onToggle(rule, checked)} />}</span>
              <button className={library.rowOpen} type="button" disabled={busy} data-testid={'rule-open-' + key}
                aria-pressed={active} onClick={() => onSelect(rule)}>
                <span className={s.rowTitle}>
                  <span title={project ? projects.get(project) : rule.title}>{project ? projects.get(project) : rule.title}</span>
                  {project && <code className={s.filename} title={rule.title}>{rule.title}</code>}
                  {rule.error && <Tooltip title={rule.error}><TriangleAlert size={14} className={library.warn} data-testid={'rule-warning-' + key} /></Tooltip>}
                </span>
                {project ? <Tooltip title={rule.path} mouseEnterDelay={0.25}>
                  <small className={s.directory} aria-label={project}><bdi dir="ltr">{shortDirectory(project)}</bdi></small>
                </Tooltip> : <span className={library.ruleMeta}><span data-testid={'rule-origin-' + key}>{scopeLabel[rule.scope]}</span><span>·</span>
                  <span className={library.modesBadge} data-testid={'rule-modes-' + key}>{modeSummary(rule)}{rule.globs?.length ? ' · Glob' : ''}</span></span>}
              </button>
            </div>;
          })}
        </div>;
      })}
    </div>
  </div>;
}
