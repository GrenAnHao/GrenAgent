import { createServer } from "node:http";
import { once } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { createManager } from "./manager";
import { inspectMcp, callInspectedTool } from "./inspection";
import type { McpServerConfig } from "./config";
vi.mock("./logRotate.js", () => ({ appendCappedLog: () => {} }));

const fixture = `
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const {id,method,params}=JSON.parse(line); if(id===undefined)return;
 let result={};
 if(method==='initialize')result={protocolVersion:params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'catalog-fixture',version:'1'}};
 if(method==='tools/list'){
  const start=params?.cursor?40:0;
  result={tools:Array.from({length:40},(_,i)=>({name:'tool-'+(start+i),description:'Fetch item '+(start+i),inputSchema:{type:'object',properties:{query:{type:'string'}}}})),...(start?{}:{nextCursor:'page2'})};
 }
 if(method==='tools/call')result={content:[{type:'text',text:params.name+':'+params.arguments.query}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
});
`;
function local(script: string) {
 const server: McpServerConfig = {name:"demo",transport:"stdio",command:process.execPath,args:["-e",script],env:{API_KEY:"fixture-private-value"}};
 return createManager({readServers:()=>[server], watch:()=>()=>{}, writeCache:()=>{}});
}
describe("MCP desktop inspection with real stdio transport",()=>{
 it("reads both catalog pages and dispatches the registered name to the original tool", async()=>{
  const mgr=local(fixture); try {
   expect(inspectMcp(mgr,"demo")).toEqual({servers:[]});
   await mgr.reloadServer("demo"); const info=inspectMcp(mgr,"demo");
   expect(info.servers[0]).toMatchObject({status:"connected",tools:80});
   expect(info.servers[0].footprints?.[79]).toEqual([JSON.stringify({name:"mcp__demo__tool_79",description:"Fetch item 79",parameters:{type:"object",properties:{query:{type:"string"}}}}).length,"codemode"]);
   expect(info.catalog?.[79]).toMatchObject({fullName:"mcp__demo__tool_79",description:"Fetch item 79",inputSchema:{type:"object"}});
   expect(inspectMcp(mgr,"demo",info.diagnostics!.attemptedAt).catalog).toBeUndefined();
   expect(await callInspectedTool(mgr,"demo","mcp__demo__tool_79",{query:"hello"})).toMatchObject({content:[{text:"tool-79:hello"}]});
   await expect(callInspectedTool(mgr,"demo","mcp__other__tool_79",{})).rejects.toThrow();
  } finally {await mgr.closeAll();}
 },12000);
 it("aborts a stalled HTTP initialize request; an old attempt cannot cancel a later one", async () => {
  let requests = 0, closed = 0;
  const http = createServer((req,res) => { req.resume(); requests++; res.on("close", () => {closed++;}); });
  http.listen(0,"127.0.0.1"); await once(http,"listening");
  const port = (http.address() as import("node:net").AddressInfo).port;
  const mgr = createManager({readServers:()=>[{name:"slow",transport:"http",url:`http://127.0.0.1:${port}/mcp`}],watch:()=>()=>{},writeCache:()=>{}});
  try {
    mgr.init(); await vi.waitFor(()=>expect(requests).toBe(1));
    const first=inspectMcp(mgr,"slow").diagnostics!, pending=mgr.connectPromise("slow");
    expect(first.handshake?.join(" ")).toContain("初始化握手");
    expect(mgr.cancelAttempt("slow",first.attemptId!)).toBe(true);
    await pending; await vi.waitFor(()=>expect(closed).toBe(1));
    expect(inspectMcp(mgr,"slow").servers[0]?.status).toBe("stopped");
    const retry=mgr.reloadServer("slow"); await vi.waitFor(()=>expect(requests).toBe(2));
    expect(mgr.cancelAttempt("slow",first.attemptId!)).toBe(false);
    const second=inspectMcp(mgr,"slow").diagnostics!;
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(mgr.cancelAttempt("slow",second.attemptId!)).toBe(true);
    await retry; await vi.waitFor(()=>expect(closed).toBe(2));
  } finally {await mgr.closeAll(); http.closeAllConnections(); await new Promise<void>(resolve=>http.close(()=>resolve()));}
 },7000);
 it("keeps only the last ten stderr lines, masks configured secrets and records the actual exit",async()=>{
  const mgr=local("for(let i=0;i<12;i++) console.error('line '+i+' '+process.env.API_KEY); process.exitCode=7");
  try {
   await mgr.reloadServer("demo"); const info=inspectMcp(mgr,"demo");
   expect(info.servers[0]).toMatchObject({status:"failed",error:expect.any(String),attemptedAt:expect.any(String)});
   expect(info.diagnostics?.exit).toBe("7");
   expect(info.diagnostics?.stderr).toHaveLength(10);
   expect(info.diagnostics?.stderr[0]).toContain("line 2");
   expect(JSON.stringify(info)).not.toContain("fixture-private-value");
  } finally {await mgr.closeAll();}
 },10000);
});
