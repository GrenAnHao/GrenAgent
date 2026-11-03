import type { projectKnowledge } from './knowledgeProjection';

/** A shared disclosure for the overview, reader banner and task detail. */
export function KnowledgeActiveItems({ view }: { view: ReturnType<typeof projectKnowledge> }) {
  if (!view.activeLabel) return null;
  return <details data-testid="knowledge-active-items" style={{ width: '100%', minWidth: 0, fontSize: 'inherit' }}>
    <summary style={{ cursor: 'pointer', overflowWrap: 'anywhere' }}>{view.activeLabel}</summary>
    <ul aria-label="正在处理的内容" style={{ margin: '8px 0 0', paddingLeft: 20, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
      {view.activeItems.map(item => <li key={`${item.phase}:${item.itemId}`} style={{ padding: '2px 0' }}>{item.title}</li>)}
    </ul>
  </details>;
}
