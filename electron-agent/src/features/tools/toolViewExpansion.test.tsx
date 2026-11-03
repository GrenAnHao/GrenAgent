import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { AgentStoreContext } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import { resetSessionViewStateForTests, useSessionViewStateStore } from '../../stores/sessionViewStateStore';
import { ToolExecution } from './ToolExecution';
import { ReasoningInline } from '../chat/ReasoningInline';

vi.mock('./LazyHighlighter', () => ({
  LazySyntaxHighlighter: (p: { children: string }) => <pre>{p.children}</pre>,
  LazyCodeDiff: () => <div />,
  LazyHighlighter: (p: { children: string }) => <pre>{p.children}</pre>,
  CodeViewWarmup: () => null,
}));
vi.mock('../chat/LazyMarkdown', () => ({
  LazyMarkdown: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));

const A = '/ws/.pi/a.jsonl';
const B = '/ws/.pi/b.jsonl';
const OUT = 'line 1\nline 2';

beforeEach(() => {
  localStorage.clear();
  resetSessionViewStateForTests();
  useSessionStore.setState({
    activeSessionPath: A,
    activeWorkspace: '/ws',
    draftConversationCwd: null,
    draftConversationId: null,
  });
});

afterEach(cleanup);

function mount(ui: React.ReactElement, sessionPath: string | null = A) {
  return render(
    <ThemeProvider themeMode="dark">
      <AgentStoreContext.Provider
        value={{
          workspace: '/ws',
          store: {} as never,
          workspaceReady: true,
          setWorkspaceReady: () => {},
          appBooted: true,
          sessionPath,
          draftId: null,
        }}
      >
        {ui}
      </AgentStoreContext.Provider>
    </ThemeProvider>,
  );
}

const bashTool = (toolCallId: string) => (
  <ToolExecution
    toolName="bash"
    toolCallId={toolCallId}
    args={{ command: 'npm test', description: 'Run unit tests' }}
    result={{ content: [{ type: 'text', text: OUT }] }}
    status="done"
  />
);

describe('ToolExecution 展开状态按会话持久化', () => {
  it('A 展开工具卡 → B 收起 → 回到 A 恢复，同一 toolCallId 不串', () => {
    const first = mount(bashTool('same-call'));
    fireEvent.click(screen.getByText('bash'));
    expect(useSessionViewStateStore.getState().isExpanded(A, 'tool:same-call')).toBe(true);
    expect(screen.getByTestId('terminal-output').textContent).toBe(OUT);
    first.unmount();

    mount(bashTool('same-call'), B);
    expect(useSessionViewStateStore.getState().isExpanded(B, 'tool:same-call')).toBeUndefined();
    expect(screen.queryByTestId('terminal-output')).toBeNull();
    cleanup();

    mount(bashTool('same-call'));
    expect(screen.getByTestId('terminal-output').textContent).toBe(OUT);
  });

  it('运行中自动展开保留；用户关掉后重挂、结果继续追加也不会自己打开', () => {
    const props = { toolName: 'bash', toolCallId: 'bash-1', args: { command: 'npm test' } };
    const first = mount(<ToolExecution {...props} result={undefined} status="running" />);
    // 运行中命令行默认展开（既有语义）。
    expect(screen.getByTestId('terminal-block')).toBeTruthy();
    fireEvent.click(screen.getByText('bash'));
    expect(screen.queryByTestId('terminal-block')).toBeNull();
    first.unmount();

    mount(
      <ToolExecution
        {...props}
        result={{ content: [{ type: 'text', text: 'still running\nmore output' }] }}
        status="running"
      />,
    );
    expect(screen.queryByTestId('terminal-block')).toBeNull();
    expect(useSessionViewStateStore.getState().isExpanded(A, 'tool:bash-1')).toBe(false);
  });
});

describe('展开 setter 只写 boolean（functional updater 兼容）', () => {
  it('真实组件点击后 store 里是布尔值，不是函数', () => {
    mount(bashTool('fn-1'));
    fireEvent.click(screen.getByText('bash'));
    const stored = useSessionViewStateStore.getState().isExpanded(A, 'tool:fn-1');
    expect(typeof stored).toBe('boolean');
    expect(stored).toBe(true);
  });

  it('真实推理卡点击后 store 里是布尔值，不是函数', () => {
    mount(<ReasoningInline content="推理正文" streaming={false} durationMs={1200} viewId="thinking:fn" />);
    fireEvent.click(screen.getByRole('button'));
    const stored = useSessionViewStateStore.getState().isExpanded(A, 'thinking:fn');
    expect(typeof stored).toBe('boolean');
    expect(stored).toBe(true);
  });
});

describe('ReasoningInline 展开状态按会话持久化', () => {
  const reasoning = (viewId: string, content = '推理正文', streaming = false) => (
    <ReasoningInline content={content} streaming={streaming} durationMs={streaming ? undefined : 3200} viewId={viewId} />
  );

  it('结束后展开正文 → 重挂/会话恢复仍展开；B 不受影响', () => {
    const first = mount(reasoning('thinking:101'));
    expect(screen.queryByTestId('md')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('md').textContent).toBe('推理正文');
    first.unmount();

    mount(reasoning('thinking:101'), B);
    expect(screen.queryByTestId('md')).toBeNull();
    cleanup();

    mount(reasoning('thinking:101'));
    expect(screen.getByTestId('md').textContent).toBe('推理正文');
  });

  it('流式追加不把用户关掉的正文重新打开', () => {
    const { rerender } = mount(reasoning('thinking:202', '第一段', true));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('reasoning-stream-body')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('reasoning-stream-body')).toBeNull();

    const wrapped = reasoning('thinking:202', '第一段\n第二段', true);
    rerender(
      <ThemeProvider themeMode="dark">
        <AgentStoreContext.Provider
          value={{
            workspace: '/ws',
            store: {} as never,
            workspaceReady: true,
            setWorkspaceReady: () => {},
            appBooted: true,
            sessionPath: A,
            draftId: null,
          }}
        >
          {wrapped}
        </AgentStoreContext.Provider>
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('reasoning-stream-body')).toBeNull();
  });
});
