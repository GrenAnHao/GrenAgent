// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listenMock, openBrowserPopupTab } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  openBrowserPopupTab: vi.fn(),
}));
vi.mock('../../../platform/runtime', () => ({ listen: listenMock }));
vi.mock('./openBrowserPopupTab', () => ({ openBrowserPopupTab }));

import { useBrowserOpenUrl } from './useBrowserOpenUrl';

describe('useBrowserOpenUrl', () => {
  beforeEach(() => {
    listenMock.mockReset();
    openBrowserPopupTab.mockReset();
  });

  it('opens a popup tab for browser-open-url and unlistens on unmount', async () => {
    const stop = vi.fn();
    let handler: ((event: { payload: unknown }) => void) | undefined;
    listenMock.mockImplementation(async (_event: string, next: (event: { payload: unknown }) => void) => {
      handler = next;
      return stop;
    });
    const hook = renderHook(() => useBrowserOpenUrl());
    await waitFor(() => expect(listenMock).toHaveBeenCalledWith('browser-open-url', expect.any(Function)));
    const payload = { url: 'https://a.test', disposition: 'new-window', sourceTabId: 'src' };
    act(() => {
      handler?.({ payload });
    });
    expect(openBrowserPopupTab).toHaveBeenCalledWith(payload);
    hook.unmount();
    expect(stop).toHaveBeenCalled();
  });
});
