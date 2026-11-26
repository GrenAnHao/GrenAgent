import { App, Button, Dropdown, Input, Modal, Segmented, Switch, Tabs, Tooltip } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Braces, ScrollText, ChevronDown, ChevronRight, PencilLine, RefreshCw, Server, SlidersHorizontal, Trash2 } from 'lucide-react';
import { copyText } from './McpConfigValues';
import { SlowHandshake, McpLogs, DiagnosticCard, McpToolInspector } from './McpInspector';
import type { CatalogTool } from '../../../../extensions/mcp/catalog';
import { diagnosticText, type ConnectionDiagnostics } from '../../../../extensions/mcp/diagnostics';
import { toolBudget } from './mcpBudget';
import { useMemo, useState, type ReactNode } from 'react';
import type { McpConfigScope } from '../../lib/pi';
import { openUrl } from '../../platform/runtime';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useMcpStatusStore, type McpServerStatus } from '../../stores/mcpStatusStore';
import { remoteTransportKind, transportOf, type McpConfig } from './mcpConfig';
import { getToolPerm, shortToolName, type Perm } from './mcpPolicy';
import { mcpStatusDotColor, mcpStatusText, resolveMcpStatus, type McpRuntimeStatus } from './mcpPresentation';

type AuthLabel = 'none' | 'oauth' | 'provider';

interface McpServerCardProps {
  name: string;
  config: McpConfig;
  enabled: boolean;
  detail?: boolean;
  connectionPanel?: ReactNode;
  scope?: McpConfigScope;
  cachedTools?: string[];
  catalog?: CatalogTool[];
  workspace?: string;
  cached?: boolean;
  runtimeError?: string;
  diagnostics?: ConnectionDiagnostics;
  runtimeStatus?: McpRuntimeStatus;
  runtimeToolNames?: string[];
  footprints?: import('../../../../extensions/mcp/definitionSize').ToolFootprint[];
  loginUrl?: string;
  exposure?: string;
  auth?: AuthLabel;
  probing?: boolean;
  probeError?: string;
  policyRaw?: Record<string, unknown>;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onReload?: () => void;
  onPermChange?: (fullName: string, perm: Perm) => void;
  onPermChangeMany?: (fullNames: string[], perm: Perm, confirmedMixed?: boolean) => void;
  onOpenRules?: (fullName: string) => void;
}

const PERM_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '需审批', value: 'needs_approval' },
  { label: '禁用', value: 'disabled' },
];

