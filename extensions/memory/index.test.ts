import { describe, expect, it } from 'vitest';
import memory from './index.js';

describe('memory extension', () => {
  it('registers local search tools and recall hook', () => {
    const tools: string[] = []; const events: string[] = [];
    memory({ registerTool: (tool: { name: string }) => tools.push(tool.name), on: (name: string) => events.push(name) } as never);
    expect(tools).toEqual(expect.arrayContaining(['memory_search', 'conversation_search']));
    expect(events).toContain('before_agent_start');
  });
});
