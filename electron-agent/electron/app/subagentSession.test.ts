import { describe, expect, it } from 'vitest';
import { isSubagentSessionLines, readSubagentSessionMeta } from './subagentSession';

describe('readSubagentSessionMeta', () => {
  it('取最后一条 subagent_meta 的 agentId 与 parentSession（tornDown 追加条目字段整体继承）', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'sa-1', cwd: 'C:/work' }),
      JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: 'sa-1', parentSession: 'C:/sessions/parent.jsonl' } }),
      JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: 'sa-1', parentSession: 'C:/sessions/parent.jsonl', tornDown: true } }),
    ];
    expect(readSubagentSessionMeta(lines)).toEqual({ agentId: 'sa-1', parentSession: 'C:/sessions/parent.jsonl' });
  });

  it('parentSession 为 null / 缺失时返回 null，非子会话返回 undefined', () => {
    const child = [
      JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: 'sa-2', parentSession: null } }),
    ];
    expect(readSubagentSessionMeta(child)).toEqual({ agentId: 'sa-2', parentSession: null });
    expect(readSubagentSessionMeta([JSON.stringify({ type: 'session', id: 'main', cwd: 'C:/work' })])).toBeUndefined();
  });
});

describe('isSubagentSessionLines', () => {
  it('识别 embedded-runner 写入 subagent_meta 的子会话', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'sa-1', cwd: 'C:/work', parentSession: 'C:/sessions/parent.jsonl' }),
      JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: 'sa-1', mode: 'one-shot' } }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'scout the workspace' } }),
    ];
    expect(isSubagentSessionLines(lines)).toBe(true);
  });

  it('fork 种子在前时仍能识别（subagent_meta 不在文件开头）', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'sa-2', cwd: 'C:/work' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '继承的父消息' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '继承的回复' }] } }),
      JSON.stringify({ type: 'custom', customType: 'subagent_catalog_base', data: { version: 0, reason: 'subagent-seed' } }),
      JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: 'sa-2', mode: 'continuable' } }),
    ];
    expect(isSubagentSessionLines(lines)).toBe(true);
  });

  it('用户 fork 出的主会话（header 带 parentSession）不是子会话', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'forked', cwd: 'C:/work', parentSession: 'C:/sessions/origin.jsonl' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '你好' } }),
    ];
    expect(isSubagentSessionLines(lines)).toBe(false);
  });

  it('正文提到 subagent_meta 的普通会话不是子会话', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 'chat', cwd: 'C:/work' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '看看 subagent_meta 是怎么写的' } }),
      JSON.stringify({ type: 'custom', customType: 'subagent_catalog', data: { children: [] } }),
      'not JSON subagent_meta',
    ];
    expect(isSubagentSessionLines(lines)).toBe(false);
  });
});
