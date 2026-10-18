import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const { openTurnReview, openPath, revealItemInDir, openWorkspaceFile } = vi.hoisted(() => ({
  openTurnReview: vi.fn(),
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
  openWorkspaceFile: vi.fn(),
}));
vi.mock('../dock/openLauncherTab', () => ({ openTurnReview }));
vi.mock('../dock/openWorkspaceFile', () => ({ openWorkspaceFile }));
vi.mock('../../platform/runtime', () => ({ openPath, revealItemInDir }));

import { TurnTail } from './TurnTail';

afterEach(() => {
  cleanup();
  openTurnReview.mockReset();
  openPath.mockReset();
  revealItemInDir.mockReset();
  openWorkspaceFile.mockReset();
});

const changes = [
  { path: 'a.txt', display: 'a.txt', added: 6, deleted: 0 },
  { path: 'b.txt', display: 'b.txt', added: 1, deleted: 1 },
  { path: 'c.txt', display: 'c.txt', added: 0, deleted: 2 },
  { path: 'd.txt', display: 'd.txt', added: 1, deleted: 0 },
];

function presented(count: number, extra?: Partial<{ path: string; display: string; description: string }>) {
  return Array.from({ length: count }, (_, index) => ({
    path: extra?.path ?? `file-0${index + 1}.txt`,
    display: extra?.display ?? `file-0${index + 1}.txt`,
    description: extra?.description ?? `第 ${index + 1} 个测试文件`,
  }));
}

