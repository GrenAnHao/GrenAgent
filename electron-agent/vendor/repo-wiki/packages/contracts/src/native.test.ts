import { describe, expect, it } from 'vitest';
import { validateRequest, type NativeAuthor, type NativeRequest } from './index';
import { createGrenRepoWikiClient } from '../../renderer/src/index';
import { nativeCitation } from '../../../apps/web/src/workspace/Markdown';
const author: NativeAuthor = { schema_version:1, engine:'qoder-wiki-local-v1', branch:'main', locale:'zh', revision:1, storage_token:'t1', mode:'pages', constraints:[], notes:[], pages:[{ id:'architecture/core', title:'Core', prompt:'Explain' }] };
describe('native renderer contract', () => {
  it('validates token CAS and safe page ids without changing old commands', () => {
    expect(() => validateRequest('native', { project_id:'p', command:'author.save', expected_revision:1, expected_storage_token:'t1', author })).not.toThrow();
    expect(() => validateRequest('native', { project_id:'p', command:'author.save', expected_revision:1, author })).toThrow();
    expect(() => validateRequest('native', { project_id:'p', command:'author.save', expected_revision:1, expected_storage_token:'t1', author:{ ...author, pages:[{ id:'../escape', title:'T', prompt:'P' }] } })).toThrow();
    expect(() => validateRequest('page', { project_id:'p', slug:'overview' })).not.toThrow();
    expect(() => validateRequest('native', { project_id:'p', command:'prepare', intent:'repair' })).toThrow();
    expect(() => validateRequest('native', { project_id:'p', command:'start', confirmation_id:'c', request_id:'r', confirm_external:false })).toThrow();
  });
  it('accepts all native command fields through the public validator, including first-save tokens and spending policy', () => {
    const defaultAuthor: NativeAuthor = { ...author, revision: 0, storage_token: '', mode: 'auto', pages: [] };
    const requests: NativeRequest[] = [
      { project_id: 'p', command: 'status', operation_id: 'op' },
      { project_id: 'p', command: 'author.read' },
      { project_id: 'p', command: 'author.save', expected_revision: 0, expected_storage_token: '', author: defaultAuthor },
      { project_id: 'p', command: 'author.save', expected_revision: 1, expected_storage_token: 'opaque-native-token', author },
      { project_id: 'p', command: 'author.convert', expected_revision: 0, expected_storage_token: '' },
      { project_id: 'p', command: 'prepare', intent: 'full', spending_policy: {} },
      { project_id: 'p', command: 'prepare', intent: 'update', spending_policy: { max_model_requests: 20, max_total_tokens: 300000 } },
      { project_id: 'p', command: 'prepare', intent: 'repair', operation_id: 'op' },
      { project_id: 'p', command: 'prepare', intent: 'resume', operation_id: 'op' },
      { project_id: 'p', command: 'start', confirmation_id: 'c', request_id: 'r', confirm_external: true },
      { project_id: 'p', command: 'control', operation_id: 'op', expected_revision: 1, action: 'pause' },
      { project_id: 'p', command: 'drafts', operation_id: 'op' },
      { project_id: 'p', command: 'projection.repair', publication_id: 'pub' },
    ];
    for (const request of requests) expect(() => validateRequest('native', request)).not.toThrow();
  });
  it('forwards the default-save and prepare sequence through the real renderer adapter', async () => {
    const forwarded: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const client = createGrenRepoWikiClient({
      async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> { forwarded.push({ command, args }); return undefined as T; },
      async subscribe() { return () => {}; },
    });
    const save: NativeRequest = { project_id: 'p', command: 'author.save', author: { ...author, revision: 0, storage_token: '', mode: 'auto', pages: [] }, expected_revision: 0, expected_storage_token: '' };
    const prepare: NativeRequest = { project_id: 'p', command: 'prepare', intent: 'full', spending_policy: {} };
    await client.invoke('native', save);
    await client.invoke('native', prepare);
    expect(forwarded).toEqual([{ command: 'repoWiki_native', args: save }, { command: 'repoWiki_native', args: prepare }]);
    await expect(client.invoke('native', { ...prepare, unexpected: true } as any)).rejects.toThrow();
    expect(forwarded).toHaveLength(2);
  });
  it('still rejects unknown native fields, misplaced fields and invalid spending policies', () => {
    for (const input of [
      { project_id: 'p', command: 'author.read', expected_storage_token: '' },
      { project_id: 'p', command: 'status', spending_policy: {} },
      { project_id: 'p', command: 'prepare', intent: 'full', unexpected: true },
      { project_id: 'p', command: 'prepare', intent: 'full', spending_policy: { max_model_requests: -1 } },
      { project_id: 'p', command: 'prepare', intent: 'full', spending_policy: { unknown_limit: 1 } },
      { project_id: 'p', command: 'author.save', expected_revision: 0, expected_storage_token: 123, author },
      { project_id: 'p', command: 'author.convert', expected_revision: 0 },
    ]) expect(() => validateRequest('native', input)).toThrow();
  });
  it('keeps the common native request size limit and legacy CAS format', () => {
    let rejection: unknown;
    try {
      validateRequest('native', { project_id: 'p', command: 'author.save', expected_revision: 1, expected_storage_token: '', author: { ...author, constraints: ['x'.repeat(8 * 1024 * 1024)] } });
    } catch (error) { rejection = error; }
    expect(rejection).toMatchObject({ name: 'ContractError', status: 413 });
    const edit = { project_id: 'p', slug: 'overview', markdown: '# Page', expected_revision: 1 };
    expect(() => validateRequest('edit', { ...edit, expected_storage_token: 'a'.repeat(64) })).not.toThrow();
    for (const token of ['', 'opaque-native-token']) expect(() => validateRequest('edit', { ...edit, expected_storage_token: token })).toThrow('Invalid expected_storage_token');
    expect(() => validateRequest('edit', { ...edit, spending_policy: {} })).toThrow('Unexpected request property');
  });
  it('maps only safe repository-relative file citations', () => {
    expect(nativeCitation('file://src/a.ts#L4-L8')).toEqual({ path:'src/a.ts', start_line:4, end_line:8 });
    for (const value of ['file:///etc/passwd#L1-L2', 'file://../secret#L1-L2', 'file://%2e%2e/secret#L1', 'file://C:%5Csecret#L1', 'file://src/a.ts#L0-L1']) expect(nativeCitation(value)).toBeNull();
  });
});
