import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, matchesGlob, relative, resolve, sep } from 'node:path';
import type { CodeGraph, Edge, EdgeKind, Language, Node, NodeKind, SearchOptions, TraversalOptions } from '@colbymchenry/codegraph';
import { validateCodeRetrievalArgs, type CodeRetrievalTool } from '../../agentData/codeRetrievalProtocol';
import type { CodeRetrievalResult, CodeRetrievalRow } from '../../agentData/codeRetrievalResult';

/** Public SDK objects are the source of truth; human-readable text is only a presentation. */
export async function executeCodeGraphTool(
  graph: CodeGraph, workspace: string, tool: CodeRetrievalTool, input: Record<string, unknown>,
): Promise<CodeRetrievalResult> {
  const args = validateCodeRetrievalArgs(workspace, tool, input);
  const limit = Math.min(numberArg(args.limit, 20), tool === 'codegraph_node' ? 2000 : 200);

  if (tool === 'codegraph_search') return search(graph, args, limit);
  if (tool === 'codegraph_files') return listFiles(graph, workspace, args);
  if (tool === 'codegraph_explore') return explore(graph, workspace, args, limit);
  if (tool === 'codegraph_status') return status(graph);
  if (tool === 'codegraph_changed') return changedFiles(graph);
  if (tool === 'codegraph_cycles') return cycles(graph, limit);
  if (tool === 'codegraph_dead_code') return deadCode(graph, args, limit);
  if (tool === 'codegraph_routes') return routes(graph, limit);
  if (tool === 'codegraph_deps') return fileDeps(graph, workspace, args);
  if (tool === 'codegraph_context') return context(graph, args, limit);
  if (tool === 'codegraph_path') return pathBetween(graph, workspace, args, limit);

  if (tool === 'codegraph_node' && typeof args.file === 'string' && args.symbol === undefined) {
    const file = indexPath(workspace, args.file);
    const nodes = graph.getNodesInFile(file);
    const text = args.symbolsOnly || args.includeCode === false ? undefined
      : await sourceSpan(workspace, file, numberArg(args.offset ?? args.line, 1), limit);
    return result('文件详情', nodes.map(toRow), nodes, [], text);
  }

  const resolved = resolveNode(graph, workspace, args.symbol as string | undefined, args.file as string | undefined, args.line);
  if ('isError' in resolved) return resolved;
  const focal = resolved;
  const depth = Math.min(numberArg(args.depth, tool === 'codegraph_impact' || tool === 'codegraph_call_graph' ? 2 : 1), 10);

  if (tool === 'codegraph_node') {
    const contextView = graph.getContext(focal.id);
    const refs = [...contextView.incomingRefs, ...contextView.outgoingRefs];
    const nodes = uniqueNodes([focal, ...contextView.ancestors, ...contextView.children, ...refs.map(({ node }) => node)]);
    const text = args.includeCode && !args.symbolsOnly
      ? await sourceSpan(workspace, focal.filePath, focal.startLine, Math.min(focal.endLine - focal.startLine + 1, limit)) : undefined;
    const metrics = args.includeMetrics === true ? graph.getNodeMetrics(focal.id) : undefined;
    return result('符号详情', [toRow(focal)], nodes, refs.map(({ edge }) => edge), text, metrics ? { metrics } : undefined);
  }
  if (tool === 'codegraph_impact') {
    const subgraph = graph.getImpactRadius(focal.id, depth);
    return subgraphResult('影响范围', subgraph, limit);
  }
  if (tool === 'codegraph_usages') {
    const refs = graph.findUsages(focal.id).slice(0, limit);
    return result('引用', refs.map(({ node }) => toRow(node)), uniqueNodes([focal, ...refs.map(({ node }) => node)]), refs.map(({ edge }) => edge));
  }
  if (tool === 'codegraph_hierarchy') return subgraphResult('类型层次', graph.getTypeHierarchy(focal.id), limit);
  if (tool === 'codegraph_call_graph') return subgraphResult('调用图', graph.getCallGraph(focal.id, depth), limit);
  if (tool === 'codegraph_metrics') {
    const metrics = graph.getNodeMetrics(focal.id);
    return result('度量', [toRow(focal)], [focal], [], JSON.stringify(metrics), { metrics });
  }
  if (tool === 'codegraph_traverse') {
    return subgraphResult('遍历', graph.traverse(focal.id, traverseOptions(args, limit)), limit);
  }
  const refs = (tool === 'codegraph_callers' ? graph.getCallers(focal.id, depth) : graph.getCallees(focal.id, depth)).slice(0, limit);
  return result(tool === 'codegraph_callers' ? '调用者' : '被调用者', refs.map(({ node }) => toRow(node)),
    uniqueNodes([focal, ...refs.map(({ node }) => node)]), refs.map(({ edge }) => edge));
}

