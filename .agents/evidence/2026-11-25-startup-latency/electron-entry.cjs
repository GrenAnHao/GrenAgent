const { app, ipcMain, session } = require('electron');
const fs=require('node:fs'), path=require('node:path');
const t0=Number(process.env.BENCH_LAUNCH), now=()=>Date.now()-t0;
const home=process.env.BENCH_HOME,tmp=process.env.BENCH_TMP;
for(const [key,val] of Object.entries({home,userData:process.env.BENCH_USER,appData:path.join(tmp,'appdata'),temp:path.join(tmp,'tmp'),logs:path.join(tmp,'logs')}))app.setPath(key,val);
const timing={entry:now()},selected=/list_all_sessions|list_pi_sessions|get_works_dir|startup|open_workspace|switch_session|get_messages|ui_history|agent_get_active_run/;
const io={fullReads:0,bytes:0,unique:0};
if(process.env.BENCH_IO){ const fsp=require('node:fs/promises'),original=fsp.readFile,seen=new Set();const dir=path.join(process.env.PI_CODING_AGENT_DIR,'sessions').toLowerCase()+path.sep;
 fsp.readFile=async function(file,...args){const v=await original.call(this,file,...args); if(typeof file==='string'&&file.toLowerCase().startsWith(dir)&&file.endsWith('.jsonl')){io.fullReads++;io.bytes+=Buffer.byteLength(v);seen.add(file);io.unique=seen.size}return v};require('node:module').syncBuiltinESMExports();}
const commands=[],errors=[];const token='BENCH_INPUT_OK_'+t0;
let wc,marks={},input,shown=false,network=0,quitting=false,reading=false;
const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,fn)=>handle(channel,channel!=='gren:invoke'?fn:async(...args)=>{
 const command=args[1]?.command;
 if(!selected.test(command))return fn(...args);
 const event={command,start:now()};commands.push(event);
 try{const result=await fn(...args);if(Array.isArray(result))event.count=result.length;
 if(command==='agent_get_messages')event.snapshot={keys:Object.keys(result??{}),messages:result?.messages?.length};
 if(command==='list_all_sessions' && Array.isArray(result)){event.activeListed=result.some(s=>s.name==='Bench active');event.changedListed=result.some(s=>s.name==='Bench isolated external update');}
 return result}catch(e){event.error=String(e).slice(0,350);throw e}
 finally{event.end=now()}
});
app.on('web-contents-created',(_,w)=>{if(w.getType()!=='window')return;wc=w;
 wc.on('dom-ready',()=>{timing.domReady=now()});
 wc.on('did-fail-load',(_,code,msg)=>errors.push({load:code,msg}));
 wc.on('render-process-gone',(_,details)=>errors.push(details));
 wc.on('console-message',(_event,level,detail)=>{if(typeof level==='object'&&level.level==='error')errors.push(String(level.message).slice(0,300)); else if(level===3)errors.push(String(detail).slice(0,300))});
});
app.on('browser-window-created',(_,w)=>{shown=w.isVisible();timing.window=now()});
app.whenReady().then(()=>{
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(detail,cb)=>{
 const local=/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(detail.url);
 if(!local)network++;cb({cancel:!local});
 });
});
function done(ok){
 if(quitting)return;quitting=true;
 const rel=Object.fromEntries(Object.entries(marks).map(([k,t])=>[k,t-t0]));
 const out={label:process.env.BENCH_LABEL,ok,timing,marks:rel,input,shown,...(process.env.BENCH_IO?{mainProcessSessionFileReads:io}:{}),blockedRendererNetwork:network,errors:errors.slice(0,18),commands:commands.filter(x=>/session|startup|workspace|get_messages|ui_history/.test(x.command)).slice(0,100)};
 if(!ok&&wc&&!wc.isDestroyed())wc.executeJavaScript("document.body?.innerText?.slice(0,800)").then(s=>{out.state=s}).catch(()=>{}).finally(()=>save(out));else save(out);
 function save(o){fs.writeFileSync(process.env.BENCH_OUTPUT,JSON.stringify(o,null,2));app.quit();setTimeout(()=>app.exit(ok?0:3),1200).unref()}
}
setInterval(async()=>{
 if(quitting || reading || !wc || wc.isDestroyed()||!timing.domReady)return;reading=true;
 try{
 const v=await wc.executeJavaScript(`(()=>{const m=window.__benchMarks;if(!m)return null;const ed=document.querySelector('[data-testid="composer-surface"] [contenteditable="true"]');const b=ed?.getBoundingClientRect();return {m,b:b&&{x:b.x+b.width/2,y:b.y+b.height/2,width:b.width,height:b.height},typed:ed?.textContent.includes(${JSON.stringify(token)})};})()`);
 if(!v)return;marks=v.m;
 const ready=marks.active&&marks.editor&&marks.splashLeaving;
 if(ready&&v.b&&v.b.width>0&&v.b.height>0&&!input){
  const x=Math.round(v.b.x),y=Math.round(v.b.y);
  wc.focus();wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x,y});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x,y});await wc.insertText(token);
  input={attempt:now(),point:{x,y}};
 }
 if(v.typed&&!input?.confirmed)input={...input,confirmed:now()};
 if(input?.confirmed && marks.splashRemoved && commands.some(e=>e.command==='list_all_sessions'&&e.activeListed&&e.end) && !commands.some(e=>e.command==='list_all_sessions'&&!e.end)) done(true);
 }catch(e){if(!quitting && errors.length<12) errors.push(String(e))}finally{reading=false}
},40).unref();
setTimeout(()=>done(false),55000).unref();
import('./out/main/main.js').catch(e=>{errors.push(String(e.stack||e));done(false)});


