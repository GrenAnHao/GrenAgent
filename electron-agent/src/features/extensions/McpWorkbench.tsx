import { Button } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { ArrowLeft, PencilLine } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { McpConfigScope } from '../../lib/pi';
import type { McpServerStatus } from '../../stores/mcpStatusStore';
import { McpServerCard } from './McpServerCard';
import type { McpEntry } from './mcpConfig';
import type { Perm } from './mcpPolicy';
import { mcpStatusColor, mcpStatusText, resolveMcpStatus } from './mcpPresentation';
import { getCacheEntry, getCachedTools, type CacheEntry } from './mcpToolsCache';

type ManagedEntry = McpEntry & { scope: McpConfigScope };

interface McpWorkbenchProps {
  workspace: string;
  entries: ManagedEntry[];
  runtimeServers: McpServerStatus[];
  toolsCache: Record<string, CacheEntry>;
  probing: ReadonlySet<string>;
  policyRaw: Record<string, unknown>;
  onToggle: (entry: ManagedEntry, enabled: boolean) => void;
  onEdit: (entry: ManagedEntry) => void;
  onDelete: (entry: ManagedEntry) => void;
  onReload: (name: string) => void;
  onPermChange: (fullName: string, perm: Perm) => void;
  onPermChangeMany?: (fullNames: string[], perm: Perm) => void;
  onOpenRules: (fullName: string) => void;
}

