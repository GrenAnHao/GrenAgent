import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { ContextToolGroup } from './ContextToolGroup';
import type { ToolSegment } from '../chat/groupMessages';
import { AgentStoreContext } from '../../stores/AgentStoreContext';
import { useSessionStore } from '../../store/session';
import { resetSessionViewStateForTests } from '../../stores/sessionViewStateStore';

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  resetSessionViewStateForTests();
  useSessionStore.setState({ activeSessionPath: null, draftConversationCwd: null, draftConversationId: null });
});

const wrap = (ui: React.ReactElement, sessionPath: string | null = '/ws/.pi/a.jsonl') =>
  render(
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

const tool = (
  id: string,
  toolName: string,
  status: 'running' | 'done' | 'error' = 'done',
): ToolSegment => ({
  kind: 'tool',
  id,
  toolCallId: `c-${id}`,
  toolName,
  args: {},
  result: {},
  status,
});

describe('ContextToolGroup 展开状态', { timeout: 30_000 }, () => {
  const group = () => <ContextToolGroup tools={[tool('same-call', 'read'), tool('b', 'ls')]} />;
  const isOpen = () => document.querySelector('.accordion-content') as HTMLElement;

  it('会话 A 展开：切到 B 收起，回到 A 恢复', () => {
    const first = wrap(group());
    expect(isOpen().style.display).toBe('none');
    fireEvent.click(screen.getByText(/已收集上下文/));
    expect(isOpen().style.display).toBe('block');
    first.unmount();

    const inB = wrap(group(), '/ws/.pi/b.jsonl');
    expect(isOpen().style.display).toBe('none');
    inB.unmount();

    wrap(group());
    expect(isOpen().style.display).toBe('block');
  });

  it('卸载重挂后从会话视图状态恢复', () => {
    const first = wrap(group());
    fireEvent.click(screen.getByText(/已收集上下文/));
    first.unmount();
    wrap(group());
    expect(isOpen().style.display).toBe('block');
  });

  it('没有会话身份时不写全局 key（不因同 workspace 共享）', () => {
    const first = wrap(group(), null);
    fireEvent.click(screen.getByText(/已收集上下文/));
    expect(isOpen().style.display).toBe('block');
    first.unmount();
    // 另一份无身份视图不继承。
    wrap(group(), null);
    expect(isOpen().style.display).toBe('none');
    expect(localStorage.getItem('pi-session-view-state')).toBeNull();
  });
});

describe('ContextToolGroup', { timeout: 30_000 }, () => {
  it('完成态：显示「已收集上下文」+ 分类计数', () => {
    const { container } = wrap(
      <ContextToolGroup tools={[tool('a', 'read'), tool('b', 'read_file'), tool('c', 'ls')]} />,
    );
    expect(container.textContent).toContain('已收集上下文');
    expect(container.textContent).toContain('2 个文件');
    expect(container.textContent).toContain('1 个目录');
  });

  it('运行中：显示 shimmer 进度（done/total）', () => {
    const { container } = wrap(
      <ContextToolGroup tools={[tool('a', 'read', 'done'), tool('b', 'list_dir', 'running')]} />,
    );
    expect(container.textContent).toContain('正在收集上下文');
    expect(container.textContent).toContain('1/2');
  });

  it('部分失败：显示计数 + 失败数（不整组标红）', () => {
    const { container } = wrap(
      <ContextToolGroup tools={[tool('a', 'read', 'done'), tool('b', 'ls', 'error')]} />,
    );
    expect(container.textContent).toContain('已收集上下文');
    expect(container.textContent).toContain('1 个失败');
  });

  it('全部失败：显示「收集上下文失败」', () => {
    const { container } = wrap(
      <ContextToolGroup tools={[tool('a', 'read', 'error'), tool('b', 'ls', 'error')]} />,
    );
    expect(container.textContent).toContain('收集上下文失败');
  });
});
