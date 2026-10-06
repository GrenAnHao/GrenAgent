import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MEMORY_DEDUP_CHAT_SYSTEM_PROMPT,
  MEMORY_DEDUP_WORK_SYSTEM_PROMPT,
  MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT,
  MEMORY_EXTRACT_WORK_SYSTEM_PROMPT,
  formatBatchConflictPrompt,
  formatExtractionPrompt,
  memoryDedupPrompt,
  memoryExtractPrompt,
  messagesFromTranscript,
} from './memoryPrompts';

/** 运行时取值，不含定界反引号；CRLF 已由模板字面量规范化为 LF。 */
const UPSTREAM = {
  work: { chars: 5269, sha256: '392b45852d0c08cad60d02f59d7660d3c09e1d47db78c3c4baf49bee9a3460c8' },
  chat: { chars: 2369, sha256: 'fae33004afa3c0b714d70b45ef5252a3cb2406b7f746e118dfc6a22519892268' },
  dedup: { chars: 2372, sha256: 'c8b68d5b186004d27e1b5437ebb6971d58c8823cbf732966cf9dcdaa64ef3a3c' },
  dedupChat: { chars: 2009, sha256: '19a41bf39e13ec0f1bda29c3e363cd110265a7af25f9373dab615fef1d96e2bd' },
} as const;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('memoryPrompts', () => {
  it('抽取与去重常量与上游运行时取值逐字一致（长度 + sha256）', () => {
    expect(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT.length).toBe(UPSTREAM.work.chars);
    expect(sha256(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT)).toBe(UPSTREAM.work.sha256);
    expect(MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT.length).toBe(UPSTREAM.chat.chars);
    expect(sha256(MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT)).toBe(UPSTREAM.chat.sha256);
    expect(MEMORY_DEDUP_WORK_SYSTEM_PROMPT.length).toBe(UPSTREAM.dedup.chars);
    expect(sha256(MEMORY_DEDUP_WORK_SYSTEM_PROMPT)).toBe(UPSTREAM.dedup.sha256);
    expect(MEMORY_DEDUP_CHAT_SYSTEM_PROMPT.length).toBe(UPSTREAM.dedupChat.chars);
    expect(sha256(MEMORY_DEDUP_CHAT_SYSTEM_PROMPT)).toBe(UPSTREAM.dedupChat.sha256);
  });

  it('work 版保留四类枚举与排除清单', () => {
    for (const type of ['work_fact', 'work_task', 'work_method', 'work_artifact']) {
      expect(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT).toContain(type);
    }
    expect(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT).toContain('不应该提取的内容');
    expect(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT).toContain('不提取与工作无关的个人偏好');
    expect(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT).toContain('返回且仅返回一个合法的 JSON 数组');
  });

  it('chat 版保留三类枚举与宁缺毋滥', () => {
    for (const type of ['persona', 'episodic', 'instruction']) {
      expect(MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT).toContain(type);
    }
    expect(MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT).toContain('宁缺毋滥');
    expect(MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT).toContain('不应该提取的内容');
  });

  it('两版都保留三个任务段与 JSON 输出协议', () => {
    for (const prompt of [MEMORY_EXTRACT_WORK_SYSTEM_PROMPT, MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT]) {
      expect(prompt).toContain('任务一');
      expect(prompt).toContain('任务二');
      expect(prompt).toContain('任务三');
      expect(prompt).toContain('```json');
      expect(prompt).toContain('`scene_name`');
    }
  });

  it('work 版保留反引号包裹的字段名', () => {
    expect(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT).toContain('`type`');
  });

  it('默认走 work 版', () => {
    expect(memoryExtractPrompt()).toBe(MEMORY_EXTRACT_WORK_SYSTEM_PROMPT);
    expect(memoryExtractPrompt('chat')).toBe(MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT);
  });

  it('work 去重提示词保留动作枚举', () => {
    expect(MEMORY_DEDUP_WORK_SYSTEM_PROMPT).toContain('store|update|skip|merge');
  });

  it('chat 去重提示词保留跨 type 合并与 persona 枚举', () => {
    expect(MEMORY_DEDUP_CHAT_SYSTEM_PROMPT).toContain('你是记忆冲突检测器');
    expect(MEMORY_DEDUP_CHAT_SYSTEM_PROMPT).toContain('persona / episodic / instruction / work_fact');
    expect(memoryDedupPrompt()).toBe(MEMORY_DEDUP_WORK_SYSTEM_PROMPT);
    expect(memoryDedupPrompt('chat')).toBe(MEMORY_DEDUP_CHAT_SYSTEM_PROMPT);
  });

  it('formatExtractionPrompt 与上游用户模板逐字段一致', () => {
    const prompt = formatExtractionPrompt({
      newMessages: [{ id: 'n1', role: 'user', content: '记住用暗色', timestamp: Date.parse('2026-09-18T00:00:00.000Z') }],
      backgroundMessages: [{ id: 'b1', role: 'assistant', content: '好的', timestamp: Date.parse('2026-09-17T23:59:00.000Z') }],
      previousSceneName: '团队在围绕主题切分',
    });
    expect(prompt).toBe(
      [
        '**输出语言**：根据下方"待提取的新消息"中 user 发言的主导语言书写 `scene_name` 和 memory `content`。',
        '',
        '【上一个情境】：团队在围绕主题切分',
        '',
        '【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：',
        '[b1] [assistant] [2026-09-17T23:59:00.000Z]: 好的',
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        '【待提取的新消息】（务必结合 timestamp 推算时间，只从这里提取记忆！）：',
        '[n1] [user] [2026-09-18T00:00:00.000Z]: 记住用暗色',
      ].join('\n'),
    );
  });

  it('无背景消息时写 无，并沿用默认上一情境', () => {
    const prompt = formatExtractionPrompt({
      newMessages: [{ id: 'n1', role: 'user', content: 'hi', timestamp: 0 }],
    });
    expect(prompt).toContain('【上一个情境】：无');
    expect(prompt).toContain('【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：\n无\n');
  });

  it('messagesFromTranscript 按行首 role 切分，并把 toolResult 映射为 assistant', () => {
    expect(messagesFromTranscript(
      'user: 你是什么模型?\ntoolResult: PI_MODEL=x\nassistant: 我是 Claude。',
      { now: 1_000_000, idPrefix: 'm' },
    )).toEqual([
      { id: 'm0', role: 'user', content: '你是什么模型?', timestamp: 1_000_000 },
      { id: 'm1', role: 'assistant', content: 'PI_MODEL=x', timestamp: 1_001_000 },
      { id: 'm2', role: 'assistant', content: '我是 Claude。', timestamp: 1_002_000 },
    ]);
  });

  it('messagesFromTranscript 正文中间有大量连续换行时不触发正则的二次复杂度', () => {
    const body = `开头\n${'\n'.repeat(200_000)}尾部\n`;
    const start = performance.now();
    const messages = messagesFromTranscript(`user: ${body}assistant: 回复`, { now: 1_000_000 });
    const elapsed = performance.now() - start;
    expect(messages).toEqual([
      { id: 'm0', role: 'user', content: `开头\n${'\n'.repeat(200_000)}尾部`, timestamp: 1_000_000 },
      { id: 'm1', role: 'assistant', content: '回复', timestamp: 1_001_000 },
    ]);
    expect(elapsed).toBeLessThan(200);
  });

  it('formatBatchConflictPrompt 输出统一候选池与按条关联 ID', () => {
    const prompt = formatBatchConflictPrompt([
      {
        newMemory: { record_id: 'r0', content: '新记忆', type: 'work_method', priority: 90, scene_name: '场景A' },
        candidates: [{
          id: 'old1', content: '旧记忆', type: 'work_method', priority: 80,
          scene_name: '场景A', timestamps: ['2026-09-18T00:00:00.000Z'],
        }],
      },
    ]);
    expect(prompt).toContain('## 统一候选记忆池（共 1 条已有记忆）');
    expect(prompt).toContain('"record_id": "old1"');
    expect(prompt).toContain('### 第 1 条新记忆 (record_id: r0)');
    expect(prompt).toContain('【关联候选 ID】["old1"]');
    expect(prompt).toContain('═'.repeat(50));
    expect(prompt).toContain('请逐条判断并输出决策 JSON 数组。当某条新记忆的候选列表为空时，该条直接输出 action=store。');
  });

  it('候选池为空时提示直接 store', () => {
    const prompt = formatBatchConflictPrompt([
      { newMemory: { record_id: 'r0', content: '新', type: 'work_fact', priority: 50, scene_name: 's' }, candidates: [] },
    ]);
    expect(prompt).toContain('（空，没有已有记忆，所有新记忆直接 store）');
    expect(prompt).toContain('[]（无相似候选，直接 store）');
  });
});
