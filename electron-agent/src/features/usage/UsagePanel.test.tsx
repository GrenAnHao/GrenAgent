import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { UsageReport } from '../../lib/usageReport';
const api = vi.hoisted(() => ({ getUsageCalls: vi.fn(), getUsageReport: vi.fn(), reconcileUsage: vi.fn(async () => ({ added: 0 })) }));
vi.mock('../../lib/pi', () => ({ pi: api }));
vi.mock('./UsageCharts', () => ({ UsageCharts: () => null, useUsageChartMetrics: () => ({}) }));
vi.mock('../settings/providerListCache', () => ({ useProviderList: () => [] }));
vi.mock('../../store', () => ({
  useSessionStore: Object.assign((select: Function) => select({
    allSessions: [{ path: '/a', name: '{"isNewTopic":true,"title":"登录状态颜色"}' }], worksDir: '/.pi/works',
  }), { getState: () => ({}) }),
}));
import { UsagePanel } from './UsagePanel';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const firstCall = {timestamp:null,provider:'p',model:'alias',responseModel:'actual',costSource:'provider' as const,cost:0.12,input:1,output:0,cacheRead:0,cacheWrite:0,totalTokens:1};
const base = {
  totals:{input:3,output:0,cacheRead:0,cacheWrite:0,totalTokens:3,cost:0.22,sessions:1,messages:3,cacheHitRate:0},
  projects: [], byDay:[], byModel:[], byProject:[],
  recentSessions:[{id:'a',path:'/a',name:null,cwd:'/.pi/works/uuid',timestamp:null,tokens:3,cost:0.22}],
  calls:[firstCall,{...firstCall,model:'old',responseModel:null,costSource:'unknown',cost:0.1}],
  warmingTotals:{cost:0.03,messages:1,totalTokens:1}, warmingCalls:[],
  recordedCost:{assistantCost:0.22,warmingCost:0.03,totalCost:0.25,sourceBreakdown:{provider:0.12,catalog:0.03,unknown:0.1}},
} satisfies UsageReport;

it('shows cost sources and total, keeps request and response identities, and cleans a live sidebar title', async () => {
  api.getUsageReport.mockResolvedValue(base);
  render(<UsagePanel/>);
  await screen.findByText('alias → actual');
  expect(screen.queryByText(/未报告$/)).toBeNull();
  expect(screen.getByText('登录状态颜色')).toBeTruthy();
  expect(screen.queryByText(/isNewTopic/)).toBeNull();
  expect(within(screen.getByTestId('usage-kpis')).getByText('$0.2500')).toBeTruthy();
  const sources = screen.getByTestId('usage-provenance-summary');
  for (const label of ['助手费用', '预热费用', '供应商报告', '目录估算', '来源未知']) {
    expect(within(sources).getByText(label)).toBeTruthy();
  }
  expect(screen.queryByText(/外部导入历史仅展示/)).toBeNull();
  fireEvent.focus(screen.getByRole('button', {name:'口径说明'}));
  expect(await screen.findByText(/外部导入历史仅展示/)).toBeTruthy();
  expect(screen.queryByTestId('warming-usage-table')).toBeNull();
});

it('keeps an old report readable, displays zero explicitly, and retries errors', async () => {
  api.getUsageReport.mockRejectedValueOnce(Error('fixture failed')).mockResolvedValue({
    ...base, recordedCost:undefined, warmingTotals:undefined, calls:[{...firstCall,cost:0}],
  });
  render(<UsagePanel/>);
  await screen.findByText(/fixture failed/);
  fireEvent.click(screen.getByText('重试'));
  expect(await screen.findByText('旧报表：费用来源未知，预热费用未提供')).toBeTruthy();
  expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0);
});

it('does not show an old KPI under a new filter or let a slower query replace the latest report', async () => {
  let finishSeven!: (r: UsageReport) => void;
  const pending = new Promise<UsageReport>(resolve => { finishSeven = resolve; });
  api.getUsageReport.mockImplementation(({range}) => range === '7d' ? pending : Promise.resolve({
    ...base, totals: {...base.totals, totalTokens: range === '30d' ? 120 : 320},
  }));
  render(<UsagePanel/>);
  await waitFor(() => expect(screen.getByTestId('usage-token-total').textContent).toBe('320'));
  fireEvent.click(screen.getByText('近 7 天'));
  expect(screen.queryByTestId('usage-token-total')).toBeNull();
  fireEvent.click(screen.getByText('近 30 天'));
  await waitFor(() => expect(screen.getByTestId('usage-token-total').textContent).toBe('120'));
  await act(async () => {finishSeven(base);});
  expect(screen.getByTestId('usage-token-total').textContent).toBe('120');
  expect(api.getUsageReport).toHaveBeenCalledWith({range:'7d', includeAllSessions:true});
});

it('pages the full ledger instead of searching a capped local preview, and retries a failed page', async () => {
  api.getUsageReport.mockResolvedValue({...base,totals:{...base.totals,messages:501},calls:Array(500).fill(firstCall)});
  const data={page:1,total:501,providers:['p'],models:['alias'],rows:[{...firstCall,model:'full-result'}]};
  api.getUsageCalls.mockResolvedValueOnce(data).mockRejectedValueOnce(Error('调用读取失败')).mockResolvedValueOnce({...data,page:2});
  render(<UsagePanel/>);
  const table=within(await screen.findByRole('region',{name:'模型调用明细'}));
  expect(await table.findByText('501')).toBeTruthy();
  fireEvent.click(table.getByText('2'));
  expect((await table.findByRole('alert')).textContent).toContain('调用读取失败');
  fireEvent.click(table.getByText('重试'));
  expect(await table.findByText('full-result → actual')).toBeTruthy();
  expect(api.getUsageCalls).toHaveBeenLastCalledWith(expect.objectContaining({page:2,range:'all'}));
});
