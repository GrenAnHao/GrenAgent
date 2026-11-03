import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectFiles } from '../../vendor/repo-wiki/packages/core/src/project-files';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';

export interface KernelProviderCall { phase: string; itemId: string; stageItemId: string; final: boolean; body: Record<string, any>; aborted: boolean; settled: boolean; startedAt: number; endedAt?: number; release(): void }
export interface KernelFixtureDefinition { id: string; title: string; goal: string; dependencies: string[] }
export const PARALLEL_PAGE_IDS = ['a', 'b', 'c', 'e', 'f', 'g', 'z-after-a', 'z-after-chain'] as const;
export const PARALLEL_DEFINITIONS: KernelFixtureDefinition[] = PARALLEL_PAGE_IDS.map(id => ({ id, title: `Page ${id}`, goal: `Explain ${id}`, dependencies: id === 'z-after-a' ? ['a'] : id === 'z-after-chain' ? ['z-after-a'] : [] }));
/** HTTP is the only fake: the SDK still serializes messages/tools and the official Agent executes Read. */
export async function kernelFixtureProvider(log: (line: string) => void, options: { parallel?: boolean; validationLinks?: boolean; safeUnknown?: boolean } = {}) {
  const calls: KernelProviderCall[] = [];
  let active = 0, peak = 0;
  const definitions = options.parallel ? PARALLEL_DEFINITIONS : [{ id: 'api', title: 'API entry', goal: 'Explain api.ts', dependencies: [] }, { id: 'library', title: 'Library module', goal: 'Explain lib.ts', dependencies: [] }];
  const catalogue = (stageItemId: string): unknown => ({ children: stageItemId === 'catalogue:root' ? definitions : [] });
  let hold = (_call: KernelProviderCall) => false;
  let fail = (_call: KernelProviderCall) => false;
  let brokenLink = true;
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    const buffers: Buffer[] = []; for await (const chunk of request) buffers.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    const stage = body.messages.map((message: any) => { const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('') : ''; try { return message.role === 'user' ? JSON.parse(text) : null; } catch { return null; } }).find((value: any) => value?.phase && value?.context?.files);
    if (!stage) { response.writeHead(400).end('Missing stage JSON prompt'); return; }
    const phase = String(stage.phase), stageItemId = String(stage.itemId ?? phase), itemId = String(stage.item?.id ?? stageItemId.replace(/^catalogue:(?:item:)?/, '')), final = body.messages.some((message: any) => message.role === 'tool');
    const path = options.validationLinks && itemId === 'library' ? 'README.md' : itemId === 'library' ? 'lib.ts' : itemId === 'api' ? 'api.ts' : 'README.md';
    const file = stage.context.files[path];
    const source = { path, hash: file?.hash, start: 1, end: 1 };
    const call: KernelProviderCall = { phase, itemId, stageItemId, final, body, aborted: false, settled: false, startedAt: Date.now(), release: () => {} };
    call.release = () => {
      if (call.settled) return; call.settled = true; call.endedAt = Date.now(); active--;
      if (fail(call)) { response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Injected kernel page failure', type: 'server_error' } })); return; }
      let payload: unknown;
      if (phase === 'overview') payload = { summary: 'The fixture exposes an API and an independent library.', sources: [source] };
      else if (phase === 'plan') payload = { items: definitions };
      else if (phase === 'catalogue') payload = catalogue(stageItemId);
      else if (phase === 'generate' && options.validationLinks && itemId === 'library') payload = { markdown: [
        '# Library', '', '[Readme](README.md#kernel-fixture)', '[API page](api.md#api)',
        '```md', '[not a real link](missing-fenced.md)', '```',
        '`[not a link either](missing-inline.md)`',
        ...(brokenLink ? [`[Broken Wiki](${options.safeUnknown ? 'missing-page.md' : '../../missing-page.md'})`] : []),
        `[Evidence](source:${path}#L1)`,
      ].join('\n'), sources: [source] };
      else if (phase === 'generate') payload = { markdown: `# ${itemId}\n\nVerified ${path} from the manifest. [Source](source:${path}#L1)\n`, sources: [source] };
      else if (phase === 'relations') payload = { relations: [{ from: 'api', to: 'library', type: 'uses', sources: [source] }] };
      else if (phase === 'validate') payload = { valid: true };
      else { response.writeHead(400).end(`Unknown phase ${phase}`); return; }
      const tool = !final ? { index: 0, id: `read-${phase}-${itemId}`, type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path, offset: 1, limit: 1 }) } } : undefined;
      respond(response, body.model, tool ? { tool_calls: [tool] } : { content: JSON.stringify(payload) }, tool ? 'tool_calls' : 'stop');
      log(`provider ${phase}/${itemId} ${final ? 'result' : 'Read'}`);
    };
    response.on('close', () => { if (!call.settled) { call.aborted = true; call.settled = true; call.endedAt = Date.now(); active--; log(`provider aborted ${phase}/${itemId}`); } });
    active++; peak = Math.max(peak, active); calls.push(call); log(`provider entered ${phase}/${itemId} final=${final}`);
    if (!hold(call)) call.release();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  return { calls, repairLinks: () => { brokenLink = false; }, get active() { return active; }, get peak() { return peak; }, baseUrl: `http://127.0.0.1:${address.port}/v1`, hold: (predicate: typeof hold) => { hold = predicate; }, fail: (predicate: typeof fail) => { fail = predicate; }, close: async () => { for (const call of calls) call.release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function respond(response: ServerResponse, model: string, delta: unknown, finish: 'stop' | 'tool_calls'): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = { id: 'kernel-fixture', object: 'chat.completion.chunk', created: 1, model };
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(delta as object) }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}


