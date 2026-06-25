import { useEffect, useMemo, useState } from 'react';
import { Icon, Modal } from '@lobehub/ui';
import { createGlobalStyle, cssVar } from 'antd-style';
import { Share2 } from 'lucide-react';
import { getRichGraph } from '../../../../lib/codeGraphIo';
import { detectCycles, findPaths } from '../../../../lib/codeGraphPath';
import type { RichGraph } from '../../../../lib/codeGraphTypes';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { useGraphState } from './useGraphState';
import { GraphToolbar } from './GraphToolbar';
import { GraphCanvas } from './GraphCanvas';
import { GraphSidebar } from './GraphSidebar';
import { wsStyles as s } from './styles';

const ModalGlobal = createGlobalStyle`
  .code-graph-modal-root .ant-modal-container {
    height: calc(100vh - 32px) !important;
    max-height: calc(100vh - 32px) !important;
    display: flex !important;
    flex-direction: column !important;
  }
  .code-graph-modal-root .ant-modal-body {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: hidden !important;
    display: flex !important;
    flex-direction: column !important;
  }
`;

function GraphContent({ workspace }: { workspace: string }) {
  const [graph, setGraph] = useState<RichGraph | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    getRichGraph(workspace)
      .then((g) => {
        if (alive) setGraph({ ...g, circularPaths: detectCycles(g.nodes.map((n) => n.path), g.edges) });
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [workspace]);

  const { state, onNodeClick, onPaneClick, setSearch, setDepth, toggleKind, highlightSet, pathEdges } =
    useGraphState(graph);

  const paths = useMemo(() => {
    if (!graph || !state.pathSource || !state.pathTarget) return [];
    return findPaths(graph.nodes.map((n) => n.path), graph.edges, state.pathSource, state.pathTarget);
  }, [graph, state.pathSource, state.pathTarget]);

  const center: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: cssVar.colorTextTertiary };

  if (loading) return <div style={center}>加载依赖图中…</div>;
  if (error) return <div data-testid="code-graph-error" style={center}>{error}</div>;
  if (!graph || graph.nodes.length === 0) return <div style={center}>未发现文件间依赖（或索引为空）</div>;

  return (
    <div data-testid="code-graph-content" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <GraphToolbar state={state} onSearch={setSearch} onDepth={setDepth} onToggleKind={toggleKind} />
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, border: `1px solid ${cssVar.colorBorderSecondary}`, borderRadius: 10, overflow: 'hidden', background: cssVar.colorBgLayout }}>
          <GraphCanvas
            graph={graph}
            highlightSet={highlightSet}
            pathEdges={pathEdges}
            visibleKinds={state.visibleKinds}
            searchQuery={state.searchQuery}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
          />
        </div>
        <div style={{ flex: '0 0 280px', border: `1px solid ${cssVar.colorBorderSecondary}`, borderRadius: 10, overflow: 'hidden', background: cssVar.colorBgContainer }}>
          <GraphSidebar
            selected={state.selected}
            graph={graph}
            pathSource={state.pathSource}
            pathTarget={state.pathTarget}
            paths={paths}
            onPick={(p) => onNodeClick(p)}
          />
        </div>
      </div>
    </div>
  );
}

/** 「代码图谱」chip：点开看当前 workspace 的文件 import 依赖图。 */
export function CodeGraphButton() {
  const { workspace } = useAgentStoreContext();
  const [open, setOpen] = useState(false);

  if (!workspace) return null;

  return (
    <>
      <ModalGlobal />
      <span className={s.chip} data-testid="code-graph-button" onClick={() => setOpen(true)}>
        <Icon icon={Share2} size={14} />
        <span className={s.muted}>代码图谱</span>
      </span>
      <Modal
        open={open}
        title="代码图谱 · 文件依赖"
        footer={null}
        width="94vw"
        centered
        rootClassName="code-graph-modal-root"
        onCancel={() => setOpen(false)}
        data-testid="code-graph-modal"
      >
        {open ? <GraphContent workspace={workspace} /> : null}
      </Modal>
    </>
  );
}
