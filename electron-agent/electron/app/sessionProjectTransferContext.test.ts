import { describe, expect, it } from 'vitest';
import { pauseSessionTransferWarming, sessionProjectTransferContext } from '../../../cli/src/session-project-transfer-context.js';

function fixture(id: string, entries: unknown[] = []) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  sessionProjectTransferContext({ on: (name: string, handler: any) => { handlers.set(name, handler); } } as any);
  const ctx = { sessionManager: { getSessionId: () => id, getEntries: () => entries } };
  const emit = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
  return { emit };
}
describe('transfer system context and idle warming fence', () => {
  it('stops only the paused session until its next explicit request, without changing settings', () => {
    const source = fixture('paused-source'); const other = fixture('other-source');
    pauseSessionTransferWarming('paused-source');
    expect(source.emit('cache_warming_decision')).toEqual({ action: 'stop' });
    expect(other.emit('cache_warming_decision')).toBeUndefined();
    source.emit('before_agent_start', { systemPromptOptions: {} });
    expect(source.emit('cache_warming_decision')).toBeUndefined();
  });
  it('injects current migration facts as a system section and never alters history', () => {
    const entries = [{type:'custom',customType:'session_project_transfer',data:{version:1,operationId:'move-1',
      fromWorkspace:'/source',toWorkspace:'/target',previousCwd:'/source',leafId:null,
      boundary:{afterEntryId:null,entryCount:0},history:{version:1,ref:'move-1'},createdAt:1}}];
    const before = JSON.stringify(entries); const f = fixture('moved-context', entries);
    const event = {systemPromptOptions:{sections:{existing:'preserved'}}};
    f.emit('before_agent_start', event);
    expect((event.systemPromptOptions.sections as Record<string,string>).session_project_transfer).toContain('"/target"');
    expect(event.systemPromptOptions.sections.existing).toBe('preserved');
    expect(JSON.stringify(entries)).toBe(before);
  });
});
