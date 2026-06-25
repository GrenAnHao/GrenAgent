import { cssVar } from 'antd-style';
import type { RichGraph } from '../../../../lib/codeGraphTypes';

function basename(p: string) {
  return p.replace(/[\/]+$/, '').split(/[\/]/).at(-1) ?? p;
}

interface Props {
  selected: string | null;
  graph: RichGraph | null;
  pathSource: string | null;
  pathTarget: string | null;
  paths: string[][];
  onPick(path: string): void;
}

export function GraphSidebar({ selected, graph, pathSource, pathTarget, paths, onPick }: Props) {
  const node = graph?.nodes.find((n) => n.path === selected);
  const outList = graph?.edges.filter((e) => e.source === selected).map((e) => e.target) ?? [];
  const incList = graph?.edges.filter((e) => e.target === selected).map((e) => e.source) ?? [];
  const inPathMode = pathSource !== null;

  if (!selected && !inPathMode) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: cssVar.colorTextTertiary, lineHeight: 1.6 }}>
        点击任意文件节点高亮其依赖；Shift+点击两节点查找路径。
      </div>
    );
  }

  if (inPathMode && paths.length === 0 && pathTarget === null) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: cssVar.colorTextTertiary }}>
        已选源：<code>{basename(pathSource!)}</code>，再 Shift+点击目标节点。
      </div>
    );
  }

  if (inPathMode && pathTarget !== null) {
    return (
      <div style={{ padding: 12, fontSize: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, color: cssVar.colorText }}>
          {paths.length} 条路径 · {basename(pathSource!)} → {basename(pathTarget)}
        </div>
        {paths.map((p) => (
          <div key={p.join("-")} style={{ marginBottom: 6, color: cssVar.colorTextSecondary }}>
            {p.map((seg, j) => (
              <span key={seg}>
                <span style={{ cursor: 'pointer', fontFamily: 'monospace' }} onClick={() => onPick(seg)}>{basename(seg)}</span>
                {j < p.length - 1 && <span style={{ color: cssVar.colorTextTertiary }}> → </span>}
              </span>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${cssVar.colorBorderSecondary}` }}>
        <div style={{ fontFamily: 'monospace', fontSize: 12.5, fontWeight: 600, color: cssVar.colorText }}>{basename(selected!)}</div>
        <div style={{ fontSize: 11, color: cssVar.colorTextTertiary, marginTop: 2, wordBreak: 'break-all' }}>{selected}</div>
        <div style={{ fontSize: 11, color: cssVar.colorTextTertiary, marginTop: 4 }}>
          依赖 {outList.length} · 被依赖 {incList.length}
          {node && <span> · 复杂度 {(node.complexity * 100).toFixed(0)}%</span>}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 8px' }}>
        {outList.length > 0 && <>
          <div style={{ fontSize: 10, textTransform: 'uppercase', color: cssVar.colorTextTertiary, padding: '4px 6px' }}>依赖（它 import）</div>
          {outList.map((p) => <div key={p} style={{ padding: '4px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', color: cssVar.colorTextSecondary }} onClick={() => onPick(p)}>{basename(p)}</div>)}
        </>}
        {incList.length > 0 && <>
          <div style={{ fontSize: 10, textTransform: 'uppercase', color: cssVar.colorTextTertiary, padding: '4px 6px', marginTop: 6 }}>被依赖（import 它）</div>
          {incList.map((p) => <div key={p} style={{ padding: '4px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', color: cssVar.colorTextSecondary }} onClick={() => onPick(p)}>{basename(p)}</div>)}
        </>}
      </div>
    </div>
  );
}
