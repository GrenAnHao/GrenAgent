import { afterEach, describe, it, expect, vi } from 'vitest';
import type { DisplayMessage } from './groupMessages';
import * as subagentUtils from '../panels/subagentUtils';
import { computeSubAgentUnits, computeAnsweredQuestions } from './messagePrecompute';

const tool = (id: string, toolName: string): DisplayMessage =>
  ({ kind: 'tool', id, toolCallId: `${id}-c`, toolName, args: {}, result: {}, status: 'done' }) as DisplayMessage;
const user = (id: string): DisplayMessage => ({ kind: 'user', id, text: 'hi' }) as DisplayMessage;
const questions = (id: string): DisplayMessage =>
  ({ kind: 'notice', id, customType: 'agent-questions', content: '{}' }) as DisplayMessage;

describe('computeSubAgentUnits', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['启动成功', 'done', { details: { agentId: 'sa-empty', status: 'running', sessionPath: '/empty.jsonl' } }],
    ['启动前拒绝', 'error', { isError: true, content: [{ type: 'text', text: '子代理已被禁用' }] }],
  ] as const)('空数组不丢失单任务：%s', (_label, status, result) => {
    const message = { ...tool('empty', 'spawn_agent'), args: { action: 'spawn', title: '检查空数组', task: '审查接口', tasks: [], chain: [] }, status, result } as DisplayMessage;
    const units = computeSubAgentUnits([message]).unitsByMessage.get('empty');
    expect(units).toHaveLength(1);
    expect(units?.[0]).toMatchObject({ no: 1, unit: { task: '审查接口', title: '检查空数组', subIndex: null, status } });
    if (status === 'done') expect(units?.[0].unit.agentId).toBe('sa-empty');
  });

  it('空 tasks 不覆盖 chain，单步链式保留逐项结果身份', () => {
    const message = { ...tool('chain', 'spawn_agent'), args: { tasks: [], chain: [{ task: '链式步骤' }] }, result: { details: { mode: 'chain', results: [{ task: '链式步骤', agentId: 'sa-step', ok: true }] } } } as DisplayMessage;
    expect(computeSubAgentUnits([message]).unitsByMessage.get('chain')).toEqual([
      { no: 1, unit: { key: 'chain#0', subIndex: 0, task: '链式步骤', agentId: 'sa-step', status: 'done' } },
    ]);
  });

  it('混合 task/tasks 不遗漏顶层任务，编号、模型及详情索引对应后端顺序', () => {
    const message = { ...tool('mixed', 'spawn_agent'), args: { title: '任务 A', task: 'A', model: 'p/a', tasks: [{ title: '任务 B', task: 'B', model: 'p/b' }] }, result: {} } as DisplayMessage;
    const units = computeSubAgentUnits([message]).unitsByMessage.get('mixed');
    expect(units?.map(({ no, unit }) => ({ no, task: unit.task, title: unit.title, model: unit.model, subIndex: unit.subIndex }))).toEqual([
      { no: 1, task: 'A', title: '任务 A', model: 'p/a', subIndex: 0 },
      { no: 2, task: 'B', title: '任务 B', model: 'p/b', subIndex: 1 },
    ]);
  });

  it('单元素 tasks 与顶层 task 一样保留单代理结果身份', () => {
    const message = { ...tool('one', 'spawn_agent'), args: { tasks: [{ task: '唯一任务', title: '唯一标题' }] }, result: { details: { agentId: 'sa-one' } } } as DisplayMessage;
    expect(computeSubAgentUnits([message]).unitsByMessage.get('one')?.[0].unit).toMatchObject({ subIndex: null, agentId: 'sa-one', title: '唯一标题' });
  });

  it('assigns continuous #N across multiple spawn_agent messages, skips non-spawn', () => {
    // 用 spy 控制每个 spawn 展开的子代理条数，验证连号跨调用累加。
    vi.spyOn(subagentUtils, 'expandSubAgents')
      .mockReturnValueOnce([{ task: 'a' }, { task: 'b' }] as never) // m1 → 2 个
      .mockReturnValueOnce([{ task: 'c' }] as never); // m2 → 1 个
    const { unitsByMessage: map } = computeSubAgentUnits([tool('m1', 'spawn_agent'), tool('x', 'read'), tool('m2', 'spawn_agent')]);
    expect(map.get('m1')!.map((u) => u.no)).toEqual([1, 2]);
    expect(map.get('m2')!.map((u) => u.no)).toEqual([3]);
    expect(map.has('x')).toBe(false);
  });

  it('wait 并回同一张启动卡片，并带上结果正文', () => {
    const task = '你正在实现「套餐多周期定价」计划的任务 2：周期常量模块';
    const spawn = {
      kind: 'tool',
      id: 'm1',
      toolCallId: 'c1',
      toolName: 'spawn_agent',
      args: { action: 'spawn', task, tasks: [], chain: [] },
      result: {
        content: [{ type: 'text', text: 'Background sub-agent started. agentId: sa-298b8d4d' }],
        details: { agentId: 'sa-298b8d4d', status: 'running', sessionPath: '/tmp/sa.jsonl' },
      },
      status: 'done',
    } as DisplayMessage;
    const wait = {
      kind: 'tool',
      id: 'm2',
      toolCallId: 'c2',
      toolName: 'spawn_agent',
      args: { action: 'wait', agentId: 'sa-298b8d4d' },
      result: {
        content: [{ type: 'text', text: `agent sa-298b8d4d: running\nTask: ${task}\n\n输出` }],
        details: { agentId: 'sa-298b8d4d', status: 'running' },
      },
      status: 'done',
    } as DisplayMessage;
    const index = computeSubAgentUnits([spawn, wait]);
    expect(index.hidden.has('m2')).toBe(true);
    expect(index.unitsByMessage.has('m2')).toBe(false);
    expect(index.unitsByMessage.get('m1')![0].unit.task).toBe(task);
    expect(index.unitsByMessage.get('m1')![0].no).toBe(1);
    const text = (index.overlay.get('m1')?.result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '';
    expect(text).toContain('输出');
    expect((index.overlay.get('m1')?.result as { details?: { sessionPath?: string } }).details?.sessionPath).toBe('/tmp/sa.jsonl');
  });

  it('等待还在跑时不另开卡片，也不把启动结果盖掉', () => {
    const spawn = {
      kind: 'tool',
      id: 'm1',
      toolCallId: 'c1',
      toolName: 'spawn_agent',
      args: { action: 'spawn', task: '实现周期常量' },
      result: { details: { agentId: 'sa-1', status: 'running', sessionPath: '/tmp/sa.jsonl' } },
      status: 'done',
    } as DisplayMessage;
    const wait = {
      kind: 'tool',
      id: 'm2',
      toolCallId: 'c2',
      toolName: 'spawn_agent',
      args: { action: 'wait', agentId: 'sa-1' },
      result: undefined,
      status: 'running',
    } as DisplayMessage;
    const index = computeSubAgentUnits([spawn, wait]);
    expect(index.hidden.has('m2')).toBe(true);
    expect(index.overlay.has('m1')).toBe(false);
    expect(index.unitsByMessage.get('m1')![0].no).toBe(1);
  });

  it('卡死超时的 wait 成功返回时，启动卡片仍标为失败', () => {
    const spawn = {
      kind: 'tool',
      id: 'm1',
      toolCallId: 'c1',
      toolName: 'spawn_agent',
      args: { action: 'spawn', task: '实现套餐定价' },
      result: { details: { agentId: 'sa-5b98b26f', status: 'running', sessionPath: '/tmp/sa.jsonl' } },
      status: 'done',
    } as DisplayMessage;
    const wait = {
      kind: 'tool',
      id: 'm2',
      toolCallId: 'c2',
      toolName: 'spawn_agent',
      args: { action: 'wait', agentId: 'sa-5b98b26f' },
      result: {
        content: [{ type: 'text', text: 'agent sa-5b98b26f: error\n\nError: stuck: no activity for >300s' }],
        details: { agentId: 'sa-5b98b26f', status: 'error', error: 'stuck: no activity for >300s' },
      },
      status: 'done',
    } as DisplayMessage;
    const index = computeSubAgentUnits([spawn, wait]);
    expect(index.overlay.get('m1')?.status).toBe('error');
  });
});

describe('computeAnsweredQuestions', () => {
  it('marks a questions notice as answered when a user message follows it', () => {
    const set = computeAnsweredQuestions([questions('q1'), user('u1'), questions('q2')]);
    expect(set.has('q1')).toBe(true); // 其后有 user
    expect(set.has('q2')).toBe(false); // 其后无 user（最后一张可交互）
  });
});
