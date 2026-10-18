import { posix, win32 } from 'node:path';

/** Snapshot of CodeGraph 1.6.2 NODE_KINDS. A protocol test compares this to the SDK export. */
export const CODEGRAPH_NODE_KINDS = [
  'file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol', 'function', 'method',
  'property', 'field', 'variable', 'constant', 'enum', 'enum_member', 'type_alias', 'namespace',
  'parameter', 'import', 'export', 'route', 'component', 'union',
] as const;

/** Snapshot of CodeGraph 1.6.2 EDGE_KINDS. */
export const CODEGRAPH_EDGE_KINDS = [
  'contains', 'calls', 'imports', 'exports', 'extends', 'implements', 'references',
  'type_of', 'returns', 'instantiates', 'overrides', 'decorates', 'navigates',
] as const;

/** Snapshot of CodeGraph 1.6.2 LANGUAGES. */
export const CODEGRAPH_LANGUAGES = [
  'typescript', 'javascript', 'tsx', 'jsx', 'arkts', 'python', 'go', 'rust', 'java', 'c', 'cpp',
  'csharp', 'razor', 'php', 'ruby', 'swift', 'kotlin', 'dart', 'svelte', 'vue', 'astro', 'liquid',
  'pascal', 'scala', 'lua', 'luau', 'objc', 'r', 'solidity', 'nix', 'yaml', 'twig', 'xml',
  'properties', 'cfml', 'cfscript', 'cfquery', 'cobol', 'vbnet', 'erlang', 'terraform', 'unknown',
] as const;

const toolArguments = {
  codegraph_search: ['query', 'kind', 'kinds', 'languages', 'includePatterns', 'excludePatterns', 'limit', 'offset', 'caseSensitive', 'mode', 'excludePrefix', 'words'],
  codegraph_explore: ['query', 'maxFiles', 'limit', 'searchLimit', 'traversalDepth', 'maxNodes', 'minScore', 'edgeKinds', 'nodeKinds', 'seedNames'],
  codegraph_callers: ['symbol', 'file', 'limit', 'depth'],
  codegraph_callees: ['symbol', 'file', 'limit', 'depth'],
  codegraph_impact: ['symbol', 'file', 'depth', 'limit'],
  codegraph_node: ['symbol', 'file', 'includeCode', 'offset', 'limit', 'symbolsOnly', 'line', 'depth', 'includeMetrics'],
  codegraph_files: ['path', 'pattern', 'format', 'includeMetadata', 'maxDepth', 'limit', 'offset'],
  codegraph_status: [],
  codegraph_usages: ['symbol', 'file', 'limit', 'line'],
  codegraph_path: ['from', 'to', 'fromFile', 'toFile', 'edgeKinds', 'limit'],
  codegraph_hierarchy: ['symbol', 'file', 'limit'],
  codegraph_call_graph: ['symbol', 'file', 'depth', 'limit'],
  codegraph_deps: ['file', 'direction'],
  codegraph_cycles: ['limit'],
  codegraph_dead_code: ['kinds', 'limit'],
  codegraph_metrics: ['symbol', 'file'],
  codegraph_routes: ['limit'],
  codegraph_traverse: ['symbol', 'file', 'maxDepth', 'depth', 'edgeKinds', 'nodeKinds', 'direction', 'limit', 'includeStart'],
  codegraph_context: ['query', 'title', 'description', 'maxNodes', 'maxCodeBlocks', 'maxCodeBlockSize', 'includeCode', 'format', 'searchLimit', 'traversalDepth', 'minScore', 'limit'],
  codegraph_changed: [],
} as const;

export type CodeRetrievalTool = keyof typeof toolArguments;
export const CODE_RETRIEVAL_TOOLS = Object.keys(toolArguments) as CodeRetrievalTool[];

