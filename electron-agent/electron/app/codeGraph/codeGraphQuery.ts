import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path';
import type { CodeGraph, Edge, Node, NodeKind } from '@colbymchenry/codegraph';
import { validateCodeRetrievalArgs, type CodeRetrievalTool } from '../../agentData/codeRetrievalProtocol';
import type { CodeRetrievalResult, CodeRetrievalRow } from '../../agentData/codeRetrievalResult';

/** Public SDK objects are the source of truth; human-readable text is only a presentation. */
export async function executeCodeGraphTool(
  graph: CodeGraph, workspace: string, tool: CodeRetrievalTool, input: Record<string, unknown>,
): Promise<CodeRetrievalResult> {
  const args = validateCodeRetrievalArgs(workspace, tool, input);
  const limit = Math.min(numberArg(args.limit, 20), tool === 'codegraph_node' ? 2000 : 200);
  const file = typeof args.file === 'string' ? indexPath(workspace, args.file) : undefined;

  if (tool === 'codegraph_search') {
    const kind = args.kind === 'type' ? 'type_alias' : args.kind as NodeKind | undefined;
    const nodes = graph.searchNodes(args.query as string, { limit, ...(kind ? { kinds: [kind] } : {}) }).map(({ node }) => node);
    return result('搜索结果', nodes.map(toRow), nodes);
  }

  if (tool === 'codegraph_files') {
    const path = typeof args.path === 'string' ? indexPath(workspace, args.path) : '';
    const pattern = typeof args.pattern === 'string' ? args.pattern.replaceAll('\\', '/') : undefined;
    const files = graph.getFiles().filter((entry) => {
      const name = entry.path.replaceAll('\\', '/');
      if (path && name !== path && !name.startsWith(`${path}/`)) return false;
      if (pattern && !matchesGlob(name, pattern)) return false;
      const tail = path ? name.slice(path.length).replace(/^\//, '') : name;
      return args.maxDepth === undefined || tail.split('/').length <= numberArg(args.maxDepth, 1);
    }).sort((a, b) => a.path.localeCompare(b.path));
    const rows = files.map((entry): CodeRetrievalRow => ({
      file: entry.path.replaceAll('\\', '/'), kind: 'file',
      ...(args.includeMetadata !== false ? { snippet: `${entry.language} · ${entry.nodeCount} 个节点` } : {}),
    }));
    return result('索引文件', rows, [], [], formatFiles(rows, args.format));
  }

  if (tool === 'codegraph_explore') {
    const context = await graph.findRelevantContext(args.query as string, { maxNodes: limit, searchLimit: Math.min(limit, 10) });
    const maxFiles = Math.min(numberArg(args.maxFiles, 12), 200);
    const files = new Set<string>();
    const nodes = [...context.nodes.values()].filter((node) => {
      if (!files.has(node.filePath) && files.size >= maxFiles) return false;
      files.add(node.filePath);
      return true;
    });
    const ids = new Set(nodes.map((node) => node.id));
    const edges = context.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    const blocks: string[] = [];
    // One representative source span per file; do not duplicate every nested symbol's body.
    for (const path of files) {
      const node = nodes.find((entry) => entry.filePath === path && entry.kind !== 'file');
      if (node) blocks.push(await sourceSpan(workspace, node.filePath, node.startLine, Math.min(node.endLine - node.startLine + 1, 200)));
    }
    const text = [context.confidence === 'low' ? '匹配置信度较低，请结合源码确认。' : '', ...blocks].filter(Boolean).join('\n\n');
    return result('相关上下文', nodes.map(toRow), nodes, edges, text);
  }

  if (tool === 'codegraph_node' && file !== undefined && args.symbol === undefined) {
    const nodes = graph.getNodesInFile(file);
    const text = args.symbolsOnly || args.includeCode === false ? undefined
      : await sourceSpan(workspace, file, numberArg(args.offset ?? args.line, 1), limit);
    return result('文件详情', nodes.map(toRow), nodes, [], text);
  }

  const symbol = args.symbol as string;
  const byId = graph.getNode(symbol);
  let candidates = byId ? [byId] : graph.getNodesByName(symbol);
  if (file !== undefined) candidates = candidates.filter((node) => node.filePath.replaceAll('\\', '/') === file);
  const line = args.line;
  if (typeof line === 'number') candidates = candidates.filter((node) => node.startLine <= line && node.endLine >= line);
  if (candidates.length !== 1) {
    const message = candidates.length ? '存在同名符号，请提供文件路径或使用节点 ID。' : `未找到符号：${symbol}`;
    return { ...result(message, candidates.map(toRow), candidates), isError: true };
  }
  const focal = candidates[0];
  const depth = Math.min(numberArg(args.depth, tool === 'codegraph_impact' ? 2 : 1), 10);

  if (tool === 'codegraph_node') {
    const context = graph.getContext(focal.id);
    const refs = [...context.incomingRefs, ...context.outgoingRefs];
    const nodes = uniqueNodes([focal, ...context.ancestors, ...context.children, ...refs.map(({ node }) => node)]);
    const text = args.includeCode && !args.symbolsOnly
      ? await sourceSpan(workspace, focal.filePath, focal.startLine, Math.min(focal.endLine - focal.startLine + 1, limit)) : undefined;
    return result('符号详情', [toRow(focal)], nodes, refs.map(({ edge }) => edge), text);
  }

  if (tool === 'codegraph_impact') {
    const subgraph = graph.getImpactRadius(focal.id, depth);
    const nodes = [...subgraph.nodes.values()].slice(0, limit);
    const ids = new Set(nodes.map((node) => node.id));
    return result('影响范围', nodes.map(toRow), nodes, subgraph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)));
  }

  const refs = (tool === 'codegraph_callers' ? graph.getCallers(focal.id, depth) : graph.getCallees(focal.id, depth)).slice(0, limit);
  return result(tool === 'codegraph_callers' ? '调用者' : '被调用者', refs.map(({ node }) => toRow(node)),
    uniqueNodes([focal, ...refs.map(({ node }) => node)]), refs.map(({ edge }) => edge));
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function indexPath(workspace: string, file: string): string {
  const path = relative(resolve(workspace), resolve(workspace, file));
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('file must stay within workspace');
  return path.replaceAll('\\', '/');
}

