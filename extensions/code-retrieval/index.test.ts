import { describe, expect, it } from 'vitest';
import codeRetrieval from './index.js';

describe('code retrieval extension', () => {
  it('registers CodeGraph tools', () => {
    const tools: string[] = [];
    codeRetrieval({ registerTool: (tool: { name: string }) => tools.push(tool.name) } as never);
    expect(tools).toEqual(expect.arrayContaining(['code_search', 'code_explore', 'code_callers', 'code_callees', 'code_impact']));
  });
});
