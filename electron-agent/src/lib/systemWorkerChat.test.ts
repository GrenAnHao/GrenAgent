import { describe, expect, it } from 'vitest';
import { isSystemWorkerPrompt, parseSystemWorkerInput } from './systemWorkerChat';

const prompt = 'Generate a Wiki page.\nTask kind: wiki_page_generate\nInput: {"source":"manual.md"}';

describe('systemWorkerChat', () => {
  it('识别系统任务提示并保留 Input JSON', () => {
    expect(isSystemWorkerPrompt(prompt)).toBe(true);
    expect(parseSystemWorkerInput(prompt)).toEqual({ source: 'manual.md' });
  });

  it('普通消息和无效 Input 不按任务解析', () => {
    expect(isSystemWorkerPrompt('你好')).toBe(false);
    expect(parseSystemWorkerInput('你好')).toBeUndefined();
    expect(parseSystemWorkerInput('Generate.\nTask kind: wiki_page_generate\nInput: invalid')).toBeUndefined();
  });
});
