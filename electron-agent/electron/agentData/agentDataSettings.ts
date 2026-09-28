/** 设置里的 AgentData 模型，形如 provider/id。空或无法拆分时表示沿用应用默认模型。 */
export function agentDataModelOverride(raw: string | undefined): { provider: string; modelId: string } | undefined {
  const value = raw?.trim() ?? '';
  const cut = value.indexOf('/');
  if (cut <= 0 || cut === value.length - 1) return undefined;
  return { provider: value.slice(0, cut), modelId: value.slice(cut + 1) };
}

export function applyAgentDataModel<T extends object>(input: T, raw: string | undefined): T {
  const model = agentDataModelOverride(raw);
  if (!model) return input;
  return { ...input, provider: model.provider, modelId: model.modelId };
}
