import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderExtensionCard } from './extensionCards';

const openPath = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: (p: string) => openPath(p) }));

afterEach(() => {
  cleanup();
  openPath.mockReset();
});

function renderCard(toolName: string, result: unknown, args: unknown = {}) {
  const node = renderExtensionCard({ toolName, args, result, status: 'done' });
  return render(<>{node}</>);
}

// @lobehub/ui（LazyMarkdown 等）首渲较重，并发跑时给足超时，避免默认 5s 抖动。
describe('renderExtensionCard', { timeout: 30_000 }, () => {
  it('returns null for unknown tools', () => {
    expect(renderExtensionCard({ toolName: 'bash', args: {}, result: {}, status: 'done' })).toBeNull();
  });

  it('kb_search shows hit sources and scores', () => {
    renderCard('kb_search', { content: [{ type: 'text', text: 'body' }], details: { mode: 'semantic', hits: [{ source: 'spec.md', score: 0.91 }] } });
    expect(screen.getByTestId('card-kb_search')).toBeTruthy();
    expect(screen.getByText(/spec\.md/)).toBeTruthy();
  });

  it('kb_add shows indexed source and chunk count', () => {
    renderCard('kb_add', { content: [], details: { source: 'notes.md', chunks: 7, embedded: true } });
    const card = screen.getByTestId('card-kb_add');
    expect(card.textContent).toContain('notes.md');
    expect(card.textContent).toContain('7');
  });

  it('memory_save shows scope', () => {
    renderCard('memory_save', { content: [], details: { id: 'm1', scope: 'global', category: 'preference' } });
    expect(screen.getByTestId('card-memory_save').textContent).toContain('全局');
  });

  it('memory_recall renders recall card', () => {
    renderCard('memory_recall', { content: [{ type: 'text', text: 'mem body' }], details: { hits: [{ id: 'm1', scope: 'project', score: 0.8 }] } });
    expect(screen.getByTestId('card-memory_recall')).toBeTruthy();
  });

  it('generate_image shows filename and opens file on click', () => {
    renderCard('generate_image', { content: [], details: { path: '/proj/.pi/images/img_42.png', model: 'gpt-image-1', size: '1024x1024' } });
    expect(screen.getByText(/img_42\.png/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('open-file-generate_image'));
    expect(openPath).toHaveBeenCalledWith('/proj/.pi/images/img_42.png');
  });

  it('spawn_agent shows sub-agent count', () => {
    renderCard('spawn_agent', { content: [{ type: 'text', text: 'out' }], details: { count: 3, failed: 1 } });
    expect(screen.getByTestId('card-spawn_agent').textContent).toContain('3');
  });

  it('fetch_url shows the url', () => {
    renderCard('fetch_url', { content: [{ type: 'text', text: '# Title' }], details: { url: 'https://x.dev', status: 200 } });
    expect(screen.getByText('https://x.dev')).toBeTruthy();
  });

  it('speak opens the audio file on click', () => {
    renderCard('speak', { content: [], details: { path: '/proj/.pi/audio/speech_1.mp3', voice: 'alloy', format: 'mp3' } });
    fireEvent.click(screen.getByTestId('open-file-speak'));
    expect(openPath).toHaveBeenCalledWith('/proj/.pi/audio/speech_1.mp3');
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
    expect(screen.getByText('1/2 完成')).toBeTruthy();
    expect(screen.getByText(/write tests/)).toBeTruthy();
    expect(screen.getByText(/ship it/)).toBeTruthy();
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
    expect(screen.getByText('Result One')).toBeTruthy();
    expect(screen.getByText('Result Two')).toBeTruthy();
    // 结果卡显示 host（去 www），而非完整 URL。
    expect(screen.getByText('one.dev')).toBeTruthy();
  });
});
