import { describe, expect, it } from 'vitest';
import {
  buildSubAgentConversationMessages,
  expandSubAgents,
  finalizeSubAgentMessages,
  spawnUnitTitle,
  subAgentCardTitle,
  subAgentMode,
  subAgentRoleLabel,
  taskTitle,
  latestStepFromMessages,
  latestSubAgentStep,
  isEmbeddedChildEvent,
  backgroundRegistryStatus,
  isBackgroundSpawn,
  shouldBindChildSession,
  subAgentId,
  subAgentSessionPath,
  rememberedSpawnTasks,
  resolveSpawnTask,
  subAgentUnitView,
  taskFromAgentResult,
  taskLabel,
} from './subagentUtils';
import type { ChatMessage } from '../../stores/agentReducer';

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> } | undefined)?.content;
  return content?.map((b) => b.text ?? '').join('') ?? '';
}

describe('subAgentSessionPath', () => {
  it('reads details.sessionPath from tool result', () => {
    expect(subAgentSessionPath({ details: { sessionPath: '/tmp/sa.jsonl' } })).toBe('/tmp/sa.jsonl');
    expect(subAgentSessionPath({ details: { agentId: 'sa-1' } })).toBeNull();
  });

  it('binds child session only when sessionPath is present', () => {
    expect(shouldBindChildSession({ details: { sessionPath: '/tmp/sa.jsonl' } })).toBe(true);
    expect(shouldBindChildSession({ details: { transcript: '{"type":"message_start"}' } })).toBe(false);
  });

  it('matches live events by sessionPath', () => {
    expect(isEmbeddedChildEvent({ source: 'subagent', sessionPath: '/s.jsonl' }, '/s.jsonl')).toBe(true);
    expect(isEmbeddedChildEvent({ source: 'subagent', sessionPath: '/other.jsonl' }, '/s.jsonl')).toBe(false);
    expect(isEmbeddedChildEvent({ source: 'interactive' }, '/s.jsonl')).toBe(false);
  });
});

describe('resolveSpawnTask', () => {
  const spawn = {
    id: 'm1',
    kind: 'tool',
    toolName: 'spawn_agent',
    args: { action: 'spawn', task: '你正在实现周期常量模块，续费不再依赖当前标价。\n\n任务全文在哪里' },
    result: { details: { agentId: 'sa-1', status: 'running' } },
  };
  const parallel = {
    id: 'p1',
    kind: 'tool',
    toolName: 'spawn_agent',
    args: { tasks: ['审规格', '审实现'] },
    result: {
      details: {
        results: [
          { task: '审规格', agentId: 'sa-a' },
          { task: '审实现', agentId: 'sa-b' },
        ],
      },
    },
  };

  it('wait 沿用先前同 agentId 的启动任务，不用结果里的第一行盖掉全文', () => {
    const remembered = rememberedSpawnTasks([spawn]);
    const result = {
      content: [{ type: 'text', text: 'agent sa-1: done\nTask: 你正在实现周期常量模块，续费不再依赖当前标价。\n\n输出' }],
      details: { agentId: 'sa-1', status: 'done' },
    };
    expect(resolveSpawnTask({ action: 'wait', agentId: 'sa-1' }, result, remembered)).toBe(spawn.args.task);
  });

  it('结果还没回来时，仍能按 agentId 对上正在跑的启动任务', () => {
    const remembered = rememberedSpawnTasks([spawn]);
    expect(resolveSpawnTask({ action: 'wait', agentId: 'sa-1' }, undefined, remembered)).toBe(spawn.args.task);
  });

  it('没有先前启动记录时，用 details.task，其次用状态头里的 Task 行', () => {
    expect(taskFromAgentResult({
      content: [{ type: 'text', text: 'agent sa-1: running\nTask: 只读审查' }],
      details: { task: '完整任务\n第二段' },
    })).toBe('完整任务\n第二段');
    expect(resolveSpawnTask(
      { action: 'status', agentId: 'sa-1' },
      { content: [{ type: 'text', text: 'agent sa-1: running\nTask: 只读审查' }], details: { agentId: 'sa-1' } },
      new Map(),
    )).toBe('只读审查');
  });

  it('启动回执和子代理正文里的 Task: 不当成标题', () => {
    expect(taskFromAgentResult({
      content: [{ type: 'text', text: 'Background sub-agent started. agentId: sa-1\nTask: 不要用这行' }],
    })).toBeNull();
    expect(taskFromAgentResult({
      content: [{ type: 'text', text: '结论\nTask: 这是正文' }],
    })).toBeNull();
  });

  it('并行启动按各自 agentId 记住任务', () => {
    const remembered = rememberedSpawnTasks([parallel]);
    expect(resolveSpawnTask({ action: 'wait', agentId: 'sa-b' }, {}, remembered)).toBe('审实现');
  });

  it('普通 spawn 不改写自己的任务', () => {
    expect(resolveSpawnTask({ task: '分析渲染' }, {}, new Map())).toBeNull();
  });
});

