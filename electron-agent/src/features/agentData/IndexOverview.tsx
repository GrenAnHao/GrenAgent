import { useEffect, useState } from 'react';
import { Button } from 'antd';
import { agentDataApi } from '../../lib/agentData';
import { decodeCodeResult, type CodeResultView, type CodeResultRow } from './codeResult';
import { browseStyles as s } from './codeBrowseStyles';

const colors = [
  'var(--ant-color-primary)',
  'var(--ant-color-info)',
  'var(--ant-color-warning)',
  'var(--ant-color-success)',
  'var(--ant-color-text-tertiary)',
];
const labels: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  tsx: 'TSX',
  jsx: 'JSX',
  cpp: 'C++',
  csharp: 'C#',
  yaml: 'YAML',
  php: 'PHP',
  unknown: '其他',
};
const label = (lang: string) => labels[lang] ?? lang.charAt(0).toUpperCase() + lang.slice(1);

export function IndexOverview({
  workspace,
  enabled,
  hideIgnored,
  revision,
  onSelect,
}: {
  workspace: string;
  enabled: boolean;
  hideIgnored: boolean;
  revision: number;
  onSelect: (row: CodeResultRow, el: HTMLElement) => void;
}) {
  const [view, setView] = useState<CodeResultView>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setError('');
    void agentDataApi.code
      .overview(workspace, hideIgnored)
      .then((raw) => {
        if (!live) return;
        const next = decodeCodeResult('codegraph_files', raw);
        if (next.isError || !next.languages) throw new Error(next.isError ? next.text : '索引服务未提供概览数据');
        setView(next);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [workspace, enabled, hideIgnored, revision, retry]);
  const langs = Object.entries(view?.languages ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = langs.reduce((n, item) => n + item[1], 0);
  const ranked = view?.rows.filter((r) => (r.incomingFiles ?? 0) > 0) ?? [];
  return (
    <section className={s.overview} aria-label="项目索引概览">
      <header>
        <h3>项目索引概览</h3>
      </header>
      {error && (
        <div role="status">
          概览读取失败：{error}{' '}
          <Button type="link" size="small" onClick={() => setRetry((n) => n + 1)}>
            重试
          </Button>
        </div>
      )}
      {!view && !error && <p>{enabled ? '正在读取概览…' : '等候可读索引…'}</p>}
      {view && (
        <>
          <section className={s.lang}>
            <header>
              <h4>语言分布</h4>
              <small>{total.toLocaleString()} 个可见文件</small>
            </header>
            {total ? (
              <>
                <div className={s.band} aria-hidden>
                  {langs.map(([name, n], i) => (
                    <span key={name} style={{ flex: n, background: colors[Math.min(i, 4)] }} />
                  ))}
                </div>
                <div className={s.legend}>
                  {langs.map(([name, n], i) => (
                    <span key={name} title={n + ' 个文件'}>
                      <i style={{ background: colors[Math.min(i, 4)] }} />
                      {label(name)} {Number(((n * 100) / total).toFixed(1))}%
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <small>没有符合当前显示规则的文件</small>
            )}
          </section>
          <header>
            <h4>核心文件</h4>
            <small title="按引用该文件的不同索引文件数排序，不计文件内引用">引用文件数 · 前 10</small>
          </header>
          {ranked.map((row, i) => (
            <button
              key={row.file}
              className={s.rank}
              data-ranked-file={row.file}
              title={row.file}
              onClick={(e) => onSelect(row, e.currentTarget)}
            >
              <small>{String(i + 1).padStart(2, '0')}</small>
              <span>
                <b>{row.file?.split('/').pop()}</b>
                <small>{row.file}</small>
              </span>
              <small>{row.incomingFiles?.toLocaleString()} 引用</small>
            </button>
          ))}
          {!ranked.length && <p>还没有跨文件引用。</p>}
        </>
      )}
    </section>
  );
}

export function IndexFileRelations({
  workspace,
  file,
  enabled,
  revision,
  onSelect,
}: {
  workspace: string;
  file: string;
  enabled: boolean;
  revision: number;
  onSelect: (row: CodeResultRow, el: HTMLElement) => void;
}) {
  const [rows, setRows] = useState<CodeResultRow[]>(),
    [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setError('');
    void agentDataApi.code
      .call({ workspace, tool: 'codegraph_deps', args: { file, direction: 'both' } })
      .then((raw) => {
        if (!live) return;
        const result = decodeCodeResult('codegraph_deps', raw);
        if (result.isError) throw new Error(result.text ?? '无法读取文件依赖');
        setRows(result.rows);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [workspace, file, enabled, revision]);
  const [limit, setLimit] = useState(20);
  return (
    <section aria-label="文件引用关系">
      <strong>文件引用关系</strong>
      {error ? (
        <p role="alert">{error}</p>
      ) : rows?.length ? (
        <>
          {rows.slice(0, limit).map((r, i) => (
            <button key={i} className={s.rank} title={r.file} onClick={(e) => onSelect(r, e.currentTarget)}>
              <span>↳</span>
              <span>{r.file}</span>
              <small>{r.snippet === 'dependent' ? '引用此文件' : '此文件依赖'}</small>
            </button>
          ))}
          {rows.length > limit && (
            <Button type="link" onClick={() => setLimit(limit + 20)}>
              更多关系
            </Button>
          )}
        </>
      ) : (
        <p>{rows ? '未发现跨文件依赖' : '正在读取引用关系…'}</p>
      )}
    </section>
  );
}
