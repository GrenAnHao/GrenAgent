import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderExtensionCard } from './extensionCards';

const openPath = vi.fn();
const revealItemInDir = vi.fn();
vi.mock('../../platform/runtime', () => ({
  openPath: (p: string) => {
    openPath(p);
    return Promise.resolve();
  },
  revealItemInDir: (p: string) => {
    revealItemInDir(p);
    return Promise.resolve();
  },
  invoke: () => Promise.reject(new Error('no ipc')),
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
  it('add_mcp_server shows the parsed config and the tool response', () => {
    renderCard(
      'add_mcp_server',
      {
        content: [{ type: 'text', text: '已添加 MCP anysearch' }],
        details: {
          status: 'saved',
          path: '/home/.pi/agent/mcp.json',
          connection: 'connected',
          tools: ['mcp__anysearch__search'],
          response: '已添加 MCP anysearch',
          parsed: {
            name: 'anysearch',
            transport: 'http',
            url: 'https://api.anysearch.com/mcp',
            headers: { Authorization: 'Bearer ${ANYSEARCH_API_KEY}' },
            dropped: { command: 'npx', env: { ANYSEARCH_API_KEY: '[REDACTED]' } },
          },
        },
      },
      { name: 'anysearch', transport: 'sse', command: 'npx' },
    );
    const card = screen.getByTestId('card-add_mcp_server');
    expect(card.textContent).toContain('参数');
    expect(card.textContent).toContain('响应');
    expect(card.textContent).toContain('https://api.anysearch.com/mcp');
    expect(card.textContent).toContain('Bearer ${ANYSEARCH_API_KEY}');
    expect(card.textContent).toContain('dropped');
    expect(card.textContent).toContain('mcp__anysearch__search');
    expect(card.textContent).toContain('已添加 MCP anysearch');
  });

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

  it('web_search shows result count and links', () => {
    renderCard('web_search', {
      content: [{ type: 'text', text: 'summary' }],
      details: {
        provider: 'bing',
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

  it('anysearch_search reuses the search card and shows the anysearch provider', () => {
    renderCard('anysearch_search', {
      content: [{ type: 'text', text: 'summary' }],
      details: {
        query: 'go 1.26',
        provider: 'anysearch',
        count: 1,
        results: [{ title: 'Go 1.26 Release Notes', url: 'https://go.dev/doc/go1.26', snippet: 'notes' }],
      },
    });
    expect(screen.getByTestId('card-web_search-toggle').textContent).toContain('anysearch');
    fireEvent.click(screen.getByTestId('card-web_search-toggle'));
    expect(screen.getByText('Go 1.26 Release Notes')).toBeTruthy();
  });

  it('does not paint local code search as a web result card', () => {
    expect(
      renderExtensionCard({
        toolName: 'search',
        args: { patterns: ['PddWorkbench'] },
        result: {
          details: {
            matches: [{ file: 'src/a.ts', line: 12, text: 'export function PddWorkbench' }],
            total: 1,
            files: 1,
            capped: false,
          },
        },
        status: 'done',
      }),
    ).toBeNull();
  });
});
