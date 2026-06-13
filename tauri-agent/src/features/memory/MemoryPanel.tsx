import { Flexbox } from '@lobehub/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi, type MemItem, type MemStats } from '../../lib/pi';
import { ManagerLayout } from '../common/ManagerLayout';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

type ScopeFilter = 'all' | 'project' | 'global';
const FILTERS: { id: ScopeFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'project', label: '项目' },
  { id: 'global', label: '全局' },
];

function formatTime(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function MemoryPanel() {
  const { workspace } = useAgentStoreContext();
  const [stats, setStats] = useState<MemStats | null>(null);
  const [items, setItems] = useState<MemItem[]>([]);
  const [filter, setFilter] = useState<ScopeFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    void Promise.all([pi.memStats(workspace), pi.memList(workspace)])
      .then(([s, list]) => {
        if (!alive) return;
        setStats(s);
        setItems(list);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [workspace]);

  const filtered = useMemo(
    () => (filter === 'all' ? items : items.filter((m) => m.scope === filter)),
    [items, filter],
  );
  const selected = useMemo(
    () => filtered.find((m) => `${m.scope}:${m.id}` === selectedKey) ?? null,
    [filtered, selectedKey],
  );

  const header = (
    <Flexbox horizontal align="center" gap={12} data-testid="mem-header" style={{ fontSize: 13 }}>
      <span>{stats ? `项目 ${stats.project} · 全局 ${stats.global}` : '加载中…'}</span>
      <Flexbox horizontal gap={4}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            data-testid={`mem-filter-${f.id}`}
            onClick={() => setFilter(f.id)}
            style={{
              padding: '2px 10px',
              borderRadius: 6,
              border,
              cursor: 'pointer',
              fontSize: 12,
              background: filter === f.id ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent',
              color: filter === f.id ? 'var(--gren-fg, inherit)' : muted,
            }}
          >
            {f.label}
          </button>
        ))}
      </Flexbox>
    </Flexbox>
  );

  let list: ReactNode;
  if (error) {
    list = <div style={{ padding: 14, fontSize: 12, color: muted }}>读取失败：{error}</div>;
  } else if (filtered.length === 0) {
    list = (
      <div data-testid="mem-empty" style={{ padding: 14, fontSize: 12, color: muted }}>
        暂无记忆
      </div>
    );
  } else {
    list = (
      <Flexbox>
        {filtered.map((m) => {
          const key = `${m.scope}:${m.id}`;
          const active = key === selectedKey;
          return (
            <button
              key={key}
              data-testid={`mem-item-${m.scope}-${m.id}`}
              onClick={() => setSelectedKey(key)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '8px 12px',
                border: 'none',
                borderBottom: border,
                cursor: 'pointer',
                textAlign: 'left',
                background: active ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent',
                color: 'inherit',
                fontSize: 12,
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.text}
              </span>
              <span style={{ color: muted, fontSize: 11 }}>
                {m.scope === 'global' ? '全局' : '项目'}
                {m.category ? ` · ${m.category}` : ''}
              </span>
            </button>
          );
        })}
      </Flexbox>
    );
  }

  const detail = selected ? (
    <Flexbox gap={10} data-testid="mem-detail">
      <div style={{ fontSize: 14, lineHeight: 1.6 }}>{selected.text}</div>
      <Flexbox gap={4} style={{ fontSize: 12, color: muted }}>
        <span>scope：{selected.scope === 'global' ? '全局' : '项目'}</span>
        <span>category：{selected.category ?? '（无）'}</span>
        <span>时间：{formatTime(selected.createdAt)}</span>
      </Flexbox>
    </Flexbox>
  ) : (
    <div style={{ color: muted, fontSize: 13 }}>选择左侧记忆查看详情</div>
  );

  return <ManagerLayout testId="memory-panel" header={header} list={list} detail={detail} />;
}
