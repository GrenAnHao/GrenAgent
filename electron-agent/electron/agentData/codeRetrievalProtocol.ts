import { posix, win32 } from 'node:path';

const toolArguments = {
  codegraph_search: ['query', 'kind', 'limit'],
  codegraph_explore: ['query', 'maxFiles', 'limit'],
  codegraph_callers: ['symbol', 'file', 'limit', 'depth'],
  codegraph_callees: ['symbol', 'file', 'limit', 'depth'],
  codegraph_impact: ['symbol', 'file', 'depth', 'limit'],
  codegraph_node: ['symbol', 'file', 'includeCode', 'offset', 'limit', 'symbolsOnly', 'line', 'depth'],
  codegraph_files: ['path', 'pattern', 'format', 'includeMetadata', 'maxDepth'],
} as const;

export type CodeRetrievalTool = keyof typeof toolArguments;

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

  if (tool === 'codegraph_search' || tool === 'codegraph_explore') readString(args.query, 'query', 4000);
  else if (tool !== 'codegraph_files' && !(tool === 'codegraph_node' && args.file !== undefined)) readString(args.symbol, 'symbol', 1000);
  if (args.symbol !== undefined) readString(args.symbol, 'symbol', 1000);

  for (const key of ['file', 'path', 'pattern']) {
    if (args[key] === undefined) continue;
    const text = readString(args[key], key, key === 'pattern' ? 1000 : 2000, key !== 'file');
    const portable = text.trim().replace(/\\/g, '/');
    const relative = path.relative(path.resolve(workspace), path.resolve(workspace, portable));
    if ((path === posix && /^[a-z]:/i.test(portable)) || /^[a-z]:[^/]/i.test(portable)
      || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`${key} must stay within workspace`);
    }
  }
  for (const key of ['limit', 'depth', 'maxFiles', 'maxDepth', 'offset', 'line']) {
    if (args[key] !== undefined && (typeof args[key] !== 'number' || !Number.isSafeInteger(args[key]) || args[key] < 1)) {
      throw new Error(`${key} must be a positive integer`);
    }
  }
  for (const key of ['includeCode', 'symbolsOnly', 'includeMetadata']) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  }
  if (args.format !== undefined && (typeof args.format !== 'string' || !['tree', 'flat', 'grouped'].includes(args.format))) throw new Error('Invalid format');
  if (args.kind !== undefined && (typeof args.kind !== 'string' || !['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'].includes(args.kind))) throw new Error('Invalid kind');
  return args;
}

function readString(value: unknown, name: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength || value.includes('\0')) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