describe('TurnTail', () => {
  it('opens review with the original file index', () => {
    render(
      <TurnTail
        turnId="turn-1"
        workspace="D:/ws"
        changes={changes}
        presented={[{ path: 'a.txt', display: 'a.txt', description: '文件读写测试' }]}
      />,
    );
    expect(screen.getByText('已编辑 4 个文件')).toBeTruthy();
    expect(screen.queryByText('d.txt')).toBeNull();
    fireEvent.click(screen.getByText('全部 4 个文件'));
    fireEvent.click(screen.getByText('c.txt'));
    expect(openTurnReview).toHaveBeenCalledWith({ turnId: 'turn-1', fileIndex: 2, workspace: 'D:/ws' });
    openWorkspaceFile.mockResolvedValue('dock');
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(openWorkspaceFile).toHaveBeenCalledWith('D:/ws/a.txt', 'D:/ws');
    expect(openPath).not.toHaveBeenCalled();
  });

  it('uses the original file index while folded', () => {
    render(<TurnTail turnId="turn-1" workspace="D:/ws" changes={changes} presented={[]} />);
    fireEvent.click(screen.getByText('c.txt'));
    expect(openTurnReview).toHaveBeenCalledWith({ turnId: 'turn-1', fileIndex: 2, workspace: 'D:/ws' });
  });

  it('uses the original file index for a hidden row after expand', () => {
    render(<TurnTail turnId="turn-1" workspace="D:/ws" changes={changes} presented={[]} />);
    fireEvent.click(screen.getByText('全部 4 个文件'));
    fireEvent.click(screen.getByText('d.txt'));
    expect(openTurnReview).toHaveBeenCalledWith({ turnId: 'turn-1', fileIndex: 3, workspace: 'D:/ws' });
  });

  it('shows unavailable host path when workspace is empty', () => {
    render(
      <TurnTail
        turnId="turn-1"
        workspace=""
        changes={[]}
        presented={[{ path: 'a.txt', display: 'a.txt', description: '文件读写测试' }]}
      />,
    );
    expect(screen.getByText('没有可用的主机路径')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(openPath).not.toHaveBeenCalled();
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  it('shows unavailable host path when the file is outside the workspace', () => {
    render(
      <TurnTail
        turnId="turn-1"
        workspace="D:/ws"
        changes={[]}
        presented={[{ path: '../secret.txt', display: 'secret.txt' }]}
      />,
    );
    expect(screen.getByText('没有可用的主机路径')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(openPath).not.toHaveBeenCalled();
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  it('uses 全部 n 个文件 for the presented fold, not 产物', () => {
    render(<TurnTail turnId="turn-1" workspace="D:/ws" changes={[]} presented={presented(5)} />);
    expect(screen.getByText('全部 5 个文件')).toBeTruthy();
    expect(screen.queryByText('file-05.txt')).toBeNull();
    expect(screen.queryByText(/产物/)).toBeNull();
  });

  it('lets a single presented file span the full row', () => {
    render(
      <TurnTail
        turnId="turn-1"
        workspace="D:/ws"
        changes={[]}
        presented={[{ path: 'a.txt', display: 'a.txt', description: '文件读写测试' }]}
      />,
    );
    expect(screen.getByTestId('presented-files').getAttribute('data-single')).toBe('true');
  });

  it('strips trailing parentheses from presented descriptions', () => {
    render(
      <TurnTail
        turnId="turn-1"
        workspace="D:/ws"
        changes={[]}
        presented={[{ path: 'a.txt', display: 'a.txt', description: '季度摘要 (内部)' }]}
      />,
    );
    expect(screen.getByText('季度摘要')).toBeTruthy();
    expect(screen.queryByText(/内部/)).toBeNull();
  });

  it('shows opening then the dock status after the right-side open succeeds', async () => {
    let finish = (_where: 'dock' | 'system') => {};
    openWorkspaceFile.mockImplementation(
      () =>
        new Promise<'dock' | 'system'>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <TurnTail
        turnId="turn-1"
        workspace="D:/ws"
        changes={[]}
        presented={[{ path: 'a.txt', display: 'a.txt', description: '文件读写测试' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(screen.getByText('正在打开…')).toBeTruthy();
    await act(async () => {
      finish('dock');
    });
    expect(screen.getByText('已在右侧文件标签中打开')).toBeTruthy();
  });

  it('reports the default program when the file had to fall back to the system', async () => {
    openWorkspaceFile.mockResolvedValue('system');
    render(
      <TurnTail turnId="turn-1" workspace="D:/ws" changes={[]} presented={[{ path: 'a.zip', display: 'a.zip' }]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(await screen.findByText('已在默认程序中打开')).toBeTruthy();
  });

  it('opens a file in the directory the session had moved to, not under the project root', async () => {
    openWorkspaceFile.mockResolvedValue('dock');
    render(
      <TurnTail
        turnId="turn-1"
        workspace="D:\\Proj\\App"
        changes={[]}
        presented={[{ path: 'docs/r.md', display: 'r.md', cwd: 'E:\\extract' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(openWorkspaceFile).toHaveBeenCalledWith('E:/extract/docs/r.md', 'E:\\extract');
  });

  it('opens an absolute file outside the project instead of disabling the card', async () => {
    openWorkspaceFile.mockResolvedValue('dock');
    render(
      <TurnTail
        turnId="turn-1"
        workspace="D:/ws"
        changes={[]}
        presented={[{ path: 'F:/other/n.txt', display: 'n.txt' }]}
      />,
    );
    expect(screen.queryByText('没有可用的主机路径')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(openWorkspaceFile).toHaveBeenCalledWith('F:/other/n.txt', 'F:/other');
  });

  it('shows a retry hint when opening fails', async () => {
    openWorkspaceFile.mockRejectedValue(new Error('boom'));
    render(
      <TurnTail turnId="turn-1" workspace="D:/ws" changes={[]} presented={[{ path: 'a.zip', display: 'a.zip' }]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    expect(await screen.findByText('打开失败，点击重试')).toBeTruthy();
  });

  it('always opens with the system program when the user picks it from the menu', async () => {
    openPath.mockResolvedValue(undefined);
    render(
      <TurnTail
        turnId="turn-1"
        workspace="D:/ws"
        changes={[]}
        presented={[{ path: 'a.txt', display: 'a.txt', description: '文件读写测试' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'a.txt 的更多文件操作' }));
    fireEvent.click(await screen.findByText('用默认应用打开'));
    expect(openPath).toHaveBeenCalledWith('D:/ws/a.txt');
    expect(openWorkspaceFile).not.toHaveBeenCalled();
    expect(await screen.findByText('已在默认程序中打开')).toBeTruthy();
  });

  it('offers default-app and reveal actions in the split menu', async () => {
    render(
      <TurnTail
        turnId="turn-1"
        workspace="D:/ws"
        changes={[]}
        presented={[{ path: 'a.txt', display: 'a.txt', description: '文件读写测试' }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'a.txt 的更多文件操作' }));
    expect(await screen.findByText('用默认应用打开')).toBeTruthy();
    expect(screen.getByText(/文件资源管理器|Finder|所在文件夹/)).toBeTruthy();
    fireEvent.click(screen.getByText(/文件资源管理器|Finder|所在文件夹/));
    expect(revealItemInDir).toHaveBeenCalled();
  });
});
