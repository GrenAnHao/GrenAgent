import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const evidence = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(evidence, '../../..');
const [action, tmpArg, tag='before', label=tag] = process.argv.slice(2);
const tmp = path.resolve(tmpArg);
assert(path.basename(tmp).startsWith('gren-boot-bench-'));
const home=path.join(tmp,'home'), agent=path.join(home,'.pi','agent'), sessions=path.join(agent,'sessions');
const p=(...xs)=>path.join(tmp,...xs);
const dir=(x)=>fs.mkdirSync(x,{recursive:true});
const json=(x,o)=>fs.writeFileSync(x,JSON.stringify(o,null,2));
const id=n=>'ba781200-0000-4000-8000-'+String(n).padStart(12,'0');
if(action==='make'){
  const groups=JSON.parse(fs.readFileSync(path.join(evidence,'sizes.json'),'utf8'));
  assert(!fs.existsSync(sessions),'fixture already exists'); dir(home);
  const timestamp='2026-01-01T00:00:00.000Z', stamp=Date.parse(timestamp);
  let n=0,total=0,visible=0,target,earliest;
  const row=Buffer.from(JSON.stringify({type:'custom',customType:'benchmark-filler',data:'z'.repeat(8000)})+'\n');
  const block=Buffer.alloc(row.length*128); for(let i=0;i<128;i++)row.copy(block,i*row.length);
  for(let g=0;g<groups.length;g++){
    const cwd=p('projects','bench-'+String(g).padStart(2,'0'));dir(cwd);
    const bucket=path.join(sessions,'--'+cwd.replace(/^[\\/]/,'').replace(/[:\\/]/g,'-')+'--');dir(bucket);
    for(const size of groups[g]){
      n++;const hit=!target && size>=2000 && size<=64000;
      const file=path.join(bucket,'2026-01-01T00-00-00-000Z_'+id(n)+'.jsonl');
      if(!earliest && size>1000)earliest=file;
      const user=hit?'ZZ-RESTORED-ACTIVE-MESSAGE':'bench-message-'+n;
      const hidden=!hit && n%4!==0 && size>650;
      const lines=[
        {type:'session',version:3,id:id(n),cwd,timestamp},
        {type:'message',id:'a0000001',parentId:null,timestamp,message:{role:'user',content:[{type:'text',text:user}],timestamp:stamp}},
        {type:'session_info',id:'a0000002',parentId:'a0000001',timestamp,name:hit?'Bench active':'Bench '+n},
        ...(hidden?[{type:'custom',customType:'subagent_meta',id:'a0000003',parentId:'a0000002',timestamp,data:{parentSession:'bench-parent',agent:'bench'}}]:[]),
      ];
      let head=Buffer.from(lines.map(x=>JSON.stringify(x)).join('\n')+'\n');
      if(head.length>size)head=Buffer.from(JSON.stringify(lines[0])+'\n');
      const bytes=Math.max(size,head.length);const fd=fs.openSync(file,'wx');fs.writeSync(fd,head);
      let left=bytes-head.length;
      while(!hit && left>=block.length){fs.writeSync(fd,block);left-=block.length;}
      const chunks=hit?0:Math.floor(left/row.length);if(chunks>0){fs.writeSync(fd,block.subarray(0,chunks*row.length));left-=chunks*row.length;}
      if(left){const tail=Buffer.alloc(left,32);tail[left-1]=10;fs.writeSync(fd,tail);}
      fs.closeSync(fd);total+=bytes;if(!hidden)visible++;
      if(hit)target={workspace:cwd,sessionPath:file,bytes};
    }
  }
  assert(target);json(p('fixture.json'),{target,earliest,n,total,projects:groups.length});
  console.log({n,total,projects:groups.length,targetBytes:target.bytes});process.exit(0)
}
const app=p(tag,'electron-agent'), profile=p('profiles',tag);
if(action==='prepare'){
  // Only the isolated build is modified: hidden window, no background throttling, timing observers.
  assert(fs.existsSync(path.join(app,'out/main/main.js')));
  const main=path.join(app,'out/main/main.js'); const js=fs.readFileSync(main,'utf8');
  assert(js.includes('width: 1200,') && js.includes('contextIsolation: true,'));
  if(!js.includes('/* BENCH-HIDDEN */'))fs.writeFileSync(main,js.replace('width: 1200,','show: false, /* BENCH-HIDDEN */ width: 1200,').replace('contextIsolation: true,','backgroundThrottling: false, contextIsolation: true,'));
  const pack=path.join(app,'package.json');const o=JSON.parse(fs.readFileSync(pack));o.main='bench.cjs';json(pack,o);
  fs.copyFileSync(path.join(evidence,'electron-entry.cjs'),path.join(app,'bench.cjs'));
  const html=path.join(app,'dist/index.html');const code=fs.readFileSync(html,'utf8');
  const target=JSON.parse(fs.readFileSync(p('fixture.json'))).target;
  const fixtureScript=fs.readFileSync(path.join(evidence,'renderer-probe.js'),'utf8').replace('/*ACTIVETARGET*/null', JSON.stringify(target));
  if(!code.includes('/* BENCH-OBSERVER */'))fs.writeFileSync(html,code.replace('<head>','<head><script>/* BENCH-OBSERVER */\n'+fixtureScript+'\n</script>'));
} else if(action==='run'){
  const req=createRequire(path.join(root,'electron-agent/package.json'));
  const exe=req('electron');
  const output=path.join(evidence,label+'.json'), log=p(label+'.log');
  assert(!fs.existsSync(output),'explicit unique run names prevent overwriting evidence');
  for(const a of [profile,p('appdata'),p('localdata'),p('logs'),p('tmp')])dir(a);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!(/(_TOKEN|_KEY|AUTH|PROXY)/i.test(key)|| /^(GREN_|PI_|CODEX_|ELECTRON_)/i.test(key))));
  const launch=Date.now(),fd=fs.openSync(log,'w');
  const child=spawn(exe,[app,'--user-data-dir='+profile,'--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows'],{
    cwd:app,windowsHide:true,stdio:['ignore',fd,fd],
    env:{...env,BENCH_OUTPUT:output,BENCH_LAUNCH:String(launch),BENCH_HOME:home,BENCH_TMP:tmp,BENCH_USER:profile,BENCH_LABEL:label,BENCH_IO:(label.startsWith('io-')?'1':''),
      USERPROFILE:home,HOME:home,APPDATA:p('appdata'),LOCALAPPDATA:p('localdata'),TEMP:p('tmp'),TMP:p('tmp'),PI_CODING_AGENT_DIR:agent,
      GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:path.join(home,'.gitconfig')},
  });fs.closeSync(fd);child.on('error',console.error);
  const code=await new Promise(r=>child.once('exit',r));if(!fs.existsSync(output))console.error(fs.readFileSync(log,'utf8').slice(-3500));
  else console.log(fs.readFileSync(output,'utf8').slice(0,1200));process.exitCode=code??1;
} else throw new Error('make | prepare | run');



