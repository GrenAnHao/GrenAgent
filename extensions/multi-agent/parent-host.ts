import type { SettlementNotice } from "./settlement-notice.js";

export interface ParentSessionHost {
  sessionId: string;
  sessionPath: string;
  workspace: string;
  isBusy(): boolean;
  isDraining(): boolean;
  sendMessage: (
    msg: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
    opts: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" },
  ) => void;
  prompt: (text: string, delivery: "followUp" | "steer") => void;
}

const hosts = new Map<string, ParentSessionHost>();

export function registerParentSessionHost(host: ParentSessionHost): () => void {
  hosts.set(host.sessionPath, host);
  return () => {
    if (hosts.get(host.sessionPath) === host) hosts.delete(host.sessionPath);
  };
}

export function lookupParentHost(sessionPath: string, workspace: string): ParentSessionHost | undefined {
  const host = hosts.get(sessionPath);
  if (!host || host.workspace !== workspace) return undefined;
  return host;
}

export function sendSettlementToParent(
  parentSessionPath: string,
  workspace: string,
  notice: SettlementNotice,
): void {
  const host = lookupParentHost(parentSessionPath, workspace);
  if (!host) return;
  const opts = host.isDraining()
    ? { triggerTurn: false as const }
    : host.isBusy()
      ? { triggerTurn: false as const, deliverAs: "steer" as const }
      : { triggerTurn: true as const, deliverAs: "followUp" as const };
  host.sendMessage(
    {
      customType: "subagent-settled",
      content: notice.content,
      display: true,
      details: {
        childId: notice.childId,
        stopReason: notice.stopReason,
        ...(notice.sessionPath ? { sessionPath: notice.sessionPath } : {}),
      },
    },
    opts,
  );
}

export function __resetParentHostsForTest(): void {
  hosts.clear();
}
