import { createHash, randomUUID } from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { KNOWLEDGE_FRAME_MAX_BYTES, KNOWLEDGE_ITEM_MAX_BYTES, type KnowledgeEvidence, type StageExecutionRequest, type StageExecutionResult } from '../../shared/knowledgeKernelContracts';
import { createKnowledgeStreamFn } from '../agent/knowledgeModelTurn';
import { createKnowledgeReadTools } from './readTools';
import type { KnowledgeStageInput, KnowledgeStagePorts } from './stageProtocol';

/**
 * Parse a stage answer. Accepts a bare object, a ```json fenced object, or an object surrounded by
 * prose; anything else is INVALID_MODEL_JSON. Schema checks happen later in the coordinator.
 */
export function parseStageJson(text: string): unknown {
  const attempts = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) attempts.push(fenced[1].trim());
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));
  for (const candidate of attempts) {
    try { const value = JSON.parse(candidate); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* try the next shape */ }
  }
  throw new Error('INVALID_MODEL_JSON');
}

/** Tool failures caused by the requested path; anything else (snapshot change, budget, IO) is fatal. */
// SEARCH_FAILED is rg rejecting the model's pattern (for example a literal \n), not a broken search.
const RECOVERABLE_TOOL_ERRORS = ['FORBIDDEN_PATH', 'BINARY_SOURCE', 'ENOENT', 'EISDIR', 'Invalid glob', 'regex parse error', 'SEARCH_FAILED'];
function isRecoverableToolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RECOVERABLE_TOOL_ERRORS.some(code => message.includes(code));
}

/** Retain a status only when the provider explicitly identifies it at the start of the error. */
function modelErrorCode(message: string): string {
  const status = /^(?:(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?[:\s]+))?([45]\d\d)\b/i.exec(message.trim());
  return status ? `MODEL_HTTP_${status[1]}` : 'MODEL_ERROR';
}

/** Remaining turns at which the model starts getting an explicit budget reminder. */
const FINAL_TURN_WARNING = 3;

