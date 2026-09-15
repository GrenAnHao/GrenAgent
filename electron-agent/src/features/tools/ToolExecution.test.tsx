import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { ToolExecution } from './ToolExecution';
import { useInlineQuestionStore } from '../../stores/inlineQuestionStore';

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

describe('ToolExecution web_search inspector', { timeout: 30_000 }, () => {
  it('显示「搜索：查询词」与结果数（N）', () => {
    wrap(
      <ToolExecution
        toolName="web_search"
        args={{ query: 'lobehub ChatItem' }}
        result={{ details: { query: 'lobehub ChatItem', count: 12, results: [] }, content: [] }}
        status="done"
      />,
    );
    // 查询词单独成高亮节点（而非 "query: ..." 的参数摘要）。
    expect(screen.getByText('lobehub ChatItem')).toBeTruthy();
    expect(document.body.textContent).toContain('搜索：');
    expect(document.body.textContent).toContain('（12）');
  });
});

describe('ToolExecution skill invocation inspector', { timeout: 30_000 }, () => {
  it('read 某个 SKILL.md 时显示「使用技能 <name>」', () => {
    wrap(
      <ToolExecution
        toolName="read"
        args={{ path: '/home/u/.agents/skills/brave-search/SKILL.md' }}
        result={{ content: [{ type: 'text', text: '---\nname: brave-search\n---\n# Brave' }] }}
        status="done"
      />,
    );
    expect(document.body.textContent).toContain('使用技能');
    expect(screen.getByText('brave-search')).toBeTruthy();
  });
});

describe('ToolExecution bash row', { timeout: 30_000 }, () => {
  it('shows command in the row and output in the body (no redundant $ prompt)', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'echo hi' }}
        result={{ content: [{ type: 'text', text: 'hi there' }] }}
        status="running"
      />,
    );
    // 命令进行内 args、输出进展开 body；工具名 bash 可见。去冗余后不再重复 $ 提示符。
    expect(screen.getByText('echo hi')).toBeTruthy();
    expect(document.body.textContent).toContain('hi there');
    expect(document.body.textContent).toContain('bash');
  });

  it('保留 ls -a 的 --- / . / ..，不当成 Markdown 吃掉', () => {
    const text = [
      '/c/Users/rxstudio/.pi/agent/works/bfe8e88c-7c78-42db-a5c6-945a84c229bc',
      '---',
      '.',
      '..',
      '.pi',
      '---',
      'Wed Sep  9 14:57:20     2026',
    ].join('\n');
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'pwd && echo "---" && ls -a && echo "---" && date' }}
        result={{ content: [{ type: 'text', text }] }}
        status="done"
      />,
    );
    fireEvent.click(screen.getByText('bash'));
    const body = document.body.textContent ?? '';
    expect(body).toContain('---');
    expect(body).toMatch(/(^|\n)\.(?:\n|$)/);
    expect(body).toContain('..');
    expect(body).toContain('.pi');
  });
});

describe('ToolExecution edit inspector', { timeout: 30_000 }, () => {
  it('supports the edits array schema and shows only the filename', () => {
    wrap(
      <ToolExecution
        toolName="edit"
        args={{ path: 'D:/workspace/GeminiProvider.ts', edits: [{ oldText: 'old', newText: 'new' }] }}
        result={{ details: { diff: ' 1 old\n-2 old\n+2 new\n 3 next' }, content: [] }}
        status="done"
      />,
    );
    fireEvent.click(screen.getByText('edit'));
    expect(screen.getAllByText('GeminiProvider.ts')).toHaveLength(2);
    expect(screen.queryByText(/D:\/workspace/)).toBeNull();
    expect(screen.getByTestId('edit-preview-language').textContent).toContain('new');
  });

  it('shows a no-change edit error even when the result is not marked as an error', () => {
    wrap(
      <ToolExecution
        toolName="edit"
        args={{
          path: 'D:/workspace/GeminiProvider.ts',
          edits: [{ oldText: 'same', newText: 'same' }],
        }}
        result={{
          content: [
            {
              type: 'text',
              text: 'No changes made to D:/workspace/GeminiProvider.ts. The replacement produced identical content.',
            },
          ],
        }}
        status="done"
      />,
    );
    fireEvent.click(screen.getByText('edit'));
    expect(document.body.textContent).toContain('No changes made');
    expect(document.body.textContent).toContain('replacement produced identical content');
    expect(screen.queryByText('+ same')).toBeNull();
  });
});

