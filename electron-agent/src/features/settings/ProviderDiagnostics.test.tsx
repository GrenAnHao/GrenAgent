import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnoseChunk, DiagnoseRequest, DiagnoseResult } from '../../lib/pi';
import type { Channel } from '../../platform/runtime';

const { listModelsGlobal, diagnoseProviderModel, abortDiagnoseProviderModel } = vi.hoisted(() => ({
  listModelsGlobal: vi.fn(),
  diagnoseProviderModel: vi.fn(),
  abortDiagnoseProviderModel: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/pi', () => ({
  pi: { listModelsGlobal, diagnoseProviderModel, abortDiagnoseProviderModel },
}));

import { invalidateAvailableModels } from './availableModelsCache';
import { ProviderDiagnostics } from './ProviderDiagnostics';

const MODELS = [
  { provider: 'relay', id: 'claude-x', api: 'anthropic-messages', reasoning: true, thinkingLevelMap: { off: 'off', low: 'low', high: 'high', xhigh: 'max' } },
  { provider: 'relay', id: 'plain', api: 'openai-completions', reasoning: false },
  { provider: 'other', id: 'not-mine', reasoning: false },
];

const OK: DiagnoseResult = {
  ok: true, cancelled: false, error: null, content: 'hi there', thinking: '', ttftMs: 120, totalMs: 900,
  promptTokens: 5, completionTokens: 9, reasoningTokens: null, totalTokens: 14, tokensPerSec: 10,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** jsdom 里 antd 关掉的下拉不会隐藏，新打开的下拉挂在 body 最后，只读它的选项。 */
async function openSelect(testId: string): Promise<HTMLElement[]> {
  const before = document.querySelectorAll('.ant-select-dropdown').length;
  fireEvent.mouseDown(screen.getByTestId(testId).closest('.ant-select')!);
  return waitFor(() => {
    const dropdowns = document.querySelectorAll<HTMLElement>('.ant-select-dropdown');
    if (dropdowns.length <= before) throw new Error(`下拉没打开：${testId}`);
    return Array.from(dropdowns[dropdowns.length - 1]!.querySelectorAll<HTMLElement>('.ant-select-item-option'));
  });
}

/** 测活层默认收起，开合记在模块内存里跨用例保留：没展开才点一下。 */
function ensureOpen(): void {
  if (!screen.queryByTestId('prov-diag-body')) fireEvent.click(screen.getByTestId('prov-diag-toggle'));
}

async function renderReady(props: Partial<Parameters<typeof ProviderDiagnostics>[0]> = {}) {
  const view = render(<ProviderDiagnostics providerId="relay" dirty={false} missingKey={false} {...props} />);
  ensureOpen();
  await waitFor(() => expect((screen.getByTestId('prov-diag-run') as HTMLButtonElement).disabled).toBe(false));
  return view;
}

beforeEach(() => {
  invalidateAvailableModels();
  listModelsGlobal.mockResolvedValue({ ok: true, models: MODELS });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProviderDiagnostics', () => {
  // 必须排第一个：开合记在模块内存里，后面的用例会把它展开。
  it('测活层默认收起，只有标题栏', async () => {
    render(<ProviderDiagnostics providerId="relay" dirty={false} missingKey={false} />);
    expect(screen.getByTestId('prov-diag-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('prov-diag-body')).toBeNull();
  });

  it('只列当前供应商的模型，默认选第一个、思考档默认关闭', async () => {
    await renderReady();

    const models = await openSelect('prov-diag-model');
    expect(models.map((el) => el.getAttribute('title'))).toEqual(['claude-x', 'plain']);
    const levels = await openSelect('prov-diag-level');
    expect(levels.map((el) => el.textContent)).toEqual(['关闭', '低', '高', '很高 · max']);
  });

  it('选了思考档就带 reasoning 发出去；关闭档不带', async () => {
    diagnoseProviderModel.mockResolvedValue(OK);
    await renderReady();

    fireEvent.click(screen.getByTestId('prov-diag-run'));
    await screen.findByTestId('prov-diag-metrics');
    const levels = await openSelect('prov-diag-level');
    fireEvent.click(levels.find((el) => el.textContent === '很高 · max')!);
    fireEvent.click(screen.getByTestId('prov-diag-run'));
    await waitFor(() => expect(diagnoseProviderModel).toHaveBeenCalledTimes(2));

    const [first, second] = diagnoseProviderModel.mock.calls.map((call) => call[0] as DiagnoseRequest);
    expect(first).toMatchObject({ providerId: 'relay', modelId: 'claude-x', prompt: 'Who are you?', stream: true, reasoning: undefined });
    expect(second).toMatchObject({ reasoning: 'xhigh' });
    expect(first.requestId).not.toBe(second.requestId);
  });

  it('流式分片分别进思考与正文；完成后显示指标与状态', async () => {
    const pending = deferred<DiagnoseResult>();
    let channel: Channel<DiagnoseChunk> | undefined;
    diagnoseProviderModel.mockImplementation((_req: DiagnoseRequest, onChunk: Channel<DiagnoseChunk>) => {
      channel = onChunk;
      return pending.promise;
    });
    await renderReady();

    fireEvent.click(screen.getByTestId('prov-diag-run'));
    act(() => {
      channel!.postMessage({ type: 'thinking', text: 'pondering' });
      channel!.postMessage({ type: 'text', text: 'hi ' });
    });
    expect(screen.getByTestId('prov-diag-thinking').textContent).toBe('pondering');
    expect(screen.getByTestId('prov-diag-output').textContent).toBe('hi ▌');
    expect(screen.getByTestId('prov-diag-toggle').textContent).toMatch(/测试中/);

    await act(async () => pending.resolve({ ...OK, thinking: 'pondering', reasoningTokens: 4 }));

    expect(screen.getByTestId('prov-diag-output').textContent).toBe('hi there');
    expect(screen.getByTestId('prov-diag-toggle').textContent).toMatch(/成功 · 900 ms/);
    expect(screen.getByTestId('prov-diag-metrics').textContent).toMatch(/思考 tokens4/);
  });

  it('发送中可以取消：按 requestId 发 abort，结果显示已取消并恢复可发送', async () => {
    const pending = deferred<DiagnoseResult>();
    diagnoseProviderModel.mockReturnValue(pending.promise);
    await renderReady();

    fireEvent.click(screen.getByTestId('prov-diag-run'));
    expect(screen.queryByTestId('prov-diag-run')).toBeNull();
    fireEvent.click(screen.getByTestId('prov-diag-cancel'));

    const requestId = (diagnoseProviderModel.mock.calls[0]![0] as DiagnoseRequest).requestId;
    expect(abortDiagnoseProviderModel).toHaveBeenCalledWith(requestId);
    expect(screen.getByTestId('prov-diag-toggle').textContent).toMatch(/正在取消/);

    await act(async () => pending.resolve({ ...OK, ok: false, cancelled: true, content: 'par' }));

    expect(screen.getByTestId('prov-diag-toggle').textContent).toMatch(/已取消/);
    expect(screen.queryByTestId('prov-diag-metrics')).toBeNull();
    expect(screen.getByTestId('prov-diag-output').textContent).toBe('par');
    expect((screen.getByTestId('prov-diag-run') as HTMLButtonElement).disabled).toBe(false);
  });

  it('换供应商时取消在飞的请求，晚到的结果丢弃', async () => {
    const pending = deferred<DiagnoseResult>();
    diagnoseProviderModel.mockReturnValue(pending.promise);
    const view = await renderReady();

    fireEvent.click(screen.getByTestId('prov-diag-run'));
    const requestId = (diagnoseProviderModel.mock.calls[0]![0] as DiagnoseRequest).requestId;
    view.rerender(<ProviderDiagnostics providerId="other" dirty={false} missingKey={false} />);
    await act(async () => pending.resolve(OK));

    expect(abortDiagnoseProviderModel).toHaveBeenCalledWith(requestId);
    expect(screen.queryByTestId('prov-diag-output')).toBeNull();
    expect(screen.queryByTestId('prov-diag-cancel')).toBeNull();
  });

  it('失败显示供应商错误', async () => {
    diagnoseProviderModel.mockResolvedValue({ ...OK, ok: false, content: '', error: '401 invalid key' });
    await renderReady();

    fireEvent.click(screen.getByTestId('prov-diag-run'));

    expect((await screen.findByTestId('prov-diag-error')).textContent).toBe('401 invalid key');
    expect(screen.getByTestId('prov-diag-toggle').textContent).toMatch(/失败/);
  });

  it('提示：未保存、没有可测模型、没填 Key', async () => {
    const dirty = await renderReady({ dirty: true });
    expect(screen.getByText('有未保存的改动，测活使用的是已保存的配置。')).toBeTruthy();
    dirty.unmount();

    const noKey = await renderReady({ missingKey: true });
    expect(screen.getByText('没有填写 API Key，请求多半会被拒绝。')).toBeTruthy();
    noKey.unmount();

    render(<ProviderDiagnostics providerId="unsaved" dirty missingKey={false} />);
    ensureOpen();
    expect(await screen.findByText('保存后才能测活：测活走已保存的配置。')).toBeTruthy();
    expect((screen.getByTestId('prov-diag-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('标题栏可以收起和展开', async () => {
    await renderReady();

    fireEvent.click(screen.getByTestId('prov-diag-toggle'));
    expect(screen.queryByTestId('prov-diag-body')).toBeNull();
    fireEvent.click(screen.getByTestId('prov-diag-toggle'));
    expect(screen.getByTestId('prov-diag-body')).toBeTruthy();
  });
});
