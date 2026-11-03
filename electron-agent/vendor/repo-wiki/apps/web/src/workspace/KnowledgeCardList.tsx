import type { WikiPage } from './api';
import { Icon } from './Icons';
import './collection.css';
export type KnowledgeCardRecord = WikiPage & { kind?: string; summary?: string; category?: string };
export type KnowledgeCardListProps = {
  cards: KnowledgeCardRecord[];
  selectedId: string;
  query: string;
  onSelect: (id: string) => void;
  onOverview?: () => void;
  overviewSelected?: boolean;
};
function cardSummary(card: KnowledgeCardRecord): string {
  if (typeof card.summary === 'string' && card.summary.trim()) return card.summary.trim();
  return card.markdown.replace(/```[\s\S]*?```/g, ' ').replace(/^#{1,6}\s+.*$/gm, '').replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`~>]/g, '').replace(/\s+/g, ' ').trim();
}
export function KnowledgeCardList({ cards, selectedId, query, onSelect, onOverview, overviewSelected }: KnowledgeCardListProps) {
  const activeCards = cards.filter(card => card.status !== 'archived');
  const needle = query.trim().toLocaleLowerCase();
  const visible = activeCards.filter(card => !needle || `${card.title} ${cardSummary(card)} ${card.category ?? ''} ${card.id}`.toLocaleLowerCase().includes(needle));
  return <nav className="rw-knowledge-card-navigation" aria-label="知识卡片目录">
    {onOverview && <button type="button" className={`rw-card-overview-row ${overviewSelected ? 'active' : ''}`} aria-current={overviewSelected ? 'page' : undefined} onClick={onOverview}><Icon name="layers" size={16}/><span>知识卡片概览</span><small aria-label={`${activeCards.length} 张知识卡片`}>{activeCards.length}</small></button>}
    <ul className="rw-knowledge-card-list">{visible.map(card => <li key={card.id}><button type="button" className={`rw-knowledge-card ${selectedId === card.id && !overviewSelected ? 'active' : ''}`} aria-current={selectedId === card.id && !overviewSelected ? 'page' : undefined} onClick={() => onSelect(card.id)}>
      <strong title={card.title}>{card.title}</strong><span className="rw-card-excerpt">{cardSummary(card) || '暂无摘要，打开查看完整内容。'}</span><span className="rw-card-tags">{card.category && <span className="rw-card-category">{card.category}</span>}{card.status === 'conflict' && <span className="rw-card-conflict">待解决冲突</span>}{card.status === 'edited' && <span className="rw-card-edited">人工修订</span>}</span>
    </button></li>)}</ul>
    {!visible.length && <p className="rw-knowledge-empty" role="status">{needle ? '没有匹配的知识卡片' : '尚未生成知识卡片'}</p>}
  </nav>;
}
