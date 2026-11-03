import { isAbsolute } from 'node:path';
import { createKnowledgeReadTools, type KnowledgeSourceFile } from '../knowledgeProcess/readTools';
export type WikiToolName = 'Read' | 'Glob' | 'Grep' | 'ListDir';
export interface WikiToolCall { id: string; name: string; arguments: Record<string, unknown> }
export const WIKI_TOOLS = [
  { name: 'Read', description: 'Read a repository-relative file in the frozen source manifest.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] } },
  { name: 'Glob', description: 'List frozen repository files matching a glob.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search frozen repository file contents.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'ListDir', description: 'List entries in the frozen source manifest.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
] as const;
export async function executeRepositoryTool(root: string, name: string, args: Record<string, unknown>, manifest: KnowledgeSourceFile[], signal?: AbortSignal): Promise<{ content: string; error?: string }> {
  try {
    if (!WIKI_TOOLS.some(tool => tool.name === name)) throw new Error('unknown_tool');
    const path = args.path ?? '.';
    if (typeof path !== 'string' || !path || isAbsolute(path) || /^[a-z]:/i.test(path) || path.includes('\\') || path.split('/').includes('..')) throw new Error('invalid_repository_path');
    if (name === 'Read' && args.path === undefined) throw new Error('invalid_repository_path');
    if ((name === 'Glob' || name === 'Grep') && (typeof args.pattern !== 'string' || !args.pattern)) throw new Error('invalid_pattern');
    const tool = createKnowledgeReadTools({ root, maxResultBytes: name === 'ListDir' ? 8000 : 32768 }, manifest).find(item => item.name === name);
    if (!tool) throw new Error('unknown_tool');
    const result = await tool.execute('wiki-read', args, signal, undefined);
    return { content: result.content.filter(item => item.type === 'text').map(item => item.text).join('\n') };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const message = error instanceof Error ? error.message : '';
    return { content: '', error: /^(invalid_repository_path|unknown_tool|invalid_pattern|FORBIDDEN_PATH|SNAPSHOT_CHANGED|BINARY_SOURCE)$/.test(message) ? message : 'repository_tool_failed' };
  }
}
