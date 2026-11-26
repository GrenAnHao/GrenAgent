import { useEffect, useState } from 'react';
import type { McpInspection } from '../../../../extensions/mcp/inspection';
import { useMcpStatusStore } from '../../stores/mcpStatusStore';

type Inspect = (workspace: string, name: string, since?: string) => Promise<McpInspection>;
export function useMcpInspection(workspace: string, name: string | undefined, attempt: string | undefined, inspect?: Inspect) {
  const key = JSON.stringify([workspace, name]);
  const [detail, setDetail] = useState<{ key: string; catalog?: McpInspection['catalog']; diagnostics?: McpInspection['diagnostics']; error?: string }>();
  useEffect(() => {
    if (!workspace || !name || !inspect) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>, since: string | undefined;
    const refresh = async () => {
      const before = useMcpStatusStore.getState().serversByWorkspace[workspace];
      try {
        const reply = await inspect(workspace, name, since);
        if (stopped) return;
        if (before !== useMcpStatusStore.getState().serversByWorkspace[workspace]) return;
        if (JSON.stringify(before ?? []) !== JSON.stringify(reply.servers))
          useMcpStatusStore.getState().setWorkspaceServers(workspace, reply.servers);
        const online = reply.servers.some(s => s.name === name && s.status === 'connected');
        since = online ? reply.diagnostics?.attemptedAt : undefined;
        setDetail(prev => {
          const catalog = online ? reply.catalog ?? (prev?.key === key ? prev.catalog : undefined) : undefined;
          return prev?.key === key && !prev.error && catalog === prev.catalog && JSON.stringify(prev.diagnostics) === JSON.stringify(reply.diagnostics)
            ? prev : { key, catalog, diagnostics: reply.diagnostics };
        });
      } catch (e) { if (!stopped) setDetail({ key, error: e instanceof Error ? e.message : String(e) }); }
      finally { if (!stopped) timer = setTimeout(refresh, 2000); }
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [key, workspace, name, attempt, inspect]);
  return detail?.key === key ? detail : undefined;
}