const EMPTY_CATALOG: CatalogTool[] = [];

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    margin-block-end: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    overflow: hidden;

    &[data-detail='true'] {
      container-type: inline-size;
      container-name: mcp-server-detail;
      margin: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      min-height: 0;
      display: flex;
      flex: 1 1 0px;
      flex-direction: column;
      overflow: hidden;
    }
  `,
  card: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 15px 18px;
  `,
  detailHeader: css`
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-block: 2px 12px;
    @container mcp-server-detail (max-width:600px) {
      justify-content:flex-start; gap:5px 12px;
      > :first-child {flex-basis:100%;}
    }
    @media (max-height:560px) {padding-block:2px 6px;}
  `,
  identity: css`
    display: flex;
    flex: 1;
    align-items: center;
    gap: 11px;
    @media (max-height:560px) {gap:7px;}
    min-width: 0;
  `,
  serverIcon: css`
    display: inline-flex;
    flex: 0 0 38px;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    @media (max-height:560px) {flex-basis:25px; width:25px; height:25px; svg {width:15px;}}
    border-radius: 9px;
    border: 1px solid ${cssVar.colorPrimaryBorder};
    color: ${cssVar.colorPrimary};
    background: ${cssVar.colorPrimaryBg};
  `,
  identityCopy: css`
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    @media (max-height:560px) { flex-direction:row; align-items:center; flex-wrap:wrap; gap:3px 7px; }
  `,
  detailName: css`
    font-size: var(--gren-font-section);
    font-weight: 600;
    letter-spacing: -0.015em;
    overflow-wrap: anywhere;
  `,
  metadata: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-secondary);

    > span { padding:2px 6px; border:1px solid ${cssVar.colorBorderSecondary}; border-radius:5px; background:var(--gren-badge-bg); font-size:var(--gren-font-caption); line-height:15px; font-weight:500; letter-spacing:0.01em; }
    > span[data-help] {cursor:help;}
  `,
  detailStatus: css`
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-secondary);
  `,
  detailActions: css`
    flex: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding-block-end: 12px;
    @media (max-height:560px) {padding-block-end:4px;gap:6px;}
  `,
  switchLabel: css`
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-inline-end: 6px;
    color: ${cssVar.colorText};
    font-size: var(--gren-font-secondary);
    font-weight: 500;
    letter-spacing: 0.01em;
    cursor: pointer;
  `,
  danger: css`
    margin-inline-start: auto;
  `,
  disabled: css`
    opacity: 0.55;
  `,
  expandBtn: css`
    display: inline-flex;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
  `,
  dot: css`
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
  `,
  name: css`
    font-weight: 600;
    letter-spacing: -0.015em;
    font-size: var(--gren-font-body);
    color: ${cssVar.colorText};
  `,
  pill: css`
    font-weight: 500;
    letter-spacing: 0.01em;
    padding: 2px 6px;
    border-radius: 6px;
    background: var(--gren-badge-bg);
    color: ${cssVar.colorTextSecondary};
    font-family: var(--font-mono);
    font-variant-ligatures: none;
    font-size: var(--gren-font-caption);
    text-transform: uppercase;
  `,
  authLabel: css`
    font-weight: 500;
    letter-spacing: 0.01em;
    padding: 2px 6px;
    border-radius: 6px;
    background: var(--gren-badge-bg);
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-caption);
  `,
  grow: css`
    flex: 1;
    min-width: 0;
  `,
  status: css`
    font-size: var(--gren-font-secondary);
    color: ${cssVar.colorTextSecondary};
  `,
  ops: css`
    display: flex;
    align-items: center;
    gap: 14px;
    color: ${cssVar.colorTextTertiary};
  `,
  iconbtn: css`
    display: inline-flex;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 28px;
    padding: 4px;
    border-radius: 6px;

    &:hover { background: ${cssVar.colorFillTertiary}; }

    &:disabled {
      cursor: default;
      opacity: 0.5;
    }
  `,
  compactDanger: css`
    color: ${cssVar.colorError};
    &:hover {
      color: ${cssVar.colorErrorHover};
      background: ${cssVar.colorErrorBg};
    }
  `,
  spin: css`
    animation: mcp-probe-spin 0.9s linear infinite;

    @keyframes mcp-probe-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `,
  tools: css`
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    padding: 8px 18px 12px;

    &[data-detail='true'] {
      display: flex;
      flex: 1 1 0px;
      flex-direction: column;
      min-height:0; overflow:hidden; padding:8px 0 0; border:0;
      @container extensions-module (max-height: 560px) {
        overflow-y:auto; overscroll-behavior:contain;
      }
    }
  `,
  toolHeading: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    padding-block-end: 10px;
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-secondary);
  `,
  content: css`
    display: contents;
    [data-detail='true'] > & {
      display: flex; flex: 1; flex-direction: column; min-height: 0;
      overflow-y: auto; overscroll-behavior: contain;
      > :not(.ant-tabs) { flex-shrink: 0; }
    }
  `,
  tabs: css`
    flex:1; min-height:100px; overflow:hidden;
    > .ant-tabs-nav { margin:0; min-height:36px; position:sticky; top:0; z-index:2; background:${cssVar.colorBgContainer}; }
    .ant-tabs-tab {padding:6px 0; font-weight:500; font-size:var(--gren-font-body);}
    .ant-tabs-body-holder {min-height:0; display:flex; flex-direction:column;}
    .ant-tabs-body, [role="tabpanel"][aria-hidden="false"] {display:flex; flex-direction:column; flex:1; min-height:0; min-width:0;}
    @container mcp-server-detail (max-width:440px) { .ant-tabs-tab + .ant-tabs-tab {margin-inline-start:12px;} }
  `,
  copyName: css`display:block; max-width:100%; overflow:hidden; text-overflow:ellipsis; border:0; padding:0; background:none; font:inherit; color:${cssVar.colorText}; cursor:copy; &:hover, &:focus-visible {color:${cssVar.colorPrimary};}`,
  toolList: css`
    padding-block-end: 8px;
    &[data-server-enabled='false'] { opacity: 0.55; }

    /* 正常高度固定筛选；窄短窗让筛选随工具滚动，保留单一滚动条与可读空间。 */
    [data-detail='true'] > & {
      flex: 1 1 0px;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      @container extensions-module (max-height: 560px) {
        flex: none; overflow: visible;
      }
    }
  `,
  toolFilters: css`flex: none;`,
  bulk: css`&& { height:25px; font-size:var(--gren-font-secondary); }`,
  filter: css`display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin-bottom:8px; > :first-child {flex:1 1 140px;}`,
  description: css`display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:var(--gren-font-secondary)/1.5 var(--font-sans); color:var(--gren-description);`,
  source: css`border:0; padding:0; color:inherit; background:none; font:inherit; letter-spacing:inherit; cursor:pointer; &:hover {color:${cssVar.colorPrimary}; text-decoration:underline;}`,
  token: css`color:${cssVar.colorTextSecondary}; font:var(--gren-font-secondary)/1.4 var(--font-mono); font-variant-numeric:tabular-nums; font-variant-ligatures:none; cursor:help;`,
  warning: css`margin-bottom:8px; color:${cssVar.colorTextSecondary}; font-size:var(--gren-font-secondary);`,
  toolRow: css`
    display: flex;
    align-items: center;
    gap: 7px;
    padding-block: 6px;
    &:not(:last-child) { border-block-end: 1px solid ${cssVar.colorBorderSecondary}; }
    [data-large='true'] > & { content-visibility:auto; contain-intrinsic-size:auto 48px; }

    @container mcp-server-detail (max-width: 440px) {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 6px;
    }
  `,
  permission: css`
    flex: 0 0 auto;

    @container mcp-server-detail (max-width: 440px) {
      grid-column: 1 / -1;
      grid-row: 2;
      width: 100%;
    }
  `,
  toolName: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--gren-font-mono);
    font-weight: 500;
    font-family: var(--font-mono);
    font-variant-ligatures: none;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  hint: css`
    padding: 8px 0;
    font-size: var(--gren-font-body);
    color: ${cssVar.colorTextTertiary};
  `,
  loginRow: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    padding: 10px 18px;

    [data-detail='true'] > & {
      margin-block-end: 14px;
      padding: 10px 12px;
      border: 1px solid ${cssVar.colorWarningBorder};
      border-radius: 8px;
      background: ${cssVar.colorWarningBg};
    }
  `,
  loginText: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: var(--gren-font-body);
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;

    > span { color: ${cssVar.colorTextSecondary}; }
  `,
}));

