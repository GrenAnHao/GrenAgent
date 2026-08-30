import { Modal } from '@lobehub/ui';
import { Select } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { useEffect, useMemo, useState } from 'react';
import { readMcpAudit } from '../../lib/mcpPolicyIo';
import { parseAuditLines, shortToolName, type AuditEntry } from './mcpPolicy';

interface AuditModalProps {
  open: boolean;
  onClose: () => void;
}

const MAX_ROWS = 500;

const styles = createStaticStyles(({ css }) => ({
  filters: css`
    display: flex;
    gap: 8px;
    margin-block-end: 12px;
  `,
  list: css`
    max-height: 60vh;
    overflow-y: auto;
  `,
  row: css`
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 8px 0;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 12px;
  `,
  ts: css`
    flex: 0 0 auto;
    color: ${cssVar.colorTextTertiary};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  `,
  tool: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  decision: css`
    flex: 0 0 auto;
    color: ${cssVar.colorTextSecondary};
  `,
  empty: css`
    padding: 32px 0;
    text-align: center;
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
}));

export function AuditModal({ open, onClose }: AuditModalProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [server, setServer] = useState<string>('');
  const [decision, setDecision] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void readMcpAudit()
      .then((text) => {
        if (!cancelled) setEntries(parseAuditLines(text).reverse());
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const servers = useMemo(() => Array.from(new Set(entries.map((e) => e.server))).filter(Boolean), [entries]);
  const decisions = useMemo(() => Array.from(new Set(entries.map((e) => e.decision))).filter(Boolean), [entries]);
  const filtered = entries
    .filter((e) => (server ? e.server === server : true))
    .filter((e) => (decision ? e.decision === decision : true))
    .slice(0, MAX_ROWS);

  return (
    <Modal open={open} title="MCP 调用审计" footer={null} onCancel={onClose} data-testid="audit-modal">
      <div className={styles.filters}>
        <Select
          size="small"
          allowClear
          placeholder="全部 server"
          style={{ width: 180 }}
          value={server || undefined}
          onChange={(v) => setServer(v ?? '')}
          options={servers.map((s) => ({ label: s, value: s }))}
          data-testid="audit-filter-server"
        />
        <Select
          size="small"
          allowClear
          placeholder="全部 decision"
          style={{ width: 180 }}
          value={decision || undefined}
          onChange={(v) => setDecision(v ?? '')}
          options={decisions.map((d) => ({ label: d, value: d }))}
          data-testid="audit-filter-decision"
        />
      </div>
      {filtered.length === 0 ? (
        <div className={styles.empty}>暂无审计记录</div>
      ) : (
        <div className={styles.list}>
          {filtered.map((e, i) => (
            <div key={i} className={styles.row} data-testid="audit-row">
              <span className={styles.ts}>{e.ts.replace('T', ' ').replace('Z', '').slice(0, 19)}</span>
              <span className={styles.tool} title={`${e.tool}\n${e.argsDigest}`}>
                {e.server}: {shortToolName(e.tool)}
              </span>
              <span className={styles.decision}>{e.decision}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