/** Verify durable publication, not merely the task's completed state. Reads must fail loudly. */
export async function inspectPublishedWiki(projectPath: string, language: string) {
  const files = new ProjectFiles(projectPath, language);
  const receipt = files.readPublicationReceipt();
  if (!receipt) throw new Error('Missing formal publication receipt');
  const facts = files.load();
  const snapshot = facts.snapshots[receipt.namespace];
  const baseline = snapshot?.kernelBaseline;
  const requiredItems = baseline?.graph?.nodes?.filter((n: any) => n.phase === 'generate') as Array<{ id: string; phase: string; kind: string; inputHash: string }> | undefined;
  if (!requiredItems?.length) throw new Error('Missing frozen required page graph');
  const manifest = baseline?.checkpoints?.find((item: any) => item.phase === 'validate' && item.itemId === 'validate')?.payload;
  if (baseline.graph.version === 2) {
    const catalogue = baseline.checkpoints.find((item: any) => item.itemId === 'catalogue:complete')?.payload;
    if (manifest?.version !== 2 || manifest.domain !== 'wiki' || manifest.pipelineConfigHash !== baseline.pipelineConfigHash || manifest.structureHash !== catalogue?.catalogueHash || !manifest.sourceSnapshotId || manifest.failedOrBlocked?.length !== 0 || !Array.isArray(manifest.required)) throw new Error('Missing or invalid frozen completion manifest');
    const required = requiredItems.map(n => ({ phase: n.phase, itemId: n.id, kind: n.kind, inputHash: n.inputHash })).sort((a, b) => a.itemId.localeCompare(b.itemId));
    const declared = manifest.required.map((n: any) => ({ phase: n.phase, itemId: n.itemId, kind: n.kind, inputHash: n.inputHash })).sort((a: any, b: any) => a.itemId.localeCompare(b.itemId));
    if (JSON.stringify(declared) !== JSON.stringify(required) || manifest.required.some((n: any) => typeof n.outputHash !== 'string' || !n.outputHash)) throw new Error('Completion manifest differs from frozen required items');
  }
  const expected = requiredItems.map(n => n.id.replace(/^(?:generate|card):/, '')).sort();
  const pages = Object.values(facts.pages[receipt.namespace] ?? {}).filter(p => p.status !== 'archived');
  if (JSON.stringify(pages.map(p => p.id).sort()) !== JSON.stringify(expected)) throw new Error('Published page set differs from frozen required items');
  const directory = join(files.directory, 'namespaces', receipt.namespace, 'pages');
  const published = (await readdir(directory, { recursive: true })).filter(name => name.endsWith('.md'));
  if (published.length !== pages.length) throw new Error('Formal Markdown inventory differs from namespace page set');
  for (const name of published) if (!(await readFile(join(directory, name), 'utf8')).trim()) throw new Error(`Empty formal Markdown: ${name}`);
  for (const page of pages) {
    if (!page.markdown?.trim() || !page.sources?.length) throw new Error(`Empty page or sources: ${page.id}`);
    for (const source of page.sources) {
      const frozen = baseline.sourceSnapshot?.files?.[source.path];
      if (!frozen?.hash || baseline.sourceSnapshot.hashes[source.path] !== frozen.hash || !Number.isInteger(source.start_line) || source.start_line < 1 || !Number.isInteger(source.end_line) || source.end_line < source.start_line || source.end_line > frozen.lines) throw new Error(`Source outside frozen snapshot: ${page.id}/${source.path}`);
      const text = await readFile(join(projectPath, ...source.path.split('/')), 'utf8');
      if (!text.split(/\r?\n/).slice(source.start_line - 1, source.end_line).join('\n').trim()) throw new Error(`Empty cited source: ${page.id}/${source.path}`);
    }
  }
  return { receipt, requiredItems: manifest?.required ?? requiredItems, pageIds: pages.map(p => p.id).sort(), published, pages };
}
