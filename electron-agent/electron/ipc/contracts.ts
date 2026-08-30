export const IPC_CHANNELS = {
  invoke: 'gren:invoke',
  pickDirectory: 'gren:pick-directory',
  openUrl: 'gren:open-url',
  openPath: 'gren:open-path',
  revealItem: 'gren:reveal-item',
  windowMinimize: 'gren:window:minimize',
  windowToggleMaximize: 'gren:window:toggle-maximize',
  windowIsMaximized: 'gren:window:is-maximized',
  windowClose: 'gren:window:close',
  eventPrefix: 'gren:event:',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export interface InvokeRequest {
  command: string;
  args?: Record<string, unknown>;
}

export interface ChannelReference {
  __grenChannelId: string;
}

export interface EventEnvelope<T = unknown> {
  event: string;
  payload: T;
}

export function isInvokeRequest(value: unknown): value is InvokeRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.command === 'string' && (candidate.args === undefined || isRecord(candidate.args));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
