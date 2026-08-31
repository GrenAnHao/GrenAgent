import { describe, expect, it } from 'vitest';
import wikiRag from './index.js';
describe('wiki rag extension', () => { it('registers wiki search', () => { const tools: string[] = []; wikiRag({ registerTool: (tool: { name: string }) => tools.push(tool.name) } as never); expect(tools).toContain('wiki_search'); }); });