describe('background spawn after restart', () => {
  it('启动回执仍算后台任务，即使详情里没有 status', () => {
    expect(isBackgroundSpawn({
      content: [{ type: 'text', text: 'Background sub-agent started. agentId: sa-1' }],
    })).toBe(true);
    expect(isBackgroundSpawn({ details: { status: 'done', agentId: 'sa-1' }, content: [{ type: 'text', text: '完成了' }] })).toBe(false);
  });

  it('sidecar restarted 不是成功完成；列表里没有这一行也不是', () => {
    expect(backgroundRegistryStatus({ status: 'done', error: 'sidecar restarted' })).toBe('interrupted');
    expect(backgroundRegistryStatus(undefined)).toBe('interrupted');
    expect(backgroundRegistryStatus({ status: 'done', error: null })).toBe('done');
    expect(backgroundRegistryStatus({ status: 'running' })).toBe('running');
  });
});

describe('taskLabel', () => {
  it('single task (with optional agent prefix)', () => {
    expect(taskLabel({ task: '分析渲染' })).toBe('分析渲染');
    expect(taskLabel({ task: '分析', agent: 'scout' })).toBe('scout: 分析');
  });
  it('chain / parallel aggregate labels', () => {
    expect(taskLabel({ chain: [{ task: 'a' }, { task: 'b' }] })).toBe('2 步链式');
    expect(taskLabel({ tasks: ['a', 'b', 'c'] })).toBe('3 个并行任务');
  });
});

describe('subAgentMode', () => {
  it('classifies single / parallel / chain', () => {
    expect(subAgentMode({ task: 'x' })).toBe('single');
    expect(subAgentMode({ tasks: ['x'] })).toBe('single'); // 单元素 tasks 等价单任务
    expect(subAgentMode({ tasks: ['x', 'y'] })).toBe('parallel');
    expect(subAgentMode({ chain: [{ task: 'a' }, { task: 'b' }] })).toBe('chain');
  });
});

