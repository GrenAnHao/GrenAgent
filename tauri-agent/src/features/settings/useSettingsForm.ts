import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi } from '../../lib/pi';

export interface SettingsForm {
  values: Record<string, string>;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** 是否有未保存改动（手动保存模式）。 */
  dirty: boolean;
  setValue: (key: string, value: string) => void;
  /** 手动保存：写 runtime-settings.json（扩展 fs.watch 热更新，不重启 sidecar）。 */
  persist: () => Promise<void>;
  /** 保存并重启 sidecar（仅 restart 类设置，如 im-gateway 连接需要）。 */
  save: () => Promise<void>;
}

export function useSettingsForm(): SettingsForm {
  const { workspace } = useAgentStoreContext();
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const wsRef = useRef(workspace);
  wsRef.current = workspace;
  const valuesRef = useRef(values);
  valuesRef.current = values;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void pi
      .getSettings()
      .then((s) => {
        if (alive) {
          setValues(s ?? {});
          setDirty(false);
        }
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 手动保存模式：setValue 只更新本地状态并标记 dirty，不落盘。
  const setValue = useCallback((key: string, value: string) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      valuesRef.current = next;
      return next;
    });
    setDirty(true);
  }, []);

  const persist = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await pi.setSettings(valuesRef.current);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await pi.setSettings(valuesRef.current);
      setDirty(false);
      // restart 类设置：close + open 重启 sidecar 使其生效。
      const ws = wsRef.current;
      await pi.closeWorkspace(ws);
      await pi.openWorkspace(ws);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  return { values, loading, saving, error, dirty, setValue, persist, save };
}
