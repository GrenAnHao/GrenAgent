import { describe, expect, it } from 'vitest';
import {
  chatFromMemoryTranscript,
  expandSystemWorkerChat,
  isSystemWorkerPrompt,
  parseMemoryTranscript,
  parseSystemWorkerInput,
} from './systemWorkerChat';

const EXTRACT_PROMPT = [
  'Extract durable memory as strict JSON with optional keys l1 (object), l2 (string), and l3 (string). Return JSON only.',
  'Task kind: memory_extract',
  'Input: {"delta":"user: 你是什么模型?\\ntoolResult: PI_MODEL=claude-opus-5\\nassistant: 我是 Claude。"}',
].join('\n');

describe('systemWorkerChat', () => {
  it('识别 SystemWorker 提示骨架', () => {
    expect(isSystemWorkerPrompt(EXTRACT_PROMPT)).toBe(true);
    expect(isSystemWorkerPrompt('你是什么模型?')).toBe(false);
  });

  it('解析 Input JSON 并展开 memory transcript', () => {
    expect(parseSystemWorkerInput(EXTRACT_PROMPT)).toEqual({
      delta: 'user: 你是什么模型?\ntoolResult: PI_MODEL=claude-opus-5\nassistant: 我是 Claude。',
    });
    expect(parseMemoryTranscript('user: 你是什么模型?\ntoolResult: PI_MODEL=claude-opus-5\nassistant: 我是 Claude。')).toEqual([
      { role: 'user', text: '你是什么模型?' },
      { role: 'toolResult', text: 'PI_MODEL=claude-opus-5' },
      { role: 'assistant', text: '我是 Claude。' },
    ]);
  });

  it('行首 role 才分段，正文里的同名前缀不算', () => {
    expect(parseMemoryTranscript('user: 请看 assistant: 只是正文\nassistant: 收到')).toEqual([
      { role: 'user', text: '请看 assistant: 只是正文' },
      { role: 'assistant', text: '收到' },
    ]);
  });

  it('把 transcript 转成对话气泡', () => {
    const msgs = chatFromMemoryTranscript(
      'user: 你是什么模型?\ntoolResult: PI_MODEL=claude-opus-5\nassistant: 我是 Claude。',
    );
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(msgs[0].kind === 'user' ? msgs[0].text : '').toBe('你是什么模型?');
    expect(msgs[2].kind === 'assistant' ? msgs[2].text : '').toBe('我是 Claude。');
  });

  it('把 memory_extract 会话展开成原对话', () => {
    const expanded = expandSystemWorkerChat([
      { kind: 'user', id: 'u1', text: EXTRACT_PROMPT },
      { kind: 'assistant', id: 'a1', text: '{"l2":"用户询问模型身份"}', thinking: '', streaming: false },
    ]);
    expect(expanded).toHaveLength(3);
    expect(expanded[0]).toMatchObject({ kind: 'user', text: '你是什么模型?' });
    expect(expanded[2]).toMatchObject({ kind: 'assistant', text: '我是 Claude。' });
  });

  it('普通对话原样返回', () => {
    const msgs = [{ kind: 'user' as const, id: 'u1', text: '你好' }];
    expect(expandSystemWorkerChat(msgs)).toBe(msgs);
  });
});
