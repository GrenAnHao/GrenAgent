import {app,BrowserWindow,session} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';import {dirname,join,resolve} from 'node:path';
const file=resolve(process.argv[2]);const out=dirname(file);app.commandLine.appendSwitch('disable-gpu');
const timer=setTimeout(()=>app.exit(2),20000);
app.whenReady().then(async()=>{let remote=0;const partition=session.fromPartition('offline-session-export');partition.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{remote++;callback({cancel:true});});partition.enableNetworkEmulation({offline:true});
const window=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{session:partition,nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true}});window.webContents.setWindowOpenHandler(()=>({action:'deny'}));const errors=[];window.webContents.on('console-message',(_event,level,message)=>{if(level>=2)errors.push(message);});
const check=(name,ok)=>{if(!ok)throw Error(name);console.log('PASS',name);};
try{
 await window.loadFile(file);await new Promise(r=>setTimeout(r,400));
 check('offline SDK viewer renders current message and historic tool body',await window.webContents.executeJavaScript("document.querySelector('#messages').textContent.includes('A answer') && document.querySelector('#messages').textContent.includes('tool raw')"));
 check('full tree retains unselected side branch',await window.webContents.executeJavaScript("document.querySelector('#tree-container').textContent.includes('SECRET_SIDE')"));
 const point=await window.webContents.executeJavaScript("(()=>{const el=[...document.querySelectorAll('.tree-node')].find(e=>e.textContent.includes('SECRET_SIDE'));if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.round(r.x+Math.min(r.width/2,120)),y:Math.round(r.y+r.height/2)};})()");check('side branch is discoverable for navigation',!!point);
 window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await new Promise(r=>setTimeout(r,150));
 check('offline side branch code block remains readable',await window.webContents.executeJavaScript("document.querySelector('#messages').textContent.includes('const secret = 1')"));
 check('history scripts and event handlers never execute',await window.webContents.executeJavaScript("globalThis.pwned === undefined"));
 check('viewer has no Node or application preload bridge',await window.webContents.executeJavaScript("typeof require==='undefined' && typeof process==='undefined' && typeof gren==='undefined'"));
 check('remote Markdown image becomes an explicit link',await window.webContents.executeJavaScript("!document.querySelector('#messages img[src^=https]') && !!document.querySelector('#messages a[href^=https]')"));
 check('opening and navigating exported history makes zero remote requests',remote===0);
 const png=await window.webContents.capturePage();await writeFile(join(out,'actual-sdk-html-offline.png'),png.toPNG());await writeFile(join(out,'actual-sdk-html-offline-results.json'),JSON.stringify({remote,errors},null,2));
}catch(error){console.error(error);process.exitCode=1;}finally{clearTimeout(timer);window.destroy();app.exit(process.exitCode??0);}
});
