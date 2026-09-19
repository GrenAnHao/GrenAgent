import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Listy, Tabs, Typography } from 'antd';
import { agentDataApi, type CodeTool } from '../../lib/agentData';
import { decodeCodeResult, retainedCodeResult, type CodeResultRow, type CodeResultView } from './codeResult';
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

export function CodeRelations({ workspace, symbol, nodeId, file, visible, reloadVersion = 0 }: CodeRelationsProps) {
  const [tab, setTab] = useState<RelationTool>('codegraph_callers');
  const [version, setVersion] = useState(0);
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
  }, [workspace, symbol, nodeId, file, tab, key, visible, version, reloadVersion]);

  return <section className={styles.card} aria-label="代码关系">
    <Tabs id="code-relations" size="small" activeKey={tab} onChange={(next) => { if (next !== tab) { epoch.current++; setTab(next as RelationTool); } }} items={relationTabs.map((item) => ({ key: item.tool, label: item.label }))} />
    <Typography.Text type="secondary">当前符号：{symbol}{file ? ` · ${file}` : ' · 未提供文件位置'}</Typography.Text>
    <Button size="small" disabled={!visible || current?.loading} onClick={() => setVersion((value) => value + 1)}>刷新关系</Button>
    {current?.loading ? <Typography.Text type="secondary" role="status">正在查询关系…</Typography.Text> : null}
    {current?.error ? <Alert type="error" showIcon title={`${current.error}${current.result ? ' 当前显示上次成功读取的结果。' : ''}`} /> : null}
    {current?.result ? <CodeResultContent result={current.result} retained={current.retained} /> : null}
  </section>;
}

export function codeRequestError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/CodeGraph SDK unavailable/i.test(message)) return `内置 CodeGraph SDK 不可用：${message}`;
  if (/spawn.*ENOENT|COMMAND[_ -]?MISSING|command\s+not found|codegraph(?:\s+CLI)?\s*:?\s*(?:not found|missing)|不是内部或外部命令/i.test(message)) return `CodeGraph CLI 不可用：${message}`;
  if (/not indexed|no index|index.*(?:not found|missing)|索引.*(?:不存在|缺失)/i.test(message)) return `CodeGraph 索引缺失：${message}`;
  return `查询失败：${message}`;
}

export function CodeResultContent({ result, retained, onSelect, selected, tool }: { result: CodeResultView; retained?: CodeResultView; onSelect?: (row: CodeResultRow, element: HTMLElement) => void; selected?: CodeResultRow; tool?: CodeTool }) {
  return <>
    {result.isError ? <Alert type="error" showIcon title={codeRequestError(result.text ?? result.message ?? 'CodeGraph 返回错误，详情见原始结果。')} /> : null}
    {retained && (retained.rows.length > 0 || retained.recognition !== 'rows') ? <>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>本次查询失败，保留上次成功读取的结果。</Typography.Text>
      <CodeResultContent result={retained} onSelect={onSelect} selected={selected} tool={tool} />
    </> : null}
    {result.message ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{result.message}</Typography.Text> : null}
    {result.recognition === 'rows' && result.rows.length === 0 && !result.isError ? <Empty description="没有匹配结果" /> : null}
    {result.rows.length ? <div className={rows.group} aria-label={tool === 'codegraph_files' ? '代码文件列表' : '代码结果'}><Listy
      items={result.rows.map((row, index) => ({ ...row, rowKey: `${row.file ?? ''}:${row.symbol ?? ''}:${row.line ?? ''}:${index}` }))}
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
    /></div> : null}
    {result.recognition === 'text' ? <pre className={styles.text}>{result.text}</pre> : null}
    {result.recognition === 'unknown' ? <Empty description="返回格式未识别，请展开原始结果查看。" /> : null}
    <details><summary>原始结果</summary><pre>{JSON.stringify(result.raw, null, 2) ?? String(result.raw)}</pre></details>
  </>;
}
