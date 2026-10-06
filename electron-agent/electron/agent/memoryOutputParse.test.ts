import { describe, expect, it } from 'vitest';
import { parseExtractionText, parseLooseJson, repairExtractionJson, sanitizeJsonForParse, stripModelWrappers } from './memoryOutputParse';

const scene = { scene_name: 's', message_ids: ['m0'], memories: [{ content: 'c', type: 'work_fact', priority: 80 }] };

describe('stripModelWrappers', () => {
  it('剥掉完整的 <think> 块和代码围栏，不完整的 think 原样保留', () => {
    expect(stripModelWrappers('<think>想 [1]</think>\n```json\n[1]\n```')).toBe('[1]');
    expect(stripModelWrappers('<think>没写完 [1]')).toBe('<think>没写完 [1]');
  });
});

describe('sanitizeJsonForParse / repairExtractionJson', () => {
  it('转义字符串里的裸换行和控制字符', () => {
    expect(JSON.parse(sanitizeJsonForParse('{"a":"x\ny\u0001"}'))).toEqual({ a: 'x\ny\u0001' });
  });

  it('非法 priority 改成 50，去掉尾逗号', () => {
    expect(JSON.parse(repairExtractionJson('[{"content":"c","priority": high,}]'))).toEqual([{ content: 'c', priority: 50 }]);
  });

  it('parseLooseJson 先净化、失败再修复', () => {
    expect(parseLooseJson('[{"content":"a\nb","priority": sheet}]')).toEqual([{ content: 'a\nb', priority: 50 }]);
    expect(() => parseLooseJson('not json')).toThrow();
  });
});

describe('parseExtractionText', () => {
  it.each([
    ['裸数组', JSON.stringify([scene])],
    ['think 包裹', `<think>先想想 [x]</think>${JSON.stringify([scene])}`],
    ['代码围栏', `\`\`\`json\n${JSON.stringify([scene])}\n\`\`\``],
    ['对象里套 scenes 数组', JSON.stringify({ scenes: [scene] })],
    ['数组前后有说明文字', `结果如下：\n${JSON.stringify([scene])}\n以上。`],
  ])('%s 都得到场景数组', (_name, raw) => {
    expect(parseExtractionText(raw)).toEqual([scene]);
  });

  it('单个场景对象包成数组', () => {
    expect(parseExtractionText(JSON.stringify(scene))).toEqual([scene]);
  });

  it('{l1,l2,l3} 信封原样返回', () => {
    expect(parseExtractionText('{"l1":[{"content":"c","type":"work_fact"}]}')).toEqual({ l1: [{ content: 'c', type: 'work_fact' }] });
  });

  it('对象里没有数组时原样返回，交给 parseMemoryExtraction 判定', () => {
    expect(parseExtractionText('{"ok":true}')).toEqual({ ok: true });
    expect(parseExtractionText('{}')).toEqual({});
  });

  it('完全没有 JSON 时抛 invalid JSON，交给 TaskQueue 重试', () => {
    expect(() => parseExtractionText('我觉得没什么可记的。')).toThrow('system Pi returned invalid JSON');
  });
});
