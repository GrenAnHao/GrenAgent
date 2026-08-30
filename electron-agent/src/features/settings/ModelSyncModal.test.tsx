import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchProviderModels } = vi.hoisted(() => ({
  fetchProviderModels: vi.fn(),
}));
vi.mock('../../lib/pi', () => ({ pi: { fetchProviderModels } }));

// 把 Modal 简化为：open 时渲染 children + 一个「确认」按钮（触发 onOk）。
vi.mock('@lobehub/ui', () => ({
  Modal: ({
    open,
    children,
    onOk,
    okText,
    okButtonProps,
  }: {
    open?: boolean;
    children?: ReactNode;
    onOk?: () => void;
    okText?: ReactNode;
    okButtonProps?: { disabled?: boolean };
  }) =>
    open ? (
      <div>
        {children}
        <button data-testid="sync-ok" disabled={okButtonProps?.disabled} onClick={onOk}>
          {okText}
        </button>
      </div>
    ) : null,
}));

import { ModelSyncModal } from './ModelSyncModal';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ModelSyncModal', () => {
  it('fetches models, marks existing, filters, selects and confirms', async () => {
    fetchProviderModels.mockResolvedValue(['gpt-4o', 'gpt-4o-mini', 'claude-3']);
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ModelSyncModal
        open
        baseUrl="https://x"
        apiKey="k"
        api="openai-completions"
        existingIds={['claude-3']}
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );

    expect(await screen.findByText('gpt-4o-mini')).toBeTruthy();
    // claude-3 已在列表 → 标记「已添加」
    expect(screen.getByText('已添加')).toBeTruthy();

    // 搜索过滤
    fireEvent.change(screen.getByTestId('sync-search'), { target: { value: 'mini' } });
    expect(screen.queryByText('gpt-4o')).toBeNull();
    expect(screen.getByText('gpt-4o-mini')).toBeTruthy();

    // 勾选过滤结果并确认
    fireEvent.click(screen.getByText('gpt-4o-mini'));
    fireEvent.click(screen.getByTestId('sync-ok'));
    expect(onConfirm).toHaveBeenCalledWith(['gpt-4o-mini']);
    expect(onClose).toHaveBeenCalled();
  });

  it('select-all picks only not-yet-added models', async () => {
    fetchProviderModels.mockResolvedValue(['a', 'b', 'c']);
    const onConfirm = vi.fn();
    render(
      <ModelSyncModal
        open
        baseUrl="u"
        apiKey="k"
        api="openai-completions"
        existingIds={['b']}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    await screen.findByText('a');
    fireEvent.click(screen.getByTestId('sync-select-all'));
    fireEvent.click(screen.getByTestId('sync-ok'));
    expect(onConfirm).toHaveBeenCalledWith(['a', 'c']);
  });

  it('shows an error when fetching models fails', async () => {
    fetchProviderModels.mockRejectedValue(new Error('boom'));
    render(
      <ModelSyncModal
        open
        baseUrl="u"
        apiKey="k"
        api="openai-completions"
        existingIds={[]}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(await screen.findByTestId('sync-error')).toBeTruthy();
  });
});
