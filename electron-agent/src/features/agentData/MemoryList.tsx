import { Button, Typography } from 'antd';
import type { MemoryItem } from '../../lib/agentData';
import { formatRelative } from '../../lib/relativeTime';
import { listRowStyles as rows } from './listRowStyles';
import { memorySummary } from './memoryPresentation';
import { memoryStyles as m } from './memoryStyles';

const dirName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

interface Props { items: MemoryItem[]; selectedId?: string; nextCursor?: string; refreshing: boolean; onSelect(item: MemoryItem): void; onLoadMore(): void }
export function MemoryList({ items, selectedId, nextCursor, refreshing, onSelect, onLoadMore }: Props) {
  return <div className={rows.group} aria-label="Memory 列表">
    {items.map((item) => {
      const body = item.kind === 'memory' ? item.record.content : item.record.snippet;
      const fullScope = item.kind === 'memory'
        ? item.record.scope === 'global' ? '全局' : item.record.sourceProjectId
        : item.record.workspace;
      const scope = item.kind === 'memory' && item.record.scope === 'global' ? '全局' : dirName(fullScope ?? '');
      const meta = item.kind === 'conversation' ? `对话记录 · ${scope}` : scope;
      return <Button block type="text" className={`${rows.row} ${rows.flush}`} title={body} key={`${item.kind}:${item.record.id}`} data-memory-row={item.record.id} aria-pressed={selectedId === item.record.id} onClick={() => onSelect(item)}>
        <span className={rows.title}>{item.kind === 'memory' ? memorySummary(item.record.content) : item.record.snippet}</span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }} title={fullScope}>{meta} · <time dateTime={new Date(item.record.updatedAt).toISOString()}>{formatRelative(item.record.updatedAt)}</time></Typography.Text>
      </Button>;
    })}
    {nextCursor ? <div className={m.loadMore}><Button disabled={refreshing} onClick={onLoadMore}>{refreshing ? '正在加载…' : '加载更多'}</Button></div> : null}
  </div>;
}
