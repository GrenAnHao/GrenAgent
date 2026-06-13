import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));

const { createList, createImage, prompt, openPath } = vi.hoisted(() => ({
  createList: vi.fn(() =>
    Promise.resolve([
      { name: 'img_2.png', bytes: 2048, modifiedMs: 200 },
      { name: 'img_1.png', bytes: 1024, modifiedMs: 100 },
    ]),
  ),
  createImage: vi.fn(() => Promise.resolve('QUJD')),
  prompt: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(),
}));
vi.mock('../../lib/pi', () => ({ pi: { createList, createImage, prompt } }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: (p: string) => openPath(p) }));

import { CreatePanel } from './CreatePanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CreatePanel', () => {
  it('lists images as gallery cards', async () => {
    render(<CreatePanel />);
    await waitFor(() => expect(screen.getByTestId('cr-header').textContent).toContain('2'));
    expect(screen.getByTestId('cr-card-img_2.png')).toBeTruthy();
    expect(screen.getByTestId('cr-card-img_1.png')).toBeTruthy();
  });

  it('loads base64 thumbnails', async () => {
    render(<CreatePanel />);
    await waitFor(() => expect(createImage).toHaveBeenCalledWith('/ws', 'img_1.png'));
    await waitFor(() => {
      const img = screen.getByTestId('cr-thumb-img_1.png') as HTMLImageElement;
      expect(img.getAttribute('src')).toContain('data:image/png;base64,QUJD');
    });
  });

  it('opens original image on card click', async () => {
    render(<CreatePanel />);
    await waitFor(() => expect(screen.getByTestId('cr-card-img_1.png')).toBeTruthy());
    fireEvent.click(screen.getByTestId('cr-card-img_1.png'));
    expect(openPath).toHaveBeenCalledWith('img_1.png');
  });

  it('submits a generate-image prompt', async () => {
    render(<CreatePanel />);
    await waitFor(() => expect(screen.getByTestId('cr-prompt')).toBeTruthy());
    fireEvent.change(screen.getByTestId('cr-prompt'), { target: { value: '一只猫' } });
    fireEvent.click(screen.getByTestId('cr-generate'));
    await waitFor(() => expect(prompt).toHaveBeenCalledWith('/ws', expect.stringContaining('一只猫')));
  });
});
