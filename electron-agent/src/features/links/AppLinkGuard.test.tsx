import { cleanup, fireEvent, render } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openInAppBrowser: vi.fn(() => true),
  openUrl: vi.fn(() => Promise.resolve()),
  openWorkspaceFile: vi.fn(() => Promise.resolve('dock')),
  warning: vi.fn(),
}));

vi.mock('../dock/browser/openInAppBrowser', () => ({ openInAppBrowser: mocks.openInAppBrowser }));
vi.mock('../dock/openWorkspaceFile', () => ({ openWorkspaceFile: mocks.openWorkspaceFile }));
vi.mock('../../platform/runtime', async (original) => ({
  ...(await original<typeof import('../../platform/runtime')>()),
  openUrl: mocks.openUrl,
}));

import { useSessionStore } from '../../store/session';
import { AppLinkGuard } from './AppLinkGuard';

beforeEach(() => {
  vi.mocked(App.useApp).mockReturnValue({ message: { warning: mocks.warning } } as never);
  useSessionStore.setState({ activeWorkspace: '/repo' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(link: React.ReactNode) {
  return render(
    <div>
      <AppLinkGuard />
      {link}
    </div>,
  );
}

/** fireEvent 返回 false 表示默认行为（页面导航）被阻止了。 */
const navigationBlocked = (el: Element, init?: MouseEventInit) => !fireEvent.click(el, init);

describe('AppLinkGuard', () => {
  it('对话里的网页链接：阻止导航，在内置浏览器打开', () => {
    const { getByText } = mount(<a href="https://example.com/a" target="_blank" rel="noreferrer">go</a>);
    expect(navigationBlocked(getByText('go'))).toBe(true);
    expect(mocks.openInAppBrowser).toHaveBeenCalledWith('https://example.com/a');
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it('Ctrl / ⌘ 点击：改用系统浏览器', () => {
    const { getByText } = mount(<a href="https://example.com/a">go</a>);
    navigationBlocked(getByText('go'), { ctrlKey: true });
    navigationBlocked(getByText('go'), { metaKey: true });
    expect(mocks.openUrl).toHaveBeenCalledTimes(2);
    expect(mocks.openInAppBrowser).not.toHaveBeenCalled();
  });

  it('链接里嵌了别的元素：点内层同样处理', () => {
    const { getByText } = mount(<a href="https://example.com/a"><strong>bold</strong></a>);
    expect(navigationBlocked(getByText('bold'))).toBe(true);
    expect(mocks.openInAppBrowser).toHaveBeenCalledTimes(1);
  });

  it('中键等同打开；右键不管', () => {
    const { getByText } = mount(<a href="https://example.com/a">go</a>);
    fireEvent(getByText('go'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(mocks.openInAppBrowser).toHaveBeenCalledTimes(1);
    fireEvent(getByText('go'), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    expect(mocks.openInAppBrowser).toHaveBeenCalledTimes(1);
  });

  it('别的组件已经 preventDefault 的不重复处理', () => {
    const { getByText } = mount(
      <a href="https://example.com/a" onClick={(event) => event.preventDefault()}>
        go
      </a>,
    );
    fireEvent.click(getByText('go'));
    expect(mocks.openInAppBrowser).not.toHaveBeenCalled();
  });

  it('项目里的相对路径：在文件标签里打开；解析不了就提示', () => {
    const { getByText } = mount(
      <>
        <a href="src/app.ts">file</a>
        <a href="../../etc/passwd">up</a>
      </>,
    );
    expect(navigationBlocked(getByText('file'))).toBe(true);
    expect(mocks.openWorkspaceFile).toHaveBeenCalledWith('/repo/src/app.ts', '/repo');
    expect(navigationBlocked(getByText('up'))).toBe(true);
    expect(mocks.warning).toHaveBeenCalledWith('无法解析这个本地链接');
  });

  it('锚点静默吞掉，不支持的协议提示', () => {
    const { getByText } = mount(
      <>
        <a href="#top">top</a>
        <a href="javascript:alert(1)">js</a>
      </>,
    );
    expect(navigationBlocked(getByText('top'))).toBe(true);
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(navigationBlocked(getByText('js'))).toBe(true);
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining('javascript'));
  });

  it('download 链接和没有 href 的 <a> 不碰', () => {
    const { getByText } = mount(
      <>
        <a href="https://example.com/f.zip" download>
          dl
        </a>
        <a>plain</a>
      </>,
    );
    expect(navigationBlocked(getByText('dl'))).toBe(false);
    expect(navigationBlocked(getByText('plain'))).toBe(false);
    expect(mocks.openInAppBrowser).not.toHaveBeenCalled();
  });
});
