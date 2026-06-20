// app.ts —— HTTP 入口（原生 http 模块）
//
// OpenAI 兼容：
//   POST /v1/embeddings   body: {"model":"bge-small-zh-v1.5","input":"..." | ["...", "..."]}
//   POST /embeddings      同上（baseUrl 未带 /v1 时 Pi capabilityFetch 会走此路径）
//
// Legacy：
//   POST /embed           body: {"text":"hello"}  ->  {"dim":512,"vector":[...]}
//
//   GET  /health          ->  {"ok":true,"model":"..."}
//   GET  /                ->  使用说明

import http = require('node:http');
import { DEFAULT_MODEL_ID, DEFAULT_OPENAI_MODEL, getEmbedding, getEmbeddings } from './vector-service';

const PORT = Number(process.env.PORT) || 8787;
const MAX_BODY = 1_000_000;

type LegacyEmbedBody = { text?: unknown };
type OpenAIEmbedBody = { model?: unknown; input?: unknown };

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('request body too large');
  }
  return body;
}

function pathname(req: http.IncomingMessage): string {
  return (req.url ?? '/').split('?')[0] || '/';
}

/** 可选鉴权：设 EMBED_API_KEY 后要求 Bearer 匹配；未设则 localhost 服务不校验（Pi 仍会带 Bearer）。 */
function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const required = process.env.EMBED_API_KEY?.trim();
  if (!required) return true;
  const auth = req.headers.authorization ?? '';
  if (auth === `Bearer ${required}`) return true;
  json(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
  return false;
}

function parseOpenAIInput(input: unknown): string[] {
  if (typeof input === 'string') return input.trim() ? [input] : [];
  if (Array.isArray(input)) {
    return input.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  }
  return [];
}

function openAIResponse(model: string, vectors: number[][]): Record<string, unknown> {
  return {
    object: 'list',
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    model,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

async function handleOpenAIEmbeddings(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!checkAuth(req, res)) return;
  let payload: OpenAIEmbedBody;
  try {
    payload = JSON.parse(await readBody(req) || '{}') as OpenAIEmbedBody;
  } catch {
    json(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
    return;
  }
  const texts = parseOpenAIInput(payload.input);
  if (texts.length === 0) {
    json(res, 400, { error: { message: 'Missing or empty "input"', type: 'invalid_request_error' } });
    return;
  }
  try {
    const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : DEFAULT_OPENAI_MODEL;
    const vectors = await getEmbeddings(texts);
    json(res, 200, openAIResponse(model, vectors));
  } catch (e) {
    console.error('[/embeddings] error:', e);
    const msg = e instanceof Error ? e.message : String(e);
    json(res, 500, { error: { message: msg, type: 'server_error' } });
  }
}

async function handleLegacyEmbed(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let payload: LegacyEmbedBody;
  try {
    payload = JSON.parse(await readBody(req) || '{}') as LegacyEmbedBody;
  } catch {
    json(res, 400, { error: 'invalid JSON' });
    return;
  }
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    json(res, 400, { error: 'missing "text"' });
    return;
  }
  try {
    const vector = await getEmbedding(payload.text);
    json(res, 200, { dim: vector.length, vector, model: DEFAULT_OPENAI_MODEL });
  } catch (e) {
    console.error('[/embed] error:', e);
    const msg = e instanceof Error ? e.stack || e.message : String(e);
    json(res, 500, { error: msg });
  }
}

const server = http.createServer(async (req, res) => {
  const path = pathname(req);
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/health') {
    json(res, 200, { ok: true, model: DEFAULT_OPENAI_MODEL, modelId: DEFAULT_MODEL_ID });
    return;
  }

  if (method === 'POST' && (path === '/v1/embeddings' || path === '/embeddings')) {
    await handleOpenAIEmbeddings(req, res);
    return;
  }

  if (method === 'POST' && path === '/embed') {
    await handleLegacyEmbed(req, res);
    return;
  }

  if (method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      '本地向量服务已就绪\n' +
        `模型：${DEFAULT_MODEL_ID}（OpenAI 名：${DEFAULT_OPENAI_MODEL}）\n\n` +
        'OpenAI 兼容：POST /v1/embeddings\n' +
        '  body: {"model":"bge-small-zh-v1.5","input":"你好"}\n' +
        '  或 input 为字符串数组批量嵌入\n\n' +
        'Legacy：POST /embed   body: {"text":"你好"}\n',
    );
    return;
  }

  json(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
});

server.listen(PORT, () => {
  console.log(`vector-service listening on http://127.0.0.1:${PORT} (${DEFAULT_MODEL_ID})`);
});
