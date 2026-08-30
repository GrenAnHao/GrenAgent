// 给 mermaid flowchart/graph 的 pipe 边标签里的特殊字符自动加引号。
//
// 背景：模型生成 mermaid 时常把代码片段塞进边标签，例如
//   A[worker.ts] -->|import { parentPort }| B[worker]
// mermaid 词法器会把标签里的 `{` 当成菱形节点 `X{...}` 的起始符（DIAMOND_START），导致解析失败。
// 用双引号包裹标签后，其中的特殊字符被当字面文本，解析即可通过。
//
// 仅处理 flowchart/graph 的 pipe 边标签（|label|），这是最常见、也是实际报错的场景；
// 其它图类型（sequenceDiagram/gantt 等）的 `|` 语义不同，保持不动以免误伤。

// 会破坏 pipe 边标签解析的字符。
const RISKY = /[{}()[\]]/;

// 紧跟边箭头收尾字符（> - . = x o）后的 pipe 标签：|label|
// 用前导字符把匹配限定在“边”上，避免误伤节点文本里偶发的成对 `|`。
const EDGE_LABEL = /([->.=xo])(\s*)\|([^|\n]+)\|/g;

function quoteLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return label;
  if (/^".*"$/.test(trimmed)) return label; // 已加引号
  if (!RISKY.test(label)) return label; // 无风险字符，保持原样，减少无谓改动
  return `"${label.replace(/"/g, '&quot;')}"`;
}

// 节点标签里出现「裸双引号」会让 mermaid 词法器进入字符串态、解析中断（报 got 'STR'），
// 例：OVERVIEW[但不提供"一键安装"等功能]。修法：把含 " 的标签整体用双引号包裹、内部 " 转 &quot;，
// 使其成为合法的「带引号标签」。含 " 才动；已是干净带引号标签保持原样。
function quoteNodeLabel(content: string): string | null {
  if (!content.includes('"')) return null;
  const wrapped = /^"([\s\S]*)"$/.exec(content);
  if (wrapped && !wrapped[1].includes('"')) return null; // 已是干净的带引号标签
  const inner = wrapped ? wrapped[1] : content;
  return `"${inner.replace(/"/g, '&quot;')}"`;
}

// 仅处理常见单层节点形状 [..] (..) {..}，且内容不含其它括号——避免误伤复合形状（如 ([..])、
// [[..]]）或内容本就含括号、已正确转义的复杂标签（那些场景内容里有括号，正则不匹配，保持不动）。
const NODE_LABEL_SHAPES: ReadonlyArray<{ re: RegExp; open: string; close: string }> = [
  { re: /([A-Za-z0-9_]+)\[([^[\](){}\n]*)\]/g, open: '[', close: ']' },
  { re: /([A-Za-z0-9_]+)\(([^[\](){}\n]*)\)/g, open: '(', close: ')' },
  { re: /([A-Za-z0-9_]+)\{([^[\](){}\n]*)\}/g, open: '{', close: '}' },
];

function escapeNodeLabelQuotes(code: string): string {
  let out = code;
  for (const { re, open, close } of NODE_LABEL_SHAPES) {
    out = out.replace(re, (full, id: string, content: string) => {
      const fixed = quoteNodeLabel(content);
      return fixed === null ? full : `${id}${open}${fixed}${close}`;
    });
  }
  return out;
}

// 输入：单个 mermaid 图的源码（不含 ``` 围栏）。返回：边标签 + 节点标签都已加引号/转义的安全版本。
export function sanitizeMermaidCode(code: string): string {
  const firstLine = code.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  if (!/^(flowchart|graph)\b/i.test(firstLine)) return code;
  const edgesFixed = code.replace(
    EDGE_LABEL,
    (_match, pre, gap, label) => `${pre}${gap}|${quoteLabel(label)}|`,
  );
  return escapeNodeLabelQuotes(edgesFixed);
}
