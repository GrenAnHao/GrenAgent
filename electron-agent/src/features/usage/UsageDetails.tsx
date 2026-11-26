import { useEffect, useMemo, useState } from 'react';
import { Pagination, Select, Tooltip } from 'antd';
import { cx } from 'antd-style';
import { CALL_PAGE_SIZE, type CallPage, type UsageFilters, type UsageReport } from '../../lib/usageReport';
import { useProviderList } from '../settings/providerListCache';
import { exactUsageTokens, formatTableCost, formatUsageTokens } from './usageFormat';
import { RecentUsageSessions } from './RecentUsageSessions';
import styles from './UsagePanel.module.css';

import { pi } from '../../lib/pi';
import { Info } from 'lucide-react';

const sources = { catalog:'按本地目录单价估算', provider:'供应商报告的实际费用', unknown:'费用来源未报告' };


export function UsageDetails({ report, range, projectId }: { report: UsageReport } & UsageFilters) {
  const [callPage, setCallPage] = useState(1);
  // 调用明细里的 provider 是 id，显示成供应商显示名（取不到回落 id）。
  const providerList = useProviderList();
  const providerNameOf = (id: string) => providerList.find((p) => p.id === id)?.name ?? id;

  const [provider,setProvider] = useState(''), [model,setModel] = useState('');
  const [revision,retry] = useState(0);
  // The report preview is already complete for small periods. Never filter a truncated preview.
  const preview = report.calls ?? [];
  const remote = preview.length === 500 && report.totals.messages > preview.length;
  const query = useMemo(() => ({range, ...(projectId && {projectId}), page:callPage, provider, model}), [range,projectId,callPage,provider,model]);
  const [response,setResponse] = useState<{query:typeof query; report:UsageReport; data?:CallPage; error?:string}>();
  useEffect(() => {
    if (!remote) return;
    let current = true;
    pi.getUsageCalls(query).then(data => { if(current) setResponse({query,report,data}); },
      e => { if(current) setResponse({query,report,error:String(e)}); });
    return () => {current=false;};
  },[remote,query,report,revision]);
  const result = response?.query === query && response.report === report ? response : undefined;
  const local = preview.filter(c=>(!provider || c.provider===provider) && (!model || c.model===model));
  const data = remote ? result?.data : undefined;
  const total = remote ? data?.total : local.length;
  const curCallPage = data?.page ?? Math.min(callPage, Math.max(1,Math.ceil(local.length / CALL_PAGE_SIZE)));
  const pagedCalls = remote ? data?.rows ?? [] : local.slice((curCallPage-1)*CALL_PAGE_SIZE,curCallPage*CALL_PAGE_SIZE);
  const options = (remote ? response?.data : undefined);
  const providers = options?.providers ?? [...new Set(preview.map(c=>c.provider))].sort();
  const models = options?.models ?? [...new Set(preview.map(c=>c.model))].sort();
  return (<>
      <RecentUsageSessions sessions={report.recentSessions}/>
      <section className={styles.card} aria-label="模型调用明细">
        <header className={styles.recentHead}><h2 className={styles.cardTitle}>模型调用明细 <span className={styles.count}>{total?.toLocaleString('en-US') ?? '…'}</span></h2>
          <div className={styles.recentTools}>
            <Select aria-label="按供应商筛选调用" size="small" popupMatchSelectWidth={false} value={provider} onChange={v=>{setProvider(v);setCallPage(1);}}
              options={[{value:'',label:'全部供应商'},...providers.map(v=>({value:v,label:providerNameOf(v)}))]}/>
            <Select aria-label="按请求模型筛选调用" size="small" popupMatchSelectWidth={false} value={model} onChange={v=>{setModel(v);setCallPage(1);}}
              options={[{value:'',label:'全部模型'},...models.map(v=>({value:v,label:v}))]}/>
          </div></header>
        <div className={styles.scrollWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={cx(styles.th, styles.thSticky)}>时间</th>
                <th className={cx(styles.th, styles.thSticky)}>供应商</th>
                <th className={cx(styles.th, styles.thSticky)}>请求模型 / 响应模型</th>
                <th className={cx(styles.thRight, styles.thSticky)}>输入</th>
                <th className={cx(styles.thRight, styles.thSticky)}>输出</th>
                <th className={cx(styles.thRight, styles.thSticky)}>缓存读</th>
                <th className={cx(styles.thRight, styles.thSticky)}>缓存写</th>
                <th className={cx(styles.thRight, styles.thSticky)}>总计</th>
                <th className={cx(styles.thRight, styles.thSticky)}>费用</th>
              </tr>
            </thead>
            <tbody>
              {pagedCalls.map((c, i) => (
                <tr key={`${c.timestamp ?? 'na'}-${(curCallPage - 1) * CALL_PAGE_SIZE + i}`}>
                  <td className={styles.td}>{c.timestamp ? new Date(c.timestamp).toLocaleString() : '—'}</td>
                  <td className={styles.td} title={providerNameOf(c.provider)}>{c.provider ? providerNameOf(c.provider) : '—'}</td>
                  <td className={styles.td} title={c.responseModel && c.responseModel !== c.model ? c.model+' → '+c.responseModel : c.model}>{c.model}{c.responseModel && c.responseModel !== c.model && ' → '+c.responseModel}</td>
                  {[c.input, c.output, c.cacheRead, c.cacheWrite, c.totalTokens].map((n, column) =>
                    <td key={column} className={cx(styles.tdRight, 'font-mono')} title={exactUsageTokens(n)}>{formatUsageTokens(n)}</td>
                  )}
                  <td className={cx(styles.tdRight, c.cost === 0 && styles.zero)}>{formatTableCost(c.cost)} <Tooltip trigger={['hover','focus']} title={sources[c.costSource ?? 'unknown']}><span tabIndex={0} className={styles.costInfo} aria-label={sources[c.costSource ?? 'unknown']}><Info size={11}/></span></Tooltip></td>
                </tr>
              ))}
              {!pagedCalls.length && (
                <tr>
                  <td className={styles.td} colSpan={9}>{result?.error ? <span role="alert">{result.error} <button onClick={()=>{setResponse(undefined);retry(v=>v+1);}}>重试</button></span> : total === undefined ? '正在读取调用…' : '没有匹配的调用'}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {total !== undefined && total > CALL_PAGE_SIZE && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <Pagination
              size="small"
              current={curCallPage}
              pageSize={CALL_PAGE_SIZE}
              total={total}
              showSizeChanger={false}
              onChange={setCallPage}
            />
          </div>
        )}
      </section>
  </>);
}