describe('expandSubAgents', () => {
  it('single → one unit with null subIndex reusing the message', () => {
    const units = expandSubAgents('m1', { task: 'solo' }, {}, 'done');
    expect(units).toEqual([{ key: 'm1', subIndex: null, task: 'solo', status: 'done' }]);
  });

  it('keeps a submitted title on the unit and leaves string tasks untitled', () => {
    const single = expandSubAgents('m1', { title: '审服务端', task: '请完整审查服务端改动。' }, {}, 'done');
    expect(single[0]?.title).toBe('审服务端');
    expect(single[0]?.task).toBe('请完整审查服务端改动。');

    const parallel = expandSubAgents(
      'm2',
      { tasks: [{ title: '审接口', task: '请审查接口' }, '没有标题的任务'] },
      {},
      'done',
    );
    expect(parallel.map((u) => u.title)).toEqual(['审接口', undefined]);
  });

  it('parallel done → per-unit status from details.results', () => {
    const units = expandSubAgents(
      'm2',
      { tasks: ['a', 'b'] },
      { details: { results: [{ task: 'a', ok: true }, { task: 'b', ok: false, error: 'boom' }] } },
      'done',
    );
    expect(units).toEqual([
      { key: 'm2#0', subIndex: 0, task: 'a', status: 'done' },
      { key: 'm2#1', subIndex: 1, task: 'b', status: 'error' },
    ]);
  });

  it('chain stopped early → later steps are pending', () => {
    const units = expandSubAgents(
      'm3',
      { chain: [{ task: 's1' }, { task: 's2' }, { task: 's3' }] },
      { details: { mode: 'chain', stoppedAt: 2, results: [{ step: 1, task: 's1', ok: true }, { step: 2, task: 's2', ok: false }] } },
      'error',
    );
    expect(units.map((u) => u.status)).toEqual(['done', 'error', 'pending']);
    expect(units.map((u) => u.task)).toEqual(['s1', 's2', 's3']);
  });

  it('running with no child session yet → starting, and keeps a model written on the task', () => {
    const units = expandSubAgents(
      'm4',
      { tasks: ['a', { task: 'b', model: 'anthropic/claude-opus' }] },
      {},
      'running',
      true,
    );
    expect(units.map((u) => u.status)).toEqual(['starting', 'starting']);
    expect(units.map((u) => u.model)).toEqual([undefined, 'anthropic/claude-opus']);
  });

  it('a child with a session path is running; the rest stay starting', () => {
    const units = expandSubAgents(
      'm5',
      { tasks: ['a', 'b', 'c'] },
      { details: { results: [{ task: 'a', agentId: 'sa-1', sessionPath: '/tmp/a.jsonl', model: 'anthropic/claude-opus', status: 'running' }, { task: 'b', model: 'anthropic/claude-opus', status: 'starting' }] } },
      'running',
      true,
    );
    expect(units.map((u) => u.status)).toEqual(['running', 'starting', 'starting']);
    expect(units[0]?.model).toBe('anthropic/claude-opus');
    expect(units[1]?.model).toBe('anthropic/claude-opus');
  });

  it('chain running with no snapshot → only the first step starts, the rest wait', () => {
    const units = expandSubAgents(
      'm6',
      { chain: [{ task: 's1', model: 'deepseek/deepseek-v4-flash' }, { task: 's2' }, { task: 's3', model: 'deepseek/deepseek-v4-flash' }] },
      {},
      'running',
    );
    expect(units.map((u) => u.status)).toEqual(['starting', 'waiting', 'waiting']);
    expect(units.map((u) => u.model)).toEqual(['deepseek/deepseek-v4-flash', undefined, 'deepseek/deepseek-v4-flash']);
  });

  it('chain keeps the model after a step is done and leaves later steps waiting', () => {
    const units = expandSubAgents(
      'm7',
      { chain: [{ task: 's1' }, { task: 's2' }, { task: 's3' }] },
      {
        details: {
          mode: 'chain',
          streaming: true,
          results: [
            { task: 's1', ok: true, status: 'done', model: 'deepseek/deepseek-v4-flash' },
            { task: 's2', status: 'running', model: 'deepseek/deepseek-v4-flash', sessionPath: '/tmp/s2.jsonl' },
            { task: 's3', status: 'waiting', model: 'deepseek/deepseek-v4-flash' },
          ],
        },
      },
      'running',
    );
    expect(units.map((u) => u.status)).toEqual(['done', 'running', 'waiting']);
    expect(units.map((u) => u.model)).toEqual([
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-flash',
    ]);
  });
});

