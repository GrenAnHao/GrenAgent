import { describe, expect, it } from 'vitest';
import { parseMemoryExtraction } from './memoryExtraction';
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

  it('空数组放行：模型明确说没有记忆', () => {
    expect(parseExtractionText('[]')).toEqual([]);
    expect(parseExtractionText('没有可记的内容：[]')).toEqual([]);
  });

  it.each([
    ['think 被截断，括号里是数字', '<think>没写完 [1]'],
    ['think 被截断，后面跟着合法场景数组', `<think>没写完 ${JSON.stringify([scene])}`],
    ['think 被截断，前面有合法场景数组', `${JSON.stringify([scene])}\n<think>没写完`],
  ])('未闭合的 think（%s）不去捞数组，抛 invalid JSON', (_name, raw) => {
    expect(() => parseExtractionText(raw)).toThrow('system Pi returned invalid JSON');
  });

  it.each([
    ['裸 L1 记录数组', '[{"content":"c","type":"work_fact"}]'],
    ['数字数组', '[1]'],
    ['字符串数组', '["a","b"]'],
    ['memories 不是数组的对象数组', '[{"scene_name":"s","memories":"x"}]'],
    ['说明文字里夹着数字数组', '见第 [1] 条'],
    ['说明文字里夹着裸 L1 记录数组', '结果：[{"content":"c","type":"work_fact"}] 以上'],
  ])('非空数组但没有场景（%s）抛 invalid JSON，不当成空结果提交', (_name, raw) => {
    expect(() => parseExtractionText(raw)).toThrow('system Pi returned invalid JSON');
  });

  it('非空数组里只要有一个带 memories 数组的对象就放行', () => {
    expect(parseExtractionText(JSON.stringify([1, scene]))).toEqual([1, scene]);
    expect(parseExtractionText(JSON.stringify([{ scene_name: '闲聊', memories: [] }]))).toEqual([{ scene_name: '闲聊', memories: [] }]);
  });

  it('信封多带键：不是信封，原样返回，由 parseMemoryExtraction 的严格校验拒绝（可重试）', () => {
    const raw = '{"l1":[{"content":"c","type":"work_fact"}],"summary":"x"}';
    expect(parseExtractionText(raw)).toEqual({ l1: [{ content: 'c', type: 'work_fact' }], summary: 'x' });
    expect(() => parseMemoryExtraction(parseExtractionText(raw), 'work')).toThrow('memory extraction output is invalid');
  });

  it('对象带别的字段时，在属性值里找场景数组', () => {
    expect(parseExtractionText(JSON.stringify({ scenes: [scene], notes: ['x'] }))).toEqual([scene]);
    expect(parseExtractionText(JSON.stringify({ summary: 'x', data: [scene] }))).toEqual([scene]);
  });

  it('属性值里的空数组不抢在真正的场景数组前面；只有空数组时按「没有记忆」处理', () => {
    expect(parseExtractionText(JSON.stringify({ notes: [], scenes: [scene] }))).toEqual([scene]);
    expect(parseExtractionText('{"scenes":[]}')).toEqual([]);
  });

  it('整段已是合法对象时不再对原文做贪婪正则', () => {
    expect(parseExtractionText('{"ok":true,"note":"[]"}')).toEqual({ ok: true, note: '[]' });
    expect(parseExtractionText('{"result":"见 [1]"}')).toEqual({ result: '见 [1]' });
  });
});
