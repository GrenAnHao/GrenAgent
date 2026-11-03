import { randomUUID } from 'node:crypto';
import type { WikiOperation, WikiUsage } from './contracts';
import { REFERENCE_PROFILE } from './referenceProfiles';
import { referenceWikiTools, type ReferenceSection } from './reference/qoder-0.5.1/wikiTools';
import { executeRepositoryTool, WIKI_TOOLS, type WikiToolCall } from './repositoryTools';

export interface WikiMessage { role: 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolError?: boolean; toolCalls?: WikiToolCall[]; nativeMessage?: unknown }
export interface WikiModelRequest { requestId: string; purpose: string; operation: WikiOperation; systemPrompt: string; messages: WikiMessage[]; tools: ReadonlyArray<{ name: string; description: string; inputSchema: object }>; maxOutputTokens: number; signal: AbortSignal }
export interface WikiModelTurn { text: string; stopReason?: 'done' | 'length' | 'error' | 'unknown'; toolCalls?: WikiToolCall[]; nativeMessage?: unknown; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }
export type WikiSessionEvent = { kind: 'session-start' | 'session-finish' | 'model-submitted' | 'model-dispatched' | 'model-completed' | 'tool-start' | 'tool-finish'; stage: string; itemId: string; runId: string; attempt: number; round: number; sessionRestartCount: number; requestId?: string; toolName?: string; error?: boolean };
export type WikiRequestModel = (request: WikiModelRequest) => Promise<WikiModelTurn>;

