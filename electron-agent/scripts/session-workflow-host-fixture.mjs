/** Real production host entry + SDK, test-owned transport/fault boundaries only. */
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir=process.env.PI_CODING_AGENT_DIR;
const nativeFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{
 const url=new URL(typeof input==='string'?input:input.url??String(input));
 if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost'){appendFileSync(join(dir,'remote-attempts.log'),url.origin+'\n');throw Error('Remote requests forbidden in fixture');}
 return nativeFetch(input,options);
};
const sdk=await import(new URL('../../cli/node_modules/@earendil-works/pi-coding-agent/dist/index.js',import.meta.url));
const refresh=sdk.AgentSession.prototype.refreshContext;
sdk.AgentSession.prototype.refreshContext=function(){if(existsSync(join(dir,'fail-refresh')))throw Error('fixture refresh failure after append');return refresh.call(this);};
const navigate=sdk.AgentSession.prototype.navigateTree;
sdk.AgentSession.prototype.navigateTree=async function(...args){const result=await navigate.apply(this,args);if(existsSync(join(dir,'fail-post-tree')))throw Error('fixture session_tree postcondition failure');return result;};
await import(process.env.SESSION_WORKFLOW_HOST_ENTRY?pathToFileURL(process.env.SESSION_WORKFLOW_HOST_ENTRY).href:new URL('../electron/agentProcess/hostEntry.ts',import.meta.url).href);
