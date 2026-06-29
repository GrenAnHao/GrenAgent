import { useEffect, useState } from 'react';
import { pi } from '../lib/pi';
import { latestSubAgentStep } from '../features/panels/subagentUtils';

const POLL_MS = 2500;

export interface SubAgentLive {
  model: string | null;
  step: number | null;
  action: string | null;
}

/** 运行中按 agentId 轮询 registry，解析模型 + 最新一步；非运行/无 id 时静默。 */
export function useSubAgentLive(workspace: string, agentId: string | null, running: boolean): SubAgentLive {
  const [live, setLive] = useState<SubAgentLive>({ model: null, step: null, action: null });

  useEffect(() => {
    if (!workspace || !agentId || !running) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const rows = await pi.subagentList(workspace);
        if (cancelled) return;
        const row = rows.find((r) => r.id === agentId);
        if (!row) return;
        const ls = latestSubAgentStep(row.transcript ?? '');
        setLive({ model: row.model ?? null, step: ls?.step ?? null, action: ls?.action ?? null });
      } catch {
        // 跨进程读 registry 偶发 SQLITE_BUSY：保留上次结果，下个 tick 再试。
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspace, agentId, running]);

  return live;
}
