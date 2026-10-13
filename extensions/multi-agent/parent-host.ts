import { outsideChild } from "../_shared/leak-owner.js";
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
  // 子代理经宿主唤起父会话（结算通知、send_message）时，离开子代理的身份：父会话这一轮的漏网错误不算子代理的
  // （leak-owner.ts）。父会话自己也是子代理时，它的宿主会重新进入它自己的身份。
  const entry: ParentSessionHost = {
    ...host,
    sendMessage: (msg, opts) => outsideChild(() => host.sendMessage(msg, opts)),
    prompt: (text, delivery) => outsideChild(() => host.prompt(text, delivery)),
  };
  hosts.set(host.sessionPath, entry);
  return () => {
    if (hosts.get(host.sessionPath) === entry) hosts.delete(host.sessionPath);
  };
}

export function lookupParentHost(sessionPath: string, workspace: string): ParentSessionHost | undefined {
  const host = hosts.get(sessionPath);
  if (!host || host.workspace !== workspace) return undefined;
  return host;
}

/** subagent-settled 消息本体。经父会话宿主投递和退回到扩展 API 投递用同一个形状。 */
export function settlementMessage(notice: SettlementNotice): {
  customType: string;
  content: string;
  display: boolean;
  details: Record<string, unknown>;
} {
  return {
    customType: "subagent-settled",
    content: notice.content,
    display: true,
    details: {
      childId: notice.childId,
      stopReason: notice.stopReason,
      ...(notice.sessionPath ? { sessionPath: notice.sessionPath } : {}),
    },
  };
}

/** 找不到父会话宿主（CLI、worker 进程里的父会话）时返回 false，由调用方决定退路。 */
export function sendSettlementToParent(
  parentSessionPath: string,
  workspace: string,
  notice: SettlementNotice,
): boolean {
  const host = lookupParentHost(parentSessionPath, workspace);
  if (!host) return false;
  const opts = host.isDraining()
    ? { triggerTurn: false as const }
    : host.isBusy()
      ? { triggerTurn: false as const, deliverAs: "steer" as const }
      : { triggerTurn: true as const, deliverAs: "followUp" as const };
  host.sendMessage(settlementMessage(notice), opts);
  return true;
}

export function __resetParentHostsForTest(): void {
  hosts.clear();
}
