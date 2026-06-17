import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@lobehub/ui';
import { AccuracyBarChart, BarChart, DonutChart } from '@lobehub/charts';
import { RefreshCw } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { pi } from '../../lib/pi';
import type { UsageReport } from '../../lib/usageReport';
import { formatTokens } from '../../lib/sessionStats';
import { useSessionStore } from '../../store';
import { useModuleStore } from '../../stores/moduleStore';
import { isUnder } from '../../lib/pathUtils';
import { buildConversations, friendlyTime } from '../sessions/useConversations';

function formatCost(n: number): string {
  if (!n) return '—';
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

const COLORS = ['#5b8ff9', '#61ddaa', '#f6bd16', '#7262fd', '#78d3f8', '#f08bb4', '#9661bc', '#ff9d4d'];

/** "2026-06-15" → "6/15"；解析失败时原样返回。 */
function shortDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  return `${Number(m[2])}/${Number(m[3])}`;
}

const styles = createStaticStyles(({ css }) => ({
  root: css`
    height: 100%;
    overflow: auto;
    padding: 20px 24px;
    background: ${cssVar.colorBgLayout};
  `,
  head: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  `,
  title: css`
    font-size: 16px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  sub: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    margin-left: 8px;
  `,
  refresh: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    padding: 4px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgContainer};
    &:hover {
      color: ${cssVar.colorText};
    }
  `,
  kpis: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  `,
  kpi: css`
    padding: 14px 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
  kpiLabel: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    margin-bottom: 6px;
  `,
  kpiValue: css`
    font-size: 22px;
    font-weight: 600;
    color: ${cssVar.colorText};
    font-variant-numeric: tabular-nums;
  `,
  grid: css`
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 16px;
    @media (max-width: 900px) {
      grid-template-columns: 1fr;
    }
  `,
  card: css`
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
    min-width: 0;
  `,
  cardTitle: css`
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
    margin-bottom: 12px;
  `,
  table: css`
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  `,
  th: css`
    text-align: left;
    color: ${cssVar.colorTextTertiary};
    font-weight: 500;
    padding: 6px 8px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
  `,
  thRight: css`
    text-align: right;
    color: ${cssVar.colorTextTertiary};
    font-weight: 500;
    padding: 6px 8px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
  `,
  td: css`
    padding: 6px 8px;
    color: ${cssVar.colorTextSecondary};
    border-bottom: 1px solid ${cssVar.colorFillQuaternary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
  `,
  tdRight: css`
    padding: 6px 8px;
    text-align: right;
    color: ${cssVar.colorText};
    border-bottom: 1px solid ${cssVar.colorFillQuaternary};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `,
  tr: css`
    cursor: pointer;
    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  state: css`
    padding: 40px;
    text-align: center;
    color: ${cssVar.colorTextTertiary};
  `,
  donutRow: css`
    display: flex;
    align-items: center;
    gap: 16px;
    @media (max-width: 480px) {
      flex-direction: column;
      align-items: stretch;
    }
  `,
  donutBox: css`
    flex: 0 0 150px;
    width: 150px;
  `,
  legend: css`
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 200px;
    overflow: auto;
  `,
  legendItem: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  `,
  legendDot: css`
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  `,
  legendName: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${cssVar.colorTextSecondary};
  `,
  legendVal: css`
    color: ${cssVar.colorText};
    font-variant-numeric: tabular-nums;
  `,
  legendPct: css`
    width: 42px;
    text-align: right;
    color: ${cssVar.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,
  tip: css`
    display: flex;
    align-items: center;
    gap: 10px;
    white-space: nowrap;
    padding: 6px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadow};
    font-size: 12px;
  `,
  tipDot: css`
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  `,
  tipName: css`
    color: ${cssVar.colorTextSecondary};
  `,
  tipVal: css`
    color: ${cssVar.colorText};
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  `,
  scrollWrap: css`
    max-height: 360px;
    overflow: auto;
  `,
  thSticky: css`
    position: sticky;
    top: 0;
    z-index: 1;
    background: ${cssVar.colorBgContainer};
  `,
}));

export function UsagePanel() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await pi.getUsageReport());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openSession = useCallback((cwd: string | null, path: string) => {
    if (!cwd) return;
    const st = useSessionStore.getState();
    st.setActiveSession(path);
    st.setActiveWorkspace(cwd);
    useModuleStore.getState().setActiveModule('chat');
  }, []);

  // 普通对话(cwd 在 ~/.pi/agent/works 下)没有项目名，沿用侧边栏的命名口径：
  // 会话标题；无标题则用「M/D HH:MM 对话」友好名，避免「按项目对比」里露出 UUID 目录名。
  const allSessions = useSessionStore((s) => s.allSessions);
  const worksDir = useSessionStore((s) => s.worksDir);
  const convNameByCwd = useMemo(() => {
    const m = new Map<string, string>();
    if (worksDir) for (const c of buildConversations(allSessions, worksDir, '', '')) m.set(c.cwd, c.name);
    return m;
  }, [allSessions, worksDir]);

  if (loading && !report) return <div className={styles.root}><div className={styles.state}>加载中…</div></div>;
  if (error) return <div className={styles.root}><div className={styles.state}>加载失败:{error}</div></div>;
  if (!report) return <div className={styles.root}><div className={styles.state}>暂无数据</div></div>;

  const t = report.totals;
  const trendData = report.byDay.map((d) => ({ date: shortDate(d.date), Token: d.tokens }));
  const modelData = report.byModel.slice(0, 8).map((m) => ({ name: m.model, value: m.tokens }));
  const modelTotal = Math.max(1, t.totalTokens);
  // calls 是后端新增字段；App 后端未重建时可能为 undefined，兜底成空数组避免崩。
  const callRows = report.calls ?? [];
  const projectData = report.byProject.slice(0, 8).map((p) => {
    const casual = !!worksDir && isUnder(p.cwd, worksDir);
    const name = casual
      ? convNameByCwd.get(p.cwd) ?? p.name ?? '普通对话'
      : p.name || (p.cwd ? basename(p.cwd) : '未知');
    return { name, value: p.tokens };
  });

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <div>
          <span className={styles.title}>用量统计</span>
          <span className={styles.sub}>全部项目汇总 · 来自 pi 会话记录</span>
        </div>
        <button type="button" className={styles.refresh} onClick={() => void load()}>
          <Icon icon={RefreshCw} size={13} />
          刷新
        </button>
      </div>

      <div className={styles.kpis}>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>总 Token</div>
          <div className={styles.kpiValue}>{formatTokens(t.totalTokens)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>总费用</div>
          <div className={styles.kpiValue}>{formatCost(t.cost)}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>会话数</div>
          <div className={styles.kpiValue}>{t.sessions}</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>缓存命中率</div>
          <div className={styles.kpiValue}>{Math.round(t.cacheHitRate * 100)}%</div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>助手消息</div>
          <div className={styles.kpiValue}>{t.messages}</div>
        </div>
      </div>

      <div className={styles.card} style={{ marginBottom: 16 }}>
        <div className={styles.cardTitle}>每日 Token 趋势</div>
        {trendData.length > 0 ? (
          <BarChart
            categories={['Token']}
            customTooltip={(props) => {
              const row = props.payload?.[0];
              if (!props.active || !row) return null;
              return (
                <div className={styles.tip}>
                  <span className={styles.tipDot} style={{ background: row.color ?? COLORS[0] }} />
                  <span className={styles.tipName}>{String(props.label ?? '')}</span>
                  <span className={styles.tipVal}>{formatTokens(Number(row.value ?? 0))}</span>
                </div>
              );
            }}
            data={trendData}
            height={200}
            index="date"
            showLegend={false}
            valueFormatter={formatTokens}
          />
        ) : (
          <div className={styles.state}>暂无数据</div>
        )}
      </div>

      <div className={styles.grid}>
        <div className={styles.card}>
          <div className={styles.cardTitle}>按模型占比</div>
          {modelData.length > 0 ? (
            <div className={styles.donutRow}>
              <div className={styles.donutBox}>
                <DonutChart
                  colors={COLORS}
                  customTooltip={(props) => {
                    const row = props.payload?.[0];
                    if (!props.active || !row) return null;
                    return (
                      <div className={styles.tip}>
                        <span className={styles.tipDot} style={{ background: row.color ?? COLORS[0] }} />
                        <span className={styles.tipName}>{String(row.name ?? '')}</span>
                        <span className={styles.tipVal}>{formatTokens(Number(row.value ?? 0))}</span>
                      </div>
                    );
                  }}
                  data={modelData}
                  showLabel={false}
                  showTooltip
                  style={{ height: 150 }}
                  valueFormatter={formatTokens}
                  variant="donut"
                />
              </div>
              <div className={styles.legend}>
                {modelData.map((m, i) => (
                  <div key={m.name} className={styles.legendItem}>
                    <span className={styles.legendDot} style={{ background: COLORS[i % COLORS.length] }} />
                    <span className={styles.legendName} title={m.name}>{m.name}</span>
                    <span className={styles.legendVal}>{formatTokens(m.value)}</span>
                    <span className={styles.legendPct}>{Math.round((m.value / modelTotal) * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.state}>暂无数据</div>
          )}
        </div>
        <div className={styles.card}>
          <div className={styles.cardTitle}>按项目对比(Token)</div>
          {projectData.length > 0 ? (
            <AccuracyBarChart
              accuracyFormatter={formatTokens}
              category="value"
              colorScheme="uniform"
              colors={['#5b8ff9']}
              data={[...projectData].sort((a, b) => b.value - a.value)}
              height={Math.max(180, projectData.length * 44)}
              index="name"
              layout="horizontal"
              showErrorBars={false}
              showPercentage={false}
              valueFormatter={formatTokens}
            />
          ) : (
            <div className={styles.state}>暂无数据</div>
          )}
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>最近会话</div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>会话</th>
              <th className={styles.th}>时间</th>
              <th className={styles.thRight}>Token</th>
              <th className={styles.thRight}>费用</th>
            </tr>
          </thead>
          <tbody>
            {report.recentSessions.map((s) => {
              const casual = !!worksDir && !!s.cwd && isUnder(s.cwd, worksDir);
              // 对话：会话标题 / 友好时间；项目会话：「项目名 - 会话标题」（标题缺省回退 新对话，与侧栏一致）。
              const label = casual
                ? s.name || friendlyTime(s.timestamp)
                : `${s.cwd ? basename(s.cwd) : '未知项目'} - ${s.name || '新对话'}`;
              return (
                <tr key={s.path} className={styles.tr} onClick={() => openSession(s.cwd, s.path)}>
                  <td className={styles.td} title={s.cwd ?? ''}>{label}</td>
                  <td className={styles.td}>{s.timestamp ? new Date(s.timestamp).toLocaleString() : '—'}</td>
                  <td className={styles.tdRight}>{formatTokens(s.tokens)}</td>
                  <td className={styles.tdRight}>{formatCost(s.cost)}</td>
                </tr>
              );
            })}
            {report.recentSessions.length === 0 && (
              <tr>
                <td className={styles.td} colSpan={4}>暂无会话</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={styles.card} style={{ marginTop: 16 }}>
        <div className={styles.cardTitle}>模型调用明细</div>
        <div className={styles.scrollWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={cx(styles.th, styles.thSticky)}>时间</th>
                <th className={cx(styles.th, styles.thSticky)}>模型</th>
                <th className={cx(styles.thRight, styles.thSticky)}>输入</th>
                <th className={cx(styles.thRight, styles.thSticky)}>输出</th>
                <th className={cx(styles.thRight, styles.thSticky)}>缓存读</th>
                <th className={cx(styles.thRight, styles.thSticky)}>缓存写</th>
                <th className={cx(styles.thRight, styles.thSticky)}>总计</th>
                <th className={cx(styles.thRight, styles.thSticky)}>费用</th>
              </tr>
            </thead>
            <tbody>
              {callRows.map((c, i) => (
                <tr key={`${c.timestamp ?? 'na'}-${i}`}>
                  <td className={styles.td}>{c.timestamp ? new Date(c.timestamp).toLocaleString() : '—'}</td>
                  <td className={styles.td} title={c.provider ? `${c.provider} / ${c.model}` : c.model}>{c.model}</td>
                  <td className={styles.tdRight}>{formatTokens(c.input)}</td>
                  <td className={styles.tdRight}>{formatTokens(c.output)}</td>
                  <td className={styles.tdRight}>{formatTokens(c.cacheRead)}</td>
                  <td className={styles.tdRight}>{formatTokens(c.cacheWrite)}</td>
                  <td className={styles.tdRight}>{formatTokens(c.totalTokens)}</td>
                  <td className={styles.tdRight}>{formatCost(c.cost)}</td>
                </tr>
              ))}
              {callRows.length === 0 && (
                <tr>
                  <td className={styles.td} colSpan={8}>暂无调用</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
