import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { agentDataApi, type AgentAuditEvent, type AgentDiagnostics } from '../../lib/agentData';
import { styles } from './agentDataStyles';

const sensitiveKey = /token|apiKey|secret|credential/i;

export function AuditDiagnosticsPanel() {
  const [audit, setAudit] = useState<AgentAuditEvent[]>([]);
  const [diagnostics, setDiagnostics] = useState<AgentDiagnostics>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError(undefined);
      const [nextAudit, nextDiagnostics] = await Promise.all([agentDataApi.audit(), agentDataApi.diagnostics()]);
      setAudit(nextAudit);
      setDiagnostics(nextDiagnostics);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return <section data-testid="audit-diagnostics-panel">
    <div className={styles.sectionHeading}><h3 className={styles.heading}>审计与诊断</h3><span className={styles.hint}>只读</span></div>
    {error ? <div className={styles.error} role="alert">{error}<button type="button" className={styles.actionButton} onClick={() => void load()}><RefreshCw size={12} />重试诊断</button></div> : null}
    {loading ? <div className={styles.state}>正在加载诊断...</div> : !error ? <>
      <div className={styles.kpis}>
        <Kpi label="任务总数" value={diagnostics?.jobs.total ?? 0} />
        <Kpi label="失败任务" value={diagnostics?.jobs.failed ?? 0} />
        <Kpi label="审计事件" value={diagnostics?.auditEvents ?? 0} />
      </div>
      {audit.length === 0 ? <div className={styles.state}>暂无审计事件</div> : <table className={styles.table}><thead><tr><th>动作</th><th>详情</th><th>时间</th></tr></thead><tbody>{audit.map((event) => <tr key={event.id}><td>{event.action}</td><td><code>{JSON.stringify(redact(event.detail))}</code></td><td>{new Date(event.createdAt).toLocaleString()}</td></tr>)}</tbody></table>}
    </> : null}
  </section>;
}

function Kpi({ label, value }: { label: string; value: number }) {
  return <div className={styles.card}><div className={styles.cardLabel}>{label}</div><div className={styles.cardValue}>{value}</div></div>;
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitiveKey.test(key) ? '[redacted]' : redact(item)]));
}
