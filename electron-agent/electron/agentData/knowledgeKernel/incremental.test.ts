import { describe,it,expect } from 'vitest';
import { analyseKnowledgeDelta } from './incremental';
describe('delta',()=>{
 it('uses published hashes and old dependency edges',()=>{const b={hashes:{'a.ts':'old','b.ts':'b'},edges:[['b.ts','a.ts']] as [string,string][],coverage:'complete' as const,commit:'a'};const c={hashes:{'a.ts':'head','b.ts':'b'},edges:[] as [string,string][],coverage:'complete' as const,commit:'b'};expect(analyseKnowledgeDelta(b,c,[{id:'page',sources:['b.ts'],dependencies:[]}])).toMatchObject({kind:'affected',invalidated:['page']});expect(analyseKnowledgeDelta({...b,hashes:c.hashes},c,[]).kind).toBe('advance');});
 it('blocks incomplete scans',()=>{const b={hashes:{a:'1'},edges:[] as [string,string][],coverage:'complete' as const};expect(analyseKnowledgeDelta(b,{...b,hashes:{},coverage:'unknown'},[]).kind).toBe('blocked');});
});

it('compares actual worktree snapshots including dirty baseline, rename and non-Git', async ()=>{
 const {mkdtempSync,writeFileSync,renameSync,rmSync}=await import('node:fs');
 const {join}=await import('node:path'); const {tmpdir}=await import('node:os'); const {execFileSync}=await import('node:child_process');
 const {scanRepositoryAsync}=await import('../../../vendor/repo-wiki/packages/core/src/scanner');
 const root=mkdtempSync(join(tmpdir(),'kernel-git-'));
 try {
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  git('init');git('config','user.email','test@example.test');git('config','user.name','Test');
  writeFileSync(join(root,'a.ts'),'export const x = 1;\n');writeFileSync(join(root,'b.ts'),"import { x } from './a';\n");git('add','.');git('commit','-m','initial');
  writeFileSync(join(root,'a.ts'),'export const x = 2;\n');const dirty=await scanRepositoryAsync(root);
  writeFileSync(join(root,'a.ts'),'export const x = 1;\n');const head=await scanRepositoryAsync(root);
  const snap=(s:typeof head)=>({hashes:s.hashes,edges:s.edges,coverage:(s.coverage.partial?'partial':'complete') as 'partial'|'complete',commit:s.identity.commit as string});
  expect(analyseKnowledgeDelta(snap(dirty),snap(head),[{id:'b',sources:['b.ts'],dependencies:[]}]).invalidated).toEqual(['b']);
  git('add','a.ts');writeFileSync(join(root,'extra.ts'),'export {};\n');renameSync(join(root,'a.ts'),join(root,'renamed.ts'));const changed=await scanRepositoryAsync(root);
  expect(analyseKnowledgeDelta(snap(head),snap(changed),[]).kind).toBe('replan');
  const plain=mkdtempSync(join(tmpdir(),'kernel-plain-'));try{writeFileSync(join(plain,'x.ts'),'a');const x=await scanRepositoryAsync(plain);writeFileSync(join(plain,'x.ts'),'b');const y=await scanRepositoryAsync(plain);expect(analyseKnowledgeDelta(snap(x),snap(y),[{id:'x',sources:['x.ts'],dependencies:[]}]).kind).toBe('affected');}finally{rmSync(plain,{recursive:true,force:true});}
 } finally {rmSync(root,{recursive:true,force:true});}
});

it('reports a non-Git workspace without mistaking a Git executable failure for it',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {scanKnowledgeSnapshot}=await import('../../../vendor/repo-wiki/packages/core/src/scanner');const root=mkdtempSync(join(tmpdir(),'kernel-kind-'));
 try{expect((await scanKnowledgeSnapshot(root)).git.kind).toBe('non-git');expect((await scanKnowledgeSnapshot(root,{},undefined,'does-not-exist-git')).git.kind).toBe('error');}finally{rmSync(root,{recursive:true,force:true});}
});

it('propagates new dependency edges and changed scope without replanning a file added in an existing directory',()=>{
 const b={hashes:{'src/a.ts':'a','src/b.ts':'b'},edges:[] as [string,string][],coverage:'complete' as const};
 const c={...b,hashes:{...b.hashes,'src/new.ts':'n'},edges:[['src/b.ts','src/new.ts']] as [string,string][]};
 const d=analyseKnowledgeDelta(b,c,[{id:'b',sources:['src/b.ts'],dependencies:[]},{id:'search',sources:[],dependencies:[],scopes:['src']}]);
 expect(d.kind).toBe('affected');expect(d.invalidated).toEqual(['b','search']);
});

it('invalidates items without recorded source or scope coverage',()=>{
 const b={hashes:{'src/a.ts':'a'},edges:[] as [string,string][],coverage:'complete' as const};
 const c={...b,hashes:{'src/a.ts':'b'}};
 expect(analyseKnowledgeDelta(b,c,[{id:'unknown',sources:[],dependencies:[]}]).invalidated).toEqual(['unknown']);
});
it('invalidates a glob search when a new matching subtree file appears',()=>{
 const b={hashes:{'src/a.ts':'a'},edges:[] as [string,string][],coverage:'complete' as const};
 const c={...b,hashes:{...b.hashes,'src/b.ts':'b'}};
 expect(analyseKnowledgeDelta(b,c,[{id:'search',sources:[],dependencies:[],scopes:['src/**/*.ts']}]).invalidated).toEqual(['search']);
});
it('does not let unreadable or empty omissions masquerade as complete deletion coverage',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {scanKnowledgeSnapshot}=await import('../../../vendor/repo-wiki/packages/core/src/scanner');const root=mkdtempSync(join(tmpdir(),'kernel-empty-'));
 try{writeFileSync(join(root,'a.ts'),'');const scan=await scanKnowledgeSnapshot(root);expect(scan.coverage.partial).toBe(false);expect(scan.files.find(f=>f.path==='a.ts')).toMatchObject({content:'',lines:1});}finally{rmSync(root,{recursive:true,force:true});}
});

it('treats an empty or dot search scope as the entire repository',()=>{
 const b={hashes:{'src/a.ts':'a'},edges:[] as [string,string][],coverage:'complete' as const};const c={...b,hashes:{...b.hashes,'src/b.ts':'b'}};
 for(const scope of ['', '.'])expect(analyseKnowledgeDelta(b,c,[{id:'search',sources:['src/a.ts'],dependencies:[],scopes:[scope]}]).invalidated).toEqual(['search']);
});
