import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef, type RefObject } from 'react';

const { setValue, abortEnhancePrompt, agent, MockAgent } = vi.hoisted(() => {
  const { createContext } = require('react') as typeof import('react');
  return {
    setValue: vi.fn(),
    abortEnhancePrompt: vi.fn(() => Promise.resolve()),
    agent: { workspace: '/ws' },
    MockAgent: createContext({ workspace: '/ws' }),
  };
});

vi.mock('../../../lib/pi', () => ({
  pi: { abortEnhancePrompt },
}));
vi.mock('../../../stores/AgentStoreContext', () => {
  const { useContext } = require('react') as typeof import('react');
  return {
    useAgentStoreContext: () => useContext(MockAgent),
    useAgentStore: () => ({
      useStore: { setState: () => undefined },
    }),
  };
});
vi.mock('./ChatInputContext', () => ({
  useChatInput: () => ({ setValue }),
}));

import { EnhancePromptOverlay } from './EnhancePromptOverlay';
import { useEnhancePromptStore } from '../../../stores/enhancePromptStore';

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

afterEach(() => {
  cleanup();
  useEnhancePromptStore.setState({ byWorkspace: {} });
});

function overlayTree(anchorRef: RefObject<HTMLDivElement | null>) {
  return (
    <MockAgent.Provider value={{ workspace: agent.workspace }}>
      <div data-chat-column="">
        <div
          ref={anchorRef}
          data-testid="composer-surface"
          style={{ width: 400, height: 80 }}
        />
        <EnhancePromptOverlay anchorRef={anchorRef} />
      </div>
    </MockAgent.Provider>
  );
}

function renderOverlay() {
  const anchorRef = createRef<HTMLDivElement>();
  const view = render(overlayTree(anchorRef));
  return {
    ...view,
    rerenderOverlay: () => view.rerender(overlayTree(anchorRef)),
  };
}