function search(graph: CodeGraph, args: Record<string, unknown>, limit: number): CodeRetrievalResult {
  const kinds = collectKinds(args);
  const offset = typeof args.offset === 'number' ? args.offset : 0;
  const mode = typeof args.mode === 'string' ? args.mode : 'search';
  const query = typeof args.query === 'string' ? args.query : '';
  let nodes: Node[] = [];
  if (mode === 'kind') {
    nodes = kinds.flatMap((kind) => graph.getNodesByKind(kind));
  } else if (mode === 'prefix') {
    nodes = graph.getNodesByNamePrefix(query, offset + limit);
  } else if (mode === 'substring') {
    nodes = graph.getNodesByNameSubstring(query, {
      ...(kinds.length ? { kinds } : {}),
      limit: offset + limit,
      ...(args.excludePrefix === true ? { excludePrefix: true } : {}),
    });
  } else if (mode === 'name') {
    nodes = graph.getNodesByName(query);
  } else if (mode === 'segment') {
    const words = Array.isArray(args.words) ? args.words as string[] : query.split(/\s+/).filter(Boolean);
    nodes = graph.getSegmentMatches(words, offset + limit).flatMap((match) => {
      const node = graph.getNode(match.nodeId);
      return node ? [node] : [];
    });
  } else {
    const options: SearchOptions = {
      ...(kinds.length ? { kinds } : {}),
      ...(Array.isArray(args.languages) ? { languages: args.languages as Language[] } : {}),
      ...(Array.isArray(args.includePatterns) ? { includePatterns: args.includePatterns as string[] } : {}),
      ...(Array.isArray(args.excludePatterns) ? { excludePatterns: args.excludePatterns as string[] } : {}),
      limit: offset + limit,
      ...(offset ? { offset } : {}),
      ...(args.caseSensitive !== undefined ? { caseSensitive: args.caseSensitive === true } : {}),
    };
    nodes = graph.searchNodes(query, options).map(({ node }) => node);
  }
  nodes = applyFilters(nodes, args, kinds).slice(offset, offset + limit);
  return result('搜索结果', nodes.map(toRow), nodes);
}

