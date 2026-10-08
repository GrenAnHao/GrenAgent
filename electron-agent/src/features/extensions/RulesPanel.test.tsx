// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return { ...actual, App: Object.assign(actual.App, { useApp: () => ({ message: toast }) }) };
});

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

  it('列表开关改了之后，打开的草稿同步，保存带最新 enabled', async () => {
    io.listContextRules.mockResolvedValue(rules);
    io.setContextRuleEnabled.mockResolvedValue(undefined);
    io.saveContextRule.mockResolvedValue(rules[0]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-open-global-zh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-open-global-zh'));
    fireEvent.click(screen.getByTestId('rule-toggle-global-zh'));
    await waitFor(() => expect(io.setContextRuleEnabled).toHaveBeenCalledWith('/ws', { scope: 'global', id: 'zh' }, false));
    fireEvent.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(io.saveContextRule).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, original: { scope: 'global', id: 'zh' } })));
  });

  it('保存失败时给出错误提示', async () => {
    io.listContextRules.mockResolvedValue([]);
    io.saveContextRule.mockRejectedValueOnce(new Error('写盘失败'));
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-new'));
    fireEvent.change(screen.getByTestId('rule-title-input'), { target: { value: 'a' } });
    fireEvent.change(screen.getByTestId('rule-body-input'), { target: { value: 'b' } });
    fireEvent.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('写盘失败'));
  });

  it('保存中不能重复提交，成功后提示已保存', async () => {
    io.listContextRules.mockResolvedValue([]);
    let release: (value: unknown) => void = () => {};
    io.saveContextRule.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-new'));
    fireEvent.change(screen.getByTestId('rule-title-input'), { target: { value: 'a' } });
    fireEvent.change(screen.getByTestId('rule-body-input'), { target: { value: 'b' } });
    fireEvent.click(screen.getByTestId('rule-save'));
    fireEvent.click(screen.getByTestId('rule-save'));
    expect(io.saveContextRule).toHaveBeenCalledTimes(1);
    release(rules[0]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('已保存'));
  });

  it('工作区变化时清掉草稿', async () => {
    io.listContextRules.mockResolvedValue(rules);
    const view = (workspace: string) => (
      <ThemeProvider><App><RulesPanel workspace={workspace} /></App></ThemeProvider>
    );
    const { rerender } = render(view('/ws'));
    await waitFor(() => expect(screen.getByTestId('rule-open-global-zh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-open-global-zh'));
    expect(screen.getByTestId('rule-title-input')).toBeInTheDocument();
    rerender(view('/other'));
    await waitFor(() => expect(screen.queryByTestId('rule-title-input')).not.toBeInTheDocument());
  });

  it('保存挂起期间换工作区，完成后不回填草稿也不提示', async () => {
    io.listContextRules.mockResolvedValue([]);
    let release: (value: unknown) => void = () => {};
    io.saveContextRule.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const view = (workspace: string) => (
      <ThemeProvider><App><RulesPanel workspace={workspace} /></App></ThemeProvider>
    );
    const { rerender } = render(view('/a'));
    await waitFor(() => expect(screen.getByTestId('rule-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-new'));
    fireEvent.change(screen.getByTestId('rule-title-input'), { target: { value: 'a' } });
    fireEvent.change(screen.getByTestId('rule-body-input'), { target: { value: 'b' } });
    fireEvent.click(screen.getByTestId('rule-save'));
    rerender(view('/b'));
    await waitFor(() => expect(screen.queryByTestId('rule-title-input')).not.toBeInTheDocument());
    release(rules[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('rule-title-input')).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('旧请求晚返回时不覆盖新请求的结果', async () => {
    let releaseOld: (value: unknown) => void = () => {};
    io.listContextRules
      .mockReturnValueOnce(new Promise((resolve) => { releaseOld = resolve; }))
      .mockResolvedValueOnce([rules[1]]);
    const view = (workspace: string) => (
      <ThemeProvider><App><RulesPanel workspace={workspace} /></App></ThemeProvider>
    );
    const { rerender } = render(view('/a'));
    rerender(view('/b'));
    await waitFor(() => expect(screen.getByTestId('rule-item-project-pnpm')).toBeInTheDocument());
    releaseOld([rules[0]]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('rule-item-global-zh')).not.toBeInTheDocument();
  });
});
