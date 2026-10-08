// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@lobehub/ui';
import { App } from 'antd';

const io = vi.hoisted(() => ({
  listPromptCommands: vi.fn(),
  savePromptCommand: vi.fn(),
  deletePromptCommand: vi.fn(),
}));
vi.mock('../../lib/promptLibraryIo', () => io);
vi.mock('../chat/input/editor/commandLoader', () => ({
  loadCommands: vi.fn(async () => [
    { name: 'compact', source: 'frontend' },
    { name: 'goal', source: 'api', apiSource: 'extension' },
    { name: 'refactor', source: 'api', apiSource: 'prompt' },
  ]),
}));
vi.mock('../chat/input/editor/promptCommandCache', () => ({ invalidatePromptCommands: vi.fn() }));

import { CommandsPanel } from './CommandsPanel';

vi.setConfig({ testTimeout: 45000 });

const refactor = { name: 'refactor', description: '重构', body: '改 {file}', params: [{ name: 'file' }], path: '/p/refactor.md' };

function renderPanel(onResourcesChanged = vi.fn()) {
  render(
    <ThemeProvider>
      <App>
        <CommandsPanel workspace="/ws" onResourcesChanged={onResourcesChanged} />
      </App>
    </ThemeProvider>,
  );
  return onResourcesChanged;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CommandsPanel', () => {
  it('列出命令并显示参数个数，选中后编辑区填好', async () => {
    io.listPromptCommands.mockResolvedValue([refactor]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('command-item-refactor')).toBeInTheDocument());
    expect(screen.getByTestId('command-item-refactor')).toHaveTextContent('1 参数');
    fireEvent.click(screen.getByTestId('command-item-refactor'));
    expect(screen.getByTestId('command-name-input')).toHaveValue('refactor');
    expect(screen.getByTestId('command-detected-params')).toHaveTextContent('file');
  });

  it('新建时提示词里的参数实时识别，保存时带上保留名并通知重载', async () => {
    io.listPromptCommands.mockResolvedValue([]);
    io.savePromptCommand.mockResolvedValue({ ...refactor, name: 'fix' });
    const changed = renderPanel();
    await waitFor(() => expect(screen.getByTestId('command-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('command-new'));
    fireEvent.change(screen.getByTestId('command-name-input'), { target: { value: 'fix' } });
    fireEvent.change(screen.getByTestId('prompt-body-input'), { target: { value: '修 {bug=all}' } });
    expect(screen.getByTestId('command-detected-params')).toHaveTextContent('bug');
    expect(screen.getByTestId('command-detected-params')).toHaveTextContent('默认 all');
    fireEvent.click(screen.getByTestId('command-save'));
    await waitFor(() => expect(io.savePromptCommand).toHaveBeenCalled());
    expect(io.savePromptCommand.mock.calls[0][0]).toMatchObject({ name: 'fix', body: '修 {bug=all}', reserved: ['compact', 'goal'] });
    expect(changed).toHaveBeenCalled();
  });

  it('和保留名重名时就地报错且不能保存', async () => {
    io.listPromptCommands.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('command-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('command-new'));
    fireEvent.change(screen.getByTestId('command-name-input'), { target: { value: 'goal' } });
    fireEvent.change(screen.getByTestId('prompt-body-input'), { target: { value: 'x' } });
    await waitFor(() => expect(screen.getByTestId('command-error')).toHaveTextContent('/goal 和已有的内置、扩展或技能命令重名'));
    expect(screen.getByTestId('command-save')).toBeDisabled();
  });
});
