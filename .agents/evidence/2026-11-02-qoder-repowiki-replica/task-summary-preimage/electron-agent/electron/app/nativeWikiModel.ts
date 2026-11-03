import { normalizeContext, type AssistantMessage, type Message, type Tool, type TranscriptContext } from '@earendil-works/pi-ai';
import type { KnowledgeModelBinding } from '../../shared/knowledgeKernelContracts';
import type { WikiOperation } from '../wikiService/contracts';
import type { WikiMessage, WikiModelRequest, WikiModelTurn } from '../wikiService/sessionRuntime';

export interface NativeWikiModelPort {
  bindKnowledgeModel(key?: string): Promise<KnowledgeModelBinding>;
  requestKnowledgeMessage(binding: KnowledgeModelBinding, transcript: TranscriptContext, options: { maxTokens: number; signal?: AbortSignal }): Promise<AssistantMessage>;
}
export interface NativeWikiGate {
  admit(operation: WikiOperation, signal: AbortSignal): Promise<string>;
  release(operation: WikiOperation, leaseId: string): Promise<void>;
  project(operation: WikiOperation): Promise<void>;
  dispatched(operation: WikiOperation, requestId: string): Promise<void>;
  stage(eventId: string, operationId: string, stage: string, detail?: unknown): Promise<void>;
  recover(operation: WikiOperation): Promise<void>;
  withSlot<T>(requestId: string, work: () => Promise<T>, signal: AbortSignal): Promise<T>;
}
export interface NativeWikiBridge {
  bind(key: string): Promise<WikiOperation['model']>;
  handle(kind: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  project(operation: WikiOperation): Promise<void>;
  stage(eventId: string, operationId: string, stage: string, detail?: unknown): Promise<void>;
  recover(operation: WikiOperation, proof: { previousExecutorExited: true }): Promise<void>;
  withProjection<T>(operation: WikiOperation, work: () => Promise<T>): Promise<T>;
  abortAndDrain(): Promise<void>;
  activateModelDispatch(): void;
}
const publicBinding = (binding: KnowledgeModelBinding): WikiOperation['model'] => ({ bindingId: binding.bindingId, expectedModel: binding.expectedModel, expectedConfiguration: binding.expectedConfiguration, provider: binding.model.provider, id: binding.model.id, name: binding.model.name, api: binding.model.api, contextWindow: binding.model.contextWindow, maxOutputTokens: binding.model.maxTokens });
const scope = (op: WikiOperation) => JSON.stringify([op.id, op.requestId, op.engine, op.templateVersion, op.action, op.repositoryRoot, op.projectId, op.branch, op.locale, op.targetCommit, op.model, op.author, op.plan, op.spendingPolicy, op.effectiveProfile]);
/** Main owns credentials and SDK objects. Gate owns target leases and the shared model slot. */
export function createNativeWikiModelBridge(ports: { model: NativeWikiModelPort; gate: NativeWikiGate }): NativeWikiBridge {
  const bindings = new Map<string, KnowledgeModelBinding>();
  const active = new Map<string, { leaseId: string; operation: WikiOperation; binding: KnowledgeModelBinding; messages: Set<string>; requests: Map<string, { abort: AbortController; settled: Promise<void> }> }>();
  let modelReady = true; let draining: Promise<void> | undefined;
  return {
    abortAndDrain() {
      modelReady = false;
      if (!draining) {
        const requests = [...active.values()].flatMap(entry => [...entry.requests.values()]);
        for (const request of requests) request.abort.abort();
        draining = Promise.allSettled(requests.map(request => request.settled)).then(() => undefined);
      }
      return draining;
    },
    activateModelDispatch() { modelReady = true; draining = undefined; },
    project: operation => ports.gate.project(operation),
    stage: (eventId, operationId, stage, detail) => ports.gate.stage(eventId, operationId, stage, detail),
    async withProjection(operation, work) {
      const entry = active.get(operation.id);
      if (entry) {
        if (scope(entry.operation) !== scope(operation)) throw new Error('NATIVE_SCOPE_MISMATCH');
        return work();
      }
      const leaseId = await ports.gate.admit(operation, new AbortController().signal);
      try { return await work(); } finally { await ports.gate.release(operation, leaseId); }
    },
    async recover(operation, proof) {
      if (proof.previousExecutorExited !== true) throw new Error('EXECUTOR_EXIT_PROOF_REQUIRED');
      const entry = active.get(operation.id);
      if (entry) {
        if (scope(entry.operation) !== scope(operation)) throw new Error('NATIVE_SCOPE_MISMATCH');
        if (entry.requests.size) throw new Error('OLD_EXECUTOR_NOT_DRAINED');
        await ports.gate.release(operation, entry.leaseId); active.delete(operation.id);
      } else await ports.gate.recover(operation);
    },
    async bind(key) {
      const binding = await ports.model.bindKnowledgeModel(`native:${key}`); bindings.set(binding.bindingId, binding); return publicBinding(binding);
    },
    async handle(kind, input, signal) {
      const op = input.operation as WikiOperation;
      if (!op || typeof op.id !== 'string' || !op.model || typeof op.model.bindingId !== 'string') throw new Error('INVALID_NATIVE_OPERATION');
      if (kind === 'native.admission') {
        if (!modelReady) throw new Error('AGENTDATA_NOT_READY');
        if (active.has(op.id)) throw new Error('NATIVE_ALREADY_ADMITTED');
        let binding = bindings.get(op.model.bindingId);
        if (!binding) {
          binding = await ports.model.bindKnowledgeModel(op.id);
          if (binding.expectedModel !== op.model.expectedModel || binding.expectedConfiguration !== op.model.expectedConfiguration) throw new Error('MODEL_CHANGED');
        } else if (JSON.stringify(publicBinding(binding)) !== JSON.stringify(op.model)) throw new Error('MODEL_CHANGED');
        if (!modelReady) throw new Error('AGENTDATA_NOT_READY');
        const leaseId = await ports.gate.admit(op, signal);
        if (!modelReady) { await ports.gate.release(op, leaseId); throw new Error('AGENTDATA_NOT_READY'); }
        active.set(op.id, { leaseId, operation: structuredClone(op), binding, messages: new Set(), requests: new Map() }); return { leaseId };
      }
      const entry = active.get(op.id);
      if (!entry || scope(entry.operation) !== scope(op)) throw new Error('NATIVE_SCOPE_MISMATCH');
      if (kind === 'native.release') {
        if (input.leaseId !== entry.leaseId) throw new Error('NATIVE_LEASE_MISMATCH');
        await ports.gate.release(op, entry.leaseId); active.delete(op.id); return null;
      }
      if (kind !== 'native.model') throw new Error('UNKNOWN_NATIVE_REQUEST');
      if (!modelReady) throw new Error('AGENTDATA_NOT_READY');
      const request = input as unknown as Omit<WikiModelRequest, 'signal'>;
      if (typeof request.requestId !== 'string' || !Array.isArray(request.messages) || !Array.isArray(request.tools) || typeof request.systemPrompt !== 'string' || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) throw new Error('INVALID_NATIVE_MODEL_REQUEST');
      const calls = new Map<string, string>();
      const messages: Message[] = request.messages.map((message: WikiMessage): Message => {
        if (message.role === 'user') return { role: 'user', content: message.content, timestamp: Date.now() };
        if (message.role === 'assistant') {
          const raw = JSON.stringify(message.nativeMessage);
          if (!message.nativeMessage || !entry.messages.has(raw)) throw new Error('INVALID_NATIVE_TRANSCRIPT');
          const assistant = message.nativeMessage as AssistantMessage;
          for (const part of assistant.content) if (part.type === 'toolCall') calls.set(part.id, part.name);
          return assistant;
        }
        if (message.role === 'tool' && message.toolCallId && calls.has(message.toolCallId)) return { role: 'toolResult', toolCallId: message.toolCallId, toolName: calls.get(message.toolCallId)!, content: [{ type: 'text', text: message.content }], isError: message.toolError === true, timestamp: Date.now() };
        throw new Error('INVALID_NATIVE_TRANSCRIPT');
      });
      const allowed = new Set(['Read', 'Glob', 'Grep', 'ListDir', ...(request.purpose === 'wiki.incremental.catalogue-analysis' ? ['SearchWiki', 'ReadWiki'] : [])]);
      if (request.tools.some(tool => !allowed.has(tool.name))) throw new Error('INVALID_NATIVE_TOOLS');
      const tools = request.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) as Tool[];
      const transcript = normalizeContext({ systemPrompt: request.systemPrompt, messages, tools });
      if (entry.requests.has(request.requestId)) throw new Error('DUPLICATE_REQUEST');
      const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal]);
      let settled!: () => void;
      const done = new Promise<void>(resolve => { settled = resolve; });
      entry.requests.set(request.requestId, { abort, settled: done });
      let response: AssistantMessage;
      try { response = await ports.gate.withSlot(request.requestId, async () => { await ports.gate.dispatched(op, request.requestId); return ports.model.requestKnowledgeMessage(entry.binding, transcript, { maxTokens: request.maxOutputTokens, signal: combined }); }, combined); }
      catch (error) { if (abort.signal.aborted && !signal.aborted) throw new Error('AGENTDATA_NOT_READY'); throw error; }
      finally { entry.requests.delete(request.requestId); settled(); }
      if (response.stopReason === 'aborted') throw new Error('aborted');
      if (response.stopReason === 'pending' || response.stopReason === 'deferred') throw new Error('MODEL_INCOMPLETE');
      const result: WikiModelTurn = { text: response.content.filter(part => part.type === 'text').map(part => part.text).join(''), toolCalls: response.content.filter(part => part.type === 'toolCall').map(part => ({ id: part.id, name: part.name, arguments: part.arguments as Record<string, unknown> })), nativeMessage: response,
        stopReason: response.stopReason === 'length' ? 'length' : response.stopReason === 'error' ? 'error' : 'done',
        ...(response.usage && response.usage.totalTokens > 0 ? { usage: { inputTokens: response.usage.input, outputTokens: response.usage.output, totalTokens: response.usage.totalTokens } } : {}) };
      entry.messages.add(JSON.stringify(response)); return result;
    },
  };
}
