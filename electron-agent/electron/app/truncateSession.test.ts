import { describe, expect, it } from 'vitest';
import { truncateSessionLines } from './truncateSession';

const header = JSON.stringify({ type: 'session', id: 's', version: 1 });
const user = (id: string, parentId: string | null) =>
  JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: id, timestamp: 1 } });
const assistant = (id: string, parentId: string) =>
  JSON.stringify({ type: 'message', id, parentId, message: { role: 'assistant', content: [{ type: 'text', text: id }], timestamp: 2 } });
const modelChange = (id: string, parentId: string) =>
  JSON.stringify({ type: 'model_change', id, parentId, model: 'test-model' });
const custom = (id: string, parentId: string | null) =>
  JSON.stringify({ type: 'custom', id, parentId, data: {} });

describe('truncateSessionLines', () => {
  it('删除目标及其后的活动链，保留 header 和更早的消息', () => {
    const lines = [header, user('u1', null), assistant('a1', 'u1'), user('u2', 'a1')];
    const result = truncateSessionLines(lines, 'u2', 'drop-target');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual([header, user('u1', null), assistant('a1', 'u1')]);
  });

  it('keep-target 保留目标，只删除它后面的条目', () => {
    const lines = [header, user('u1', null), assistant('a1', 'u1')];
    const result = truncateSessionLines(lines, 'u1', 'keep-target');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.map((line) => JSON.parse(line).id)).toEqual(['s', 'u1']);
  });

  it('目标之后还有不属于后代的行时拒绝，且不改输入', () => {
    const lines = [header, user('u1', null), user('other', null)];
    const result = truncateSessionLines(lines, 'u1', 'drop-target');
    expect(result).toEqual({ ok: false, reason: 'branched' });
  });

  it('drop-target 从 user 截断时删除 model_change 与 assistant 链，保留 header', () => {
    const lines = [header, user('u1', null), modelChange('mc1', 'u1'), assistant('a1', 'mc1')];
    const result = truncateSessionLines(lines, 'u1', 'drop-target');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual([header]);
  });

  it('user 之后出现 parentId 不在该链上的 custom 时返回 branched 且不改输入', () => {
    const lines = [header, user('u1', null), custom('c1', null)];
    const before = [...lines];
    const result = truncateSessionLines(lines, 'u1', 'drop-target');
    expect(result).toEqual({ ok: false, reason: 'branched' });
    expect(lines).toEqual(before);
  });
});
