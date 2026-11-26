/**
 * Local loopback "model" for transfer runtime tests: an OpenAI-completions SSE
 * endpoint on 127.0.0.1 that records every request body. It never reaches a real
 * provider, so request counting proves the migration itself asks the model zero
 * times.
 *
 * `lineDelayMs` holds the reply open so a test can observe a turn that is
 * genuinely still streaming (not settled); `release()` finishes those replies.
 */
import { createServer, type Server } from 'node:http';

export interface CapturedModelRequest {
  path: string;
  body: string;
}

export interface LoopbackModel {
  url: string;
  requests: CapturedModelRequest[];
  /** Text the fixture model streams back. */
  reply: string;
  /** Milliseconds to hold each reply open before finishing it. */
  lineDelayMs: number;
  /** Finish every held reply now. */
  release(): void;
  close(): Promise<void>;
}

export async function startLoopbackModel(): Promise<LoopbackModel> {
  const held: Array<() => void> = [];
  const state: LoopbackModel = {
    url: '',
    requests: [],
    reply: 'fixture reply',
    lineDelayMs: 0,
    release() {
      for (const finish of held.splice(0)) finish();
    },
    close: async () => {
      state.release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    state.requests.push({ path: req.url ?? '', body });
    const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model' };
    const payload =
      [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: state.reply }, finish_reason: null }] },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join('') + 'data: [DONE]\n\n';
    if (state.lineDelayMs > 0) {
      await new Promise<void>((resolve) => held.push(resolve));
    }
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return state;
}
