import type { EdgeKind } from '../../../../lib/codeGraphTypes';
import type { GraphState } from './useGraphState';

const KIND_LABELS: Record<EdgeKind, string> = {
  'import-value': 'import', 'import-type': 'type', 'reexport': 're-exp',
  'dynamic': 'lazy', 'call': 'call', 'circular': 'circular',
};
const KIND_COLORS: Record<EdgeKind, string> = {
  'import-value': '#6b7280', 'import-type': '#818cf8', 'reexport': '#34d399',
  'dynamic': '#f59e0b', 'call': '#38bdf8', 'circular': '#ef4444',
};

interface Props {
  state: GraphState;
  onSearch(q: string): void;
  onDepth(d: 1 | 2 | 3 | 4): void;
  onToggleKind(k: EdgeKind): void;
}

export function GraphToolbar({ state, onSearch, onDepth, onToggleKind }: Props) {
  const depthDisabled = state.selected === null || state.pathSource !== null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', flexWrap: 'wrap', fontSize: 11 }}>
      <input
        type="search"
        placeholder="搜索文件名…"
        value={state.searchQuery}
        onChange={(e) => onSearch(e.target.value)}
        style={{ padding: '3px 8px', borderRadius: 6, border: '1px solid #374151', background: '#1f2937', color: '#e2e8f0', fontSize: 11 }}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#9ca3af' }}>
        深度
        <input
          type="range" min={1} max={4} step={1}
          value={state.depth}
          disabled={depthDisabled}
          onChange={(e) => onDepth(Number(e.target.value) as 1 | 2 | 3 | 4)}
          aria-label="depth"
        />
        <span style={{ color: '#a78bfa', fontWeight: 600 }}>{state.depth}</span>
      </label>
      <div style={{ width: 1, height: 18, background: '#374151' }} />
      {(Object.keys(KIND_LABELS) as EdgeKind[]).map((k) => {
        const active = state.visibleKinds.has(k);
        return (
          <button
            key={k}
            type="button"
            onClick={() => onToggleKind(k)}
            style={{
              padding: '2px 7px', borderRadius: 4, fontSize: 10, cursor: 'pointer',
              border: `1px solid ${active ? KIND_COLORS[k] : '#374151'}`,
              background: active ? `${KIND_COLORS[k]}22` : '#1f2937',
              color: active ? KIND_COLORS[k] : '#6b7280',
            }}
          >
            {KIND_LABELS[k]}
          </button>
        );
      })}
    </div>
  );
}
