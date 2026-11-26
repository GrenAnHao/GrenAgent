import { App, Button, Dropdown, Input, Select } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Layers3, ArrowLeft, Ellipsis, PencilLine, RotateCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { copyText, McpConfigValue } from './McpConfigValues';
import { useMcpInspection } from './useMcpInspection';
import type { pi, McpConfigScope } from '../../lib/pi';
import type { McpServerStatus } from '../../stores/mcpStatusStore';
import { McpServerCard } from './McpServerCard';
import type { McpEntry } from './mcpConfig';
import type { Perm } from './mcpPolicy';
import { mcpStatusDotColor, mcpStatusText, resolveMcpStatus } from './mcpPresentation';
import { getCacheEntry, getCachedTools, type CacheEntry } from './mcpToolsCache';

type ManagedEntry = McpEntry & { scope: McpConfigScope };

interface McpWorkbenchProps {
  workspace: string;
  inspect?: typeof pi.inspectMcpServer;
  entries: ManagedEntry[];
  runtimeServers: McpServerStatus[];
  budgets?: ReturnType<typeof import('./mcpBudget').workspaceBudget>['byServer'];
  toolsCache: Record<string, CacheEntry>;
  probing: ReadonlySet<string>;
  policyRaw: Record<string, unknown>;
  onToggle: (entry: ManagedEntry, enabled: boolean) => void;
  onEdit: (entry: ManagedEntry) => void;
  onDelete: (entry: ManagedEntry) => void;
  onReload: (name: string) => void | Promise<void>;
  onPermChange: (fullName: string, perm: Perm) => void;
  onPermChangeMany?: (fullNames: string[], perm: Perm, confirmedMixed?: boolean) => void;
  onOpenRules: (fullName: string) => void;
}

