import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callFromMessage, defaultLedgerPath, sharedLedger, type UsageLedger } from "./ledger.js";

// 每条带 usage 的助手消息结束时记一笔账。主会话、嵌入式子代理、子进程子代理都会加载本扩展，
// 用量页直接查账本，不再扫会话目录。记账失败只丢这一笔，不影响对话。
// 见 .agents/notes/implemented/architecture/2026-10-21-usage-ledger.md

export interface UsageLedgerOptions {
  /** 测试用：指定账本；默认 <agentDir>/usage/ledger.db。 */
  ledger?: () => UsageLedger;
  now?: () => Date;
}

export function createUsageLedgerExtension(options: UsageLedgerOptions = {}) {
  const ledgerOf = options.ledger ?? (() => sharedLedger(defaultLedgerPath(getAgentDir())));
  const now = options.now ?? (() => new Date());
  return function usageLedger(pi: ExtensionAPI) {
    pi.on("message_end", (event, ctx) => {
      try {
        const manager = ctx.sessionManager;
        const sessionId = manager.getSessionId();
        // 时间取记账这一刻：与 pi 随后写进 jsonl 的条目时间只差几毫秒，历史导入用的是条目时间。
        const call = callFromMessage(event.message, sessionId, now().toISOString());
        if (!call) return;
        const ledger = ledgerOf();
        ledger.transaction(() => {
          ledger.upsertSession({
            id: sessionId,
            path: manager.getSessionFile() ?? null,
            cwd: ctx.cwd || null,
            startedAt: manager.getHeader()?.timestamp ?? null,
            name: manager.getSessionName()?.trim() || null,
          });
          ledger.record(call, "live");
        });
      } catch (error) {
        console.error("[usage-ledger] record failed", error);
      }
    });
  };
}

export default createUsageLedgerExtension();
