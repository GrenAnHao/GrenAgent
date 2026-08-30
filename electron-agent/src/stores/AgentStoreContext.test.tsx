import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// createAgentStore 会订阅 pi://event，这里 mock 掉，避免触碰 Tauri IPC。
vi.mock('../lib/pi', () => ({
  onPiEvent: () => Promise.resolve(() => {}),
  onPiExit: () => Promise.resolve(() => {}),
}));

import { AgentStoreProvider, useAgentStoreContext } from './AgentStoreContext';
import { agentStoreRegistry } from './agentStoreRegistry';

function ReadyProbe() {
  const { workspaceReady, appBooted } = useAgentStoreContext();
  return (
    <>
      <div data-testid="ready">{String(workspaceReady)}</div>
      <div data-testid="booted">{String(appBooted)}</div>
    </>
  );
}

beforeEach(() => {
  agentStoreRegistry.destroyAll();
});

afterEach(() => {
  cleanup();
  agentStoreRegistry.destroyAll();
});

describe('AgentStoreProvider 全屏 loading gating（切会话不再「刷新」）', () => {
  it('首次打开未常驻 workspace：workspaceReady=false（显示全屏 loading，符合预期）', () => {
    render(
      <AgentStoreProvider workspace="/ws/fresh">
        <ReadyProbe />
      </AgentStoreProvider>,
    );
    expect(screen.getByTestId('ready').textContent).toBe('false');
  });

  it('切到已常驻 workspace：workspaceReady=true（不再全屏 loading，直接展示缓存消息）', () => {
    // 预置：该 workspace 的 store 已常驻（之前打开过、未被 LRU 淘汰）。
    agentStoreRegistry.getOrCreate('/ws/resident');

    render(
      <AgentStoreProvider workspace="/ws/resident">
        <ReadyProbe />
      </AgentStoreProvider>,
    );

    expect(screen.getByTestId('ready').textContent).toBe('true');
  });

  it('从一个对话切到另一个已常驻对话：不被打回 loading', () => {
    agentStoreRegistry.getOrCreate('/ws/b'); // 目标对话已常驻

    const { rerender } = render(
      <AgentStoreProvider workspace="/ws/a">
        <ReadyProbe />
      </AgentStoreProvider>,
    );
    // /ws/a 首次打开：loading
    expect(screen.getByTestId('ready').textContent).toBe('false');

    // 切到已常驻的 /ws/b：应直接 ready，不再全屏 loading
    rerender(
      <AgentStoreProvider workspace="/ws/b">
        <ReadyProbe />
      </AgentStoreProvider>,
    );
    expect(screen.getByTestId('ready').textContent).toBe('true');
  });
});

describe('AgentStoreProvider 冷启动 appBooted（全屏 loading 仅留给首屏）', () => {
  it('冷启动打开未常驻对话：appBooted=false（首屏才全屏 loading）', () => {
    render(
      <AgentStoreProvider workspace="/ws/cold">
        <ReadyProbe />
      </AgentStoreProvider>,
    );
    expect(screen.getByTestId('booted').textContent).toBe('false');
  });

  it('首屏完成后切到未常驻新对话：appBooted 保持 true（不再全屏，仅内容区骨架屏）', () => {
    agentStoreRegistry.getOrCreate('/ws/first'); // 首个对话已常驻 → 渲染即就绪、已 booted

    const { rerender } = render(
      <AgentStoreProvider workspace="/ws/first">
        <ReadyProbe />
      </AgentStoreProvider>,
    );
    expect(screen.getByTestId('booted').textContent).toBe('true');

    rerender(
      <AgentStoreProvider workspace="/ws/brand-new">
        <ReadyProbe />
      </AgentStoreProvider>,
    );
    // 新对话未就绪 → 内容区骨架屏（workspaceReady=false），但不回退到全屏（appBooted 仍 true）
    expect(screen.getByTestId('ready').textContent).toBe('false');
    expect(screen.getByTestId('booted').textContent).toBe('true');
  });
});
