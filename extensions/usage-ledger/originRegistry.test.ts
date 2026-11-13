import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { UsageOriginRegistry } from './originRegistry.js';
const clean: Array<() => void> = [];
afterEach(() => clean.splice(0).reverse().forEach(fn => fn()));
function registry() { const dir=mkdtempSync(join(tmpdir(),'usage-origin-')); clean.push(()=>rmSync(dir,{recursive:true,force:true})); const r=new UsageOriginRegistry(join(dir,'origin.db')); clean.push(()=>r.close()); return r; }
it('normalizes multilevel managed copies and keeps canonical binding immutable',()=>{
 const r=registry(); r.registerLocalEntry({sessionId:'a',entryId:'1'}); r.bindLedgerKey({sessionId:'a',entryId:'1'},'t:a:42');
 r.prepare({operationId:'op1',kind:'fork',targetSessionId:'b',mappings:[{targetEntryId:'2',source:{sessionId:'a',entryId:'1'}}]});
 expect(r.resolveUsageOrigin({sessionId:'b',entryId:'2'})).toEqual({kind:'unverified'}); r.commit('op1');
 r.prepare({operationId:'op2',kind:'clone',targetSessionId:'c',mappings:[{targetEntryId:'3',source:{sessionId:'b',entryId:'2'}}]});r.commit('op2');
 expect(r.resolveUsageOrigin({sessionId:'c',entryId:'3'})).toEqual({kind:'local-origin',originSessionId:'a',originEntryId:'1'});
 expect(r.ledgerKey({sessionId:'c',entryId:'3'})).toBe('t:a:42');
 expect(()=>r.bindLedgerKey({sessionId:'c',entryId:'3'},'t:c:42')).toThrow();
});
it('external imports never grant origins, later actual requests do',()=>{
 const r=registry();r.prepare({operationId:'import',kind:'import',targetSessionId:'i',mappings:[{targetEntryId:'old',source:{sessionId:'fake',entryId:'1'}}]});r.commit('import');
 expect(r.resolveUsageOrigin({sessionId:'i',entryId:'old'})).toEqual({kind:'external-history'});
 r.registerLocalEntry({sessionId:'i',entryId:'new'});expect(r.resolveUsageOrigin({sessionId:'i',entryId:'new'})).toMatchObject({kind:'local-origin',originSessionId:'i'});
 expect(r.resolveUsageOrigin({sessionId:'x',entryId:'unregistered'})).toEqual({kind:'unverified'});
});
it('freezes legacy roster once, requires exact path and never extends on cold scan',()=>{
 const r=registry();r.freezeLegacyRoster([{sessionId:'a',path:'C:/old/a.jsonl'}]);r.freezeLegacyRoster([{sessionId:'b',path:'C:/new/b.jsonl'}]);
 expect(r.isLegacySession({sessionId:'a',path:'C:/old/a.jsonl'})).toBe(true);
 expect(r.isLegacySession({sessionId:'a',path:'C:/copy/a.jsonl'})).toBe(false);
 expect(r.isLegacySession({sessionId:'b',path:'C:/new/b.jsonl'})).toBe(false);
 expect(r.isLegacySession({sessionId:'a',path:'C:/old/a.jsonl',required:true})).toBe(false);
});
it('aborts only pending operations and leaves unresolved sources unverified',()=>{
 const r=registry();r.prepare({operationId:'x',kind:'clone',targetSessionId:'b',mappings:[{targetEntryId:'1',source:{sessionId:'unknown',entryId:'1'}}]});r.abort('x');expect(()=>r.commit('x')).toThrow();
 expect(r.resolveUsageOrigin({sessionId:'b',entryId:'1'})).toEqual({kind:'unverified'});
});
it('managed unresolved mappings normalize after the original legacy source is reconciled',()=>{
 const r=registry();r.freezeLegacyRoster([{sessionId:'old',path:'C:/old.jsonl'}]);
 r.prepare({operationId:'first',kind:'clone',targetSessionId:'b',mappings:[{targetEntryId:'2',source:{sessionId:'old',entryId:'1'}}]});r.commit('first');
 r.prepare({operationId:'second',kind:'fork',targetSessionId:'c',mappings:[{targetEntryId:'3',source:{sessionId:'b',entryId:'2'}}]});r.commit('second');
 expect(r.resolveUsageOrigin({sessionId:'c',entryId:'3'})).toEqual({kind:'unverified'});
 r.registerLocalEntry({sessionId:'old',entryId:'1'},'C:/old.jsonl');r.bindLedgerKey({sessionId:'old',entryId:'1'},'t:old:42');
 expect(r.resolveUsageOrigin({sessionId:'c',entryId:'3'})).toEqual({kind:'local-origin',originSessionId:'old',originEntryId:'1'});expect(r.ledgerKey({sessionId:'c',entryId:'3'})).toBe('t:old:42');
});
