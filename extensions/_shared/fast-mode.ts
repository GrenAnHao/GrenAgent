/** Shared capability contract; keep this module browser-safe. */
export interface FastModel {
  provider?: string;
  id?: string;
  api?: string;
  compat?: unknown;
}

export function fastApiSupported(api: string | undefined): boolean {
  return ['anthropic-messages', 'openai-completions', 'openai-responses', 'openai-codex-responses', 'azure-openai-responses'].includes(api ?? '');
}

export function supportsFastMode(model: FastModel | null | undefined): boolean {
  const compat = model?.compat;
  return !!compat && typeof compat === 'object' &&
    (compat as Record<string, unknown>).supportsFastMode === true && fastApiSupported(model?.api);
}

export function fastPreferenceKey(provider: string, id: string): string {
  return `${provider}\0${id}`;
}

/** Operates on the built request, preserving thinking, tools and existing betas. */
export function applyFastPayload(payload: unknown, api: string | undefined, enabled: boolean): unknown {
  if (!enabled || !fastApiSupported(api) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  if (api === 'anthropic-messages') {
    const betas = Array.isArray(body.betas) ? body.betas.filter((v): v is string => typeof v === 'string') : [];
    return { ...body, speed: 'fast', betas: [...new Set([...betas, 'fast-mode-2026-02-01'])] };
  }
  return { ...body, service_tier: 'priority' };
}