const styles = createStaticStyles(({ css }) => ({
  workbench: css`
    display: grid;
    flex: 1;
    grid-template-columns: clamp(198px, 20%, 248px) minmax(0, 1fr);
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
    overscroll-behavior: contain;
    padding: 8px;
    border-inline-end: 1px solid var(--gren-master-divider);
    background: var(--gren-master-bg);

    @container extension-content (max-width: 680px) {
      border-inline-end: 0;
      [data-mobile-detail='true'] > & { display: none; }
    }
  `,
  maskedEmpty: css`margin:auto; color:${cssVar.colorTextSecondary}; font-size:var(--gren-font-body);`,
  filters: css`position:sticky; inset-block-start:-8px; z-index:2; display:grid; gap:6px; padding:4px 2px 8px; background:var(--gren-master-bg); & > div {display:flex; align-items:center; gap:4px;} .ant-select {flex:1;}`,
  row: css`display:flex; align-items:center; flex:none; gap:2px; border-radius:7px; margin-bottom:3px; border:1px solid transparent;
    &:hover {background:${cssVar.colorFillQuaternary};} &[data-selected='true'] {background:${cssVar.colorPrimaryBg}; border-color:${cssVar.colorPrimaryBorder}; box-shadow:inset 3px 0 ${cssVar.colorPrimary};}
    & > button:last-child {margin-right:3px; opacity:0.5;} &:hover > button:last-child, &:focus-within > button:last-child {opacity:1;}
  `,
  item: css`
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 7px 8px;
    border: 0;
    border-radius: 7px;
    text-align: start;
    color: ${cssVar.colorText};
    background: transparent;
    cursor: pointer;

  `,
  itemCopy: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  `,
  name: css`
    font-size: var(--gren-font-body);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  state: css`
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-secondary);
    overflow-wrap: anywhere;
  `,
  load: css`display:inline-flex; align-items:center; gap:3px; margin-inline-start:5px; font-size:var(--gren-font-caption); color:${cssVar.colorTextSecondary}; font-variant-numeric:tabular-nums;`,
  dot: css`
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  `,
  detail: css`
    /* 服务器标题和操作不参与滚动；正文在卡片内部消费剩余高度。 */
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: ${cssVar.colorBgContainer};
    padding: 16px 18px;
    @media (max-height: 560px) { padding: 8px 14px; }

    @container extension-content (max-width: 680px) {
      [data-mobile-detail='false'] > & { display: none; }
    }
  `,
  back: css`
    display: none;
    align-items: center;
    gap: 6px;
    flex: none;
    margin-block-end: 18px;
    @media (max-height:560px) { margin-block-end:4px; }
    padding: 0;
    border: 0;
    color: ${cssVar.colorTextSecondary};
    background: transparent;
    font-size: var(--gren-font-body);
    cursor: pointer;

    @container extension-content (max-width: 680px) { display: inline-flex; align-self: flex-start; }
  `,
  config: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-block-start: 16px;
  `,
  configHeading: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-block-end: 12px;
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-secondary);
  `,
  summary: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
    margin: 0;
    font-size: var(--gren-font-body);
    > div { min-width: 0; }
    dt { margin-block-end: 4px; color: ${cssVar.colorTextSecondary}; font-size: var(--gren-font-secondary); }
    dd { margin: 0; overflow-wrap: anywhere; }
    code { font-size: var(--gren-font-secondary); }
  `,
}));

interface ConfigRow { label: string; values: string[]; fields?: Record<string, unknown> }

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function shellArg(arg: string): string {
  return arg === '' || /[\s"']/.test(arg) ? JSON.stringify(arg) : arg;
}

/** 配置来自用户可手写的文件，非法值不能成为 React 子节点。 */
function connectionRows(config: McpEntry['config']): ConfigRow[] {
  const rows: ConfigRow[] = [];
  if ('url' in config) {
    rows.push({ label: '服务地址', values: [typeof config.url === 'string' ? config.url : '格式无效'] });
    const headers = objectKeys(config.headers);
    if (headers.length) rows.push({ label: '请求头', values: headers, fields: config.headers });
    return rows;
  }
  const command = typeof config.command === 'string' ? [config.command, ...stringList(config.args)].map(shellArg).join(' ') : '格式无效';
  rows.push({ label: '启动命令', values: [command] });
  if (typeof config.cwd === 'string' && config.cwd) rows.push({ label: '工作目录', values: [config.cwd] });
  const env = objectKeys(config.env);
  if (env.length) rows.push({ label: '环境变量', values: env, fields: config.env });
  return rows;
}

export function McpWorkbench({ workspace, inspect, entries, runtimeServers, budgets, toolsCache, probing, policyRaw, onToggle, onEdit, onDelete, onReload, onPermChange, onPermChangeMany, onOpenRules }: McpWorkbenchProps) {
  const [selection, setSelection] = useState<{ workspace: string; name: string; scope: McpConfigScope } | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const preferred = entries.find((entry) => selection?.workspace === workspace && entry.name === selection.name && entry.scope === selection.scope) ?? entries[0];
  useEffect(() => {
    setSelection((current) => {
      if (current?.workspace === workspace && entries.some((entry) => entry.name === current.name && entry.scope === current.scope)) return current;
      const first = entries[0];
      return first ? { workspace, name: first.name, scope: first.scope } : null;
    });
  }, [workspace, entries]);
  useEffect(() => { setMobileDetail(false); }, [workspace]);
  const { message } = App.useApp();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [reloading, setReloading] = useState(false);
  const liveByName = new Map(runtimeServers.map(server => [server.name, server]));
  const rows = entries.map(entry => {
    const live = liveByName.get(entry.name);
    const cache = getCacheEntry(toolsCache, entry.name);
    const input = { enabled: entry.enabled, probing: probing.has(entry.name), probeError: cache?.ok === false ? cache.error || '探测失败' : undefined,
      error: live?.error, cached: cache?.ok, count: (live?.toolNames ?? cache?.toolNames ?? []).length, status: resolveMcpStatus(live?.status, live?.loginUrl) };
    const failed = entry.enabled && (input.status === 'failed' || (!input.status && !!input.probeError));
    return { entry, input, failed };
  });
  const failures = rows.filter(row => row.failed && !row.input.probing);
  const visible = rows.filter(({entry,input,failed}) => entry.name.toLowerCase().includes(query.trim().toLowerCase()) &&
    (group === 'all' || (group === 'enabled' && entry.enabled) || (group === 'connected' && entry.enabled && input.status === 'connected') || (group === 'failed' && failed) || (group === 'disabled' && !entry.enabled)));
  const selected = visible.some(row => row.entry === preferred) ? preferred : visible[0]?.entry;
  const runtime = selected ? liveByName.get(selected.name) : undefined;
  const observation = useMcpInspection(workspace, (selected ?? preferred)?.name, runtime?.attemptedAt, inspect);
  const selectedCache = selected ? getCacheEntry(toolsCache, selected.name) : undefined;
  const configRows = selected ? connectionRows(selected.config) : [];
  const reloadFailed = async () => {
    setReloading(true);
    try { for (const {entry} of failures) await onReload(entry.name); }
    finally { setReloading(false); }
  };
  const identity = JSON.stringify([workspace, selected?.scope, selected?.name]);
  return (
    <div className={styles.workbench} data-testid="mcp-workbench" data-mobile-detail={mobileDetail}>
      <aside className={styles.directory} data-testid="mcp-directory" aria-label="服务器目录">
        <div className={styles.filters}>
          <Input size="small" aria-label="搜索服务器" placeholder="搜索服务器" prefix={<Search size={13}/>} allowClear value={query} onChange={e => setQuery(e.target.value)}/>
          <div><Select data-testid="mcp-directory-status" aria-label="服务器状态" size="small" value={group} onChange={setGroup} options={[
            {value:'all',label:`全部状态 · ${entries.length}`}, {value:'enabled',label:'已启用'}, {value:'connected',label:'已连接'}, {value:'failed',label:'连接失败'}, {value:'disabled',label:'未启用'}
          ]}/><Button size="small" type="text" aria-label="重载全部异常项" title={`重载全部异常项（${failures.length}）`} disabled={!failures.length || reloading} onClick={() => void reloadFailed()} icon={<RotateCw size={14}/>}>{failures.length ? `异常重载 ${failures.length}` : null}</Button></div>
        </div>
        {!visible.length && <p className={styles.state}>没有匹配的服务器</p>}
        {visible.map(({ entry, input }) => {
          const active = selected?.name === entry.name && selected.scope === entry.scope;
          const budget = budgets?.get(entry.name);
          const heavy = budget && (budget.available > 30 || budget.permittedChars > 12000);
          const cachedOnly = input.enabled && !input.status && !input.probing && !input.probeError && (input.cached || input.count > 0);
          const actions = [{key:'toggle',label:entry.enabled?'停用':'启用'}, {key:'reload',label:'重载',disabled:!entry.enabled || input.probing || input.status === 'connecting'}, {key:'copy',label:'复制完整配置（含凭据）'}];
          const menu = { items: actions, onClick: ({key}: {key:string}) => {
            if (key === 'toggle') onToggle(entry, !entry.enabled);
            if (key === 'reload') onReload(entry.name);
            if (key === 'copy') void copyText(JSON.stringify({mcpServers:{[entry.name]:entry.config}}, null, 2), message);
          }};
          const dotColor = mcpStatusDotColor(input);
          return (
            <Dropdown key={`${entry.scope}:${entry.name}`} trigger={['contextMenu']} menu={menu}><div className={styles.row} data-selected={active} data-status={entry.enabled ? input.status : undefined}>
            <button type="button" className={styles.item} data-testid={`mcp-select-${entry.name}`} aria-pressed={active} onClick={() => { setSelection({ workspace, name: entry.name, scope: entry.scope }); setMobileDetail(true); }}>
              <span className={styles.dot} style={{ background: cachedOnly ? 'transparent' : dotColor, border: `1px solid ${dotColor}` }} title={cachedOnly ? '仅命中本地缓存，没有活动连接' : undefined} aria-hidden="true" />
              <span className={styles.itemCopy}><span className={styles.name} title={entry.name}>{entry.name}</span><span className={styles.state}>{mcpStatusText(input)}{heavy && <span className={styles.load} aria-label={`高开销，可用定义约 ${budget.permitted} tokens`} title={`${budget.available} 个可用工具的定义约 ${budget.permitted} tokens；按需工具不常驻。`}><Layers3 size={11}/>{budget.permitted}</span>}</span></span>
            </button>
            <Dropdown menu={menu} trigger={['click']}><Button type="text" size="small" aria-label={`${entry.name} 快捷操作`} icon={<Ellipsis size={15}/>}/></Dropdown>
            </div></Dropdown>
          );
        })}
      </aside>
      <section className={styles.detail} data-testid="mcp-detail" aria-label="服务器详情">
        <button type="button" className={styles.back} data-testid="mcp-back" onClick={() => setMobileDetail(false)}><ArrowLeft size={14} />服务器列表</button>
        {selected ? <>
          <McpServerCard
            key={`server:${identity}`} workspace={workspace} cached={selectedCache?.ok}
            catalog={runtime?.status === 'connected' ? observation?.catalog : selectedCache?.catalog}
            runtimeError={runtime?.error} diagnostics={runtime ? (observation?.diagnostics?.attemptedAt === runtime.attemptedAt ? observation?.diagnostics : undefined) ?? (runtime.attemptedAt ? {attemptedAt: runtime.attemptedAt, stderr: []} : undefined) : selectedCache ? { attemptedAt: selectedCache.probedAt, stderr: selectedCache.stderr ?? [], exit: selectedCache.exit } : undefined}
            connectionPanel={<section key={`config:${identity}`} className={styles.config} aria-label="连接配置">
              <div className={styles.configHeading}>
                <span>连接配置</span>
                <Button size="small" type="link" icon={<PencilLine size={14} />} aria-label={`编辑 ${selected.name}`} data-testid={`mcp-edit-${selected.name}`} onClick={() => onEdit(selected)}>编辑</Button>
              </div>
              <dl className={styles.summary}>
                {configRows.map((row) => (
                  <div key={row.label}><dt>{row.label}</dt><dd>{row.fields ? row.values.map(field => <McpConfigValue key={field} field={field} value={row.fields?.[field]}/>) : <code>{row.values[0]}</code>}</dd></div>
                ))}
              </dl>
            </section>}
            detail name={selected.name} config={selected.config} enabled={selected.enabled} scope={selected.scope}
            cachedTools={getCachedTools(toolsCache, selected.name)} runtimeStatus={runtime?.status} runtimeToolNames={runtime?.toolNames} footprints={runtime?.footprints}
            loginUrl={runtime?.loginUrl} exposure={runtime?.exposure} auth={runtime?.auth}
            probing={probing.has(selected.name)} probeError={selectedCache?.ok === false ? selectedCache.error || '探测失败' : undefined}
            policyRaw={policyRaw} onToggle={(enabled) => onToggle(selected, enabled)} onEdit={() => onEdit(selected)} onDelete={() => onDelete(selected)}
            onReload={() => onReload(selected.name)} onPermChange={onPermChange} onPermChangeMany={onPermChangeMany} onOpenRules={onOpenRules}
          />
          {observation?.error && <small role="status">实时状态读取失败：{observation.error}</small>}
        </> : <p className={styles.maskedEmpty}>没有匹配的服务器，调整左侧筛选即可继续。</p>}
      </section>
    </div>
  );
}
