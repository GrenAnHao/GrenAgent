import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderExtensionCard } from './extensionCards';

const openPath = vi.fn();
const revealItemInDir = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: (p: string) => {
    openPath(p);
    return Promise.resolve();
  },
  revealItemInDir: (p: string) => {
    revealItemInDir(p);
    return Promise.resolve();
  },
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/proj' }),
}));

afterEach(() => {
  cleanup();
  openPath.mockReset();
  revealItemInDir.mockReset();
});

function renderCard(
  toolName: string,
  result: unknown,
  args: unknown = {},
  status: 'running' | 'done' | 'error' = 'done',
) {
  const node = renderExtensionCard({ toolName, args, result, status });
  return render(<>{node}</>);
}

// @lobehub/ui（LazyMarkdown 等）首渲较重，并发跑时给足超时，避免默认 5s 抖动。
describe('renderExtensionCard', { timeout: 30_000 }, () => {
  it('returns null for unknown tools', () => {
    expect(renderExtensionCard({ toolName: 'bash', args: {}, result: {}, status: 'done' })).toBeNull();
  });

  it('does not render cards for removed legacy memory or knowledge tools', () => {
    for (const toolName of ['kb_search', 'kb_add', 'memory_save', 'memory_recall']) {
      expect(renderExtensionCard({ toolName, args: {}, result: {}, status: 'done' })).toBeNull();
    }
  });

  it('generate_image shows filename in tooltip and reveals file on click', () => {
    renderCard('generate_image', { content: [], details: { path: '/proj/.pi/images/img_42.png', model: 'gpt-image-1', size: '1024x1024' } });
    // 文件名现在收进 hover tooltip（title 属性），标题展示提示词/占位。
    expect(screen.getByTitle('img_42.png')).toBeTruthy();
    fireEvent.click(screen.getByTestId('reveal-file-generate_image'));
    expect(revealItemInDir).toHaveBeenCalledWith('/proj/.pi/images/img_42.png');
  });

  it('spawn_agent shows sub-agent count', () => {
    renderCard('spawn_agent', { content: [{ type: 'text', text: 'out' }], details: { count: 3, failed: 1 } });
    expect(screen.getByTestId('card-spawn_agent').textContent).toContain('3');
  });

  it('fetch_url shows the url', () => {
    renderCard('fetch_url', { content: [{ type: 'text', text: '# Title' }], details: { url: 'https://x.dev', status: 200 } });
    expect(screen.getByText('https://x.dev')).toBeTruthy();
  });

  it('speak reveals the audio file on click', () => {
    renderCard('speak', { content: [], details: { path: '/proj/.pi/audio/speech_1.mp3', voice: 'alloy', format: 'mp3' } });
    fireEvent.click(screen.getByTestId('reveal-file-speak'));
    expect(revealItemInDir).toHaveBeenCalledWith('/proj/.pi/audio/speech_1.mp3');
  });

  it('todo shows progress and items', () => {
    renderCard('todo', {
      content: [{ type: 'text', text: 'Added todo #1: write tests' }],
      details: {
        action: 'add',
        nextId: 3,
        todos: [
          { id: 1, text: 'write tests', done: true },
          { id: 2, text: 'ship it', done: false },
        ],
      },
    });
    expect(screen.getByTestId('card-todo')).toBeTruthy();
    expect(screen.getByText('待办')).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(screen.getByText(/write tests/)).toBeTruthy();
    expect(screen.getByText(/ship it/)).toBeTruthy();
  });

  it('todo collapses to a single bar when cleared', () => {
    renderCard('todo', {
      content: [{ type: 'text', text: 'Cleared 5 todos' }],
      details: { action: 'clear', todos: [] },
    });
    expect(screen.getByTestId('card-todo')).toBeTruthy();
    expect(screen.getByText('待办')).toBeTruthy();
    // 兜底文本进入 header 右侧 count 位置，而非底部单独一行。
    expect(screen.getByText('Cleared 5 todos')).toBeTruthy();
    expect(screen.queryByText('暂无待办')).toBeNull();
  });

  it('web_search shows result count and links', () => {
    renderCard('web_search', {
      content: [{ type: 'text', text: 'summary' }],
      details: {
        provider: 'tavily',
        query: 'pi',
        count: 2,
        results: [
          { title: 'Result One', url: 'https://one.dev', snippet: 's1' },
          { title: 'Result Two', url: 'https://two.dev', snippet: 's2' },
        ],
      },
    });
    expect(screen.getByTestId('card-web_search')).toBeTruthy();
    // 结果卡默认折叠，点 header 展开后才渲染结果链接。
    fireEvent.click(screen.getByTestId('card-web_search-toggle'));
    expect(screen.getByText('Result One')).toBeTruthy();
    expect(screen.getByText('Result Two')).toBeTruthy();
    // 结果卡显示 host（去 www），而非完整 URL。
    expect(screen.getByText('one.dev')).toBeTruthy();
  });
});
