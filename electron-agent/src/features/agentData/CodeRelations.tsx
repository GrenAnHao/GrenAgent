import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Listy, Segmented, Typography } from 'antd';
import { agentDataApi, type CodeTool } from '../../lib/agentData';
import { CODE_PAGE_SIZE, decodeCodeResult, retainedCodeResult, type CodeResultRow, type CodeResultView } from './codeResult';
import { codeStyles as styles } from './codeStyles';
import { listRowStyles as rows } from './listRowStyles';

export interface CodeRelationsProps { workspace: string; symbol: string; nodeId?: string; file?: string; visible: boolean; reloadVersion?: number }
const relationTabs = [
  { tool: 'codegraph_callers', label: '调用者' },
  { tool: 'codegraph_callees', label: '被调用者' },
  { tool: 'codegraph_impact', label: '影响' },
] as const;
type RelationTool = typeof relationTabs[number]['tool'];
// Listy 自带的条目内边距交给行本身，否则可点区域会比条目小一圈。
const listyItemFlush = { item: { padding: 0 } };
/** 原始结果展开后最多显示的字符数，超出部分截断并注明。 */
const RAW_PREVIEW_LIMIT = 200_000;

export function CodeRelations({ workspace, symbol, nodeId, file, visible, reloadVersion = 0 }: CodeRelationsProps) {
  const [tab, setTab] = useState<RelationTool>('codegraph_callers');
  const key = `${workspace}\0${nodeId ?? symbol}\0${file ?? ''}\0${tab}`;
  const epoch = useRef(0);
  const [state, setState] = useState<{ key: string; result?: CodeResultView; retained?: CodeResultView; error?: string; loading: boolean }>({ key, loading: false });
  const current = state.key === key ? state : undefined;

  useEffect(() => {
    const request = ++epoch.current;
    if (!visible || !symbol) return;
    setState((old) => ({ key, result: old.key === key ? old.result : undefined, retained: old.key === key ? old.retained : undefined, loading: true }));
    void agentDataApi.code.call({ workspace, tool: tab, args: { symbol: nodeId ?? symbol, ...(file ? { file } : {}) } })
      .then((raw) => {
        if (request !== epoch.current) return;
        const result = decodeCodeResult(tab, raw);
        setState((old) => ({ key, result, retained: retainedCodeResult(result, old.result, old.retained), loading: false }));
      })
      .catch((cause) => {
        if (request === epoch.current) setState((old) => ({ ...old, loading: false, error: codeRequestError(cause) }));
      });
    return () => { epoch.current++; };
  }, [workspace, symbol, nodeId, file, tab, key, visible, reloadVersion]);

  return <section aria-label="代码关系">
    <Segmented id="code-relations" size="small" value={tab} onChange={(next) => { if (next !== tab) { epoch.current++; setTab(next as RelationTool); } }} options={relationTabs.map((item) => ({ value: item.tool, label: item.label }))} />
    <Typography.Text type="secondary">当前符号：{symbol}{file ? ` · ${file}` : ' · 未提供文件位置'}</Typography.Text>
    {current?.loading ? <Typography.Text type="secondary" role="status">正在查询关系…</Typography.Text> : null}
    {current?.error ? <Alert type="error" showIcon title={`${current.error}${current.result ? ' 当前显示上次成功读取的结果。' : ''}`} /> : null}
    {current?.result ? <CodeResultContent key={key} result={current.result} retained={current.retained} /> : null}
  </section>;
}

export function codeRequestError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/CodeGraph SDK unavailable/i.test(message)) return `内置 CodeGraph SDK 不可用：${message}`;
  if (/spawn.*ENOENT|COMMAND[_ -]?MISSING|command\s+not found|codegraph(?:\s+CLI)?\s*:?\s*(?:not found|missing)|不是内部或外部命令/i.test(message)) return `CodeGraph CLI 不可用：${message}`;
  if (/not indexed|no index|index.*(?:not found|missing)|索引.*(?:不存在|缺失)/i.test(message)) return `CodeGraph 索引缺失：${message}`;
  return `查询失败：${message}`;
}

/** 结果由服务端分页：画全部已加载的行，「显示更多」改为向调用方要下一页，不再在前端切页。remaining 为 0（最后一页已到）时不显示按钮，但仍要传。 */
export interface MoreRows { remaining: number; loading: boolean; onLoad: () => void }

