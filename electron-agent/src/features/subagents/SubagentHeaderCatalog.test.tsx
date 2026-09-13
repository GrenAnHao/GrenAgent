import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../store/session';
import type { CatalogRowView, SubagentCatalogEntry } from '../../lib/pi';

const { subagentCatalog, subagentCatalogRow, onPiEvent } = vi.hoisted(() => ({
  subagentCatalog: vi.fn(),
  subagentCatalogRow: vi.fn(),
  onPiEvent: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock('../../lib/pi', () => ({
  pi: {
    subagentCatalog,
    subagentCatalogRow,
  },
  onPiEvent,
}));

import {
  formatCatalogDuration,
  formatCatalogTokens,
  SubagentHeaderCatalog,
} from './SubagentHeaderCatalog';

const PARENT = '/parent.jsonl';

const entry: SubagentCatalogEntry = {
  id: 'sa-1',
  sessionPath: '/child.jsonl',
  createdAt: 1,
  mode: 'one-shot',
  label: 'first child',
};

const settledRow: CatalogRowView = {
  ...entry,
  activity: 'settled',
  hasChildren: false,
};

beforeEach(() => {
  useSessionStore.setState({ activeSessionPath: PARENT });
  subagentCatalog.mockResolvedValue({ entries: [entry], diagnostics: [] });
  subagentCatalogRow.mockResolvedValue(settledRow);
  onPiEvent.mockResolvedValue(() => {});
});

afterEach(() => {
  cleanup();
  useSessionStore.setState({ activeSessionPath: null });
  vi.clearAllMocks();
});

async function openCatalog() {
  render(<SubagentHeaderCatalog />);
  const trigger = await screen.findByTestId('subagent-header-catalog');
  fireEvent.click(trigger);
  return trigger;
}

describe('SubagentHeaderCatalog', () => {
  it('entries 空：没有 data-testid="subagent-header-catalog"', async () => {
    subagentCatalog.mockResolvedValue({ entries: [], diagnostics: [] });
    render(<SubagentHeaderCatalog />);
    await waitFor(() => expect(subagentCatalog).toHaveBeenCalledWith(PARENT));
    expect(screen.queryByTestId('subagent-header-catalog')).toBeNull();
  });

  it('有行：按钮在；点开看到 label 与 mode', async () => {
    await openCatalog();
    expect(await screen.findByText('first child')).toBeTruthy();
    expect(screen.getByText('one-shot')).toBeTruthy();
  });

  it('有 running：按钮 title 含运行数', async () => {
    subagentCatalogRow.mockResolvedValue({ ...settledRow, activity: 'running' });
    render(<SubagentHeaderCatalog />);
    const trigger = await screen.findByTestId('subagent-header-catalog');
    expect(trigger.getAttribute('title') ?? '').toMatch(/1/);
  });

  it('点行调用 onOpen(entry)', async () => {
    const onOpen = vi.fn();
    render(<SubagentHeaderCatalog onOpen={onOpen} />);
    fireEvent.click(await screen.findByTestId('subagent-header-catalog'));
    fireEvent.click(await screen.findByText('first child'));
    await waitFor(() => {
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
        id: 'sa-1',
        sessionPath: '/child.jsonl',
        label: 'first child',
        mode: 'one-shot',
      }));
    });
  });

  it('下拉 role="tree"，宽度 360px', async () => {
    await openCatalog();
    const tree = await screen.findByRole('tree');
    expect(tree).toHaveStyle({ width: '360px' });
  });

  it('Esc 关闭下拉（tree 消失或不可见）', async () => {
    await openCatalog();
    const tree = await screen.findByRole('tree');
    fireEvent.keyDown(tree, { key: 'Escape' });
    await waitFor(() => {
      const remaining = screen.queryByRole('tree');
      expect(remaining == null || remaining.getAttribute('hidden') != null).toBe(true);
    });
  });
});

describe('formatCatalogDuration', () => {
  it('不足一分钟用秒', () => {
    expect(formatCatalogDuration(12_000)).toBe('12s');
    expect(formatCatalogDuration(0)).toBe('0s');
  });

  it('不足一小时用 m:ss', () => {
    expect(formatCatalogDuration(90_000)).toBe('1:30');
    expect(formatCatalogDuration(65_000)).toBe('1:05');
  });

  it('更长用 h:mm:ss', () => {
    expect(formatCatalogDuration(3_661_000)).toBe('1:01:01');
  });
});

describe('formatCatalogTokens', () => {
  it('小于 1000 原样', () => {
    expect(formatCatalogTokens(999)).toBe('999');
  });

  it('否则一位小数加 k / M，可去掉末尾 .0', () => {
    expect(formatCatalogTokens(1000)).toBe('1k');
    expect(formatCatalogTokens(1500)).toBe('1.5k');
    expect(formatCatalogTokens(1_000_000)).toBe('1M');
    expect(formatCatalogTokens(1_500_000)).toBe('1.5M');
  });
});
