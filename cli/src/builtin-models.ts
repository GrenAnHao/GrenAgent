import { getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model } from '@earendil-works/pi-ai';

/** SDK defaults for the model editor, never connection configuration or resolved auth. */
export type BuiltinModelInfo = Pick<Model<Api>,
  | 'id' | 'api' | 'name' | 'reasoning' | 'input' | 'contextWindow' | 'maxTokens' | 'cost'
  | 'thinkingLevelMap' | 'compat' | 'samplingParams' | 'samplingParamsByThinkingLevel'
  | 'inputLimits' | 'promptCache'
>;

/** Static chat catalog only: no Models collection, runtime, credential store or refresh. */
export function listBuiltinModels(provider: string): BuiltinModelInfo[] {
  // Validate membership before the SDK lookup, including inherited keys such as __proto__.
  if (!getBuiltinProviders().some((id) => id === provider)) return [];
  return getBuiltinModels(provider as BuiltinProvider).map((model) => {
    const metadata: BuiltinModelInfo = {
      id: model.id,
      api: model.api,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: model.compat,
      samplingParams: model.samplingParams,
      samplingParamsByThinkingLevel: model.samplingParamsByThinkingLevel,
      inputLimits: model.inputLimits,
      promptCache: model.promptCache,
    };
    // Detach nested metadata from SDK singleton entries and omit non-JSON values/functions.
    return JSON.parse(JSON.stringify(metadata)) as BuiltinModelInfo;
  });
}