describe('subAgentUnitView', () => {
  it('single (subIndex null) passes the whole message result through', () => {
    const result = { details: { transcript: 'x' } };
    const view = subAgentUnitView({ task: 'solo' }, result, 'done', null);
    expect(view).toEqual({ task: 'solo', result, status: 'done' });
  });

  it('parallel unit → that unit final output + status', () => {
    const result = { details: { results: [{ task: 'a', ok: true, output: 'a out' }, { task: 'b', ok: false, error: 'boom' }] } };
    const ok = subAgentUnitView({ tasks: ['a', 'b'] }, result, 'done', 0);
    expect(ok.task).toBe('a');
    expect(ok.status).toBe('done');
    expect(textOf(ok.result)).toContain('a out');

    const bad = subAgentUnitView({ tasks: ['a', 'b'] }, result, 'done', 1);
    expect(bad.status).toBe('error');
    expect(textOf(bad.result)).toContain('boom');
  });

  it('parallel unit forwards sessionPath so the dock binds the child session', () => {
    const result = {
      details: {
        results: [{ task: 'a', ok: true, output: 'a out', agentId: 'sa-1', sessionPath: '/tmp/a.jsonl' }],
      },
    };
    const view = subAgentUnitView({ tasks: ['a', 'b'] }, result, 'done', 0);
    expect(subAgentSessionPath(view.result)).toBe('/tmp/a.jsonl');
    expect(shouldBindChildSession(view.result)).toBe(true);
  });

  it('chain step not yet started → waiting copy', () => {
    const view = subAgentUnitView(
      { chain: [{ task: 's1' }, { task: 's2' }] },
      { details: { results: [{ task: 's1', status: 'running' }, { task: 's2', status: 'waiting' }] } },
      'running',
      1,
    );
    expect(textOf(view.result)).toContain('等待上一步完成');
  });

  it('pending chain step → explanatory text', () => {
    const result = { details: { results: [{ step: 1, task: 's1', ok: false }] } };
    const view = subAgentUnitView({ chain: [{ task: 's1' }, { task: 's2' }] }, result, 'error', 1);
    expect(view.task).toBe('s2');
    expect(textOf(view.result)).toContain('未执行');
  });

  it('running unit → no result yet', () => {
    const view = subAgentUnitView({ tasks: ['a', 'b'] }, {}, 'running', 0);
    expect(view.status).toBe('running');
    expect(view.result).toBeUndefined();
  });

  it('running parallel unit keeps sessionPath so the dock binds the live child', () => {
    const result = {
      details: {
        streaming: true,
        results: [{ task: 'a', agentId: 'sa-1', sessionPath: '/tmp/a.jsonl' }, { task: 'b' }],
      },
    };
    const view = subAgentUnitView({ tasks: ['a', 'b'] }, result, 'running', 0);
    expect(view.status).toBe('running');
    expect(subAgentSessionPath(view.result)).toBe('/tmp/a.jsonl');
    expect(subAgentId(view.result)).toBe('sa-1');
    expect(shouldBindChildSession(view.result)).toBe(true);
    expect(textOf(view.result)).toBe('');
  });
});

describe('subAgentCardTitle', () => {
  it('uses the submitted title and caps it at 24 characters', () => {
    expect(subAgentCardTitle('审服务端', '请完整审查一次已完成的服务端改动，审完再回复。')).toBe('审服务端');
    expect(subAgentCardTitle('标'.repeat(30), '任务')).toBe(`${'标'.repeat(24)}…`);
  });

  it('falls back to the truncated task when title is missing', () => {
    expect(subAgentCardTitle(undefined, '你是代码审查代理。请完整审查服务端改动。')).toBe('完整审查服务端改动');
  });

  it('reads the title for a single task and for one parallel item', () => {
    expect(spawnUnitTitle({ title: '审服务端', task: '全文' }, null)).toBe('审服务端');
    expect(spawnUnitTitle({ tasks: [{ title: '审接口', task: '全文' }, '另一项'] }, 0)).toBe('审接口');
    expect(spawnUnitTitle({ tasks: ['没有标题'] }, 0)).toBeUndefined();
    expect(spawnUnitTitle({ chain: [{ title: '第一步', task: '做甲' }] }, 0)).toBe('第一步');
  });
});

describe('taskTitle', () => {
  it('drops the role sentence and keeps the action', () => {
    expect(taskTitle('你是代码审查代理（只读，不要修改任何文件）。请完整审查一次已完成的服务端改动，审完再回复。')).toBe(
      '完整审查一次已完成的服务端改动',
    );
  });

  it('caps a long action', () => {
    expect(taskTitle(`请${'审'.repeat(30)}。`)).toBe(`${'审'.repeat(24)}…`);
  });
});

describe('subAgentRoleLabel', () => {
  it('extracts the bold role after 角色', () => {
    expect(subAgentRoleLabel('## 角色 你是 **Rust/系统架构倡导者**. 任务...')).toBe('Rust/系统架构倡导者');
  });
  it('falls back to first non-empty line stripped of markdown', () => {
    expect(subAgentRoleLabel('# 审查这段并发代码的安全性\n\n更多...')).toBe('审查这段并发代码的安全性');
  });
  it('truncates long fallback with ellipsis', () => {
    expect(subAgentRoleLabel('一'.repeat(50))).toBe(`${'一'.repeat(40)}…`);
  });
  it('empty → 子代理任务', () => {
    expect(subAgentRoleLabel('')).toBe('子代理任务');
  });
});

