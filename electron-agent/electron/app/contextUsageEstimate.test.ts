import { describe, expect, it } from 'vitest';
import { estimateLiveContextTokens, withEstimatedContextUsage } from './contextUsageEstimate';

describe('withEstimatedContextUsage', () => {
  const unknown = {
    sessionId: 's',
    contextUsage: { tokens: null as number | null, contextWindow: 1000, percent: null as number | null },
  };

  it('fills a post-compaction window from the summary and system prompt', () => {
    const filled = withEstimatedContextUsage(unknown, {
      systemPrompt: 'abcdefgh',
      messages: [{ role: 'compactionSummary', summary: 'abcd' }],
    });
    // 8 prompt chars + 4 summary chars = 12 / 4 = 3 tokens.
    expect(filled.contextUsage).toEqual({ tokens: 3, contextWindow: 1000, percent: 0.3 });
  });

  it('leaves a known provider sample untouched', () => {
    const known = {
      contextUsage: { tokens: 40, contextWindow: 1000, percent: 4 },
    };
    expect(withEstimatedContextUsage(known, { messages: [{ role: 'user', content: 'hello world!!' }] })).toBe(known);
  });

  it('leaves an empty window unknown instead of drawing 0%', () => {
    expect(withEstimatedContextUsage(unknown, { messages: [], systemPrompt: '' })).toBe(unknown);
  });

  it('does not double-count a system message already in the context', () => {
    const tokens = estimateLiveContextTokens({
      systemPrompt: 'this prompt is not added',
      messages: [{ role: 'system', content: 'abcd' }],
    });
    expect(tokens).toBe(1);
  });

  it('counts assistant text, thinking, and tool calls', () => {
    const tokens = estimateLiveContextTokens({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'abcd' },
          { type: 'text', text: 'efgh' },
          { type: 'toolCall', name: 'ab', arguments: { x: 1 } },
        ],
      }],
    });
    const toolChars = 'ab'.length + JSON.stringify({ x: 1 }).length;
    expect(tokens).toBe(Math.ceil((4 + 4 + toolChars) / 4));
  });
});
