import { describe, expect, it } from 'vitest';
import { messagesFromAgent, type ChatMessage } from '../../stores/agentReducer';
import { groupMessages } from './groupMessages';
import { resolveSessionFile } from './sessionCwd';
import { changesForTurn, presentedForTurn } from './turnDeliverables';
import type { ToolSegment } from './groupMessages';

const old = 'D:/old-project';
const target = 'E:/target-project';

function sourceTool(entryId: string, callId: string, cwd?: string) {
  return [
    { role: 'assistant', timestamp: 1, entryId: `${entryId}-assistant`, sourceCwd: cwd,
      content: [{ type: 'toolCall', id: callId, name: 'read', arguments: { path: 'src/config.ts' } }] },
    { role: 'toolResult', timestamp: 2, entryId, sourceCwd: cwd,
      toolCallId: callId, toolName: 'read', isError: false, content: [{ type: 'text', text: 'read' }] },
  ];
}

describe('transferred message sources', () => {
  it('routes per-reference deliverables and changes to their own frozen directory', () => {
    const mk = (toolName: string, sourceRefs: Record<string, string>, args: unknown, details: unknown): ToolSegment => ({
      kind: 'tool', id: toolName, toolCallId: toolName, toolName, status: 'done', args,
      result: { content: [], details }, cwd: old, sourceRefs,
    });
    const changed = changesForTurn([mk('write', { path: `${old}/branch` }, { path: 'src/config.ts', content: 'a' }, {})]);
    expect(changed[0]?.cwd).toBe(`${old}/branch`);
    const delivered = presentedForTurn([mk('present', { 'files.0.path': `${old}/branch` }, {}, {
      files: [{ path: 'src/config.ts' }, { path: 'other.ts' }],
    })]);
    expect(delivered.map(file => file.cwd)).toEqual([`${old}/branch`, old]);
    expect(resolveSessionFile(target, delivered[0]?.cwd, delivered[0]!.path)?.absolute).toBe(`${old}/branch/src/config.ts`);
  });
  it('uses source project for frozen history and target for new tool results', () => {
    const messages = messagesFromAgent([...sourceTool('old-entry', 'old-call', old), ...sourceTool('new-entry', 'new-call')]);
    const turns = groupMessages(messages);
    const tools = turns.flatMap(turn => turn.kind === 'turn' ? turn.segments.filter(segment => segment.kind === 'tool') : []);
    expect(tools).toMatchObject([{ entryId: 'old-entry', cwd: old }, { entryId: 'new-entry' }]);
    expect(resolveSessionFile(target, tools[0]?.kind === 'tool' ? tools[0].cwd : undefined, 'src/config.ts')?.absolute)
      .toBe(`${old}/src/config.ts`);
    expect(resolveSessionFile(target, tools[1]?.kind === 'tool' ? tools[1].cwd : undefined, 'src/config.ts')?.absolute)
      .toBe(`${target}/src/config.ts`);
  });

  it('passes assistant text and user historical source to localized links', () => {
    const messages = messagesFromAgent([
      { role: 'user', timestamp: 1, entryId: 'u1', sourceCwd: old, content: [{ type: 'text', text: '[source](src/config.ts)' }] },
      { role: 'assistant', timestamp: 2, entryId: 'a1', sourceCwd: old, content: [{ type: 'text', text: '[source](src/config.ts)' }] },
    ]);
    const user = messages.find((m): m is Extract<ChatMessage, { kind: 'user' }> => m.kind === 'user');
    const assistant = messages.find((m): m is Extract<ChatMessage, { kind: 'assistant' }> => m.kind === 'assistant');
    expect(user).toMatchObject({ entryId: 'u1', sourceCwd: old });
    expect(assistant).toMatchObject({ entryId: 'a1', sourceCwd: old });
    expect(groupMessages(messages).find(m => m.kind === 'turn')).toMatchObject({
      segments: [{ kind: 'text', sourceCwd: old, entryId: 'a1' }],
    });
  });
});
