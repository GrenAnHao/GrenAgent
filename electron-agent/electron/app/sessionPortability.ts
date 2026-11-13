import { readSessionPreferences } from '../../../extensions/_shared/session-preferences.js';
import { stat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { AgentSession } from '../../../cli/src/pi-sdk.js';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import { branchSnapshot, strictSessionJsonl, type SessionDocument } from './sessionWorkflowData.js';
import type { SessionWorkflowAck, SessionWorkflowRequest, SessionTreeDto } from './sessionWorkflowContracts.js';
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
/** Keep the SDK's offline viewer and base64 transport; history never receives its script nonce. */
export function isolateSessionHtml(html:string):string{
  const nonce=randomUUID().replaceAll('-','');
  html=html.replace(/(<script id="session-data" type="application\/json">)([\s\S]*?)(<\/script>)/,(full,open,data,close)=>{
    const decoded=JSON.parse(Buffer.from(data,'base64').toString('utf8'));
    if(decoded.renderedTools)for(const item of Object.values(decoded.renderedTools) as Record<string,unknown>[])for(const k of Object.keys(item))if(typeof item[k]==='string')item[k]=`<pre>${escape(item[k])}</pre>`;
    return open+Buffer.from(JSON.stringify(decoded)).toString('base64')+close;
  });
  // Markdown remote images become explicit links. Inline raster images already use data URLs.
  html=html.replace(/image\(token\) \{[\s\S]*?\n\s*\},/,(match)=>match.replace(/let out = '<img[\s\S]*?return out;/,"return '<a href=\"' + escapeHtml(href) + '\" target=\"_blank\" rel=\"noreferrer noopener\">' + escapeHtml(token.text || href) + '</a>';"));
  html=html.replaceAll('onclick=', 'data-pi-inline=');
  html=html.replace('</body>', `<script>document.addEventListener('click',event=>{
    const element=event.target.closest('.tool-output.expandable,.skill-invocation,.compaction,.system-prompt.expandable,.tool-item,.download-json-btn');
    if(!element||window.getSelection().toString())return;
    if(element.classList.contains('download-json-btn')){window.downloadSessionJson();return;}
    element.classList.toggle(element.classList.contains('tool-item')?'params-expanded':'expanded');
  });</script></body>`);
  html=html.replace(/<script\b/g,`<script nonce="${nonce}"`);
  const csp=`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  return html.replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">`);
}
interface ExportTicket {tree:SessionTreeDto;format:'html'|'jsonl';destination:string;expires:number;exists:boolean;document:SessionDocument;}
interface ImportTicket {document:SessionDocument;expires:number;}
export class SessionPortability {
  private readonly exports=new Map<string,ExportTicket>();private readonly imports=new Map<string,ImportTicket>();
  async previewExport(session:AgentSession,tree:SessionTreeDto,r:SessionWorkflowRequest):Promise<SessionWorkflowAck>{
    if(!r.destination||!isAbsolute(r.destination)||!['html','jsonl'].includes(r.format??''))throw new Error('Main-process destination approval required');
    let exists=false;try{const s=await stat(r.destination);if(!s.isFile())throw new Error('Destination is not a file');exists=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const ticket=randomUUID(),format=r.format!;
    const document=branchSnapshot(session.sessionManager);this.exports.set(ticket,{tree,format,destination:r.destination,expires:Date.now()+5*60_000,exists,document});
    return{status:'ok',ticket,destination:r.destination,exists,format,scope:format==='html'?'HTML：完整会话树':'JSONL：当前分支（不是全树备份）',nodeCount:format==='html'?session.sessionManager.getEntryCount():document.entries.length,sensitive:['原始消息','系统提示','工具定义、参数与结果','文件内容'],tree};
  }
  async export(session:AgentSession,tree:SessionTreeDto,r:SessionWorkflowRequest):Promise<SessionWorkflowAck>{
    const ticket=this.exports.get(r.ticket??'');if(!ticket||ticket.expires<Date.now())throw new Error('EXPORT_STALE: 请重新预览');
    if(ticket.tree.expectedRevision!==tree.expectedRevision||ticket.tree.targetSessionPath!==tree.targetSessionPath||ticket.tree.expectedLeafId!==tree.expectedLeafId)throw new Error('SESSION_STALE: 请重新预览导出');
    if(ticket.exists&&r.overwrite!==true)throw new Error('OVERWRITE_CONFIRMATION_REQUIRED');
    const temp=`${ticket.destination}.${randomUUID()}.tmp`;
    try{
      if(ticket.format==='jsonl'){
        const raw=[ticket.document.header,...ticket.document.entries].map(e=>JSON.stringify(e)).join('\n')+'\n';strictSessionJsonl(raw);await writeFile(temp,raw,{encoding:'utf8',flag:'wx'});
      }else{await session.exportToHtml(temp,{themeName:'dark'});const html=await readFile(temp,'utf8');await writeFile(temp,isolateSessionHtml(html),'utf8');}
      // A file created after preview is never silently overwritten.
      if(!ticket.exists){try{await stat(ticket.destination);throw new Error('EXPORT_STALE: 目标已出现，请重新预览');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
      await rename(temp,ticket.destination);this.exports.delete(r.ticket!);
      return{status:'ok',destination:ticket.destination};
    }catch(e){await rm(temp,{force:true});throw e;}
  }
  async previewImport(source:string):Promise<SessionWorkflowAck>{
    if(!isAbsolute(source)||/^(?:\\\\|\/\/)/.test(source)||!source.toLowerCase().endsWith('.jsonl'))throw new Error('请选择本地 JSONL 文件');
    const info=await stat(source);if(!info.isFile()||info.size>32*1024*1024)throw new Error('JSONL exceeds 32 MiB or is not a file');
    const document=strictSessionJsonl(await readFile(source,'utf8'));const ticket=randomUUID();this.imports.set(ticket,{document,expires:Date.now()+5*60_000});
    // Data-only projection: no resources, auth, tools, runtime or network are initialized.
    const sm=SessionManager.inMemory(document.header.cwd,{},[document.header,...document.entries]);
    return{status:'ok',ticket,cwd:document.header.cwd,nodeCount:document.entries.length,preview:sm.buildSessionProjection().messages,requestedPreferences:readSessionPreferences(document.entries as never)};
  }
  takeImport(ticket:string):SessionDocument{const value=this.imports.get(ticket);if(!value||value.expires<Date.now())throw new Error('IMPORT_STALE: 请重新预览');this.imports.delete(ticket);return value.document;}
}


