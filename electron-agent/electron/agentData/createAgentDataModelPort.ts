import { createHash, randomUUID } from 'node:crypto';
import type { AssistantMessage, ThinkingLevel, TranscriptContext } from '@earendil-works/pi-ai';
import type { KnowledgeModelBinding } from '../../shared/knowledgeKernelContracts';
import type { ModelRuntimeHost } from '../agent/modelRuntimeHost';
import type { AgentDataModelPort } from '../agentDataProcess/modelPort';
import { agentDataModelOverride } from './agentDataSettings';

/** The existing knowledge-model route; shared by old Wiki and Repo Wiki. */
export function createAgentDataModelPort(
  host: ModelRuntimeHost,
  readModelSetting: () => string | undefined,
  configurationSource: () => Promise<string> = async () => '',
): AgentDataModelPort & {
  configurationIdentity(): Promise<string>;
  bindKnowledgeModel(taskId?: string): Promise<KnowledgeModelBinding>;
  requestKnowledgeMessage(binding: KnowledgeModelBinding, transcript: TranscriptContext, options: { maxTokens: number; reasoning?: ThinkingLevel; signal?: AbortSignal }): Promise<AssistantMessage>;
} {
  const bindings = new Map<string, { identity: string; model: string }>();
  const resolve = async () => {
    const setting = readModelSetting();
    const selected = agentDataModelOverride(setting);
    const runtime = await host.ensure();
    const source = await configurationSource();
    const configured = selected ? runtime.getModel(selected.provider, selected.modelId) : await host.resolveDefaultModel();
    if (!configured) throw new Error('MODEL_UNAVAILABLE');
    // SDK models are data records. Bind the same immutable configuration that
    // the cache identity describes, including endpoint, headers and compat.
    const model = structuredClone(configured);
    // Provider headers/authHeader are resolved separately from getModel by SDK.
    const request = structuredClone(runtime.getCompatibilityRequestConfig?.(model) ?? {});
    const identity = createHash('sha256').update(JSON.stringify([setting ?? '', model, request, source])).digest('hex');
    return { model, identity, request };
  };
  return {
    configurationIdentity: async () => (await resolve()).identity,
    bindKnowledgeModel: async (taskId) => {
      const { model, identity } = await resolve();
      const bindingId = randomUUID();
      const expectedModel = `${model.provider}/${model.id}`;
      if (!taskId?.startsWith('admission:')) bindings.set(bindingId, { identity, model: expectedModel });
      const { id, name, api, provider, reasoning, input, contextWindow, maxTokens, cost } = model;
      return { bindingId, expectedModel, expectedConfiguration: identity, model: { id, name, api, provider, reasoning, input, contextWindow, maxTokens, cost } };
    },
    requestKnowledgeMessage: async (binding, transcript, options) => {
      const saved = bindings.get(binding.bindingId);
      if (!saved || saved.identity !== binding.expectedConfiguration || saved.model !== binding.expectedModel) throw new Error('MODEL_CHANGED');
      const { model, identity, request } = await resolve();
      if (identity !== saved.identity || `${model.provider}/${model.id}` !== saved.model) throw new Error('MODEL_CHANGED');
      const runtime = await host.ensure();
      return runtime.streamSimple(model, transcript, {
        ...options, maxRetries: 0,
        transformHeaders: async (headers) => {
          if ((await resolve()).identity !== saved.identity) throw new Error('MODEL_CHANGED');
          const actual = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
          for (const [key, value] of Object.entries(request.headers ?? {})) {
            if (actual.get(key.toLowerCase()) !== value) throw new Error('MODEL_CHANGED');
          }
          return headers;
        },
      }).result();
    },
    describe: async () => {
      const selected = agentDataModelOverride(readModelSetting());
      return selected ? `${selected.provider}/${selected.modelId}` : host.describeModel();
    },
    complete: async (input) => {
      const { model, identity, request: providerRequest } = await resolve();
      if (input.expectedModel && `${model.provider}/${model.id}` !== input.expectedModel) throw new Error('MODEL_CHANGED');
      if (input.expectedConfiguration && input.expectedConfiguration !== identity) throw new Error('MODEL_CHANGED');
      const { expectedModel: _expectedModel, expectedConfiguration: _expectedConfiguration, ...request } = input;
      return host.completeSimple({
        ...request, model,
        ...(input.expectedConfiguration ? { beforeDispatch: async (headers: Record<string, string | null>) => {
          if ((await resolve()).identity !== identity) throw new Error('MODEL_CHANGED');
          const actual = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
          for (const [key, value] of Object.entries(providerRequest.headers ?? {})) {
            if (actual.get(key.toLowerCase()) !== value) throw new Error('MODEL_CHANGED');
          }
        } } : {}),
      });
    },
  };
}
