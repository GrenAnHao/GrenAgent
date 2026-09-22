import { describe, expect, it } from 'vitest';
import { messagesWithEntryIds } from './messagesWithEntryIds';

describe('messagesWithEntryIds', () => {
  it('把 sourceEntry.id 写到对应投影消息的 entryId', () => {
    const messages = messagesWithEntryIds({
      entries: [
        {
          sourceEntry: { id: 'u1' },
          messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
        },
        {
          sourceEntry: { id: 'a1' },
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2 }],
        },
        {
          sourceEntry: { id: 'u2' },
          messages: [{ role: 'user', content: 'again', timestamp: 3 }],
        },
      ],
    });

    expect(messages).toEqual([
      { role: 'user', content: 'hello', timestamp: 1, entryId: 'u1' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2, entryId: 'a1' },
      { role: 'user', content: 'again', timestamp: 3, entryId: 'u2' },
    ]);
  });

  it('一条 entry 产出多条消息时共用同一 entryId', () => {
    const messages = messagesWithEntryIds({
      entries: [
        {
          sourceEntry: { id: 'compact-1' },
          messages: [
            { role: 'user', content: 'summary' },
            { role: 'assistant', content: 'kept' },
          ],
        },
      ],
    });
    expect(messages.map((m) => m.entryId)).toEqual(['compact-1', 'compact-1']);
  });
});