async function explore(graph: CodeGraph, workspace: string, args: Record<string, unknown>, limit: number): Promise<CodeRetrievalResult> {
  const maxNodes = Math.min(numberArg(args.maxNodes, limit), 200);
  const contextView = await graph.findRelevantContext(args.query as string, {
    maxNodes,
    searchLimit: numberArg(args.searchLimit, Math.min(limit, 10)),
    ...(args.traversalDepth !== undefined ? { traversalDepth: numberArg(args.traversalDepth, 2) } : {}),
    ...(typeof args.minScore === 'number' ? { minScore: args.minScore } : {}),
    ...(Array.isArray(args.edgeKinds) ? { edgeKinds: args.edgeKinds as EdgeKind[] } : {}),
    ...(Array.isArray(args.nodeKinds) ? { nodeKinds: (args.nodeKinds as string[]).map(normalizeKind) } : {}),
    ...(Array.isArray(args.seedNames) ? { seedNames: args.seedNames as string[] } : {}),
  });
  const maxFiles = Math.min(numberArg(args.maxFiles, 12), 200);
  const files = new Set<string>();
  const nodes = [...contextView.nodes.values()].filter((node) => {
    if (!files.has(node.filePath) && files.size >= maxFiles) return false;
    files.add(node.filePath);
    return true;
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = contextView.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const blocks: string[] = [];
  for (const path of files) {
    const node = nodes.find((entry) => entry.filePath === path && entry.kind !== 'file');
    if (node) blocks.push(await sourceSpan(workspace, node.filePath, node.startLine, Math.min(node.endLine - node.startLine + 1, 200)));
  }
  const text = [contextView.confidence === 'low' ? '匹配置信度较低，请结合源码确认。' : '', ...blocks].filter(Boolean).join('\n\n');
  return result('相关上下文', nodes.map(toRow), nodes, edges, text);
}

function listFiles(graph: CodeGraph, workspace: string, args: Record<string, unknown>): CodeRetrievalResult {
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
    ...(args.includeMetadata !== false ? {
      snippet: [entry.language, `${entry.nodeCount} 个节点`, entry.generated ? 'generated' : '', `${entry.size} B`].filter(Boolean).join(' · '),
    } : {}),
  }));
  return result('索引文件', rows, [], [], formatFiles(rows, args.format));
}

function status(graph: CodeGraph): CodeRetrievalResult {
  const stats = graph.getStats();
  const extra = {
    stats,
    indexState: graph.getIndexState(),
    stale: graph.isIndexStale(),
    lastIndexedAt: graph.getLastIndexedAt(),
    build: graph.getIndexBuildInfo(),
    frameworks: graph.getDetectedFrameworks(),
    generatedFiles: graph.getGeneratedFileCount(),
    pendingReferences: graph.getPendingReferenceCount(),
    backend: String(graph.getBackend()),
    journalMode: graph.getJournalMode(),
    indexing: graph.isIndexing(),
    projectRoot: graph.getProjectRoot(),
  };
  return result('索引状态', [], [], [], `files ${stats.fileCount} · nodes ${stats.nodeCount} · edges ${stats.edgeCount}`, extra);
}

function changedFiles(graph: CodeGraph): CodeRetrievalResult {
  const changed = graph.getChangedFiles();
  const rows = [
    ...changed.added.map((file) => ({ file, snippet: 'added' })),
    ...changed.modified.map((file) => ({ file, snippet: 'modified' })),
    ...changed.removed.map((file) => ({ file, snippet: 'removed' })),
  ];
  return result('变更文件', rows, [], [], undefined, { changed });
}

function cycles(graph: CodeGraph, limit: number): CodeRetrievalResult {
  const found = graph.findCircularDependencies().slice(0, limit);
  const rows = found.map((cycle, index) => ({ symbol: `cycle-${index + 1}`, snippet: cycle.join(' -> ') }));
  return result('循环依赖', rows, [], [], undefined, { cycles: found });
}

function deadCode(graph: CodeGraph, args: Record<string, unknown>, limit: number): CodeRetrievalResult {
  const kinds = Array.isArray(args.kinds) ? (args.kinds as string[]).map(normalizeKind) : undefined;
  const nodes = graph.findDeadCode(kinds).slice(0, limit);
  return result('未引用符号', nodes.map(toRow), nodes);
}

function routes(graph: CodeGraph, limit: number): CodeRetrievalResult {
  const manifest = graph.getRoutingManifest(limit);
  const topRouteFile = graph.getTopRouteFile();
  const rows = (manifest?.entries ?? []).map((entry) => ({
    file: entry.handlerFile, line: entry.handlerLine, symbol: entry.handler, kind: entry.handlerKind, snippet: entry.url,
  }));
  return result('路由', rows, [], [], undefined, { routes: manifest, topRouteFile });
}

