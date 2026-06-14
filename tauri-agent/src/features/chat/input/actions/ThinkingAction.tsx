import { useCallback, useEffect, useState } from 'react';
import { Select } from '@lobehub/ui/base-ui';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { pi } from '../../../../lib/pi';

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

const OPTIONS = LEVELS.map((l) => ({ label: l, value: l }));

interface RpcSessionState {
  thinkingLevel?: string;
}

export default function ThinkingAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const [level, setLevel] = useState('off');
  const [ready, setReady] = useState(false);

  const loadLevel = useCallback(async () => {
    try {
      const state = (await pi.getState(workspace)) as RpcSessionState;
      if (state?.thinkingLevel) setLevel(state.thinkingLevel);
      setReady(true);
      return true;
    } catch {
      setReady(false);
      return false;
    }
  }, [workspace]);

  useEffect(() => {
    if (!workspaceReady) {
      setReady(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      await loadLevel();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace, workspaceReady, loadLevel]);

  const onChange = (next: string) => {
    setLevel(next);
    void pi.setThinkingLevel(workspace, next);
  };

  const onOpenChange = (open: boolean) => {
    if (open && !ready) void loadLevel();
  };

  return (
    <Select
      size="small"
      popupMatchSelectWidth={false}
      disabled={!workspaceReady || !ready}
      value={level}
      options={OPTIONS}
      placeholder="推理"
      onChange={onChange}
      onOpenChange={onOpenChange}
    />
  );
}
