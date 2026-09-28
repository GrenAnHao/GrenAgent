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
});
