import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace } = vi.hoisted(() => ({
  getSettings: vi.fn((): Promise<Record<string, string>> => Promise.resolve({})),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace },
}));

import { ConnectionsPanel } from './ConnectionsPanel';
import { useImMessagesStore } from '../../stores/imMessagesStore';

// jsdom 下 antd Modal/Switch 首次渲染较慢（本机 transform/import 开销大），放宽超时避免误判。
vi.setConfig({ testTimeout: 30000 });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useImMessagesStore.getState().setConversations([]);
});

describe('ConnectionsPanel', () => {
  it('开启微信：写入 WECHAT_OC_ENABLE，且未待扫码时不弹二维码', async () => {
    render(<ConnectionsPanel />);
    await waitFor(() => expect(screen.getByTestId('wechat-enable')).toBeTruthy());
    fireEvent.click(screen.getByTestId('wechat-enable'));
    // bug2 回归：toggle 的 setValue + 立即 persist 必须把 enable=1 真正写盘。
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ WECHAT_OC_ENABLE: '1' })),
    );
    // bug1 回归：后端未进入 waiting-scan（store 默认 idle），不应弹扫码窗。
    expect(screen.queryByText('微信扫码登录')).toBeNull();
  });

  it('微信启用且有会话时，展开后渲染收发的对话气泡', async () => {
    getSettings.mockResolvedValueOnce({ WECHAT_OC_ENABLE: '1' });
    useImMessagesStore.getState().setConversations([
      {
        user: 'u_abc',
        messages: [
          { role: 'user', text: '帮我查下天气' },
          { role: 'assistant', text: '今天晴，25 度' },
        ],
      },
    ]);
    render(<ConnectionsPanel />);
    // 折叠条带消息总数；默认折叠，气泡内容此时不应出现。
    await waitFor(() => expect(screen.getByTestId('wechat-msgs-toggle')).toBeTruthy());
    expect(screen.getByText('微信会话记录（2）')).toBeTruthy();
    expect(screen.queryByText('帮我查下天气')).toBeNull();
    // 展开后渲染用户消息与助手回复。
    fireEvent.click(screen.getByTestId('wechat-msgs-toggle'));
    expect(screen.getByText('帮我查下天气')).toBeTruthy();
    expect(screen.getByText('今天晴，25 度')).toBeTruthy();
  });

  it('微信启用但无会话时，仍显示常驻入口并展开为空态', async () => {
    getSettings.mockResolvedValueOnce({ WECHAT_OC_ENABLE: '1' });
    render(<ConnectionsPanel />);
    // 微信启用即常驻显示入口（计数为 0），不再因无消息而整块隐藏。
    await waitFor(() => expect(screen.getByTestId('wechat-msgs-toggle')).toBeTruthy());
    expect(screen.getByText('微信会话记录（0）')).toBeTruthy();
    // 展开后是空态提示，而非气泡列表。
    fireEvent.click(screen.getByTestId('wechat-msgs-toggle'));
    expect(screen.getByTestId('wechat-msgs-empty')).toBeTruthy();
    expect(screen.queryByTestId('wechat-msgs')).toBeNull();
  });

  it('微信未启用时不显示会话记录入口', async () => {
    render(<ConnectionsPanel />);
    await waitFor(() => expect(screen.getByTestId('wechat-enable')).toBeTruthy());
    expect(screen.queryByTestId('wechat-msgs-toggle')).toBeNull();
  });
});
