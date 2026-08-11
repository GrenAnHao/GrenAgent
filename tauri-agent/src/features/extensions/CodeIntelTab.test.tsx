import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ModelSelectField 依赖 provider 数据；mock 成一个最小输入桩，聚焦本组件逻辑。
vi.mock('../settings/ModelSelectField', () => ({
  ModelSelectField: ({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId?: string }) => (
    <input data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { ThemeProvider } from '@lobehub/ui';
import { CodeIntelTab } from './CodeIntelTab';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTab(values: Record<string, string> = {}) {
  const setValue = vi.fn();
  const onChange = vi.fn();
  const { container } = render(
    <ThemeProvider>
      <CodeIntelTab values={values} setValue={setValue} onChange={onChange} knownToolNames={[]} />
    </ThemeProvider>,
  );
  return { setValue, onChange, container };
}

describe('CodeIntelTab', () => {
  it('changing engine writes CODE_INTEL and marks changed', async () => {
    const { setValue, onChange, container } = renderTab({ CODE_INTEL: 'codebase-memory' });
    // antd Select：打开下拉后选「关闭」。下拉项渲染在 portal；用模糊 class 兼容任意 prefixCls。
    const selector =
      container.querySelector('[class*="select-selector"]') ?? container.querySelector('[role="combobox"]');
    expect(selector).toBeTruthy();
    fireEvent.mouseDown(selector!);
    await waitFor(() => expect(screen.getByText('关闭')).toBeTruthy());
    fireEvent.click(screen.getByText('关闭'));
    expect(setValue).toHaveBeenCalledWith('CODE_INTEL', 'off');
    expect(onChange).toHaveBeenCalled();
  });

  it('falls back to codebase-memory display for a removed/unknown engine value (legacy gitnexus)', () => {
    renderTab({ CODE_INTEL: 'gitnexus' });
    // 选择器回落显示 codebase-memory，不再渲染 gitnexus。
    expect(screen.getByText('codebase-memory（内置，默认）')).toBeTruthy();
    expect(screen.queryByText(/GitNexus/i)).toBeNull();
  });

  it('shows the yield badge when a user codebase-memory signature is present', () => {
    render(
      <ThemeProvider>
        <CodeIntelTab
          values={{}}
          setValue={vi.fn()}
          onChange={vi.fn()}
          knownToolNames={['search_graph', 'trace_path']}
        />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('code-intel-badge').textContent).toContain('让位');
  });

  it('toggles the auto-init switch (writes CODE_INTEL_AUTO_INIT)', () => {
    const { setValue } = renderTab({ CODE_INTEL_AUTO_INIT: '1' });
    fireEvent.click(screen.getByTestId('code-intel-autoinit'));
    expect(setValue).toHaveBeenCalledWith('CODE_INTEL_AUTO_INIT', '0');
  });

  it('toggles the explorer switch (writes CODE_INTEL_EXPLORER)', () => {
    const { setValue } = renderTab({ CODE_INTEL_EXPLORER: '1' });
    fireEvent.click(screen.getByTestId('code-intel-explorer'));
    expect(setValue).toHaveBeenCalledWith('CODE_INTEL_EXPLORER', '0');
  });
});