async function sourceSpan(workspace: string, file: string, offset: number, limit: number): Promise<string> {
  const path = indexPath(workspace, file);
  const [root, target] = await Promise.all([realpath(workspace), realpath(resolve(workspace, path))]);
  indexPath(root, target); // A symlink must not turn a permitted lexical path into an outside read.
  if ((await stat(target)).size > 1024 * 1024) throw new Error('Source file exceeds the 1 MiB preview limit');
  const lines = (await readFile(target, 'utf8')).split(/\r?\n/);
  if (offset > lines.length) throw new Error('Source line is outside the file');
  const count = Math.max(1, Math.min(limit, 2000));
  const body = lines.slice(offset - 1, offset - 1 + count).map((line, index) => `${offset + index}: ${line}`).join('\n');
  return `${path}\n${body}${offset - 1 + count < lines.length ? '\n（后续源码未展开）' : ''}`;
}

function toRow(node: Node): CodeRetrievalRow {
  return {
    id: node.id, file: node.filePath.replaceAll('\\', '/'), kind: node.kind,
    ...(node.kind !== 'file' ? { symbol: node.name } : {}),
    ...(node.startLine > 0 ? { line: node.startLine } : {}),
    ...(node.endLine > 0 ? { endLine: node.endLine } : {}),
    ...(node.signature ? { snippet: node.signature } : {}),
  };
}

function uniqueNodes(nodes: Node[]): Node[] {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function result(title: string, rows: CodeRetrievalRow[], nodes: Node[] = [], edges: Edge[] = [], detail?: string): CodeRetrievalResult {
  const lines = rows.map((row) => [row.symbol ?? row.file, row.kind, row.file && row.line ? `${row.file}:${row.line}` : row.file, row.snippet].filter(Boolean).join(' · '));
  return {
    content: [{ type: 'text', text: [`${title}（${rows.length}）`, ...lines, detail].filter(Boolean).join('\n') }],
    isError: false,
    structuredContent: { schemaVersion: 1, rows, nodes, edges },
  };
}

function formatFiles(rows: CodeRetrievalRow[], format: unknown): string | undefined {
  if (format !== 'tree' && format !== 'grouped') return undefined;
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const parts = row.file!.split('/');
    const name = parts.pop()!;
    const parent = parts.join('/') || '.';
    const group = groups.get(parent) ?? [];
    group.push(name);
    groups.set(parent, group);
  }
  return [...groups].map(([parent, names]) => `${parent}/\n${names.map((name) => `  ${name}`).join('\n')}`).join('\n');
}