export function CodeResultContent({ result, retained, onSelect, selected, tool, more }: { result: CodeResultView; retained?: CodeResultView; onSelect?: (row: CodeResultRow, element: HTMLElement) => void; selected?: CodeResultRow; tool?: CodeTool; more?: MoreRows }) {
  return <>
    {result.isError ? <Alert type="error" showIcon title={codeRequestError(result.text ?? result.message ?? 'CodeGraph 返回错误，详情见原始结果。')} /> : null}
    {retained && (retained.rows.length > 0 || retained.recognition !== 'rows') ? <>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>本次查询失败，保留上次成功读取的结果。</Typography.Text>
      <CodeResultContent result={retained} onSelect={onSelect} selected={selected} tool={tool} />
    </> : null}
    {result.message ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{result.message}</Typography.Text> : null}
    {result.recognition === 'rows' && result.rows.length === 0 && !result.isError ? <Empty description="没有匹配结果" /> : null}
    {result.rows.length ? <ResultRows items={result.rows} onSelect={onSelect} selected={selected} tool={tool} more={more} /> : null}
    {result.recognition === 'text' ? <pre className={styles.text}>{result.text}</pre> : null}
    {result.recognition === 'unknown' ? <Empty description="返回格式未识别，请展开原始结果查看。" /> : null}
    <RawResult raw={result.raw} />
  </>;
}

interface ResultRowsProps { items: CodeResultRow[]; onSelect?: (row: CodeResultRow, element: HTMLElement) => void; selected?: CodeResultRow; tool?: CodeTool; more?: MoreRows }

/** 结果行分页渲染：默认在前端按页切；服务端分页时（more）画全部已加载的行。换查询时由调用方用 key 重置已展开的页数。 */
function ResultRows({ items, onSelect, selected, tool, more }: ResultRowsProps) {
  const [limit, setLimit] = useState(CODE_PAGE_SIZE);
  const shown = more ? items : items.slice(0, limit);
  const remaining = more ? more.remaining : items.length - shown.length;
  const loading = more?.loading ?? false;
  const showMore = more ? more.onLoad : () => setLimit((current) => current + CODE_PAGE_SIZE);
  return <div className={rows.group} aria-label={tool === 'codegraph_files' ? '代码文件列表' : '代码结果'}>
    <Listy
      items={shown.map((row, index) => ({ ...row, rowKey: `${row.file ?? ''}:${row.symbol ?? ''}:${row.line ?? ''}:${index}` }))}
      rowKey={(row: { rowKey: string }) => row.rowKey}
      styles={listyItemFlush}
      itemRender={(row: CodeResultRow & { rowKey: string }) => {
        // 不能包成 Fragment：antd Button 会把 Fragment 整体包进一个 span，行内元素就不再纵向堆叠。
        const content = [
          <Typography.Text key="name" strong>{row.symbol ?? row.file}</Typography.Text>,
          row.symbol ? <Typography.Text key="file" type="secondary" style={{ fontSize: 12 }}>{row.file ?? '未提供文件位置'}</Typography.Text> : null,
          <Typography.Text key="line" type="secondary" style={{ fontSize: 12 }}>{row.line === undefined ? '未提供行号' : `第 ${row.line} 行`}</Typography.Text>,
          row.snippet ? <Typography.Text key="snippet">{row.snippet}</Typography.Text> : null,
        ];
        return onSelect
          ? <Button block type="text" className={`${rows.row} ${rows.flush}`} aria-pressed={selected?.file === row.file && selected?.symbol === row.symbol && selected?.line === row.line} onClick={(event) => onSelect(row as CodeResultRow, event.currentTarget)}>{content}</Button>
          : <div className={rows.row}>{content}</div>;
      }}
    />
    {remaining > 0 ? <div className={styles.loadMore}>
      {/* 用 aria-disabled 而不是 disabled：键盘用户刚按下的按钮被禁用会丢焦点；antd 的 loading 图标带 aria-label="loading"，会混进按钮的可访问名。 */}
      <Button block type="text" aria-disabled={loading || undefined} style={loading ? { cursor: 'progress', opacity: 0.6 } : undefined} onClick={loading ? undefined : showMore}>{loading ? '正在加载…' : `显示更多（还有 ${remaining} 项）`}</Button>
    </div> : null}
  </div>;
}

/** 展开才序列化：折叠着的 details 内容照样在 DOM 里，几万行的结果每次渲染都 stringify 一遍代价不小。 */
function RawResult({ raw }: { raw: unknown }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => open ? JSON.stringify(raw, null, 2) ?? String(raw) : '', [open, raw]);
  const truncated = text.length > RAW_PREVIEW_LIMIT;
  return <details className={styles.raw} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>原始结果</summary>
    {open ? <>
      <pre>{truncated ? text.slice(0, RAW_PREVIEW_LIMIT) : text}</pre>
      {truncated ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>已截断：显示前 {RAW_PREVIEW_LIMIT} 个字符，共 {text.length} 个字符。</Typography.Text> : null}
    </> : null}
  </details>;
}
