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
const ask = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('../../components/askConfirm', () => ({ useAskConfirm: () => ask }));

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
  it('返回目录后重新打开当前规则保留草稿，宽窄切换不替换编辑器', async () => {
    io.listContextRules.mockResolvedValue(rules);
    const view = (width: number) => (
      <ThemeProvider><App><div style={{ width, containerType: 'inline-size', containerName: 'extension-content' }}>
        <RulesPanel workspace="/ws" />
      </div></App></ThemeProvider>
    );
    const { rerender } = render(view(900));
    await waitFor(() => expect(screen.getByTestId('rule-open-global-zh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-open-global-zh'));
    const editor = screen.getByTestId('rule-body-input');
    fireEvent.change(editor, { target: { value: '未保存的正文' } });
    rerender(view(600));
    expect(screen.getByTestId('rule-workbench')).toHaveAttribute('data-mobile-detail', 'true');
    expect(screen.getByTestId('rule-body-input')).toBe(editor);
    fireEvent.click(screen.getByTestId('rule-back'));
    expect(screen.getByTestId('rule-workbench')).toHaveAttribute('data-mobile-detail', 'false');
    fireEvent.click(screen.getByTestId('rule-open-global-zh'));
    expect(screen.getByTestId('rule-body-input')).toBe(editor);
    expect(editor).toHaveValue('未保存的正文');
    rerender(view(900));
    expect(screen.getByTestId('rule-body-input')).toBe(editor);
    expect(editor).toHaveValue('未保存的正文');
  });

  it('有未保存的修改时换规则先确认，取消就留在原草稿', async () => {
    io.listContextRules.mockResolvedValue(rules);
    ask.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-open-global-zh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-open-global-zh'));
    expect(screen.queryByTestId('rule-dirty')).toBeNull();
    expect(screen.getByTestId('rule-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('rule-body-input'), { target: { value: '未保存的正文' } });
    expect(screen.getByTestId('rule-dirty')).toHaveTextContent('未保存');
    fireEvent.click(screen.getByTestId('rule-open-project-pnpm'));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('rule-body-input')).toHaveValue('未保存的正文');
    fireEvent.click(screen.getByTestId('rule-open-project-pnpm'));
    await waitFor(() => expect(screen.getByTestId('rule-title-input')).toHaveValue('用 pnpm'));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('详情开关写明状态，范围下写出保存目录，停用的规则在列表里变淡', async () => {
    io.listContextRules.mockResolvedValue(rules);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-open-project-pnpm')).toBeInTheDocument());
    expect(screen.getByTestId('rule-item-project-pnpm')).toHaveAttribute('data-enabled', 'false');
    fireEvent.click(screen.getByTestId('rule-open-project-pnpm'));
    expect(screen.getByTestId('rule-editor')).toHaveTextContent('已停用');
    expect(screen.getByTestId('rule-scope-path')).toHaveTextContent('.pi/rules');
    expect(screen.getByTestId('rule-delete')).toHaveTextContent(/^删除$/);
    expect(screen.getByTestId('rule-workbench')).not.toHaveTextContent('名称、范围和正文修改后需要保存');
  });

  it('新建直接进入详情', async () => {
    io.listContextRules.mockResolvedValue([]);
    renderPanel();
    fireEvent.click(screen.getByTestId('rule-new'));
    expect(screen.getByTestId('rule-workbench')).toHaveAttribute('data-mobile-detail', 'true');
    expect(screen.getByTestId('rule-title-input')).toHaveValue('');
  });

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

  it('详情开关立即写盘并保留正在编辑的正文', async () => {
    io.listContextRules.mockResolvedValue(rules);
    io.setContextRuleEnabled.mockResolvedValue(undefined);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-open-global-zh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-open-global-zh'));
    fireEvent.change(screen.getByTestId('rule-body-input'), { target: { value: '未保存的正文' } });
    fireEvent.click(screen.getByTestId('rule-detail-toggle'));
    await waitFor(() => expect(screen.getByTestId('rule-detail-toggle')).toHaveAttribute('aria-checked', 'false'));
    expect(io.setContextRuleEnabled).toHaveBeenCalledWith('/ws', { scope: 'global', id: 'zh' }, false);
    expect(screen.getByTestId('rule-body-input')).toHaveValue('未保存的正文');
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
    fireEvent.change(screen.getByTestId('rule-title-input'), { target: { value: '中文回答 2' } });
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

describe('RulesPanel 模式范围', () => {
  const scoped = [
    { id: 'ultra', scope: 'global', path: '/g/u.md', title: 'Ultra 调度', enabled: true, body: '- 派工', modes: ['ultra'] },
    { id: 'zh', scope: 'global', path: '/g/zh.md', title: '中文回答', enabled: true, body: '- 中文' },
  ];

  it('列表标出模式范围，旧规则标全部模式', async () => {
    io.listContextRules.mockResolvedValue(scoped);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-item-global-ultra')).toBeInTheDocument());
    expect(screen.getByTestId('rule-modes-global-ultra')).toHaveTextContent('Ultra');
    expect(screen.getByTestId('rule-modes-global-zh')).toHaveTextContent('全部模式');
  });

  it('编辑区回显已保存的模式范围，保存时完整带回', async () => {
    io.listContextRules.mockResolvedValue(scoped);
    io.saveContextRule.mockResolvedValue(scoped[0]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-open-global-ultra')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-open-global-ultra'));
    expect(screen.getByTestId('rule-mode-ultra')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('rule-mode-agent')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('rule-mode-all')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('rule-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('rule-title-input'), { target: { value: 'Ultra 调度 2' } });
    fireEvent.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(io.saveContextRule).toHaveBeenCalledWith(expect.objectContaining({
      original: { scope: 'global', id: 'ultra' },
      modes: ['ultra'],
    })));
  });

  it('新建默认适用全部模式，选中模式后保存带上范围', async () => {
    io.listContextRules.mockResolvedValue([]);
    io.saveContextRule.mockResolvedValue(scoped[0]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-new'));
    fireEvent.change(screen.getByTestId('rule-title-input'), { target: { value: 'Ultra 调度' } });
    fireEvent.change(screen.getByTestId('rule-body-input'), { target: { value: '- 派工' } });
    fireEvent.click(screen.getByTestId('rule-mode-ultra'));
    expect(screen.getByTestId('rule-mode-ultra')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(io.saveContextRule).toHaveBeenCalledWith(expect.objectContaining({ modes: ['ultra'] })));
  });

  it('取消全部模式选择等于全部模式，保存不带 modes', async () => {
    io.listContextRules.mockResolvedValue(scoped);
    io.saveContextRule.mockResolvedValue(scoped[1]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-open-global-ultra')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-open-global-ultra'));
    fireEvent.click(screen.getByTestId('rule-mode-ultra'));
    fireEvent.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(io.saveContextRule).toHaveBeenCalledWith(expect.objectContaining({ modes: undefined })));
  });

  it('「全部」在没有选模式时亮起，点它清空已选模式', async () => {
    io.listContextRules.mockResolvedValue(scoped);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-open-global-zh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-open-global-zh'));
    expect(screen.getByTestId('rule-mode-all')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('rule-mode-plan'));
    expect(screen.getByTestId('rule-mode-all')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('rule-mode-all'));
    expect(screen.getByTestId('rule-mode-plan')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('rule-mode-all')).toHaveAttribute('aria-pressed', 'true');
  });

  it('可以同时选择多个模式', async () => {
    io.listContextRules.mockResolvedValue([]);
    io.saveContextRule.mockResolvedValue(scoped[0]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('rule-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('rule-new'));
    fireEvent.change(screen.getByTestId('rule-title-input'), { target: { value: 'X' } });
    fireEvent.change(screen.getByTestId('rule-body-input'), { target: { value: 'y' } });
    fireEvent.click(screen.getByTestId('rule-mode-ultra'));
    fireEvent.click(screen.getByTestId('rule-mode-plan'));
    fireEvent.click(screen.getByTestId('rule-save'));
    // 保存顺序按模式枚举排：plan 在 ultra 之前
    await waitFor(() => expect(io.saveContextRule).toHaveBeenCalledWith(expect.objectContaining({ modes: ['plan', 'ultra'] })));
  });
});
