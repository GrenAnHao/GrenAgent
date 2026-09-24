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
  it('外层显示 description，展开后才看到命令；输出不重复命令', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{
          command: 'Get-Date -Format yyyy-MM-dd',
          description: 'Show current local date',
        }}
        result={{ content: [{ type: 'text', text: '2026-09-16' }] }}
        status="done"
      />,
    );
    expect(screen.getByText('Show current local date')).toBeTruthy();
    expect(screen.getByText('bash')).toBeTruthy();
    expect(screen.queryByText('Get-Date -Format yyyy-MM-dd')).toBeNull();
    expect(screen.queryByTestId('terminal-block')).toBeNull();

    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByTestId('terminal-prompt').textContent).toBe('ws');
    expect(screen.getByTestId('terminal-command').textContent).toBe('Get-Date -Format yyyy-MM-dd');
    const output = screen.getByTestId('terminal-output');
    expect(output.textContent).toBe('2026-09-16');
    expect(output.getAttribute('data-variant')).toBe('terminal');
  });

  it('没有 description 时外层显示「执行命令」，原始命令只在展开卡里', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'Get-Location; Get-ChildItem | Select-Object Mode,Name | Format-Table -AutoSize' }}
        result={{ content: [{ type: 'text', text: 'Path\n----' }] }}
        status="done"
      />,
    );
    expect(screen.getByText('执行命令')).toBeTruthy();
    expect(
      screen.queryByText('Get-Location; Get-ChildItem | Select-Object Mode,Name | Format-Table -AutoSize'),
    ).toBeNull();
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByTestId('terminal-command').textContent).toBe(
      'Get-Location; Get-ChildItem | Select-Object Mode,Name | Format-Table -AutoSize',
    );
  });

  it('运行中自动展开：命令在卡片头，结果流式出现在卡片体', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'Get-ChildItem', description: 'List files in current directory' }}
        result={{ content: [{ type: 'text', text: 'Name    Length\n----    ------' }] }}
        status="running"
      />,
    );
    expect(screen.getByText('List files in current directory')).toBeTruthy();
    expect(screen.getByTestId('terminal-command').textContent).toBe('Get-ChildItem');
    expect(screen.getByTestId('terminal-output').textContent).toBe('Name    Length\n----    ------');
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull();
  });

  it('运行中尚无输出时只显示命令，不占位', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'sleep 5', description: 'Wait five seconds' }}
        result={undefined}
        status="running"
      />,
    );
    expect(screen.getByTestId('terminal-command').textContent).toBe('sleep 5');
    expect(screen.queryByTestId('terminal-output')).toBeNull();
    expect(screen.queryByTestId('terminal-empty')).toBeNull();
  });

  it('完成后无输出显示占位，并可复制已有输出', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'Get-Date', description: 'Show current local date' }}
        result={{ content: [{ type: 'text', text: '2026-09-16 02:07:31 +08:00' }] }}
        status="done"
      />,
    );
    fireEvent.click(screen.getByText('bash'));
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('2026-09-16 02:07:31 +08:00');
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
        args={{
          command: 'pwd && echo "---" && ls -a && echo "---" && date',
          description: 'List directory entries',
        }}
        result={{ content: [{ type: 'text', text }] }}
        status="done"
      />,
    );
    fireEvent.click(screen.getByText('bash'));
    const output = screen.getByTestId('terminal-output').textContent ?? '';
    expect(output).toContain('---');
    expect(output).toMatch(/(^|\n)\.(?:\n|$)/);
    expect(output).toContain('..');
    expect(output).toContain('.pi');
  });

  it('展开 bash 输出按命令行排版，长行可横向滚动', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'Get-ChildItem -Recurse', description: 'List files recursively' }}
        result={{ content: [{ type: 'text', text: 'Name    LastWriteTime\n----    -------------' }] }}
        status="done"
      />,
    );
    fireEvent.click(screen.getByText('bash'));
    const output = screen.getByTestId('terminal-output');
    expect(output.getAttribute('data-variant')).toBe('terminal');
    expect(output.textContent).toBe('Name    LastWriteTime\n----    -------------');
  });
});

describe('ToolExecution edit inspector', { timeout: 30_000 }, () => {
  it('shows the Chinese verb and filename only on the title row', () => {
    wrap(
      <ToolExecution
        toolName="edit"
        args={{ path: 'D:/workspace/GeminiProvider.ts', edits: [{ oldText: 'old', newText: 'new' }] }}
        result={{ details: { diff: ' 1 old\n-2 old\n+2 new\n 3 next' }, content: [] }}
        status="done"
      />,
    );
    expect(screen.getByText('编辑')).toBeTruthy();
    expect(screen.getAllByText('GeminiProvider.ts')).toHaveLength(1);
    expect(screen.getByText('GeminiProvider.ts').nextElementSibling?.textContent).toContain('+1');
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
    fireEvent.click(screen.getByText('编辑'));
    expect(screen.getAllByText('GeminiProvider.ts').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('file-diff-block').getAttribute('data-new-content')).toContain('new');
  });

  it('streams write additions from growing args', () => {
    const { rerender } = wrap(
      <ToolExecution toolName="write" args={{ path: 'a.txt', content: 'a' }} result={{}} status="running" />,
    );
    expect(screen.getByText('写入')).toBeTruthy();
    expect(screen.getByTestId('file-diff-block').getAttribute('data-new-content')).toBe('a\n');
    rerender(
      <ThemeProvider themeMode="dark">
        <ToolExecution toolName="write" args={{ path: 'a.txt', content: 'a\nb' }} result={{}} status="running" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('file-diff-block').getAttribute('data-new-content')).toBe('a\nb\n');
  });

  it('does not show read body while running without result text', () => {
    wrap(<ToolExecution toolName="read" args={{ path: 'a.txt' }} result={{}} status="running" />);
    expect(screen.getByText('读取')).toBeTruthy();
    expect(screen.queryByTestId('file-read-block')).toBeNull();
    expect(document.querySelector('.lucide-chevron-right')).toBeNull();
  });

  it('renders read body after done with filename only on the title', async () => {
    wrap(
      <ToolExecution
        toolName="read"
        args={{ path: 'a.txt' }}
        result={{ content: [{ type: 'text', text: 'hello from file' }] }}
        status="done"
      />,
    );
    expect(screen.getByText('读取')).toBeTruthy();
    expect(screen.getAllByText('a.txt')).toHaveLength(1);
    fireEvent.click(screen.getByText('读取'));
    expect(screen.getByTestId('file-read-block').textContent).toContain('hello from file');
    expect((await screen.findAllByText('a.txt')).length).toBeGreaterThanOrEqual(2);
  });

  it('renders present as a single row', () => {
    wrap(
      <ToolExecution
        toolName="present"
        args={{ files: [{ path: 'a.txt', description: 'demo' }] }}
        result={{ details: { files: [{ path: 'a.txt', description: 'demo' }] } }}
        status="done"
      />,
    );
    expect(screen.getByText('交付文件')).toBeTruthy();
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(screen.queryByTestId('file-diff-block')).toBeNull();
  });

  it('shows present error first line only', () => {
    wrap(
      <ToolExecution
        toolName="present"
        args={{ files: [{ path: 'x.txt', description: 'demo' }] }}
        result={{ content: [{ type: 'text', text: 'Cannot present x: file not found\nmore' }] }}
        status="error"
      />,
    );
    expect(screen.getByText('交付失败')).toBeTruthy();
    expect(screen.getByText('Cannot present x: file not found')).toBeTruthy();
    expect(document.body.textContent).not.toContain('more');
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
    fireEvent.click(screen.getByText('编辑'));
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

