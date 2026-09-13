import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChildOverlayStore } from '../../stores/childOverlayStore';
import type { ChildOverlay } from '../../stores/childOverlayStore';

const { subagentPrompt, subagentInterrupt, subagentCatalogRow } = vi.hoisted(() => ({
  subagentPrompt: vi.fn(),
  subagentInterrupt: vi.fn(),
  subagentCatalogRow: vi.fn(),
}));

vi.mock('../../lib/pi', () => ({
  pi: {
    subagentPrompt,
    subagentInterrupt,
    subagentCatalogRow,
  },
}));

vi.mock('../panels/useChildSessionBinding', () => ({
  useChildSessionBinding: () => [],
}));

vi.mock('../chat/ChatMessageItems', () => ({
  ChatMessageItems: () => <div data-testid="child-overlay-messages" />,
}));

import { ChildSessionOverlay } from './ChildSessionOverlay';

function openOverlay(over: Partial<ChildOverlay> = {}) {
  useChildOverlayStore.getState().open({
    id: 'sa-1',
    sessionPath: '/child.jsonl',
    parentSessionPath: '/parent.jsonl',
    label: 'first child',
    mode: 'one-shot',
    activity: 'settled',
    tornDown: false,
    ...over,
  });
}

beforeEach(() => {
  useChildOverlayStore.setState({ overlay: null, error: null });
  subagentPrompt.mockResolvedValue(undefined);
  subagentInterrupt.mockResolvedValue(undefined);
  subagentCatalogRow.mockResolvedValue({
    id: 'sa-1',
    sessionPath: '/child.jsonl',
    createdAt: 1,
    mode: 'one-shot',
    label: 'first child',
    activity: 'settled',
    hasChildren: false,
  });
});

afterEach(() => {
  cleanup();
  useChildOverlayStore.setState({ overlay: null, error: null });
  vi.clearAllMocks();
});

describe('ChildSessionOverlay', () => {
  it('one-shot：有 subagent-child-overlay，无 textarea，文案「此子代理只读」', () => {
    openOverlay({ mode: 'one-shot', activity: 'settled', tornDown: false });
    render(<ChildSessionOverlay />);
    expect(screen.getByTestId('subagent-child-overlay')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('此子代理只读')).toBeTruthy();
  });

  it('continuable + ready：有 textarea；点发送后 pi.subagentPrompt 收到 delivery followUp', async () => {
    openOverlay({ mode: 'continuable', activity: 'ready', tornDown: false });
    render(<ChildSessionOverlay />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => {
      expect(subagentPrompt).toHaveBeenCalledWith(
        '',
        '/parent.jsonl',
        '/child.jsonl',
        'hello',
        'followUp',
      );
    });
  });

  it('continuable + running：按钮「引导」，delivery steer', async () => {
    openOverlay({ mode: 'continuable', activity: 'running', tornDown: false });
    render(<ChildSessionOverlay />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'steer me' } });
    fireEvent.click(screen.getByRole('button', { name: '引导' }));
    await waitFor(() => {
      expect(subagentPrompt).toHaveBeenCalledWith(
        '',
        '/parent.jsonl',
        '/child.jsonl',
        'steer me',
        'steer',
      );
    });
  });

  it('tornDown：无法继续，无输入', () => {
    openOverlay({ mode: 'continuable', activity: 'settled', tornDown: true });
    render(<ChildSessionOverlay />);
    expect(screen.getByText('无法继续')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('点返回调用 close / onClose', () => {
    const onClose = vi.fn();
    openOverlay();
    render(<ChildSessionOverlay onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /返回/ }));
    expect(onClose).toHaveBeenCalled();
    expect(useChildOverlayStore.getState().overlay).toBeNull();
  });
});
