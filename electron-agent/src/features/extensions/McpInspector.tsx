import { Button, Input, Modal } from 'antd';
import { useEffect, useState } from 'react';
import { pi } from '../../lib/pi';
import type { CatalogTool } from '../../../../extensions/mcp/catalog';
import type { ConnectionDiagnostics } from '../../../../extensions/mcp/diagnostics';
import { cssVar, createStaticStyles } from 'antd-style';

const styles = createStaticStyles(({ css }) => ({
  pre: css`margin: 6px 0 14px; padding: 10px 12px; max-height: 30vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; border-radius: 6px; background: ${cssVar.colorFillQuaternary};`,
  parameters: css`margin:6px 0; max-height:24vh; overflow:auto; font-size:13px;
    > div {padding:6px 0; border-bottom:1px solid ${cssVar.colorBorderSecondary};}
    dt {display:flex; gap:8px; align-items:baseline;} code {overflow-wrap:anywhere;} small, dd {color:${cssVar.colorTextSecondary};}
    dd {margin:2px 0 0;} `,
  failure: css`margin: 0 0 12px; padding: 10px 12px; border: 1px solid ${cssVar.colorErrorBorder}; border-radius: 8px; background: ${cssVar.colorErrorBg}; font-size: 12px; & > p {margin: 6px 0; overflow-wrap:anywhere;} strong {color:${cssVar.colorErrorText};} time {color:${cssVar.colorTextSecondary};} summary {cursor:pointer;}`,
  slow: css`display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; padding:8px 12px; margin-bottom:10px; border-radius:8px; background:${cssVar.colorWarningBg}; color:${cssVar.colorWarningText}; font-size:12px; strong{font-weight:500; font-variant-numeric:tabular-nums;}`,
  actions: css`display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-block:8px;`,
}));

function Parameters({schema}: {schema: unknown}) {
  const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
  const root = obj(schema);
  const fields = Object.entries(obj(root.properties));
  return <>
    {!!fields.length && <dl className={styles.parameters}>{fields.map(([name, definition]) => {
      const field = obj(definition);
      const type = Array.isArray(field.type) ? field.type.filter(t => typeof t === 'string').join(' | ') : typeof field.type === 'string' ? field.type : '';
      return <div key={name}><dt><code>{name}</code><small>{[type, Array.isArray(root.required) && root.required.includes(name) ? '必填' : '可选'].filter(Boolean).join(' · ')}</small></dt>
        {typeof field.description === 'string' && <dd>{field.description}</dd>}</div>;
    })}</dl>}
    {schema != null ? <details open={!fields.length} style={{marginBottom:12}}><summary>完整 inputSchema</summary><pre className={styles.pre}>{JSON.stringify(schema, null, 2)}</pre></details>
      : <p>尚无参数定义，可重载服务器刷新。</p>}
  </>;
}

export function McpToolInspector({ workspace, server, fullName, tool, canCall, close }: {
  workspace: string; server: string; fullName: string; tool?: CatalogTool; canCall: boolean; close: () => void;
}) {
  const [input, setInput] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [failed, setFailed] = useState(false);
  const run = async () => {
    if (!canCall || busy) return;
    setResult(''); setBusy(true);
    try {
      const args = JSON.parse(input) as unknown;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是 JSON 对象');
      const reply = await pi.testMcpTool(workspace, server, fullName, args as Record<string, unknown>);
      setFailed(!!reply.isError);
      setResult(JSON.stringify(reply.structuredContent ?? reply.content ?? reply, null, 2));
    } catch (e) { setFailed(true); setResult(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <Modal open title={<code>{tool?.name ?? fullName}</code>} onCancel={close} footer={null} width={580}>
    {tool?.description && <p className="tool-description">{tool.description}</p>}
    <strong>输入参数</strong>
    <Parameters schema={tool?.inputSchema}/>
    <label htmlFor="mcp-test-args">测试调用 · JSON 参数</label>
    <Input.TextArea id="mcp-test-args" rows={3} value={input} onChange={e => setInput(e.target.value)} />
    <div className={styles.actions}><Button type="primary" size="small" onClick={() => void run()} disabled={!canCall} loading={busy}>运行测试</Button>
      <small>{canCall ? '将向当前服务器发送一次真实调用。' : '需连接服务器并启用该工具。'}</small></div>
    {result && <><strong role="status">{failed ? '调用失败' : '调用结果'}</strong><pre className={styles.pre}>{result}</pre></>}
  </Modal>;
}

export function DiagnosticCard({ error, diagnostics, reconnect, busy, openLogs }: {
  error?: string; diagnostics?: ConnectionDiagnostics; reconnect?: () => void; busy: boolean; openLogs: () => void;
}) {
  return <section className={styles.failure} aria-label="错误诊断">
    <strong>连接失败</strong>　<time>{diagnostics?.attemptedAt ? new Date(diagnostics.attemptedAt).toLocaleString() : '尝试时间未记录'}</time>
    <p>{error || '未收到错误详情，请重新连接。'}{diagnostics?.exit != null && ` · 进程退出：${diagnostics.exit}`}</p>
    {!!diagnostics?.stderr.length && <details><summary>标准错误 · 最近 {diagnostics.stderr.length} 行</summary><pre className={styles.pre}>{diagnostics.stderr.join('\n')}</pre></details>}
    <div className={styles.actions}><Button size="small" disabled={busy} onClick={reconnect}>重新连接</Button><Button type="text" size="small" onClick={openLogs}>查看实时日志</Button></div>
  </section>;
}

/** Count from the host's attempt, not the time the detail view was opened. */
export function SlowHandshake({workspace, name, trace, openLogs}: {
  workspace: string; name: string; trace: ConnectionDiagnostics; openLogs: () => void;
}) {
  const start = Date.parse(trace.attemptedAt);
  const [now, setNow] = useState(Date.now);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((now - start) / 1000);
  if (!Number.isFinite(seconds) || seconds < 15) return null;
  const stop = async () => {
    if (sending || !trace.attemptId) return;
    setFeedback(''); setSending(true);
    try { setFeedback(await pi.cancelMcpAttempt(workspace, name, trace.attemptId) ? '本次连接已终止。' : '连接状态已变化，未终止其他连接。'); }
    catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { setSending(false); }
  };
  return <div className={styles.slow} data-testid="mcp-slow-handshake">
    <strong>连接已耗时 {seconds} 秒</strong>
    <Button size="small" type="link" onClick={openLogs}>查看实时握手日志</Button>
    {trace.attemptId && <Button size="small" loading={sending} onClick={() => void stop()}>终止重试</Button>}
    {feedback && <span role="status">{feedback}</span>}
  </div>;
}

export function McpLogs({ name, status, error, diagnostics, close }: {
  name: string; status: string; error?: string; diagnostics?: ConnectionDiagnostics; close: () => void;
}) {
  return <Modal open title={`${name} · 连接日志`} onCancel={close} footer={null}>
    <p>{status}{diagnostics?.attemptedAt && ` · ${new Date(diagnostics.attemptedAt).toLocaleString()}`}</p>
    {error && <p>{error}</p>}
    {diagnostics?.exit != null && <p>进程退出：{diagnostics.exit}</p>}
    {!!diagnostics?.handshake?.length && <><strong>握手进度</strong><pre className={styles.pre}>{diagnostics.handshake.join('\n')}</pre></>}
    <strong>stderr · 最近 10 行</strong>
    <pre className={styles.pre}>{diagnostics?.stderr.join('\n') || '未收到标准错误输出。'}</pre>
  </Modal>;
}