function fileDeps(graph: CodeGraph, workspace: string, args: Record<string, unknown>): CodeRetrievalResult {
  const file = indexPath(workspace, args.file as string);
  const direction = typeof args.direction === 'string' ? args.direction : 'dependencies';
  const dependencies = direction === 'dependents' ? [] : graph.getFileDependencies(file).map((path) => path.replaceAll('\\', '/'));
  const dependents = direction === 'dependencies' ? [] : graph.getFileDependents(file).map((path) => path.replaceAll('\\', '/'));
  const rows = [
    ...dependencies.map((path) => ({ file: path, snippet: 'dependency' })),
    ...dependents.map((path) => ({ file: path, snippet: 'dependent' })),
  ];
  return result('文件依赖', rows, [], [], undefined, { dependencies, dependents });
}

async function context(graph: CodeGraph, args: Record<string, unknown>, limit: number): Promise<CodeRetrievalResult> {
  const input = typeof args.query === 'string' ? args.query : { title: args.title as string, description: args.description as string | undefined };
  const built = await graph.buildContext(input, {
    maxNodes: Math.min(numberArg(args.maxNodes, limit), 200),
    ...(args.maxCodeBlocks !== undefined ? { maxCodeBlocks: numberArg(args.maxCodeBlocks, 10) } : {}),
    ...(args.maxCodeBlockSize !== undefined ? { maxCodeBlockSize: numberArg(args.maxCodeBlockSize, 2000) } : {}),
    ...(args.includeCode !== undefined ? { includeCode: args.includeCode === true } : {}),
    ...(args.format === 'markdown' || args.format === 'json' ? { format: args.format } : {}),
    ...(args.searchLimit !== undefined ? { searchLimit: numberArg(args.searchLimit, 5) } : {}),
    ...(args.traversalDepth !== undefined ? { traversalDepth: numberArg(args.traversalDepth, 2) } : {}),
    ...(typeof args.minScore === 'number' ? { minScore: args.minScore } : {}),
  });
  if (typeof built === 'string') return contextFromText(built);
  const nodes = [...built.subgraph.nodes.values()];
  const rows = built.entryPoints.length ? built.entryPoints.map(toRow) : built.relatedFiles.map((file) => ({ file }));
  return result('任务上下文', rows, nodes, built.subgraph.edges, built.summary, {
    context: { query: built.query, summary: built.summary, relatedFiles: built.relatedFiles, stats: built.stats, codeBlocks: built.codeBlocks },
  });
}

