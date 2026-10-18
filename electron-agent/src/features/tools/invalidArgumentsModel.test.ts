import { describe, expect, it } from 'vitest';
import { parseInvalidArguments } from './invalidArgumentsModel';

/** Build the error text the way pi 1.3.0 does: parseToolCallArguments, then validateToolArguments. */
async function piInvalidArgumentsText(tool: string, raw: string): Promise<string> {
  const { parseToolCallArguments } = await import('@earendil-works/pi-ai/utils/json-parse');
  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  const { Type } = await import('typebox');
  const parsed = parseToolCallArguments(raw);
  expect(parsed.argumentsError).toBeTruthy();
  try {
    validateToolArguments(
      { name: tool, description: '', parameters: Type.Object({ command: Type.String() }) },
      { type: 'toolCall', id: 'call-1', name: tool, ...parsed },
    );
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('validation unexpectedly passed');
}

describe('parseInvalidArguments', () => {
  it('reads the reason and the raw text from the result pi builds for malformed arguments', async () => {
    const raw = '{"command": "echo hi", "timeout": 5,}';
    const text = await piInvalidArgumentsText('bash', raw);
    const parsed = parseInvalidArguments({ content: [{ type: 'text', text }], isError: true });
    expect(parsed).toEqual({
      tool: 'bash',
      reason: expect.stringMatching(/JSON/),
      received: raw,
    });
  });

  it('keeps multi-line received text as sent', async () => {
    const raw = '{"command": "line1\nline2"';
    const text = await piInvalidArgumentsText('mcp__antd__antd_doc', raw);
    expect(parseInvalidArguments({ content: [{ type: 'text', text }] })?.received).toBe(raw);
    expect(parseInvalidArguments({ content: [{ type: 'text', text }] })?.tool).toBe('mcp__antd__antd_doc');
  });

  it('ignores other tool errors, including schema validation failures', () => {
    expect(parseInvalidArguments({ content: [{ type: 'text', text: 'Command exited with code 1' }] })).toBeUndefined();
    expect(parseInvalidArguments({ content: [{ type: 'text', text: 'Validation failed for tool "bash":\n  - command: must be string' }] })).toBeUndefined();
    expect(parseInvalidArguments(undefined)).toBeUndefined();
  });
});
