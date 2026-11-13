import { createHash } from 'node:crypto';
import type { ModelRuntimeHost } from '../agent/modelRuntimeHost';
import type { AgentDataModelPort } from './modelPort';
import { agentDataModelOverride } from './agentDataSettings';

/** Short-call model port for AgentData system tasks. Credentials stay in the main process. */
export function createAgentDataModelPort(
  host: ModelRuntimeHost,
  readModelSetting: () => string | undefined,
  configurationSource: () => Promise<string> = async () => '',
): AgentDataModelPort {
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
