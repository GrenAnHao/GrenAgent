import { describe, expect, it } from 'vitest';
import { validateRequest } from './index';
import { nativeCitation } from '../../../apps/web/src/workspace/Markdown';
const author = { schema_version:1, engine:'qoder-wiki-local-v1', branch:'main', locale:'zh', revision:1, storage_token:'t1', mode:'pages', constraints:[], notes:[], pages:[{ id:'architecture/core', title:'Core', prompt:'Explain' }] };
describe('native renderer contract', () => {
  it('validates token CAS and safe page ids without changing old commands', () => {
    expect(() => validateRequest('native', { project_id:'p', command:'author.save', expected_revision:1, expected_storage_token:'t1', author })).not.toThrow();
    expect(() => validateRequest('native', { project_id:'p', command:'author.save', expected_revision:1, author })).toThrow();
    expect(() => validateRequest('native', { project_id:'p', command:'author.save', expected_revision:1, expected_storage_token:'t1', author:{ ...author, pages:[{ id:'../escape', title:'T', prompt:'P' }] } })).toThrow();
    expect(() => validateRequest('page', { project_id:'p', slug:'overview' })).not.toThrow();
    expect(() => validateRequest('native', { project_id:'p', command:'prepare', intent:'repair' })).toThrow();
    expect(() => validateRequest('native', { project_id:'p', command:'start', confirmation_id:'c', request_id:'r', confirm_external:false })).toThrow();
  });
  it('maps only safe repository-relative file citations', () => {
    expect(nativeCitation('file://src/a.ts#L4-L8')).toEqual({ path:'src/a.ts', start_line:4, end_line:8 });
    for (const value of ['file:///etc/passwd#L1-L2', 'file://../secret#L1-L2', 'file://%2e%2e/secret#L1', 'file://C:%5Csecret#L1', 'file://src/a.ts#L0-L1']) expect(nativeCitation(value)).toBeNull();
  });
});
