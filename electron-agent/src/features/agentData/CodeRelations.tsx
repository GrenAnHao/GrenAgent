import { useEffect, useRef, useState } from 'react';
import { agentDataApi, type CodeTool } from '../../lib/agentData';
import { decodeCodeResult, retainedCodeResult, type CodeResultRow, type CodeResultView } from './codeResult';
import { codeStyles as styles } from './codeStyles';

export interface CodeRelationsProps { workspace: string; symbol: string; nodeId?: string; file?: string; visible: boolean; reloadVersion?: number }
const relationTabs = [
  { tool: 'codegraph_callers', label: '调用者' },
  { tool: 'codegraph_callees', label: '被调用者' },
  { tool: 'codegraph_impact', label: '影响' },
] as const;
type RelationTool = typeof relationTabs[number]['tool'];

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
    <div className={styles.toolbar} role="tablist" aria-label="关系类型">{relationTabs.map((item) => <button type="button" className={styles.button} role="tab" key={item.tool} aria-selected={tab === item.tool} onClick={() => { if (tab !== item.tool) { epoch.current++; setTab(item.tool); } }}>{item.label}</button>)}</div>
    <div className={styles.hint}>当前符号：{symbol}{file ? ` · ${file}` : ' · 未提供文件位置'}</div>
    <button type="button" className={styles.button} disabled={!visible || current?.loading} onClick={() => setVersion((value) => value + 1)}>刷新关系</button>
    {current?.loading ? <p className={styles.hint} role="status">正在查询关系…</p> : null}
    {current?.error ? <div className={styles.error} role="alert">{current.error}{current.result ? ' 当前显示上次成功读取的结果。' : ''}</div> : null}
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

export function CodeResultContent({ result, retained, onSelect, selected, tool }: { result: CodeResultView; retained?: CodeResultView; onSelect?: (row: CodeResultRow, element: HTMLButtonElement) => void; selected?: CodeResultRow; tool?: CodeTool }) {
  return <>
    {result.isError ? <div className={styles.error} role="alert">{codeRequestError(result.text ?? result.message ?? 'CodeGraph 返回错误，详情见原始结果。')}</div> : null}
    {retained && (retained.rows.length > 0 || retained.recognition !== 'rows') ? <>
      <p className={styles.hint}>本次查询失败，保留上次成功读取的结果。</p>
      <CodeResultContent result={retained} onSelect={onSelect} selected={selected} tool={tool} />
    </> : null}
    {result.message ? <p className={styles.hint}>{result.message}</p> : null}
    {result.recognition === 'rows' && result.rows.length === 0 && !result.isError ? <div className={styles.state}>没有匹配结果</div> : null}
    {result.rows.length ? <ul className={styles.results} aria-label={tool === 'codegraph_files' ? '代码文件列表' : '代码结果'}>{result.rows.map((row, index) => {
      const content = <><strong>{row.symbol ?? row.file}</strong>{row.symbol ? <span className={styles.hint}>{row.file ?? '未提供文件位置'}</span> : null}<span className={styles.hint}>{row.line === undefined ? '未提供行号' : `第 ${row.line} 行`}</span>{row.snippet ? <span className={styles.text}>{row.snippet}</span> : null}</>;
      return <li key={`${row.file ?? ''}:${row.symbol ?? ''}:${row.line ?? ''}:${index}`}>{onSelect
        ? <button type="button" className={styles.result} aria-pressed={selected?.file === row.file && selected?.symbol === row.symbol && selected?.line === row.line} onClick={(event) => onSelect(row, event.currentTarget)}>{content}</button>
        : <div className={styles.result}>{content}</div>}</li>;
    })}</ul> : null}
    {result.recognition === 'text' ? <pre className={styles.text}>{result.text}</pre> : null}
    {result.recognition === 'unknown' ? <div className={styles.state}>返回格式未识别，请展开原始结果查看。</div> : null}
    <details className={styles.raw}><summary>原始结果</summary><pre>{JSON.stringify(result.raw, null, 2) ?? String(result.raw)}</pre></details>
  </>;
}
