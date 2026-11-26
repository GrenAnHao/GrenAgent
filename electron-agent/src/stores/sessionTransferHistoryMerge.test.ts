import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './agentReducer';
import { enrichHistorySources, historyBelongsTo } from './sessionTransferHistoryMerge';
import { snapshotMessages } from './sessionSnapshot';

const SOURCE = 'D:/repo';
const TARGET = 'D:/target';

const user = (id: string, timestamp: number, entryId?: string): ChatMessage => ({
  kind: 'user',
  id,
  text: `u-${id}`,
  timestamp,
  ...(entryId ? { entryId } : {}),
});

const tool = (id: string, toolCallId: string, timestamp: number, extra: Partial<Extract<ChatMessage, { kind: 'tool' }>> = {}): ChatMessage & { timestamp: number } => ({
  kind: 'tool',
  id,
  toolCallId,
  toolName: 'read',
  args: {},
  result: {},
  status: 'done',
  timestamp,
  ...extra,
});

const notice = (id: string, timestamp: number): ChatMessage & { timestamp: number } => ({
  kind: 'notice',
  customType: 'test-notice',
  id,
  content: `notice-${id}`,
  timestamp,
});

describe('transfer history source merge', () => {
  it('attaches backend sources by entryId and toolCallId without touching content', () => {
    const history = [user('a', 10, 'e1'), tool('b', 'tc1', 11), user('c', 12, 'e3')];
    const backend = [
      user('backend-a', 10, 'e1'),
      tool('backend-b', 'tc1', 11, { entryId: 'e2', sourceCwd: TARGET, sourceRefs: { path: SOURCE } }),
      user('backend-c', 12, 'e3'),
    ];
    const { messages, changed } = enrichHistorySources(history, backend, SOURCE);
    expect(changed).toBe(true);
    expect(messages[0]).toMatchObject({ id: 'a', text: 'u-a' });
    expect(messages[1]).toMatchObject({ id: 'b', sourceCwd: TARGET, sourceRefs: { path: SOURCE } });
    expect(messages[2]).toMatchObject({ id: 'c' });
    // 正文与 id 不动
    expect((messages[1] as Extract<ChatMessage, { kind: 'tool' }>).toolCallId).toBe('tc1');
  });

  it('keeps an already recorded source instead of overwriting it on a round trip', () => {
    const history = [tool('t', 'tc', 20, { sourceCwd: 'D:/first', sourceRefs: { path: 'D:/first' } })];
    const backend = [tool('bt', 'tc', 20, { entryId: 'e', sourceCwd: TARGET, sourceRefs: { path: TARGET } })];
    const { messages, changed } = enrichHistorySources(history, backend, TARGET);
    expect(changed).toBe(false);
    expect(messages[0]).toMatchObject({ sourceCwd: 'D:/first', sourceRefs: { path: 'D:/first' } });
  });

  it('falls back to the transfer source for legacy rows missing from the backend', () => {
    const history = [user('a', 10, 'e1'), tool('legacy', 'tc-legacy', 11)];
    const backend = [user('backend-a', 10, 'e1')];
    const { messages, changed } = enrichHistorySources(history, backend, SOURCE);
    expect(changed).toBe(true);
    expect(messages[1]).toMatchObject({ kind: 'tool', toolCallId: 'tc-legacy', sourceCwd: SOURCE });
    // 没有来源位的辅助消息（通知、压缩分隔）原样保留，不编造字段
    const withNotice = enrichHistorySources([...history, notice('n', 12)], backend, SOURCE);
    expect(withNotice.messages[2]).toEqual(notice('n', 12));
  });

  it('reports a history that already belongs to the target project', () => {
    expect(historyBelongsTo([tool('t', 'tc', 1, { sourceCwd: TARGET })], TARGET)).toBe(true);
    expect(historyBelongsTo([tool('t', 'tc', 1, { sourceCwd: SOURCE })], TARGET)).toBe(false);
  });

  it('snapshotMessages patches a longer ui-history instead of trusting it verbatim', () => {
    const longHistory = [user('a', 10, 'e1'), tool('t', 'tc', 11), user('legacy', 12)];
    const backendRaw = [
      { role: 'user', timestamp: 10, entryId: 'e1', sourceCwd: SOURCE, content: [{ type: 'text', text: 'u-a' }] },
      {
        role: 'toolResult',
        timestamp: 11,
        entryId: 'e2',
        toolCallId: 'tc',
        toolName: 'read',
        sourceCwd: TARGET,
        sourceRefs: { path: SOURCE },
        content: [{ type: 'text', text: 'ok' }],
      },
    ];
    const snap = snapshotMessages(backendRaw as never, longHistory, { fallbackSource: SOURCE });
    expect(snap.historySourcesPatched).toBe(true);
    const toolRow = snap.sanitized.find((m) => m.kind === 'tool') as Extract<ChatMessage, { kind: 'tool' }>;
    expect(toolRow).toMatchObject({ sourceCwd: TARGET, sourceRefs: { path: SOURCE } });
    const legacyRow = snap.sanitized.find((m) => m.id === 'legacy') as ChatMessage;
    expect(legacyRow).toMatchObject({ sourceCwd: SOURCE });
  });

  it('does not let a longer ui-history impersonate an explicit empty root', () => {
    const longHistory = [user('old', 10, 'e1')];
    const snap = snapshotMessages([], longHistory, { backendLeaf: null, fallbackSource: SOURCE });
    expect(snap.emptyRoot).toBe(true);
    // 空根显示空会话；旧 ui-history 不当成当前内容
    expect(snap.sanitized).toEqual([]);
    expect(snap.historySourcesPatched).toBe(false);
  });
});
