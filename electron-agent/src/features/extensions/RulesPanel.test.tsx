// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';

const io = vi.hoisted(() => ({
  listContextRules: vi.fn(),
  saveContextRule: vi.fn(),
  setContextRuleEnabled: vi.fn(),
  deleteContextRule: vi.fn(),
}));
vi.mock('../../lib/promptLibraryIo', () => io);

import { RulesPanel } from './RulesPanel';

vi.setConfig({ testTimeout: 45000 });

const rules = [
  { id: 'zh', scope: 'global', path: '/g/zh.md', title: '中文回答', enabled: true, body: '- 中文' },
  { id: 'pnpm', scope: 'project', path: '/w/pnpm.md', title: '用 pnpm', enabled: false, body: '- pnpm' },
  { id: 'bad', scope: 'global', path: '/g/bad.md', title: 'bad', enabled: false, body: '', error: 'YAML 错误' },
];

function renderPanel(workspace = '/ws') {
  render(
    <ThemeProvider>
      <App>
        <RulesPanel workspace={workspace} />
      </App>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RulesPanel', () => {
  it('列出规则，按范围筛选', async () => {
    io.listContextRules.mockResolvedValue(rules);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-item-global-zh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-filter-project'));
    expect(screen.queryByTestId('rule-item-global-zh')).not.toBeInTheDocument();
    expect(screen.getByTestId('rule-item-project-pnpm')).toBeInTheDocument();
  });

  it('开关立即写盘', async () => {
    io.listContextRules.mockResolvedValue(rules);
    io.setContextRuleEnabled.mockResolvedValue(undefined);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-toggle-project-pnpm')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-toggle-project-pnpm'));
    await waitFor(() => expect(io.setContextRuleEnabled).toHaveBeenCalledWith('/ws', { scope: 'project', id: 'pnpm' }, true));
  });

  it('坏文件标警告且开关不可用', async () => {
    io.listContextRules.mockResolvedValue(rules);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-warning-global-bad')).toBeInTheDocument());
    expect(screen.getByTestId('rule-toggle-global-bad')).toBeDisabled();
  });

  it('新建规则保存到所选范围', async () => {
    io.listContextRules.mockResolvedValue([]);
    io.saveContextRule.mockResolvedValue(rules[0]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-new'));
    fireEvent.change(screen.getByTestId('rule-title-input'), { target: { value: '中文回答' } });
    fireEvent.change(screen.getByTestId('rule-body-input'), { target: { value: '- 中文' } });
    fireEvent.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(io.saveContextRule).toHaveBeenCalledWith({
      workspace: '/ws', scope: 'global', original: undefined, title: '中文回答', enabled: true, body: '- 中文',
    }));
  });

  it('没有工作区时项目范围不可选', async () => {
    io.listContextRules.mockResolvedValue([]);
    renderPanel('');
    await waitFor(() => expect(screen.getByTestId('rule-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-new'));
    expect(screen.getByTestId('rule-scope-project')).toHaveAttribute('aria-disabled', 'true');
  });
});