const NODE_KIND_SET = new Set<string>([...CODEGRAPH_NODE_KINDS, 'type']);
const EDGE_KIND_SET = new Set<string>(CODEGRAPH_EDGE_KINDS);
const LANGUAGE_SET = new Set<string>(CODEGRAPH_LANGUAGES);
const SEARCH_MODES = new Set(['search', 'prefix', 'substring', 'kind', 'name', 'segment']);
const DEPS_DIRECTIONS = new Set(['dependencies', 'dependents', 'both']);
const TRAVERSE_DIRECTIONS = new Set(['outgoing', 'incoming', 'both']);
const FILE_FORMATS = new Set(['tree', 'flat', 'grouped']);
const CONTEXT_FORMATS = new Set(['markdown', 'json']);
const QUERY_OPTIONAL = new Set(['codegraph_files', 'codegraph_status', 'codegraph_changed', 'codegraph_cycles', 'codegraph_dead_code', 'codegraph_routes']);
const SYMBOL_TOOLS = new Set(['codegraph_callers', 'codegraph_callees', 'codegraph_impact', 'codegraph_usages', 'codegraph_hierarchy', 'codegraph_call_graph', 'codegraph_metrics']);

export function readCodeRetrievalTool(value: unknown): CodeRetrievalTool {
  if (typeof value !== 'string' || !Object.hasOwn(toolArguments, value)) throw new Error('Unsupported CodeGraph tool');
  return value as CodeRetrievalTool;
}

/** RPC boundary validation only; never starts CodeGraph or touches an index. */
export function validateCodeRetrievalArgs(workspace: string, tool: CodeRetrievalTool, value: unknown): Record<string, unknown> {
  const path = /^[a-z]:|^\\\\/i.test(workspace) ? win32 : posix;
  if (!workspace.trim() || !path.isAbsolute(workspace) || workspace.includes('\0')) throw new Error('workspace must be an absolute path');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CodeGraph args must be an object');
  const args = { ...value } as Record<string, unknown>;
  const allowed: readonly string[] = toolArguments[readCodeRetrievalTool(tool)];
  for (const key of Object.keys(args)) {
    if (key !== 'projectPath' && !allowed.includes(key)) throw new Error(`Unsupported CodeGraph argument: ${key}`);
  }
  if (args.projectPath !== undefined) {
    const projectPath = readString(args.projectPath, 'projectPath', 4000);
    if (!path.isAbsolute(projectPath) || path.relative(path.resolve(workspace), path.resolve(projectPath)) !== '') {
      throw new Error('projectPath must match workspace');
    }
  }
  delete args.projectPath;

  requirePrimary(tool, args);
  if (args.symbol !== undefined) readString(args.symbol, 'symbol', 1000);
  if (args.query !== undefined) readString(args.query, 'query', 4000);
  if (args.from !== undefined) readString(args.from, 'from', 1000);
  if (args.to !== undefined) readString(args.to, 'to', 1000);
  if (args.title !== undefined) readString(args.title, 'title', 1000);
  if (args.description !== undefined) readString(args.description, 'description', 4000);

  for (const key of ['file', 'path', 'pattern', 'fromFile', 'toFile']) {
    if (args[key] === undefined) continue;
    assertWorkspacePath(path, workspace, readString(args[key], key, key === 'pattern' ? 1000 : 2000, key !== 'file' && key !== 'fromFile' && key !== 'toFile'), key);
  }
  for (const key of ['includePatterns', 'excludePatterns']) {
    if (args[key] === undefined) continue;
    for (const item of readStringArray(args[key], key, 1000)) assertWorkspacePath(path, workspace, item, key);
  }

  for (const key of ['limit', 'depth', 'maxFiles', 'maxDepth', 'line', 'searchLimit', 'traversalDepth', 'maxNodes', 'maxCodeBlocks', 'maxCodeBlockSize']) {
    if (args[key] !== undefined) readInt(args[key], key, 1);
  }
  if (args.offset !== undefined) readInt(args.offset, 'offset', 0);
  if (args.minScore !== undefined) {
    if (typeof args.minScore !== 'number' || !Number.isFinite(args.minScore) || args.minScore < 0 || args.minScore > 1) {
      throw new Error('minScore must be a number between 0 and 1');
    }
  }
  for (const key of ['includeCode', 'symbolsOnly', 'includeMetadata', 'caseSensitive', 'excludePrefix', 'includeStart', 'includeMetrics']) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  }

  if (args.format !== undefined) {
    const allowedFormats = tool === 'codegraph_context' ? CONTEXT_FORMATS : FILE_FORMATS;
    if (typeof args.format !== 'string' || !allowedFormats.has(args.format)) throw new Error('Invalid format');
  }
  if (args.kind !== undefined && (typeof args.kind !== 'string' || !NODE_KIND_SET.has(args.kind))) throw new Error('Invalid kind');
  if (args.kinds !== undefined) readEnumArray(args.kinds, 'kinds', NODE_KIND_SET);
  if (args.nodeKinds !== undefined) readEnumArray(args.nodeKinds, 'nodeKinds', NODE_KIND_SET);
  if (args.edgeKinds !== undefined) readEnumArray(args.edgeKinds, 'edgeKinds', EDGE_KIND_SET);
  if (args.languages !== undefined) readEnumArray(args.languages, 'languages', LANGUAGE_SET);
  if (args.seedNames !== undefined) readStringArray(args.seedNames, 'seedNames', 1000);
  if (args.words !== undefined) readStringArray(args.words, 'words', 200);
  if (args.mode !== undefined && (typeof args.mode !== 'string' || !SEARCH_MODES.has(args.mode))) throw new Error('Invalid mode');
  if (args.direction !== undefined) {
    const allowedDirections = tool === 'codegraph_deps' ? DEPS_DIRECTIONS : TRAVERSE_DIRECTIONS;
    if (typeof args.direction !== 'string' || !allowedDirections.has(args.direction)) throw new Error('Invalid direction');
  }
  return args;
}