/** Execute one isolated stage with the official Agent and only manifest-bound read tools. */
export async function runKnowledgeStage(request: StageExecutionRequest, ports: KnowledgeStagePorts, signal?: AbortSignal): Promise<StageExecutionResult> {
  if (Buffer.byteLength(JSON.stringify(request)) > KNOWLEDGE_FRAME_MAX_BYTES) throw new Error('FRAME_TOO_LARGE');
  const input = request.input as KnowledgeStageInput;
  if (!input || typeof input.root !== 'string' || !Array.isArray(input.manifest) || typeof input.systemPrompt !== 'string' || typeof input.userPrompt !== 'string') throw new Error('INVALID_STAGE_INPUT');
  const unit = request.budget.unit;
  const evidence: KnowledgeEvidence[] = [];
  // Partial tool output is not a failure: the tool tells the model how to continue, and the
  // coordinator only accepts citations inside the line ranges a Read actually returned.
  let fatal: unknown, lastReadBytes = 0;
  const abort = new AbortController();
  const onAbort = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let lease: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve(), leaseRunning = false;
  const reserveLease = async () => { const id = randomUUID(); await ports.reserve({ requestId: id, kind: 'time', reserved: { activeTimeMs: 5000 } }); lease = id; };
  const finishLease = async () => { const id = lease; lease = undefined; if (id) await ports.finish(id, { activeTimeMs: 5000 }); };
  const scheduleLease = () => { timer = setTimeout(() => { pending = (async () => { await finishLease(); if (leaseRunning) { await reserveLease(); if (leaseRunning) scheduleLease(); } })().catch(error => { fatal = error; abort.abort(error); }); }, 4500); };
  const startLease = async () => { if (leaseRunning) return; leaseRunning = true; try { await reserveLease(); scheduleLease(); } catch (error) { leaseRunning = false; throw error; } };
  const stopLease = async () => { leaseRunning = false; if (timer) clearTimeout(timer); await pending; if (timer) clearTimeout(timer); await finishLease(); if (fatal) throw fatal; };
  const tools = createKnowledgeReadTools({ root: input.root, maxFileBytes: unit.maxFileBytes, maxLines: unit.maxReadLines, maxResultBytes: unit.maxResultBytes, maxMatches: unit.maxSearchMatches, maxEntries: unit.maxDirectoryEntries }, input.manifest, observation => {
    evidence.push({ path: observation.path, hash: observation.hash, kind: observation.kind, scope: observation.scope, startLine: observation.startLine, endLine: observation.endLine });
    lastReadBytes = observation.readBytes ?? 0;
  });
  const wrapped = tools.map(tool => ({ ...tool, execute: async (id: string, args: any, toolSignal?: AbortSignal, update?: any) => {
    const reservation = randomUUID();
    let dispatched = false;
    try {
      if (abort.signal.aborted) throw abort.signal.reason ?? new Error('aborted');
      await ports.reserve({ requestId: reservation, kind: 'tool', reserved: { readBytes: tool.name === 'Read' || tool.name === 'Grep' ? unit.maxResultBytes : 0, resultBytes: unit.maxResultBytes } });
      if (abort.signal.aborted) throw abort.signal.reason ?? new Error('aborted');
      await ports.markDispatched?.(reservation);
      dispatched = true;
      lastReadBytes = 0;
      const result = await tool.execute(id, args, toolSignal, update);
      if (fatal) throw fatal;
      const text = result.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
      await ports.finish(reservation, { readBytes: lastReadBytes, resultBytes: Buffer.byteLength(text) });
      return result;
    } catch (error) {
      // A bad path or a binary file is the model's mistake: report it as a tool error and let it
      // continue. Budget, a changed snapshot or abort still stop the whole stage.
      if (!dispatched || fatal || abort.signal.aborted || !isRecoverableToolError(error)) { fatal ??= error; abort.abort(error); throw error; }
      await ports.finish(reservation, { readBytes: 0, resultBytes: 0 });
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(reason.startsWith('SEARCH_FAILED') ? `${reason.trim()}\nFix the pattern (single-line regex, or literal: true) and try again.` : `${reason}: this path is not readable here. Use Glob or ListDir to find manifest files and try another path.`);
    }
    finally { if (!dispatched) await ports.release?.(reservation); }
  } }));
  const model = { ...request.binding.model, baseUrl: 'http://knowledge.invalid' } as Model<Api>;
  let modelTurns = 0, toolCalls = 0;
  const streamFn = createKnowledgeStreamFn(async (_model, transcript, options) => {
    modelTurns++;
    await stopLease();
    try {
      return await ports.requestModel({
        controllerEpoch: request.fence.controllerEpoch, requestId: randomUUID(), taskId: request.taskId, fence: request.fence,
        phase: request.phase, itemId: request.itemId, attempt: request.attempt, bindingId: request.binding.bindingId, transcript,
        options: { maxTokens: Math.min(unit.maxOutputTokens, model.maxTokens, unit.maxTotalTokens), ...(options?.reasoning ? { reasoning: options.reasoning } : {}) },
      }, AbortSignal.any([abort.signal, ...(options?.signal ? [options.signal] : [])]));
    } finally { if (!abort.signal.aborted) await startLease(); }
  });
  // The model cannot see the unit budget on its own: without these notes it kept reading files
  // until the last allowed request was spent and the stage ended BUDGET_EXHAUSTED without an answer.
  const note = (text: string) => ({ role: 'user' as const, content: text, timestamp: Date.now() });
  const prepareNextTurnWithContext = ({ context, toolResults }: { context: { messages: any[]; tools?: any[] }; toolResults: unknown[] }) => {
    toolCalls += toolResults.length;
    const turnsLeft = unit.maxModelRequests - modelTurns, toolsLeft = unit.maxToolCalls - toolCalls;
    if (!toolResults.length) return undefined;
    if (turnsLeft <= 1 || toolsLeft <= 0) return {
      context: { ...context, tools: [] },
      messages: [note('This is your final turn and no tools remain. Do not request more tools. Reply now with the complete JSON object, using only the evidence already gathered and stating any gaps.')],
    };
    if (turnsLeft <= FINAL_TURN_WARNING) return { messages: [note(`Budget: ${turnsLeft - 1} more tool turn(s) and ${toolsLeft} tool call(s) remain before you must answer. Batch the reads you still need into one turn, then return the JSON.`)] };
    return undefined;
  };
  const budgetIntro = `\n\nBudget for this step: at most ${unit.maxModelRequests} model turns and ${unit.maxToolCalls} tool calls. Request several tools in one turn instead of one per turn, and leave a turn for the final JSON.`;
  const agent = new Agent({ initialState: { model, systemPrompt: input.systemPrompt + budgetIntro, tools: wrapped }, streamFn, toolExecution: 'sequential', prepareNextTurnWithContext });
  const abortAgent = () => agent.abort();
  abort.signal.addEventListener('abort', abortAgent, { once: true });
  let payload: unknown = null, disposition: StageExecutionResult['disposition'] = 'failed', error: StageExecutionResult['error'], retriable = false;
  try {
    if (abort.signal.aborted) throw abort.signal.reason ?? new Error('aborted');
    await startLease();
    await agent.prompt(input.userPrompt);
    if (fatal) throw fatal;
    if (abort.signal.aborted) throw abort.signal.reason ?? new Error('aborted');
    const last = agent.state.messages.at(-1);
    if (!last || last.role !== 'assistant' || last.stopReason !== 'stop') {
      if (last?.role === 'assistant' && last.stopReason === 'error' && /\b(?:429|5\d\d)\b/.test(last.errorMessage ?? '')) retriable = true;
      throw new Error(last?.role === 'assistant' && last.stopReason === 'error' ? modelErrorCode(last.errorMessage ?? '') : last && last.role === 'assistant' ? `MODEL_${last.stopReason.toUpperCase()}` : 'MODEL_NO_RESULT');
    }
    const answer = (message: typeof last) => message.content.filter(part => part.type === 'text').map(part => part.text).join('');
    try { payload = parseStageJson(answer(last)); }
    catch (parseError) {
      // Real models often wrap the object in ```json fences or add a sentence; ask once for the bare object.
      if (modelTurns >= unit.maxModelRequests) throw parseError;
      await agent.prompt('Your last reply was not a single valid JSON object. Reply again with only that JSON object: no Markdown fences, no text before or after it.');
      const retry = agent.state.messages.at(-1);
      if (retry?.role === 'assistant' && retry.stopReason === 'error') throw new Error(modelErrorCode(retry.errorMessage ?? ''));
      if (!retry || retry.role !== 'assistant' || retry.stopReason !== 'stop') throw parseError;
      payload = parseStageJson(answer(retry));
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > KNOWLEDGE_ITEM_MAX_BYTES) throw new Error('PAYLOAD_TOO_LARGE');
    disposition = 'prepared';
  } catch (cause) {
    payload = null;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes('BUDGET_EXHAUSTED') || message.includes('CATALOGUE_LIMIT')) disposition = 'blocked';
    error = { code: message, message, retriable };
  } finally {
    try { await stopLease(); } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); disposition = message.includes('BUDGET_EXHAUSTED') || message.includes('CATALOGUE_LIMIT') ? 'blocked' : 'failed'; error = { code: message, message, retriable: false }; }
    signal?.removeEventListener('abort', onAbort);
    abort.signal.removeEventListener('abort', abortAgent);
  }
  return { version: 1, taskId: request.taskId, fence: request.fence, phase: request.phase, itemId: request.itemId, stageAttempt: request.attempt, sequence: 1, inputHash: request.inputHash, outputHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload, evidence, dependencies: input.dependencies ?? [], disposition, ...(error ? { error } : {}) };
}
