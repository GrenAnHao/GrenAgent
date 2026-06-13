import { Flexbox } from '@lobehub/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi, type ReviewNote } from '../../lib/pi';
import { ManagerLayout } from '../common/ManagerLayout';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

const SEVERITY_ORDER = ['blocker', 'major', 'minor', 'nit', 'praise'];
const SEVERITY_COLOR: Record<string, string> = {
  blocker: '#f87171',
  major: '#fb923c',
  minor: '#facc15',
  nit: '#9aa1ac',
  praise: '#4ade80',
};

export function ReviewPanel() {
  const { workspace } = useAgentStoreContext();
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    void pi
      .rvList(workspace)
      .then((list) => {
        if (alive) setNotes(list);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  const groups = useMemo(() => {
    const extras = [...new Set(notes.map((n) => n.severity))].filter(
      (s) => !SEVERITY_ORDER.includes(s),
    );
    const order = [...SEVERITY_ORDER, ...extras];
    return order
      .map((sev) => ({ sev, items: notes.filter((n) => n.severity === sev) }))
      .filter((g) => g.items.length > 0);
  }, [notes]);

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId],
  );

  const header = (
    <Flexbox horizontal align="center" gap={12} data-testid="rv-header" style={{ fontSize: 13 }}>
      <span>{notes.length} 条发现</span>
    </Flexbox>
  );

  let list: ReactNode;
  if (error) {
    list = <div style={{ padding: 14, fontSize: 12, color: muted }}>读取失败：{error}</div>;
  } else if (notes.length === 0) {
    list = (
      <div data-testid="rv-empty" style={{ padding: 14, fontSize: 12, color: muted }}>
        暂无审查发现
      </div>
    );
  } else {
    list = (
      <Flexbox>
        {groups.map((g) => (
          <Flexbox key={g.sev}>
            <div style={{ padding: '6px 12px', fontSize: 11, color: muted }}>
              {g.sev}（{g.items.length}）
            </div>
            {g.items.map((n) => {
              const active = n.id === selectedId;
              return (
                <button
                  key={n.id}
                  data-testid={`rv-note-${n.id}`}
                  onClick={() => setSelectedId(n.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    border: 'none',
                    borderBottom: border,
                    cursor: 'pointer',
                    textAlign: 'left',
                    background: active
                      ? 'var(--gren-rail-active, rgba(255,255,255,0.08))'
                      : 'transparent',
                    color: 'inherit',
                    fontSize: 12,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      flex: '0 0 auto',
                      background: SEVERITY_COLOR[n.severity] ?? muted,
                    }}
                  />
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {n.file}
                    {n.line != null ? `:${n.line}` : ''}
                  </span>
                </button>
              );
            })}
          </Flexbox>
        ))}
      </Flexbox>
    );
  }

  const detail = selected ? (
    <Flexbox gap={10} data-testid="rv-detail">
      <div style={{ fontSize: 14, lineHeight: 1.6 }}>{selected.message}</div>
      <Flexbox gap={4} style={{ fontSize: 12, color: muted }}>
        <span>severity：{selected.severity}</span>
        <span>
          位置：{selected.file}
          {selected.line != null ? `:${selected.line}` : ''}
        </span>
      </Flexbox>
    </Flexbox>
  ) : (
    <div style={{ color: muted, fontSize: 13 }}>选择左侧发现查看详情</div>
  );

  return <ManagerLayout testId="review-panel" header={header} list={list} detail={detail} />;
}
