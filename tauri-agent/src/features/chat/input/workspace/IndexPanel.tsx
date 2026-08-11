import { useEffect, useMemo, useState } from 'react';
import { Button, Flexbox, Icon, Popover } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronRight, Database, Hammer, Play, RotateCw } from 'lucide-react';
import { codeIntelInit, codeIntelReindex, codeIntelStatus, codeIntelSync } from '../../../../lib/codeIntelIo';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { parseAnsi, parseCodegraphStatus } from '../../../extensions/ansi';
import { wsStyles as s } from './styles';

const mono = 'ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, monospace';

const d = createStaticStyles(({ css }) => ({
  wrap: css`
    display: flex;
    flex-direction: column;

    width: 460px;
    max-height: 420px;
    margin: -4px;
  `,
  head: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
  `,
  title: css`
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  body: css`
    scrollbar-width: thin;
    overflow-y: auto;
    padding: 12px;
  `,
  toolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  `,
  statePill: css`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 9px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
  `,
  statePillOk: css`
    background: ${cssVar.colorSuccessBg};
    color: ${cssVar.colorSuccess};
  `,
  statePillIdle: css`
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorTextTertiary};
  `,
  stateDot: css`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  `,
  statGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
    gap: 8px;
    margin-block-start: 12px;
  `,
  statCard: css`
    padding: 10px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorFillQuaternary};
  `,
  statValue: css`
    font-family: ${mono};
    font-size: 18px;
    font-weight: 650;
    line-height: 1.2;
    color: ${cssVar.colorText};
    font-variant-numeric: tabular-nums;
  `,
  statLabel: css`
    margin-block-start: 3px;
    font-size: 10.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: ${cssVar.colorTextTertiary};
  `,
  detailList: css`
    margin-block-start: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  detailItem: css`
    display: flex;
    gap: 10px;
    font-size: 11.5px;
    line-height: 1.5;
  `,
  detailKey: css`
    flex: 0 0 auto;
    min-width: 58px;
    color: ${cssVar.colorTextTertiary};
  `,
  detailVal: css`
    min-width: 0;
    color: ${cssVar.colorTextSecondary};
    font-family: ${mono};
    word-break: break-all;
  `,
  rawBar: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-block-start: 12px;
  `,
  rawToggle: css`
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    cursor: pointer;
    transition: color 0.16s ease;

    &:hover {
      color: ${cssVar.colorText};
    }
  `,
  // 原始输出面：故意不跟主题走，明暗两套下都是深色终端面。里面的字色来自 parseAnsi 的
  // 16 色 SGR 板，那套板是按深色终端底调的（见 extensions/ansi.ts），换成浅底会让亮色系
  // ANSI 前景全部糊掉。下面的 hairline 边框同理，是「深面上的描边」，与 app 明暗无关。
  log: css`
    margin: 8px 0 0;
    padding: 12px 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: #0e1116;
    color: #abb2bf;
    font-family: ${mono};
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow: auto;
  `,
  empty: css`
    padding: 18px;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    text-align: center;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

export function IndexView({ workspace }: { workspace: string }) {
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const parsed = useMemo(() => parseCodegraphStatus(status), [status]);
  const logSegments = useMemo(() => parseAnsi(status), [status]);
  const loaded = status.trim().length > 0;

  const refreshStatus = async () => {
    setBusy('status');
    try {
      setStatus(await codeIntelStatus(workspace));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const run = async (kind: 'init' | 'sync' | 'reindex') => {
    setBusy(kind);
    try {
      const fn = kind === 'init' ? codeIntelInit : kind === 'sync' ? codeIntelSync : codeIntelReindex;
      setStatus(await fn(workspace));
      await refreshStatus();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // 弹层打开即挂载本视图 → 拉一次状态（按 workspace 计算，运行期不变）。
  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  const details = [
    ...(parsed.project ? [{ label: 'Project', value: parsed.project }] : []),
    ...parsed.details,
  ];
  const rawVisible = showRaw || !parsed.indexed;

  return (
    <div className={d.wrap} data-testid="code-index-panel">
      <div className={d.head}>
        <span className={d.title}>索引（当前 workspace）</span>
        <Flexbox horizontal align="center" gap={8}>
          {loaded ? (
            <span
              className={`${d.statePill} ${parsed.indexed ? d.statePillOk : d.statePillIdle}`}
              data-testid="code-intel-state"
            >
              <span className={d.stateDot} />
              {parsed.indexed ? '已索引' : '未索引'}
            </span>
          ) : null}
          <Button
            size="small"
            icon={<RotateCw size={14} />}
            loading={busy === 'status'}
            data-testid="code-intel-refresh"
            onClick={() => void refreshStatus()}
          >
            刷新
          </Button>
        </Flexbox>
      </div>

      <div className={d.body}>
        <div className={d.toolbar}>
          <Button
            type="primary"
            size="small"
            icon={<Play size={14} />}
            loading={busy === 'init'}
            data-testid="code-intel-init"
            onClick={() => void run('init')}
          >
            初始化
          </Button>
          <Button
            size="small"
            icon={<RotateCw size={14} />}
            loading={busy === 'sync'}
            data-testid="code-intel-sync"
            onClick={() => void run('sync')}
          >
            增量同步
          </Button>
          <Button
            size="small"
            icon={<Hammer size={14} />}
            loading={busy === 'reindex'}
            data-testid="code-intel-reindex"
            onClick={() => void run('reindex')}
          >
            重建
          </Button>
        </div>

        {!loaded ? (
          <div className={d.empty} style={{ marginBlockStart: 12 }}>
            读取索引状态中…
          </div>
        ) : (
          <>
            {parsed.stats.length > 0 ? (
              <div className={d.statGrid}>
                {parsed.stats.map((st) => (
                  <div key={st.label} className={d.statCard}>
                    <div className={d.statValue}>{st.value}</div>
                    <div className={d.statLabel}>{st.label}</div>
                  </div>
                ))}
              </div>
            ) : null}

            {details.length > 0 ? (
              <div className={d.detailList}>
                {details.map((dt) => (
                  <div key={dt.label} className={d.detailItem}>
                    <span className={d.detailKey}>{dt.label}</span>
                    <span className={d.detailVal}>{dt.value}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {parsed.indexed ? (
              <div className={d.rawBar}>
                <button
                  type="button"
                  className={d.rawToggle}
                  data-testid="code-intel-raw-toggle"
                  onClick={() => setShowRaw((v) => !v)}
                >
                  {showRaw ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  原始输出
                </button>
              </div>
            ) : null}

            {rawVisible ? (
              <pre className={d.log} data-testid="code-intel-status">
                {logSegments.map((seg, i) => (
                  <span
                    key={`${i}-${seg.text.length}`}
                    style={{
                      color: seg.color,
                      fontWeight: seg.bold ? 600 : undefined,
                      opacity: seg.dim ? 0.7 : undefined,
                    }}
                  >
                    {seg.text}
                  </span>
                ))}
              </pre>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** 「索引」入口 chip：点开看当前 workspace 的代码图谱索引状态 + 初始化/同步/重建。 */
export function IndexButton() {
  const { workspace } = useAgentStoreContext();
  const [open, setOpen] = useState(false);

  if (!workspace) return null;

  return (
    <Popover
      arrow={false}
      // 关闭态占位用空 span 而非 null：antd Popover content 为空会判定 noTitle，
      // 短路掉 onOpenChange 使点击无法打开（数据懒加载仍由 open 控制）。
      content={open ? <IndexView workspace={workspace} /> : <span />}
      open={open}
      placement="topLeft"
      trigger="click"
      onOpenChange={setOpen}
    >
      <span className={s.chip} data-testid="code-index-button">
        <Icon icon={Database} size={14} />
        <span className={s.muted}>索引</span>
      </span>
    </Popover>
  );
}