function requirePrimary(tool: CodeRetrievalTool, args: Record<string, unknown>): void {
  if (tool === 'codegraph_search') {
    if (args.mode === 'kind') {
      if (args.kind === undefined && args.kinds === undefined) throw new Error('kind is required');
      return;
    }
    readString(args.query, 'query', 4000);
    return;
  }
  if (tool === 'codegraph_explore') {
    readString(args.query, 'query', 4000);
    return;
  }
  if (tool === 'codegraph_context') {
    if (args.query === undefined && args.title === undefined) throw new Error('query or title is required');
    return;
  }
  if (tool === 'codegraph_path') {
    readString(args.from, 'from', 1000);
    readString(args.to, 'to', 1000);
    return;
  }
  if (tool === 'codegraph_deps') {
    readString(args.file, 'file', 2000);
    return;
  }
  if (QUERY_OPTIONAL.has(tool)) return;
  if (tool === 'codegraph_node' || tool === 'codegraph_traverse') {
    if (args.file === undefined) readString(args.symbol, 'symbol', 1000);
    return;
  }
  if (SYMBOL_TOOLS.has(tool)) readString(args.symbol, 'symbol', 1000);
}

function assertWorkspacePath(path: typeof posix, workspace: string, text: string, key: string): void {
  const portable = text.trim().replace(/\\/g, '/');
  const relative = path.relative(path.resolve(workspace), path.resolve(workspace, portable));
  if ((path === posix && /^[a-z]:/i.test(portable)) || /^[a-z]:[^/]/i.test(portable)
    || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${key} must stay within workspace`);
  }
}

function readString(value: unknown, name: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength || value.includes('\0')) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function readInt(value: unknown, name: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a positive integer`);
  return value;
}

function readStringArray(value: unknown, name: string, maxLength: number, maxItems = 50): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Invalid ${name}`);
  return value.map((item) => readString(item, name, maxLength));
}

function readEnumArray(value: unknown, name: string, allowed: Set<string>): string[] {
  const items = readStringArray(value, name, 100);
  if (items.some((item) => !allowed.has(item))) throw new Error(`Invalid ${name}`);
  return items;
}