const styles = createStaticStyles(({ css }) => ({
  workbench: css`
    display: grid;
    flex: 1;
    grid-template-columns: 188px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorBgContainer};

    @container extension-content (max-width: 680px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  directory: css`
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 8px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
    background: var(--gren-sidebar-bg, ${cssVar.colorBgLayout});

    @container extension-content (max-width: 680px) {
      border-inline-end: 0;
      [data-mobile-detail='true'] > & { display: none; }
    }
  `,
  item: css`
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-width: 0;
    margin-block-end: 3px;
    padding: 10px;
    border: 0;
    border-radius: 7px;
    text-align: start;
    color: ${cssVar.colorText};
    background: transparent;
    cursor: pointer;

    &:hover { background: ${cssVar.colorFillTertiary}; }
    &[aria-pressed='true'] { background: ${cssVar.colorPrimaryBg}; }
  `,
  itemCopy: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  `,
  name: css`
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
  `,
  state: css`
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    overflow-wrap: anywhere;
  `,
  dot: css`
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  `,
  detail: css`
    /* 列布局：工具列表自己滚动、连接配置贴底；高度实在不够时才退回整栏滚动。 */
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 22px 22px 20px;

    @container extension-content (max-width: 680px) {
      [data-mobile-detail='false'] > & { display: none; }
    }
  `,
  back: css`
    display: none;
    align-items: center;
    gap: 6px;
    margin-block-end: 18px;
    padding: 0;
    border: 0;
    color: ${cssVar.colorTextSecondary};
    background: transparent;
    font-size: 13px;
    cursor: pointer;

    @container extension-content (max-width: 680px) { display: inline-flex; align-self: flex-start; }
  `,
  config: css`
    flex: none;
    max-height: 45%;
    overflow-y: auto;
    padding-block-start: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  configHeading: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-block-end: 12px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  summary: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
    margin: 0;
    font-size: 13px;
    > div { min-width: 0; }
    dt { margin-block-end: 4px; color: ${cssVar.colorTextSecondary}; font-size: 12px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  `,
  key: css`
    display: inline-block;
    margin: 0 6px 4px 0;
    padding: 1px 6px;
    border-radius: 4px;
    background: ${cssVar.colorFillTertiary};
  `,
  masked: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 12px;
  `,
}));

interface ConfigRow { label: string; values: string[]; secret?: boolean }

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function shellArg(arg: string): string {
  return arg === '' || /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

/** 连接配置要写全：命令带参数、工作目录；环境变量和请求头只列名字，值可能是密钥。 */
function connectionRows(config: McpEntry['config']): ConfigRow[] {
  const raw = config as Record<string, unknown>;
  const rows: ConfigRow[] = [];
  if ('url' in config) {
    rows.push({ label: '服务地址', values: [typeof raw.url === 'string' ? raw.url : '格式无效'] });
    const headers = objectKeys(raw.headers);
    if (headers.length) rows.push({ label: '请求头', values: headers, secret: true });
    return rows;
  }
  const command = typeof raw.command === 'string' ? [raw.command, ...stringList(raw.args)].map(shellArg).join(' ') : '格式无效';
  rows.push({ label: '启动命令', values: [command] });
  if (typeof raw.cwd === 'string' && raw.cwd) rows.push({ label: '工作目录', values: [raw.cwd] });
  const env = objectKeys(raw.env);
  if (env.length) rows.push({ label: '环境变量', values: env, secret: true });
  return rows;
}

export function McpWorkbench({ workspace, entries, runtimeServers, toolsCache, probing, policyRaw, onToggle, onEdit, onDelete, onReload, onPermChange, onPermChangeMany, onOpenRules }: McpWorkbenchProps) {
  const [selection, setSelection] = useState<{ workspace: string; name: string; scope: McpConfigScope } | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const selected = entries.find((entry) => selection?.workspace === workspace && entry.name === selection.name && entry.scope === selection.scope) ?? entries[0];
  useEffect(() => {
    setSelection((current) => {
      if (current?.workspace === workspace && entries.some((entry) => entry.name === current.name && entry.scope === current.scope)) return current;
      const first = entries[0];
      return first ? { workspace, name: first.name, scope: first.scope } : null;
    });
  }, [workspace, entries]);
  useEffect(() => { setMobileDetail(false); }, [workspace]);
  const runtime = selected ? runtimeServers.find((server) => server.name === selected.name) : undefined;
  const selectedCache = selected ? getCacheEntry(toolsCache, selected.name) : undefined;
  const configRows = selected ? connectionRows(selected.config) : [];

  return (
    <div className={styles.workbench} data-testid="mcp-workbench" data-mobile-detail={mobileDetail}>
      <aside className={styles.directory} data-testid="mcp-directory" aria-label="服务器目录">
        {entries.map((entry) => {
          const live = runtimeServers.find((server) => server.name === entry.name);
          const tools = live?.toolNames ?? getCachedTools(toolsCache, entry.name);
          const cache = getCacheEntry(toolsCache, entry.name);
          const input = {
            enabled: entry.enabled,
            probing: probing.has(entry.name),
            probeError: cache?.ok === false ? cache.error : undefined,
            count: tools.length,
            status: resolveMcpStatus(live?.status, live?.loginUrl),
          };
          return (
            <button type="button" key={`${entry.scope}:${entry.name}`} className={styles.item} data-testid={`mcp-select-${entry.name}`} aria-pressed={selected?.name === entry.name && selected.scope === entry.scope} onClick={() => { setSelection({ workspace, name: entry.name, scope: entry.scope }); setMobileDetail(true); }}>
              <span className={styles.dot} style={{ background: mcpStatusColor(input) }} aria-hidden="true" />
              <span className={styles.itemCopy}><span className={styles.name}>{entry.name}</span><span className={styles.state}>{mcpStatusText(input)}</span></span>
            </button>
          );
        })}
      </aside>
      <section className={styles.detail} data-testid="mcp-detail" aria-label="服务器详情">
        <button type="button" className={styles.back} data-testid="mcp-back" onClick={() => setMobileDetail(false)}><ArrowLeft size={14} />服务器列表</button>
        {selected ? <>
          <McpServerCard
            key={`${selected.scope}:${selected.name}`}
            detail name={selected.name} config={selected.config} enabled={selected.enabled} scope={selected.scope}
            cachedTools={getCachedTools(toolsCache, selected.name)} runtimeStatus={runtime?.status} runtimeToolNames={runtime?.toolNames}
            loginUrl={runtime?.loginUrl} exposure={runtime?.exposure} auth={runtime?.auth}
            probing={probing.has(selected.name)} probeError={selectedCache?.ok === false ? selectedCache.error : undefined}
            policyRaw={policyRaw} onToggle={(enabled) => onToggle(selected, enabled)} onEdit={() => onEdit(selected)} onDelete={() => onDelete(selected)}
            onReload={() => onReload(selected.name)} onPermChange={onPermChange} onPermChangeMany={onPermChangeMany} onOpenRules={onOpenRules}
          />
          <section className={styles.config} aria-label="连接配置">
            <div className={styles.configHeading}>
              <span>连接配置</span>
              <Button size="small" type="link" icon={<PencilLine size={14} />} aria-label={`编辑 ${selected.name}`} data-testid={`mcp-edit-${selected.name}`} onClick={() => onEdit(selected)}>编辑</Button>
            </div>
            <dl className={styles.summary}>
              {configRows.map((row) => (
                <div key={row.label}><dt>{row.label}</dt><dd>{row.secret ? <>{row.values.map((key) => <code key={key} className={styles.key}>{key}</code>)}<span className={styles.masked}>值已隐藏</span></> : <code>{row.values[0]}</code>}</dd></div>
              ))}
            </dl>
          </section>
        </> : null}
      </section>
    </div>
  );
}
