import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callFromMessage,callKey,warmFromEntry,warmKey, defaultLedgerPath, sharedLedger, type UsageLedger } from "./ledger.js";

import {sharedOriginRegistry,type UsageOriginRegistry} from "./originRegistry.js";
import {ensureLegacyRoster} from "./legacyRoster.js";

// 每条带 usage 的助手消息结束时记一笔账。主会话、嵌入式子代理、子进程子代理都会加载本扩展，
// 用量页直接查账本，不再扫会话目录。记账失败只丢这一笔，不影响对话。
// 见 .agents/notes/implemented/architecture/2026-10-21-usage-ledger.md

export interface UsageLedgerOptions {
  /** 测试用：指定账本；默认 <agentDir>/usage/ledger.db。 */
  ledger?: () => UsageLedger;
  now?: () => Date;
  registry?:()=>UsageOriginRegistry;
}

export function createUsageLedgerExtension(options: UsageLedgerOptions = {}) {
  const ledgerOf = options.ledger ?? (() => sharedLedger(defaultLedgerPath(getAgentDir())));
  const registryOf=options.registry??(()=>sharedOriginRegistry(getAgentDir()));
  const now = options.now ?? (() => new Date());
  return function usageLedger(pi: ExtensionAPI) {
    const seen=new Map<string,Set<string>>();
    pi.on('session_start',(_event,ctx)=>{
      const manager=ctx.sessionManager;
      // session_start only establishes a negative baseline, never grants old entries.
      seen.set(manager.getSessionId(),new Set(manager.getEntries().map(e=>e.id)));
      if(!options.registry)try{ensureLegacyRoster(getAgentDir(),registryOf());}catch{console.error('[usage-ledger] legacy provenance unavailable');}
    });
    const capture=(_event:unknown,ctx:any)=>{
      const manager=ctx.sessionManager;const sessionId=manager.getSessionId();const known=seen.get(sessionId);if(!known)return;
      try{
        const ledger=ledgerOf();const registry=registryOf();
        for(const entry of manager.getEntries()){
          if(known.has(entry.id))continue;
          const warm=warmFromEntry(entry,sessionId);
          const call=entry.type==='message'?callFromMessage(entry.message,sessionId,entry.timestamp):null;
          if(!warm&&!call){known.add(entry.id);continue;}
          const ref={sessionId,entryId:entry.id};registry.registerLocalEntry(ref,manager.getSessionFile());
          if(warm){ledger.recordWarm(warm);registry.bindLedgerKey(ref,warmKey(warm));}
          else if(call){call.entryId=entry.id;const key=callKey(call);if(key){ledger.record(call,'live');registry.bindLedgerKey(ref,key);}}
          known.add(entry.id);
        }
      }catch{console.error('[usage-ledger] delayed persisted usage could not be registered');}
    };
    // Official CLI main exposes no AgentSession observer. These are delayed public
    // lifecycle checkpoints, not a polling loop or an entry_appended substitute.
    pi.on('turn_end',capture);pi.on('agent_end',capture);
    pi.on('session_shutdown',(event,ctx)=>{capture(event,ctx);seen.delete(ctx.sessionManager.getSessionId());});
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
        console.error("[usage-ledger] record failed");
      }
    });
  };
}

export default createUsageLedgerExtension();
