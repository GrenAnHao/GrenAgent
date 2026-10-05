import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('./LazyHighlighter', () => ({
  LazySyntaxHighlighter: (p: { animated?: boolean; language: string; children: string }) => (
    <pre data-animated={String(Boolean(p.animated))} data-language={p.language} data-testid="lazy-syntax">{p.children}</pre>
  ),
  LazyCodeDiff: () => <div data-testid="lazy-code-diff" />,
  LazyHighlighter: (p: { children: string }) => <pre>{p.children}</pre>,
  CodeViewWarmup: () => null,
}));
// 真实实现会动态加载 @pierre/diffs 和 shiki 去逐行追加；这里只关心路由到了哪个视图。
vi.mock('./StreamingCodeView', () => ({
  StreamingCodeView: (p: { path: string; content: string }) => (
    <div data-path={p.path} data-testid="streaming-code-view">{p.content}</div>
  ),
}));
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('ToolExecution code search', { timeout: 30_000 }, () => {
  it('标题展示检索式和命中数，展开后是文件行而不是网页空结果', async () => {
    wrap(
      <ToolExecution
        toolName="search"
        args={{ patterns: ['PddWorkbench', '跑通'] }}
        result={{
          content: [{ type: 'text', text: 'src/a.ts\n  12: export function PddWorkbench\n(1 matches in 1 files)' }],
          details: {
            matches: [{ file: 'src/a.ts', line: 12, text: 'export function PddWorkbench' }],
            total: 1,
            files: 1,
            capped: false,
          },
        }}
        status="done"
      />,
    );
    expect(document.body.textContent).toContain('检索');
    expect(screen.getByText('PddWorkbench | 跑通')).toBeTruthy();
    expect(document.body.textContent).toContain('1 处');
    expect(document.body.textContent).not.toContain('未找到结果');
    expect(screen.queryByTestId('card-code-search')).toBeNull();

    fireEvent.click(screen.getByText('PddWorkbench | 跑通'));
    const card = screen.getByTestId('card-code-search');
    expect(await screen.findByText('a.ts')).toBeTruthy();
    expect(card.textContent).toContain('export function PddWorkbench');
    expect(document.body.textContent).not.toContain('未找到结果');
  });

  it('没有 patterns 时展开显示工具原因', () => {
    wrap(
      <ToolExecution
        toolName="search"
        args={{}}
        result={{
          content: [{ type: 'text', text: 'search: no valid patterns.' }],
          details: { matches: [], total: 0, files: 0, capped: false },
        }}
        status="done"
      />,
    );
    expect(document.body.textContent).not.toContain('搜索：search');
    fireEvent.click(screen.getByText(/检索/, { selector: 'span' }));
    expect(document.body.textContent).toContain('search: no valid patterns.');
    expect(document.body.textContent).not.toContain('未找到结果');
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
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy();
  });

  it('运行中输出变长时贴住底部', () => {
    const { rerender } = wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'ping', description: 'Ping' }}
        result={{ content: [{ type: 'text', text: 'line-1' }] }}
        status="running"
      />,
    );
    const output = screen.getByTestId('terminal-output');
    Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 480 });
    rerender(
      <ThemeProvider themeMode="dark">
        <ToolExecution
          toolName="bash"
          args={{ command: 'ping', description: 'Ping' }}
          result={{ content: [{ type: 'text', text: 'line-1\nline-2' }] }}
          status="running"
        />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('terminal-output').scrollTop).toBe(480);
  });

  it('运行中尚无输出时整张卡已经出现：输出区先占一行，显示等待响应中', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'sleep 5', description: 'Wait five seconds' }}
        result={undefined}
        status="running"
      />,
    );
    expect(screen.getByTestId('terminal-command').textContent).toBe('sleep 5');
    expect(screen.getByTestId('terminal-waiting').textContent).toBe('等待响应中');
    expect(screen.queryByTestId('terminal-output')).toBeNull();
    expect(screen.queryByTestId('terminal-empty')).toBeNull();
  });

  it('pi 先发来的空结果也算等待响应', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'npm run build', description: 'Build' }}
        result={{ content: [] }}
        status="running"
      />,
    );
    expect(screen.getByTestId('terminal-waiting')).toBeTruthy();
  });

  it('第一行输出到来时替换等待占位', () => {
    const props = { toolName: 'bash', args: { command: 'Get-Date', description: 'Show date' }, status: 'running' as const };
    const { rerender } = wrap(<ToolExecution {...props} result={undefined} />);
    expect(screen.getByTestId('terminal-waiting')).toBeTruthy();
    rerender(
      <ThemeProvider themeMode="dark">
        <ToolExecution {...props} result={{ content: [{ type: 'text', text: '2026-09-16' }] }} />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('terminal-waiting')).toBeNull();
    expect(screen.getByTestId('terminal-output').textContent).toBe('2026-09-16');
  });

  it('多行命令在卡片头只占一行，悬停可看全文', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'cd extensions\nnpx vitest run', description: 'Run tests' }}
        result={undefined}
        status="running"
      />,
    );
    const command = screen.getByTestId('terminal-command');
    expect(command.textContent).toBe('cd extensions …');
    expect(command.getAttribute('title')).toBe('cd extensions\nnpx vitest run');
    expect(screen.getAllByTestId('terminal-prompt')).toHaveLength(1);
  });

  it('行尾显示运行时长：运行中随时间自增，完成后定格在记录的耗时', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
    try {
      wrap(
        <ToolExecution
          toolName="bash"
          args={{ command: 'sleep 90', description: 'Wait' }}
          result={undefined}
          status="running"
          startedAt={Date.now()}
        />,
      );
      expect(screen.getByTestId('tool-run-duration').textContent).toBe('· 0s');
      act(() => {
        vi.advanceTimersByTime(80_000);
      });
      expect(screen.getByTestId('tool-run-duration').textContent).toBe('· 1m20s');
    } finally {
      vi.useRealTimers();
    }

    cleanup();
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'sleep 10', description: 'Wait' }}
        result={{ content: [{ type: 'text', text: 'ok' }] }}
        status="done"
        startedAt={1}
        durationMs={9_600}
      />,
    );
    expect(screen.getByTestId('tool-run-duration').textContent).toBe('· 10s');
  });

  it('没有计时数据的 bash 行不显示时长', () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'ls', description: 'List' }}
        result={{ content: [{ type: 'text', text: 'a' }] }}
        status="done"
      />,
    );
    expect(screen.queryByTestId('tool-run-duration')).toBeNull();
  });

  it('复制按钮弹出菜单：复制命令 / 复制结果 / 复制全部', async () => {
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
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['复制命令', '复制结果', '复制全部']);

    fireEvent.click(screen.getByRole('menuitem', { name: '复制命令' }));
    expect(writeText).toHaveBeenLastCalledWith('Get-Date');

    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '复制结果' }));
    expect(writeText).toHaveBeenLastCalledWith('2026-09-16 02:07:31 +08:00');

    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '复制全部' }));
    expect(writeText).toHaveBeenLastCalledWith('$ Get-Date\n2026-09-16 02:07:31 +08:00');
  });

  it('还没有输出时复制结果不可用，复制命令仍可用', async () => {
    wrap(
      <ToolExecution
        toolName="bash"
        args={{ command: 'sleep 5', description: 'Wait' }}
        result={undefined}
        status="running"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect((await screen.findByRole('menuitem', { name: '复制结果' })).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: '复制命令' }).getAttribute('aria-disabled')).not.toBe('true');
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

describe('ToolExecution default expansion', () => {
  it('写入和编辑运行中默认收起', () => {
    wrap(
      <ToolExecution toolName="write" args={{ path: 'a.txt', content: 'hello' }} result={{}} status="running" />,
    );
    expect(screen.queryByTestId('file-diff-block')).toBeNull();
    cleanup();
    wrap(
      <ToolExecution
        toolName="edit"
        args={{ path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }}
        result={{}}
        status="running"
      />,
    );
    expect(screen.queryByTestId('file-diff-block')).toBeNull();
    expect(screen.queryByTestId('streaming-file-body')).toBeNull();
  });

  it('检索类工具运行中默认收起，点开后才看到结果', () => {
    wrap(
      <ToolExecution
        toolName="grep"
        args={{ pattern: 'foo' }}
        result={{ content: [{ type: 'text', text: 'Found 1 match\nsrc/a.ts:\n  Line 1: foo' }] }}
        status="running"
      />,
    );
    expect(screen.queryByTestId('card-grep')).toBeNull();
    fireEvent.click(screen.getByText(/检索/));
    expect(screen.getByTestId('card-grep')).toBeTruthy();
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
    expect(screen.queryByTestId('file-diff-block')).toBeNull();
    fireEvent.click(screen.getByText('写入'));
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

  it('renders the image when a read result contains image bytes', () => {
    wrap(
      <ToolExecution
        toolName="read"
        args={{ path: 'shots/kiro-1-expanded.png' }}
        result={{
          content: [
            { type: 'text', text: 'Read image file [image/png]\n[Image: original 2x2, displayed at 2x2.]' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
        }}
        status="done"
      />,
    );
    expect(screen.queryByTestId('file-read-image')).toBeNull();
    fireEvent.click(screen.getByText('读取'));
    const img = screen.getByTestId('file-read-image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(img.getAttribute('alt')).toBe('kiro-1-expanded.png');
    expect(screen.queryByText(/Read image file/)).toBeNull();
    expect(screen.queryByTestId('file-read-block')).toBeNull();
  });

  it('shows the read line range on the row', () => {
    wrap(
      <ToolExecution
        toolName="read"
        args={{ path: 'src/CodeCollector.ts', offset: 12, limit: 20 }}
        result={{ content: [{ type: 'text', text: 'line' }] }}
        status="done"
      />,
    );
    expect(screen.getByText('CodeCollector.ts · 12-31')).toBeTruthy();
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
      mode: 'live',
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

describe('ToolExecution 参数生成', () => {
  const growWrite = (content: string, argsComplete = false) => (
    <ThemeProvider themeMode="dark">
      <ToolExecution
        toolName="write"
        args={{ path: 'notes/a.html', content }}
        result={undefined}
        status="running"
        argsComplete={argsComplete}
      />
    </ThemeProvider>
  );

  it('write 生成中只做代码高亮，完成后才换成 diff', () => {
    const { rerender } = render(growWrite('hello'));
    fireEvent.click(screen.getByText('写入'));
    // 写入全是新增行，生成阶段不上 diff。
    expect(screen.queryByTestId('streaming-file-body')).toBeNull();
    expect(screen.queryByTestId('file-diff-block')).toBeNull();
    expect(screen.getByTestId('streaming-code-view').textContent).toContain('hello');
    expect(document.body.textContent).toContain('a.html');
    expect(document.body.textContent).toContain('生成中 · 1 行');
    rerender(growWrite('hello\nworld'));
    expect(document.body.textContent).toContain('生成中 · 2 行');
    expect(screen.getByTestId('streaming-code-view').textContent).toContain('world');
    rerender(growWrite('hello\nworld', true));
    expect(screen.queryByTestId('streaming-code-view')).toBeNull();
    expect(screen.getByTestId('file-diff-block').getAttribute('data-new-content')).toContain('world');
  });

  it('write 生成中全程复用同一个高亮视图，不按字符数重挂', () => {
    const chunk = (c: string) => `${c.repeat(700)}\n`;
    const { rerender } = render(growWrite(chunk('a')));
    fireEvent.click(screen.getByText('写入'));
    const view = screen.getByTestId('streaming-code-view');
    rerender(growWrite(chunk('a') + chunk('b')));
    rerender(growWrite(chunk('a') + chunk('b') + chunk('c')));
    expect(screen.getByTestId('streaming-code-view')).toBe(view);
  });

  it('write 超出高亮预算时退回纯文本预览', () => {
    render(growWrite(`${'x'.repeat(200 * 1024)}\n`));
    fireEvent.click(screen.getByText('写入'));
    expect(screen.queryByTestId('streaming-code-view')).toBeNull();
    expect(screen.getByTestId('streaming-file-body').textContent).toContain('已接收');
  });

  it('edit 参数生成中显示删除块，行数随新文本变长', () => {
    const edit = (newText?: string) => (
      <ThemeProvider themeMode="dark">
        <ToolExecution
          toolName="edit"
          args={{ path: 'a.ts', edits: [{ oldText: 'before', ...(newText === undefined ? {} : { newText }) }] }}
          result={undefined}
          status="running"
          argsComplete={false}
        />
      </ThemeProvider>
    );
    const { rerender } = render(edit());
    fireEvent.click(screen.getByText('编辑'));
    expect(screen.getByTestId('streaming-file-body').querySelector('[data-kind="old"]')?.textContent).toContain('before');
    expect(document.body.textContent).toContain('生成中 · -1');
    rerender(edit('after\nmore'));
    expect(document.body.textContent).toContain('生成中 · +2 -1');
    expect(screen.getByTestId('streaming-file-body').querySelector('[data-kind="new"]')?.textContent).toContain('more');
  });

  it('空参数不抛错', () => {
    expect(() => wrap(
      <ToolExecution toolName="write" args={{}} result={undefined} status="running" argsComplete={false} />,
    )).not.toThrow();
    expect(screen.queryByTestId('streaming-file-body')).toBeNull();
    fireEvent.click(screen.getByText('写入'));
    expect(screen.getByTestId('streaming-file-body').textContent).toContain('等待参数');
  });
});

