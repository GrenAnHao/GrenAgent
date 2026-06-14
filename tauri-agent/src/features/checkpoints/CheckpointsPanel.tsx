import { ActionIcon, Flexbox } from '@lobehub/ui';
import { Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi, type CpItem } from '../../lib/pi';
import { ManagerLayout } from '../common/ManagerLayout';
import { LazyHighlighter } from '../tools/LazyHighlighter';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function CheckpointsPanel() {
  const { workspace } = useAgentStoreContext();
  const [items, setItems] = useState<CpItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    void pi
      .cpList(workspace)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [workspace]);

  useEffect(() => reload(), [reload]);

  const selected = useMemo(() => items.find((c) => c.id === selectedId) ?? null, [items, selectedId]);

  const onSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      setDiffText('');
      void pi
        .cpDiff(workspace, id)
        .then(setDiffText)
        .catch((e) => setDiffText(`diff 读取失败：${e instanceof Error ? e.message : String(e)}`));
    },
    [workspace],
  );

  const onRevert = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(`回滚工作区文件到检查点「${selected.label}」？`)) return;
    await pi.runCommand(workspace, `/checkpoint revert ${selected.id}`);
    reload();
  }, [workspace, selected, reload]);

  const header = (
    <Flexbox horizontal align="center" gap={12} data-testid="cp-header" style={{ fontSize: 13, width: '100%' }}>
      <span>{items.length ? `${items.length} 个检查点` : '检查点'}</span>
    </Flexbox>
  );

  let list: ReactNode;
  if (error) {
    list = <div style={{ padding: 14, fontSize: 12, color: muted }}>读取失败：{error}</div>;
  } else if (items.length === 0) {
    list = (
      <div data-testid="cp-empty" style={{ padding: 14, fontSize: 12, color: muted }}>
        暂无检查点。agent 改动文件后会自动生成。
      </div>
    );
  } else {
    list = (
      <Flexbox>
        {items.map((c) => {
          const active = c.id === selectedId;
          return (
            <button
              key={c.id}
              data-testid={`cp-item-${c.id}`}
              onClick={() => onSelect(c.id)}
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
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
              <span style={{ color: muted, fontSize: 11 }}>
                {c.kind === 'manual' ? '手动' : '自动'} · {c.files.length} 文件 · {formatTime(c.createdAt)}
              </span>
            </button>
          );
        })}
      </Flexbox>
    );
  }

  const detail = selected ? (
    <Flexbox gap={10} data-testid="cp-detail" style={{ height: '100%' }}>
      <Flexbox horizontal align="center" gap={8}>
        <span style={{ fontSize: 13, flex: 1 }}>{selected.label}</span>
        <ActionIcon data-testid="cp-revert" icon={Undo2} size="small" title="回滚到此检查点" onClick={() => void onRevert()} />
      </Flexbox>
      {diffText ? (
        <LazyHighlighter language="diff" copyable style={{ maxHeight: '100%' }}>
          {diffText}
        </LazyHighlighter>
      ) : (
        <span style={{ fontSize: 12, color: muted }}>无差异或加载中…</span>
      )}
    </Flexbox>
  ) : (
    <div style={{ color: muted, fontSize: 13 }}>选择左侧检查点查看 diff，可一键回滚</div>
  );

  return <ManagerLayout testId="checkpoints-panel" header={header} list={list} detail={detail} />;
}