describe('EnhancePromptOverlay', () => {
  // 本浮层只 setValue，粘贴块由 ChatInput 状态保持，不断言 chips。
  let rectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    agent.workspace = '/ws';
    setValue.mockClear();
    abortEnhancePrompt.mockClear();
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 400, left: 20, width: 480, height: 80, bottom: 480, right: 500, x: 20, y: 400, toJSON() {},
    } as DOMRect);
  });
  afterEach(() => {
    rectSpy?.mockRestore();
  });

  it('idle 不 portal', () => {
    renderOverlay();
    expect(screen.queryByTestId('enhance-prompt-overlay')).toBeNull();
  });

  it('idle 墓碑不 portal', () => {
    useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    useEnhancePromptStore.getState().clear('/ws');
    renderOverlay();
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']?.status).toBe('idle');
    expect(screen.queryByTestId('enhance-prompt-overlay')).toBeNull();
  });

  it('delta 追加；应用调用 setValue', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    renderOverlay();
    act(() => {
      useEnhancePromptStore.getState().append('/ws', seq, '美化');
    });
    expect(screen.getByTestId('enhance-prompt-preview').textContent).toContain('美化');
    fireEvent.click(screen.getByTestId('enhance-prompt-apply'));
    expect(setValue).toHaveBeenCalledWith('美化');
    expect(abortEnhancePrompt).toHaveBeenCalledWith('/ws');
  });

  it('取消不调用 setValue 且 abort', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    renderOverlay();
    act(() => {
      useEnhancePromptStore.getState().append('/ws', seq, '美化');
    });
    fireEvent.click(screen.getByTestId('enhance-prompt-cancel'));
    expect(setValue).not.toHaveBeenCalled();
    expect(abortEnhancePrompt).toHaveBeenCalledWith('/ws');
    expect(screen.queryByTestId('enhance-prompt-overlay')).toBeNull();
  });

  it('关闭 X abort 且不 setValue', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    renderOverlay();
    act(() => {
      useEnhancePromptStore.getState().append('/ws', seq, '美化');
    });
    fireEvent.click(screen.getByTestId('enhance-prompt-close'));
    expect(setValue).not.toHaveBeenCalled();
    expect(abortEnhancePrompt).toHaveBeenCalledWith('/ws');
    expect(screen.queryByTestId('enhance-prompt-overlay')).toBeNull();
  });

  it('Esc capture 等同取消', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    renderOverlay();
    act(() => {
      useEnhancePromptStore.getState().append('/ws', seq, '美化');
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(setValue).not.toHaveBeenCalled();
    expect(abortEnhancePrompt).toHaveBeenCalledWith('/ws');
    expect(screen.queryByTestId('enhance-prompt-overlay')).toBeNull();
  });

  it('awaitingContext 显示正在结合项目上下文…，首包后生成中', () => {
    useEnhancePromptStore.getState().start('/ws', { awaitingContext: true, source: '原文' });
    renderOverlay();
    expect(screen.getByTestId('enhance-prompt-status').textContent).toContain('正在结合项目上下文');
    act(() => {
      useEnhancePromptStore.getState().append(
        '/ws',
        useEnhancePromptStore.getState().byWorkspace['/ws'].seq,
        'x',
      );
    });
    expect(screen.getByTestId('enhance-prompt-status').textContent).toContain('生成中');
  });

  it('首包未到显示等待模型响应，error 显示失败', () => {
    useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    renderOverlay();
    expect(screen.getByTestId('enhance-prompt-status').textContent).toContain('等待模型响应');
    act(() => {
      useEnhancePromptStore.getState().fail(
        '/ws',
        useEnhancePromptStore.getState().byWorkspace['/ws'].seq,
        '增强超时，请重试',
      );
    });
    expect(screen.getByTestId('enhance-prompt-status').textContent).toContain('失败');
    expect(screen.getByTestId('enhance-prompt-error').textContent).toContain('增强超时，请重试');
  });

  it('error 或 preview 空时应用禁用；生成中且预览非空可应用', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    renderOverlay();
    expect(screen.getByTestId('enhance-prompt-apply')).toBeDisabled();

    act(() => {
      useEnhancePromptStore.getState().append('/ws', seq, '美化');
    });
    expect(screen.getByTestId('enhance-prompt-apply')).not.toBeDisabled();

    act(() => {
      useEnhancePromptStore.getState().fail('/ws', seq, '模型不可用');
    });
    expect(screen.getByTestId('enhance-prompt-apply')).toBeDisabled();
  });

  it('失败时错误一行在按钮上方；预览优先 preview，空则 source', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    renderOverlay();
    act(() => {
      useEnhancePromptStore.getState().fail('/ws', seq, '模型不可用');
    });
    expect(screen.getByTestId('enhance-prompt-error').textContent).toContain('模型不可用');
    expect(screen.getByTestId('enhance-prompt-preview').textContent).toContain('原文');

    const error = screen.getByTestId('enhance-prompt-error');
    const apply = screen.getByTestId('enhance-prompt-apply');
    expect(error.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('失败且已有 preview 时预览用 preview 不用 source', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    renderOverlay();
    act(() => {
      useEnhancePromptStore.getState().append('/ws', seq, '半成品');
      useEnhancePromptStore.getState().fail('/ws', seq, '中断');
    });
    expect(screen.getByTestId('enhance-prompt-preview').textContent).toContain('半成品');
    expect(screen.getByTestId('enhance-prompt-preview').textContent).not.toContain('原文');
  });

  it('切工作区 abort 并 clear 上一个 workspace', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    const view = renderOverlay();
    act(() => {
      useEnhancePromptStore.getState().append('/ws', seq, '美化');
    });
    expect(screen.getByTestId('enhance-prompt-overlay')).toBeTruthy();

    agent.workspace = '/other';
    view.rerenderOverlay();

    expect(abortEnhancePrompt).toHaveBeenCalledWith('/ws');
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']?.status).toBe('idle');
  });

  it('卸载 abort 并 clear 当前 workspace', () => {
    const seq = useEnhancePromptStore.getState().start('/ws', { source: '原文' });
    const view = renderOverlay();
    act(() => {
      useEnhancePromptStore.getState().append('/ws', seq, '美化');
    });
    view.unmount();
    expect(setValue).not.toHaveBeenCalled();
    expect(abortEnhancePrompt).toHaveBeenCalledWith('/ws');
    expect(useEnhancePromptStore.getState().byWorkspace['/ws']?.status).toBe('idle');
  });

  // 主进程的 enhance_prompt_abort 要求 workspace 非空，启动时还没选项目就是空串。
  it('workspace 为空时卸载不 abort', () => {
    agent.workspace = '';
    const view = renderOverlay();
    view.unmount();
    expect(abortEnhancePrompt).not.toHaveBeenCalled();
  });

  it('从空 workspace 切到真实 workspace 不 abort 空串', () => {
    agent.workspace = '';
    const view = renderOverlay();

    agent.workspace = '/ws';
    view.rerenderOverlay();

    expect(abortEnhancePrompt).not.toHaveBeenCalled();
  });
});
