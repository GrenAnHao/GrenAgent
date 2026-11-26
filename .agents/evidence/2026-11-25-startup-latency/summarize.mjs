import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const rows=fs.readdirSync(dir).filter(f=>/^(baseline|new-empty|new-cached|cross)-.+\.json$/.test(f)).map(name=>{
 const r=JSON.parse(fs.readFileSync(path.join(dir,name))),first=c=>r.commands.find(x=>x.command===c);
 const l=first('list_all_sessions'),o=first('open_workspace'),s=r.marks.splashDom;
 return {run:r.label,status:r.ok?'pass':'invalid',processInput:r.input?.confirmed??null,logoLeave:r.marks.splashLeaving-s,logoRemoved:r.marks.splashRemoved-s,
 logoInput:r.input?r.input.confirmed-s:null,window:r.timing.window,hostOpen:o.end-o.start,listStart:l.start,listEnd:l.end,listDuration:l.end-l.start,
 lookup:first('lookup_startup_session')?first('lookup_startup_session').end-first('lookup_startup_session').start:null,
 ordering:r.ok?(l.start>r.marks.splashLeaving?'after':'before'):null,visible:l.count};
});
const median=(xs)=>{const s=xs.sort((a,b)=>a-b),i=s.length>>1;return s.length%2?s[i]:(s[i]+s[i-1])/2};
const med=(xs)=>Object.fromEntries(['processInput','logoInput','logoLeave','logoRemoved','hostOpen','listDuration','listEnd'].map(k=>[k,median(xs.map(r=>r[k]))]));
const stable=rows.filter(r=>r.status==='pass');
const isbase=r=>r.run.startsWith('baseline')||r.run.includes('old'),isnew=r=>r.run.includes('empty');
const keys={before:isbase,empty:isnew,cached:r=>r.run.includes('cached')};
const medians={};
for(const [cohort,filter] of [['all',()=>true],['initial',r=>!r.run.startsWith('cross')],['cross',r=>r.run.startsWith('cross')]]){
 const group=stable.filter(filter);if(!group.length)continue;medians[cohort]={};
 for(const [k,test]of Object.entries(keys)){const slice=group.filter(test);if(slice.length)medians[cohort][k]={n:slice.length,...med(slice)};}
}
const result={unit:'ms',rows,medians};fs.writeFileSync(path.join(dir,'timings.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(medians,null,2));

