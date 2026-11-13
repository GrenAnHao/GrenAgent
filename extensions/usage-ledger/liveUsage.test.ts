import{mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';import{expect,it,vi}from'vitest';import{attachUsageEntryTracking}from'./liveUsage.js';
it('a corrupt provenance registry disables tracking without blocking session creation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'usage-corrupt-origin-'));mkdirSync(join(dir,'usage'));writeFileSync(join(dir,'usage','origins.db'),'not sqlite');const log=vi.spyOn(console,'error').mockImplementation(()=>{});const subscribe=vi.fn(()=>()=>{});
 try{expect(()=>attachUsageEntryTracking({subscribe,sessionManager:{}},dir)).not.toThrow();expect(subscribe).not.toHaveBeenCalled();}finally{log.mockRestore();rmSync(dir,{recursive:true,force:true});}
});
