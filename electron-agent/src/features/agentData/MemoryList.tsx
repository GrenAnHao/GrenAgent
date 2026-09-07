import type { MemoryItem } from '../../lib/agentData';
import { memoryLevelLabels, memorySummary } from './memoryPresentation';
import { memoryStyles as m } from './memoryStyles';

interface Props { items: MemoryItem[]; selectedId?: string; nextCursor?: string; refreshing: boolean; onSelect(item: MemoryItem): void; onLoadMore(): void }
export function MemoryList({ items, selectedId, nextCursor, refreshing, onSelect, onLoadMore }: Props) {
  return <div className={m.list} aria-label="Memory 列表">
    {items.map((item) => <button type="button" title={item.kind === 'memory' ? item.record.content : item.record.snippet} key={`${item.kind}:${item.record.id}`} data-memory-row={item.record.id} className={m.row} aria-pressed={selectedId === item.record.id} onClick={() => onSelect(item)}>
      <span className={m.summary} title={item.kind === 'memory' ? item.record.content : item.record.snippet}>{item.kind === 'memory' ? memorySummary(item.record.content) : item.record.snippet}</span>
      <span className={m.meta}><span>{item.kind === 'memory' ? memoryLevelLabels[item.record.level] : '对话记录'}</span><span>{item.kind === 'memory' ? item.record.scope === 'global' ? '全局' : item.record.sourceProjectId : item.record.workspace}</span><time dateTime={new Date(item.record.updatedAt).toISOString()}>{new Date(item.record.updatedAt).toLocaleDateString()}</time></span>
    </button>)}
    {nextCursor ? <button type="button" className={m.button} disabled={refreshing} onClick={onLoadMore}>{refreshing ? '正在加载…' : '加载更多'}</button> : null}
  </div>;
}
