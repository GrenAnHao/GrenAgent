import { describe, expect, it } from 'vitest';
import {
  MEMORY_EXTRACT_CHAT_SYSTEM_PROMPT,
  MEMORY_EXTRACT_WORK_SYSTEM_PROMPT,
  memoryExtractPrompt,
} from './memoryPrompts';

describe('memoryPrompts', () => {
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
});