function usePublishedServer(name: string): McpServerStatus | undefined {
  const workspace = useOptionalAgentStoreContext()?.workspace ?? '';
  return useMcpStatusStore((state) => {
    const list = workspace ? (state.serversByWorkspace[workspace] ?? []) : state.servers;
    return list.find((server) => server.name === name);
  });
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function configExposure(config: McpConfig): string | undefined {
  return textField((config as { exposure?: unknown }).exposure);
}

function configAuth(config: McpConfig): AuthLabel | undefined {
  const value = (config as { auth?: unknown }).auth;
  return value === 'oauth' || value === 'provider' ? value : undefined;
}

function authText(auth: AuthLabel | undefined): string | null {
  if (auth === 'oauth') return 'OAuth';
  if (auth === 'provider') return '供应商登录';
  return null;
}

function scopeText(scope: McpConfigScope): string {
  if (scope === 'global') return '全局配置';
  if (scope === 'project') return '项目配置';
  return '应用设置';
}

function urlHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function McpServerCard({
  name, config, enabled, detail = false, connectionPanel, scope, cachedTools = [], runtimeStatus, runtimeToolNames, footprints, loginUrl, exposure, auth,
  probing = false, probeError, policyRaw = {}, workspace = '', catalog = EMPTY_CATALOG, diagnostics, runtimeError, cached,
  onToggle, onEdit, onDelete, onReload, onPermChange, onPermChangeMany, onOpenRules,
}: McpServerCardProps) {
  const {message} = App.useApp();
  const [tab, setTab] = useState("tools");
  const [confirmPerm, setConfirmPerm] = useState<{target:Perm; names:string[]}>();
  const [expanded, setExpanded] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [filter, setFilter] = useState('');
  const [permissionFilter, setPermissionFilter] = useState('all');
  const [inspected, setInspected] = useState<string>();
  const [logs, setLogs] = useState(false);
  const toolMap = useMemo(() => new Map(catalog.map(t => [t.fullName, t])), [catalog]);
  const stored = usePublishedServer(name);
  const published = detail ? undefined : stored;
  const liveTools = runtimeToolNames ?? published?.toolNames;
  const tools = (runtimeStatus ?? published?.status) === 'failed' && !liveTools?.length ? cachedTools : liveTools ?? cachedTools;
  const url = loginUrl ?? published?.loginUrl;
  const shownExposure = exposure ?? published?.exposure ?? configExposure(config) ?? 'codemode';
  const shownAuth = auth ?? published?.auth ?? configAuth(config);
  const status = resolveMcpStatus(runtimeStatus ?? published?.status, url);
  const statusInput = { enabled, probing, probeError, count: tools.length, status, error: runtimeError, cached };
  const statusText = mcpStatusText(statusInput);
  const authLabel = authText(shownAuth);
  const reloadHint = detail ? '点上方「重载」刷新连接与工具列表' : '点右侧「重载」刷新连接与工具列表';
  const emptyHint = !enabled ? '启用后可加载工具。'
    : status === 'connected' ? '暂无可用工具'
    : status === 'connecting' ? '正在连接服务器…'
    : status === 'needs-login' ? '登录后可加载工具。'
    : status === 'failed' || probeError ? '连接恢复后可刷新工具目录。' : reloadHint;
  const needle = filter.trim().toLowerCase();
  const matched = tools.filter(full => (!needle || (toolMap.get(full)?.name ?? shortToolName(full)).toLowerCase().includes(needle) || full.toLowerCase().includes(needle) || toolMap.get(full)?.description?.toLowerCase().includes(needle)));
  const counts: Record<string,number> = {all:matched.length, auto:0, needs_approval:0, disabled:0};
  matched.forEach(full => counts[getToolPerm(policyRaw, full)]++);
  const shownTools = permissionFilter === 'all' ? matched : matched.filter(full => getToolPerm(policyRaw,full) === permissionFilter);
  const budget = useMemo(() => toolBudget(tools, toolMap, enabled, policyRaw, shownExposure, (config as { toolExposure?: Record<string,string> }).toolExposure, footprints), [tools, toolMap, enabled, policyRaw, shownExposure, config, footprints]);
  const failed = enabled && (status === 'failed' || (!status && !!probeError));
  const rawFailure = status ? runtimeError : probeError;
  const failure = rawFailure && diagnosticText(config, rawFailure);
  const safeTrace = diagnostics && { ...diagnostics, stderr: diagnostics.stderr.map(line => diagnosticText(config, line)) };
  const cachedOnly = enabled && !status && !probing && !probeError && (cached || tools.length > 0);
  const dotColor = mcpStatusDotColor(statusInput);
  const dot = { background: cachedOnly ? 'transparent' : dotColor, border: `1px solid ${dotColor}` };
  const reloadDisabled = !enabled || probing || status === 'connecting';

  const openLogin = () => {
    if (!url) return;
    void openUrl(url).then(
      () => setOpenFailed(false),
      () => setOpenFailed(true),
    );
  };
  const copyLogin = () => {
    if (!url || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(url).catch(() => {});
  };
  const toggle = <Switch checked={enabled} onChange={onToggle} aria-label={`启用 ${name}`} data-testid={`mcp-toggle-${name}`} />;
  const compactOperations = <>
    <button
      type="button"
      className={styles.iconbtn}
      title="重载"
      aria-label={`重载 ${name}`}
      data-testid={`mcp-reload-${name}`}
      disabled={reloadDisabled}
      onClick={onReload}
    >
      <RefreshCw size={15} className={probing ? styles.spin : undefined} />
    </button>
    {toggle}
    <button type="button" className={styles.iconbtn} title="编辑配置" aria-label={`编辑 ${name}`} data-testid={`mcp-edit-${name}`} onClick={onEdit}>
      <PencilLine size={16} />
    </button>
    <button type="button" className={`${styles.iconbtn} ${styles.compactDanger}`} title="删除服务器" aria-label={`删除 ${name}`} data-testid={`mcp-delete-${name}`} onClick={onDelete}>
      <Trash2 size={16} />
    </button>
  </>;
  const permissions = new Set(tools.map(full => getToolPerm(policyRaw,full)));
  const bulk = tools.length > 1 && onPermChangeMany && <Dropdown trigger={['click']} menu={{
    items:PERM_OPTIONS.map(o => ({key:o.value, disabled:permissions.size === 1 && permissions.has(o.value as Perm), label:<span data-testid={`mcp-perm-all-${o.value}`}>全部设为{o.label}</span>})),
    onClick:({key}) => { if (tools.length > 10 && permissions.size > 1) setConfirmPerm({target:key as Perm,names:[...tools]}); else onPermChangeMany(tools, key as Perm); }
  }}><Button size="small" className={styles.bulk} data-testid="mcp-bulk-settings">批量设置 <ChevronDown size={12}/></Button></Dropdown>;
  const toolPanel = <div className={styles.tools} data-detail={detail} data-testid={`mcp-tool-pane-${name}`}>
            <div className={styles.toolFilters}>
            {detail && !enabled && tools.length > 0 ? <div className={styles.hint} data-testid={`mcp-disabled-hint-${name}`}>服务器已停用，权限在启用后生效。</div> : null}
            {detail && budget.available > 30 && <div className={styles.warning}>{budget.available} 个工具可用。禁用低频工具可减少误调用；按需暴露可缩短提示词。</div>}
            {detail && tools.length > 0 ? (
              <div className={styles.filter}><Input
                allowClear
                size="small"
                placeholder="搜索工具名或描述" aria-label="搜索工具名或描述"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                data-testid={`mcp-tool-filter-${name}`}
              /><Segmented size="small" aria-label="按权限筛选" data-testid="mcp-permission-filter" value={permissionFilter} onChange={v => setPermissionFilter(String(v))} options={[{label:'全部',value:'all'}, ...PERM_OPTIONS].map(o => ({...o, label:`${o.label} (${counts[o.value]})`}))} /></div>
            ) : null}
            </div>
          <div className={styles.toolList} data-large={tools.length >= 50} data-server-enabled={enabled} data-testid={`mcp-tool-list-${name}`}>
            {tools.length === 0 ? (
              <div className={styles.hint}>{emptyHint}</div>
            ) : shownTools.length === 0 ? (
              <div className={styles.hint}>没有匹配的工具</div>
            ) : (
              shownTools.map((full) => (
                <div key={full} className={styles.toolRow} data-testid={`mcp-tool-${full}`}>
                  <span className={styles.toolName}><button type="button" className={styles.copyName} title={`复制工具标识符：${full}`} onClick={() => void copyText(full, message, '已复制工具名')}>{toolMap.get(full)?.name ?? shortToolName(full)}</button>
                    {toolMap.get(full)?.description && <Tooltip title={toolMap.get(full)!.description} placement="topLeft"><span className={styles.description}>{toolMap.get(full)!.description}</span></Tooltip>}
                  </span>
                  <Segmented
                    size="small"
                    className={styles.permission}
                    value={getToolPerm(policyRaw, full)}
                    options={PERM_OPTIONS}
                    onChange={(v) => onPermChange?.(full, v as Perm)}
                    data-testid={`mcp-perm-${full}`}
                  />
                  <Tooltip title="编辑此工具的参数审批规则"><button
                    type="button"
                    className={styles.iconbtn}
                    aria-label={`${shortToolName(full)} 参数规则`}
                    data-testid={`mcp-rules-${full}`}
                    onClick={() => onOpenRules?.(full)}
                  >
                    <SlidersHorizontal size={15} />
                  </button></Tooltip>
                  {detail && <Tooltip title="查看参数定义并测试调用"><button type="button" className={styles.iconbtn} aria-label={`${shortToolName(full)} 参数与调试`} onClick={() => setInspected(full)}><Braces size={15} /></button></Tooltip>}
                </div>
              ))
            )}
          </div>
        </div>;
  return (
    <div className={styles.wrap} data-detail={detail} data-testid={`mcp-server-${name}`}>
      {detail ? <>
        <div className={styles.detailHeader}>
          <div className={styles.identity}>
            <span className={styles.serverIcon}><Server size={20} /></span>
            <div className={styles.identityCopy}>
              <span className={styles.detailName}>{name}</span>
              <div className={styles.metadata}>
                <span>{'url' in config ? remoteTransportKind(config.url).toUpperCase() : transportOf(config).toUpperCase()}</span>
                {shownExposure.startsWith('codemode') ? <Tooltip title="Code Mode 通过代码调用聚合工具，按需发现参数定义，无需把每个工具的完整 schema 常驻在对话里。"><span data-help tabIndex={0}>{shownExposure}</span></Tooltip> : <span>{shownExposure}</span>}
                {authLabel ? <span>{authLabel}</span> : null}
                {scope ? <span><button type="button" className={styles.source} onClick={onEdit} aria-label="查看或切换配置来源" title={scope === 'global' ? '~/.pi/agent/mcp.json（所有项目）' : scope === 'project' ? `${workspace}/.pi/mcp.json（当前项目）` : '桌面应用设置'}>{scopeText(scope)}</button></span> : null}
              </div>
            </div>
          </div>
          <span className={styles.token} title={`按名称、描述、参数定义约每 4 字符 1 token 估算。可用定义 ≈ ${budget.permitted}；直接暴露 ≈ ${budget.direct}。按需工具不常驻，权限控制调用而非注册。`}>可用定义 ≈ {budget.permitted} tokens</span>
          <span className={styles.detailStatus} data-testid={`mcp-status-${name}`}>
            <span className={styles.dot} style={dot} aria-hidden="true" />
            {statusText}
          </span>
        </div>
        <div className={styles.detailActions} data-testid={`mcp-actions-${name}`}>
          <label className={styles.switchLabel}>
            {toggle}
            <span>{enabled ? '已启用' : '已停用'}</span>
          </label>
          <Button
            size="small"
            icon={<RefreshCw size={14} className={probing ? styles.spin : undefined} />}
            aria-label={`重载 ${name}`}
            data-testid={`mcp-reload-${name}`}
            disabled={reloadDisabled}
            onClick={onReload}
          >
            重载
          </Button>
          <Button size="small" type="text" icon={<ScrollText size={14}/>} onClick={() => setLogs(true)}>日志</Button>
          <Button
            size="small"
            type="text"
            danger
            className={styles.danger}
            icon={<Trash2 size={14} />}
            aria-label={`删除 ${name}`}
            data-testid={`mcp-delete-${name}`}
            onClick={onDelete}
          >
            删除
          </Button>
        </div>
      </> : (
      <div className={`${styles.card} ${enabled ? '' : styles.disabled}`}>
        <button
          type="button"
          className={styles.expandBtn}
          data-testid={`mcp-expand-${name}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <span className={styles.dot} style={{ background: dotColor }} />
        <span className={styles.name}>{name}</span>
        <span className={styles.pill}>{transportOf(config)}</span>
        {shownExposure ? <span className={styles.pill}>{shownExposure}</span> : null}
        {authLabel ? <span className={styles.authLabel}>{authLabel}</span> : null}
        {scope ? <span className={styles.pill}>{scope === 'global' ? '全局' : scope === 'project' ? '项目' : '应用'}</span> : null}
        <span className={styles.grow} />
        <span className={styles.status}>{statusText}</span>
        <span className={styles.ops}>{compactOperations}</span>
      </div>
      )}
      <div className={styles.content} data-testid={detail ? "mcp-detail-scroll" : undefined}>
      {detail && enabled && runtimeStatus === 'connecting' && diagnostics && <SlowHandshake key={diagnostics.attemptId ?? diagnostics.attemptedAt} trace={diagnostics} workspace={workspace} name={name} openLogs={() => setLogs(true)} />}
      {detail && failed && <DiagnosticCard error={failure} diagnostics={safeTrace} busy={reloadDisabled} reconnect={onReload} openLogs={() => setLogs(true)} />}
      {logs && <McpLogs name={name} status={statusText} error={failed ? failure : undefined} diagnostics={safeTrace} close={() => setLogs(false)} />}
      {inspected && <McpToolInspector workspace={workspace} server={name} fullName={inspected} tool={toolMap.get(inspected)} canCall={enabled && status === 'connected' && tools.includes(inspected) && getToolPerm(policyRaw, inspected) !== 'disabled'} close={() => setInspected(undefined)} />}
      {status === 'needs-login' && url ? (
        <div className={styles.loginRow} data-testid={`mcp-login-${name}`}>
          <span className={styles.loginText} title={url}>
            {openFailed ? '无法打开浏览器，请复制链接登录' : '需要在浏览器中登录'} <span>· {urlHost(url)}</span>
          </span>
          <Button size="small" type="primary" autoInsertSpace={false} onClick={openLogin}>登录</Button>
          <Button size="small" onClick={copyLogin}>复制链接</Button>
        </div>
      ) : null}
      {detail && connectionPanel ? <Tabs className={styles.tabs} size="small" activeKey={tab} onChange={setTab}
        tabBarExtraContent={tab === 'tools' ? bulk : undefined} items={[
          {key:'tools', label:`工具权限 (${tools.length})`, children:toolPanel},
          {key:'connection', label:'连接配置 & 环境变量', children:connectionPanel, destroyOnHidden:true},
        ]} /> : (expanded || detail) && <>{detail && <div className={styles.toolHeading}>工具权限 · {tools.length}{bulk}</div>}{toolPanel}</>}
      </div>
      {confirmPerm && <Modal open title="覆盖现有工具权限？" okText="确认覆盖" cancelText="取消" onCancel={() => setConfirmPerm(undefined)}
        onOk={() => { onPermChangeMany?.(confirmPerm.names, confirmPerm.target, true); setConfirmPerm(undefined); }}>
        <p>{name} 的 {confirmPerm.names.length} 个工具将全部设为「{PERM_OPTIONS.find(p => p.value === confirmPerm.target)?.label}」，包括未显示的工具。已有参数规则保留。</p>
      </Modal>}
    </div>
  );
}
