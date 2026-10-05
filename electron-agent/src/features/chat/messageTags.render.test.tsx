// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openBrowserPopupTab } = vi.hoisted(() => ({ openBrowserPopupTab: vi.fn() }));
vi.mock('../dock/browser/openBrowserPopupTab', () => ({ openBrowserPopupTab }));

import { renderMessageTags } from './messageTags';

const URL_TEXT = 'https://linux.do/t/topic/2904342';

describe('renderMessageTags link chip', () => {
  beforeEach(() => openBrowserPopupTab.mockClear());

  it('opens the full URL in the built-in browser on click', () => {
    render(<span>{renderMessageTags(`读取这篇文章 <${URL_TEXT}>`)}</span>);

    fireEvent.click(screen.getByRole('link', { name: /linux\.do/ }));

    expect(openBrowserPopupTab).toHaveBeenCalledWith({ url: URL_TEXT, disposition: 'new-window' });
  });

  it('opens on Enter so the chip is keyboard reachable', () => {
    render(<span>{renderMessageTags(`看看 ${URL_TEXT}`)}</span>);

    const link = screen.getByRole('link', { name: /linux\.do/ });
    expect(link).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(link, { key: 'Enter' });

    expect(openBrowserPopupTab).toHaveBeenCalledTimes(1);
  });

  it('keeps file chips non-clickable', () => {
    render(<span>{renderMessageTags('看一下 @src/foo.ts')}</span>);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('拖入的区外文件只显示文件名，完整路径放在悬停提示里', () => {
    render(<span>{renderMessageTags('开始规划\n\n@.pi/dropped/4321a/one.md @.pi/dropped/77bc/two.md')}</span>);

    expect(screen.getByText('one.md').parentElement).toHaveAttribute('title', '.pi/dropped/4321a/one.md');
    expect(screen.getByText('two.md')).toBeInTheDocument();
    expect(screen.queryByText(/4321a/)).not.toBeInTheDocument();
  });

  it('工作区内的路径原样显示', () => {
    render(<span>{renderMessageTags('@src/foo.ts')}</span>);
    expect(screen.getByText('src/foo.ts')).toBeInTheDocument();
  });
});
