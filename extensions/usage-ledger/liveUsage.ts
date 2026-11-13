import { callFromMessage, callKey, defaultLedgerPath, sharedLedger, warmFromEntry, warmKey, type UsageLedger } from './ledger.js';
import { sharedOriginRegistry, type UsageOriginRegistry } from './originRegistry.js';

/** Installed where the actual AgentSession is owned, including CLI and embedded workers. */
export function attachUsageEntryTracking(session:any,agentDir:string,options:{ledger?:UsageLedger;registry?:UsageOriginRegistry}={}):()=>void {
  let ledger:UsageLedger;let registry:UsageOriginRegistry;
  try{ledger=options.ledger??sharedLedger(defaultLedgerPath(agentDir));registry=options.registry??sharedOriginRegistry(agentDir);}
  catch{console.error('[usage-ledger] provenance tracking unavailable; model execution continues');return()=>{};}
  const manager=session.sessionManager;
  const consume=(entry:any)=>{
    try {
      const sessionId=manager.getSessionId();const ref={sessionId,entryId:entry.id};
      const warm=warmFromEntry(entry,sessionId);
      const call=entry.type==='message'?callFromMessage(entry.message,sessionId,entry.timestamp):null;
      if(!warm&&!call)return;
      registry.registerLocalEntry(ref,manager.getSessionFile());
      if(warm){ledger.recordWarm(warm);registry.bindLedgerKey(ref,warmKey(warm));}
      else if(call){call.entryId=entry.id;const key=callKey(call);if(key){ledger.record(call,'live');registry.bindLedgerKey(ref,key);}}
    }catch {console.error('[usage-ledger] persisted usage could not be registered');}
  };
  return session.subscribe((event:any)=>{
    if(event.type==='entry_appended')consume(event.entry);
    // SDK emits message_end before its synchronous appendMessage; the microtask observes
    // only that exact message object, never scans/re-grants restored history.
    else if(event.type==='message_end'&&event.message?.role==='assistant')queueMicrotask(()=>{
      try{const entry=manager.getEntries().findLast((e:any)=>e.type==='message'&&e.message===event.message);if(entry)consume(entry);}catch{console.error('[usage-ledger] persisted entry unavailable');}
    });
  });
}