/** Host adapter, not a claim about the unavailable Qoder SDK message envelope. */
export async function runWikiSession(input: { operation: WikiOperation; signal: AbortSignal; purpose: string; systemPrompt: string; prompt: string; usage(value: WikiUsage): void; requestModel: WikiRequestModel; trace?: Omit<WikiSessionEvent, 'kind' | 'requestId' | 'toolName' | 'error'>; event?: (event: WikiSessionEvent) => void; manifest: Array<{ path: string; hash: string }>; priorWiki?: { catalogue: ReferenceSection[]; pages: Record<string, unknown> } }): Promise<{ text: string; turns: number; stopReason: 'done' | 'length' | 'error' | 'unknown' }> {
  const record = (kind: WikiSessionEvent['kind'], extra: Partial<WikiSessionEvent> = {}) => { if (input.trace) input.event?.({ ...input.trace, ...extra, kind }); };
  record('session-start');
  const messages: WikiMessage[] = [{ role: 'user', content: input.prompt }];
  const modelLimit = Number(input.operation.model?.maxOutputTokens);
  const maxOutputTokens = Number.isFinite(modelLimit) && modelLimit > 0 ? Math.min(modelLimit, REFERENCE_PROFILE.maxOutputTokens) : REFERENCE_PROFILE.maxOutputTokens;
  const modelContext = Number(input.operation.model?.contextWindow);
  const contextWindow = Number.isFinite(modelContext) && modelContext > 0 ? Math.min(modelContext, REFERENCE_PROFILE.contextWindow) : REFERENCE_PROFILE.contextWindow;
  const wikiTools = input.priorWiki ? referenceWikiTools(input.priorWiki.catalogue, Object.entries(input.priorWiki.pages).flatMap(([sectionId, value]) => { const content = (value as { markdown?: unknown })?.markdown; return typeof content === 'string' ? [{ sectionId, content }] : []; })) : [];
  const toolDefinitions = input.priorWiki ? [...WIKI_TOOLS, ...wikiTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))] : WIKI_TOOLS;
  const estimateTokens = (value: string) => { const bytes = Buffer.byteLength(value, 'utf8'); return bytes === 0 ? 0 : bytes <= 3 ? 1 : Math.floor(bytes / 3); };
  let estimate = [input.systemPrompt, input.prompt, JSON.stringify(toolDefinitions)].reduce((sum, value) => sum + estimateTokens(value), 0);
  const seenCalls = new Set<string>();
  for (let turn = 0; turn <= REFERENCE_PROFILE.maxSteps; turn++) {
    input.signal.throwIfAborted();
    const closing = turn === REFERENCE_PROFILE.maxSteps || turn > 0 && estimate >= contextWindow;
    if (closing) messages.push({ role: 'user', content: 'Do not call any more tools. Follow the original output format and provide the final answer now. Use the same output language as the original request or instructions.' });
    const requestId = randomUUID();
    input.usage({ requestId, state: 'dispatched', reservationTokens: contextWindow + maxOutputTokens });
    record('model-submitted', { requestId });
    let response: WikiModelTurn;
    try { response = await input.requestModel({ requestId, purpose: input.purpose, operation: input.operation, systemPrompt: input.systemPrompt, messages: [...messages], tools: closing ? [] : toolDefinitions, maxOutputTokens, signal: input.signal }); }
    catch (error) { input.usage({ requestId, state: 'unknown', reservationTokens: contextWindow + maxOutputTokens }); record('model-completed', { requestId, error: true }); throw error; }
    const usage = response.usage;
    const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
    const totalTokens = valid(usage?.totalTokens) && usage.totalTokens > 0 ? usage.totalTokens : valid(usage?.inputTokens) && valid(usage?.outputTokens) && usage.inputTokens + usage.outputTokens > 0 ? usage.inputTokens + usage.outputTokens : undefined;
    input.usage(valid(totalTokens) ? { requestId, state: 'actual', ...(valid(usage?.inputTokens) ? { inputTokens: usage.inputTokens } : {}), ...(valid(usage?.outputTokens) ? { outputTokens: usage.outputTokens } : {}), totalTokens } : { requestId, state: 'unknown', reservationTokens: contextWindow + maxOutputTokens });
    record('model-completed', { requestId, error: response.stopReason === 'error' });
    const calls = response.toolCalls ?? [];
    // A terminal provider response that won the race with pause is still a valid checkpoint.
    if (!calls.length || response.stopReason === 'error' || response.stopReason === 'length') return { text: response.text, turns: turn + 1, stopReason: response.stopReason ?? 'unknown' };
    input.signal.throwIfAborted();
    if (closing) throw new Error('session_closing_tool_call');
    const assistant: WikiMessage = { role: 'assistant', content: response.text, toolCalls: calls, ...(response.nativeMessage ? { nativeMessage: response.nativeMessage } : {}) };
    messages.push(assistant); estimate += estimateTokens(JSON.stringify(response.nativeMessage ?? assistant));
    for (const call of calls) {
      if (seenCalls.has(call.id)) continue;
      seenCalls.add(call.id);
      input.signal.throwIfAborted();
      const toolName = ['Read', 'Glob', 'Grep', 'ListDir', 'SearchWiki', 'ReadWiki'].includes(call.name) ? call.name : 'unknown';
      record('tool-start', { requestId, toolName });
      const wikiTool = wikiTools.find(tool => tool.name === call.name);
      let result: { content: string; error?: string };
      if (!wikiTool) result = await executeRepositoryTool(input.operation.repositoryRoot, call.name, call.arguments, input.manifest, input.signal);
      else if (wikiTool.name === 'SearchWiki') {
        const { query, limit } = call.arguments;
        result = typeof query === 'string' && query.trim() && (limit === undefined || Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= 20)
          ? { content: JSON.stringify(wikiTool.execute({ query, ...(typeof limit === 'number' ? { limit } : {}) })) } : { content: '', error: 'invalid_arguments' };
      } else {
        const { ref } = call.arguments;
        result = typeof ref === 'string' ? { content: JSON.stringify(wikiTool.execute({ ref })) } : { content: '', error: 'invalid_arguments' };
      }
      record('tool-finish', { requestId, toolName, error: !!result.error });
      if (result.error === 'SNAPSHOT_CHANGED') throw new Error('SOURCE_SNAPSHOT_CHANGED');
      const message: WikiMessage = { role: 'tool', toolCallId: call.id, toolError: !!result.error, content: result.error ? JSON.stringify({ error: result.error }) : result.content };
      messages.push(message); estimate += estimateTokens(JSON.stringify(message));
    }
  }
  throw new Error('session_turn_limit');
}



