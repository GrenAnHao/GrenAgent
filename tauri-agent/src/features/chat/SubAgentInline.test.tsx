import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@lobehub/ui';
import { SubAgentInline } from './SubAgentInline';

afterEach(cleanup);

const wrap = (ui: React.ReactElement) =>
  render(<ThemeProvider themeMode="dark">{ui}</ThemeProvider>);

describe('SubAgentInline', { timeout: 30_000 }, () => {
  it('折叠头显示子代理编号与任务名', () => {
    wrap(<SubAgentInline index={1} task="分析工具渲染" result={{}} status="done" />);
    expect(screen.getByText(/子代理 #1/)).toBeTruthy();
    expect(screen.getByText(/分析工具渲染/)).toBeTruthy();
  });

  it('运行中显示运行提示', () => {
    wrap(<SubAgentInline index={2} task="分析主结构" result={{}} status="running" />);
    expect(screen.getByText(/运行中/)).toBeTruthy();
  });
});
