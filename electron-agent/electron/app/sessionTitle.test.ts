import { describe, expect, it, vi } from 'vitest';
import { generateSessionTitle, type TitleCall } from './sessionTitle';

const lines = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join('\n');

const SESSION = lines(
  { type: 'session', id: 's', cwd: 'C:/work' },
  {
    type: 'message',
    message: {
      role: 'user',
      content: '<skill name="brainstorming" location="C:/s/SKILL.md">\nReferences are relative to C:/s.\n\n# 头脑风暴\n</skill>\n\n规划套餐订购页',
    },
  },
  { type: 'message', message: { role: 'assistant', provider: 'newapi', model: 'glm', content: [] } },
  { type: 'message', message: { role: 'user', content: '继续吧' } },
  { type: 'session_info', name: '# 生成标题' },
);

function run(complete: (input: TitleCall) => Promise<string>, titleModel?: string, raw = SESSION) {
  return generateSessionTitle('C:/s.jsonl', { complete, titleModel: () => titleModel, readFile: async () => raw });
}

describe('generateSessionTitle', () => {
  it('用第一条用户消息、拆开技能块，输出清洗后返回', async () => {
    const complete = vi.fn(async (_input: TitleCall) => '**套餐订购页规划**');
    await expect(run(complete, 'title/fast')).resolves.toBe('套餐订购页规划');
    const call = complete.mock.calls[0]![0];
    expect(call).toMatchObject({ provider: 'title', modelId: 'fast', maxTokens: 1024 });
    expect(call.user).toContain('<request>\n规划套餐订购页\n</request>');
    expect(call.user).toContain('Skill: brainstorming');
    expect(call.user).not.toContain('继续吧');
    expect(call.user).not.toContain('头脑风暴');
  });

  it('标题模型失败或给出拒绝句时，依次换会话模型、默认模型', async () => {
    const complete = vi.fn<(input: TitleCall) => Promise<string>>()
      .mockRejectedValueOnce(new Error('模型不可用'))
      .mockResolvedValueOnce('无法生成有意义的标题。')
      .mockResolvedValueOnce('套餐订购页');
    await expect(run(complete, 'gone/model')).resolves.toBe('套餐订购页');
    expect(complete.mock.calls.map(([input]) => input.provider ?? 'default')).toEqual(['gone', 'newapi', 'default']);
  });

  it('全部报错时抛出；有回答但都不能用时返回空串', async () => {
    await expect(run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(run(async () => 'Sorry, I cannot.')).resolves.toBe('');
  });

  it('没有用户消息、或只有图片时不调用模型', async () => {
    const complete = vi.fn(async (_input: TitleCall) => 'x');
    await expect(run(complete, undefined, lines({ type: 'session' }))).resolves.toBe('');
    await expect(run(complete, undefined, lines({ type: 'message', message: { role: 'user', content: [{ type: 'image', data: '', mimeType: 'image/png' }] } }))).resolves.toBe('');
    expect(complete).not.toHaveBeenCalled();
  });
});