function contextFromText(text: string): CodeRetrievalResult {
  let parsed: Record<string, unknown> | undefined;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* markdown default */ }
  const files = Array.isArray(parsed?.relatedFiles)
    ? parsed.relatedFiles.filter((file): file is string => typeof file === 'string')
    : [...new Set([...text.matchAll(/(?:^|[\s*`(-])([\w./\\-]+\.[A-Za-z][\w]*)/g)].map((match) => match[1]))];
  return result('任务上下文', files.map((file) => ({ file })), [], [], text, { context: parsed ?? { text } });
}

function pathBetween(graph: CodeGraph, workspace: string, args: Record<string, unknown>, limit: number): CodeRetrievalResult {
  const from = resolveNode(graph, workspace, args.from as string, args.fromFile as string | undefined);
  if ('isError' in from) return from;
  const to = resolveNode(graph, workspace, args.to as string, args.toFile as string | undefined);
  if ('isError' in to) return to;
  const found = graph.findPath(from.id, to.id, Array.isArray(args.edgeKinds) ? args.edgeKinds as EdgeKind[] : undefined);
  if (!found) return result('路径', [], [], [], '未找到路径');
  const nodes = found.map(({ node }) => node).slice(0, limit);
  const edges = found.flatMap(({ edge }) => edge ? [edge] : []);
  return result('路径', nodes.map(toRow), nodes, edges);
}

function resolveNode(
  graph: CodeGraph, workspace: string, symbol: string | undefined, file?: string, line?: unknown,
): Node | CodeRetrievalResult {
  const indexed = typeof file === 'string' ? indexPath(workspace, file) : undefined;
  if (!symbol && indexed) {
    const nodes = graph.getNodesInFile(indexed);
    const start = nodes.find((node) => node.kind === 'file') ?? nodes[0];
    if (start) return start;
    return { ...result('未找到符号：文件为空', []), isError: true };
  }
  const byId = symbol ? graph.getNode(symbol) : null;
  let candidates = byId ? [byId] : symbol ? graph.getNodesByName(symbol) : [];
  if (indexed !== undefined) candidates = candidates.filter((node) => node.filePath.replaceAll('\\', '/') === indexed);
  if (typeof line === 'number') candidates = candidates.filter((node) => node.startLine <= line && node.endLine >= line);
  if (candidates.length === 1) return candidates[0];
  const message = candidates.length ? '存在同名符号，请提供文件路径或使用节点 ID。' : `未找到符号：${symbol}`;
  return { ...result(message, candidates.map(toRow), candidates), isError: true };
}

function traverseOptions(args: Record<string, unknown>, limit: number): TraversalOptions {
  return {
    maxDepth: Math.min(numberArg(args.maxDepth ?? args.depth, 2), 20),
    ...(Array.isArray(args.edgeKinds) ? { edgeKinds: args.edgeKinds as EdgeKind[] } : {}),
    ...(Array.isArray(args.nodeKinds) ? { nodeKinds: (args.nodeKinds as string[]).map(normalizeKind) } : {}),
    ...(args.direction === 'outgoing' || args.direction === 'incoming' || args.direction === 'both' ? { direction: args.direction } : {}),
    limit,
    ...(args.includeStart !== undefined ? { includeStart: args.includeStart === true } : {}),
  };
}

function subgraphResult(title: string, subgraph: { nodes: Map<string, Node>; edges: Edge[] }, limit: number): CodeRetrievalResult {
  const nodes = [...subgraph.nodes.values()].slice(0, limit);
  const ids = new Set(nodes.map((node) => node.id));
  return result(title, nodes.map(toRow), nodes, subgraph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)));
}

function collectKinds(args: Record<string, unknown>): NodeKind[] {
  const values = [
    ...(Array.isArray(args.kinds) ? args.kinds as string[] : []),
    ...(typeof args.kind === 'string' ? [args.kind] : []),
  ];
  return [...new Set(values.map(normalizeKind))];
}

function normalizeKind(kind: string): NodeKind {
  return (kind === 'type' ? 'type_alias' : kind) as NodeKind;
}

function applyFilters(nodes: Node[], args: Record<string, unknown>, kinds: NodeKind[]): Node[] {
  const languages = Array.isArray(args.languages) ? args.languages as string[] : undefined;
  const include = Array.isArray(args.includePatterns) ? args.includePatterns as string[] : undefined;
  const exclude = Array.isArray(args.excludePatterns) ? args.excludePatterns as string[] : undefined;
  return nodes.filter((node) => {
    if (kinds.length && !kinds.includes(node.kind)) return false;
    if (languages?.length && !languages.includes(node.language)) return false;
    const file = node.filePath.replaceAll('\\', '/');
    if (include?.length && !include.some((pattern) => matchesGlob(file, pattern))) return false;
    if (exclude?.length && exclude.some((pattern) => matchesGlob(file, pattern))) return false;
    return true;
  });
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
  indexPath(root, target);
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

function result(title: string, rows: CodeRetrievalRow[], nodes: Node[] = [], edges: Edge[] = [], detail?: string, extra?: Record<string, unknown>): CodeRetrievalResult {
  const lines = rows.map((row) => [row.symbol ?? row.file, row.kind, row.file && row.line ? `${row.file}:${row.line}` : row.file, row.snippet].filter(Boolean).join(' · '));
  return {
    content: [{ type: 'text', text: [`${title}（${rows.length}）`, ...lines, detail].filter(Boolean).join('\n') }],
    isError: false,
    structuredContent: { schemaVersion: 1, rows, nodes, edges, ...(extra ? { extra } : {}) },
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
