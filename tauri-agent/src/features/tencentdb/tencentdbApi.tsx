import { useCallback, useEffect, useState } from 'react';
import { tencentdbApi } from '../../lib/tencentdb';
import type { TencentdbConnectionConfig, TencentdbStatus } from '../../lib/tencentdb';

export { tencentdbApi };
export type { TencentdbConnectionConfig, TencentdbStatus };

export const DEFAULT_TENCENTDB_CONFIG: TencentdbConnectionConfig = {
  mode: 'local',
  endpoint: '',
  serviceId: 'personal-memory',
  teamId: 'personal:local',
  agentId: 'pi-personal',
  userId: 'local',
};

export function useTencentdbConnection() {
  const [config, setConfig] = useState<TencentdbConnectionConfig | null>(null);
  const [status, setStatus] = useState<TencentdbStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [nextConfig, nextStatus] = await Promise.all([tencentdbApi.config(), tencentdbApi.status()]);
      setConfig(nextConfig);
      setStatus(nextStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { config, status, loading, error, reload, setConfig, setStatus };
}