describe('ToolExecution ask_user', () => {
  it('shows cancelled when done with no answers', () => {
    wrap(
      <ToolExecution
        toolName="ask_user"
        args={{ questions: [{ question: 'T', options: ['甲'] }] }}
        result={{ content: [{ type: 'text', text: '用户取消了选择' }] }}
        status="done"
      />,
    );
    expect(screen.getByTestId('ask-user-cancelled')).toBeTruthy();
    expect(screen.queryByTestId('answered-questions-card')).toBeNull();
  });

  it('shows answered card when done with choices', () => {
    wrap(
      <ToolExecution
        toolName="ask_user"
        args={{ questions: [{ question: 'T', options: ['甲', '乙'] }] }}
        result={{ content: [{ type: 'text', text: '[我的选择]\n1. T：乙' }] }}
        status="done"
      />,
    );
    expect(screen.getByTestId('answered-questions-card')).toBeTruthy();
  });
});

describe('ToolExecution ask_user stub', () => {
  afterEach(() => {
    useInlineQuestionStore.setState({ byWorkspace: {} });
  });

  it('shows the pending stub only while a request is in the store', () => {
    useInlineQuestionStore.getState().setRequest({
      workspace: '/ws',
      id: 'u1',
      data: { kind: 'questions', id: 'q1', questions: [] },
    });
    wrap(<ToolExecution toolName="ask_user" args={{}} result={{}} status="running" />);
    expect(screen.getByTestId('ask-user-pending')).toBeTruthy();
    expect(screen.queryByTestId('inline-question')).toBeNull();
  });

  it('hides the stub once the store is cleared', () => {
    wrap(<ToolExecution toolName="ask_user" args={{}} result={{}} status="running" />);
    expect(screen.queryByTestId('ask-user-pending')).toBeNull();
  });

  it('renders nothing on error', () => {
    const { container } = wrap(<ToolExecution toolName="ask_user" args={{}} result={{}} status="error" />);
    expect(screen.queryByTestId('ask-user-pending')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('ToolExecution generate_image card', { timeout: 30_000 }, () => {
  it('still renders generate_image as its own card', () => {
    wrap(
      <ToolExecution
        toolName="generate_image"
        args={{ prompt: '一只在键盘上打字的橘猫，扁平插画' }}
        result={undefined}
        status="running"
      />,
    );
    expect(screen.getByTestId('card-generate_image')).toBeTruthy();
    expect(screen.queryByTestId('card-todo')).toBeNull();
    expect(screen.queryByText('更新任务清单')).toBeNull();
  });
});

describe('ToolExecution todo row', () => {
  it('renders 更新任务清单 without card-todo', () => {
    wrap(
      <ToolExecution
        toolName="todo"
        args={{}}
        result={{
          details: {
            todos: [
              { id: 1, text: '搭骨架', status: 'completed' },
              { id: 2, text: '写组件', status: 'in_progress' },
              { id: 3, text: '跑后台构建', status: 'in_progress' },
              { id: 4, text: '读源码', status: 'in_progress' },
              { id: 5, text: '补测试', status: 'pending' },
            ],
            nextId: 6,
          },
          content: [{ type: 'text', text: '1 pending, 3 in progress, 1 completed' }],
        }}
        status="done"
      />,
    );
    expect(screen.getByText('更新任务清单')).toBeTruthy();
    expect(document.body.textContent).toContain('1/5 已完成');
    expect(document.body.textContent).toContain('写组件');
    expect(document.body.textContent).toContain('+2');
    expect(screen.queryByTestId('card-todo')).toBeNull();
  });

  it('shows 已清空 for an empty successful list', () => {
    wrap(
      <ToolExecution
        toolName="todo"
        args={{}}
        result={{ details: { todos: [], nextId: 1 }, content: [{ type: 'text', text: '0 pending, 0 in progress, 0 completed' }] }}
        status="done"
      />,
    );
    expect(screen.getByText('已清空')).toBeTruthy();
  });

  it('shows error copy when details.error is set even if status is done', () => {
    wrap(
      <ToolExecution
        toolName="todo"
        args={{}}
        result={{
          details: { todos: [], nextId: 1, error: 'text required' },
          content: [{ type: 'text', text: 'Error: text required' }],
        }}
        status="done"
      />,
    );
    expect(screen.getByText('Error: text required')).toBeTruthy();
    expect(document.querySelector('[data-status="error"]')).toBeTruthy();
    expect(screen.queryByText('已清空')).toBeNull();
  });
});

