import { getConfig } from './runtime-config.js';
import { MemoryClient } from '../memory/client.js';

export interface DesktopControlPort {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

export function desktopControl(): DesktopControlPort {
  return new MemoryClient();
}

export async function authorizeDesktopOperation(
  client: DesktopControlPort,
  operation: Record<string, unknown>,
): Promise<{ status: 'allowed' | 'denied' | 'blocked' }> {
  try {
    return await client.request('permission.authorize', {
      operation,
      profile: getConfig('PI_PERMISSION_PROFILE') ?? 'workspace',
    });
  } catch {
    return { status: 'denied' };
  }
}