describe('latestStepFromMessages', () => {
  it('empty → null', () => {
    expect(latestStepFromMessages([])).toBeNull();
  });
  it('latest tool → 调用 toolName，step 计 assistant+tool', () => {
    const msgs = [
      { kind: 'assistant', id: 'a1', text: 'hi', thinking: '', streaming: false } as ChatMessage,
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'read_file', args: {}, result: {}, status: 'done' } as ChatMessage,
    ];
    expect(latestStepFromMessages(msgs)).toEqual({ step: 2, action: '调用 read_file' });
  });
  it('latest assistant → 生成回复中…', () => {
    const msgs = [
      { kind: 'tool', id: 't1', toolCallId: 'c1', toolName: 'grep', args: {}, result: {}, status: 'done' } as ChatMessage,
      { kind: 'assistant', id: 'a1', text: '结论...', thinking: '', streaming: false } as ChatMessage,
    ];
    expect(latestStepFromMessages(msgs)).toEqual({ step: 2, action: '生成回复中…' });
  });
});

describe('latestSubAgentStep', () => {
  it('empty transcript → null', () => {
    expect(latestSubAgentStep('')).toBeNull();
  });
});

describe('buildSubAgentConversationMessages', () => {
  it('uses transcript replay when assistant/tool messages exist', () => {
    const replay: ChatMessage[] = [
      { kind: 'assistant', id: 'sa-0', text: 'c=5', thinking: '', streaming: false },
    ];
    const msgs = buildSubAgentConversationMessages(
      'task',
      { content: [{ type: 'text', text: 'ignored fallback' }] },
      'done',
      replay,
    );
    expect(msgs[0]).toMatchObject({ kind: 'user', text: 'task', promptFrame: true });
    expect(msgs[1]).toMatchObject({ kind: 'assistant', text: 'c=5' });
  });

  it('falls back to result text when transcript replay is empty (session header only)', () => {
    const msgs = buildSubAgentConversationMessages(
      'task',
      { content: [{ type: 'text', text: 'RESULT:c=5' }] },
      'done',
      [],
    );
    expect(msgs.map((m) => (m.kind === 'assistant' || m.kind === 'user' ? m.text : ''))).toEqual([
      'task',
      'RESULT:c=5',
    ]);
  });

  it('does not prepend the task when the replay already contains that user send', () => {
    const replay: ChatMessage[] = [
      { kind: 'user', id: 'u1', text: '你有 bash 工具' },
      { kind: 'assistant', id: 'sa-0', text: 'tool-used=failed', thinking: '', streaming: false },
    ];
    const msgs = buildSubAgentConversationMessages('你有 bash 工具', { content: [] }, 'done', replay);
    expect(msgs.filter((m) => m.kind === 'user')).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'user', id: 'u1', text: '你有 bash 工具', promptFrame: true });
  });

  it('does not show (no output) as a fake reply', () => {
    const msgs = buildSubAgentConversationMessages(
      'task',
      { content: [{ type: 'text', text: '(no output)' }] },
      'done',
      [],
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: 'user', text: 'task', promptFrame: true });
  });
});

describe('finalizeSubAgentMessages', () => {
  const runningTool = {
    kind: 'tool',
    id: 't1',
    toolCallId: 'c1',
    toolName: 'bash',
    args: {},
    result: undefined,
    status: 'running',
  } as ChatMessage;

  it('running status → returns the same array untouched', () => {
    const msgs = [runningTool];
    expect(finalizeSubAgentMessages(msgs, 'running')).toBe(msgs);
  });

  it('done → dangling running tool becomes done', () => {
    const [m] = finalizeSubAgentMessages([runningTool], 'done');
    expect(m.kind === 'tool' && m.status).toBe('done');
  });

  it('error → dangling running tool becomes error', () => {
    const [m] = finalizeSubAgentMessages([runningTool], 'error');
    expect(m.kind === 'tool' && m.status).toBe('error');
  });

  it('done → streaming assistant stops streaming', () => {
    const assistant = {
      kind: 'assistant',
      id: 'a1',
      text: 'partial',
      thinking: '',
      streaming: true,
    } as ChatMessage;
    const [m] = finalizeSubAgentMessages([assistant], 'done');
    expect(m.kind === 'assistant' && m.streaming).toBe(false);
  });

  it('already-terminal steps are left as-is', () => {
    const doneTool = { ...runningTool, status: 'done' } as ChatMessage;
    const [m] = finalizeSubAgentMessages([doneTool], 'done');
    expect(m.kind === 'tool' && m.status).toBe('done');
  });
});
