import { describe, expect, it, vi } from 'vitest';
import { PiClient, type PiLineTransport } from './client';

class MemoryTransport implements PiLineTransport {
  lines: string[] = [];
  writeLine = vi.fn(async (line: string) => {
    this.lines.push(line);
  });
  kill = vi.fn(async () => {});
}

describe('PiClient', () => {
  it('correlates JSONL responses and rejects command errors', async () => {
    const transport = new MemoryTransport();
    const client = new PiClient('C:/workspace', transport);
    const pending = client.send<{ value: number }>({ type: 'get_state' });
    const request = JSON.parse(transport.lines[0]) as { id: string };
    client.handleLine(JSON.stringify({ type: 'response', id: request.id, command: 'get_state', success: true, data: { value: 7 } }));
    await expect(pending).resolves.toEqual({ value: 7 });

    const failed = client.send({ type: 'abort' });
    const failedRequest = JSON.parse(transport.lines[1]) as { id: string };
    client.handleLine(JSON.stringify({ type: 'response', id: failedRequest.id, command: 'abort', success: false, error: 'busy' }));
    await expect(failed).rejects.toThrow('busy');
  });

  it('forwards events and extension UI requests', () => {
    const transport = new MemoryTransport();
    const onEvent = vi.fn();
    const onUiRequest = vi.fn();
    const client = new PiClient('workspace', transport, { onEvent, onUiRequest });
    client.handleLine('{"type":"agent_start"}');
    client.handleLine('{"type":"extension_ui_request","id":"u1","method":"confirm"}');
    expect(onEvent).toHaveBeenCalledWith('workspace', { type: 'agent_start' });
    expect(onUiRequest).toHaveBeenCalledWith('workspace', { type: 'extension_ui_request', id: 'u1', method: 'confirm' });
  });
});
