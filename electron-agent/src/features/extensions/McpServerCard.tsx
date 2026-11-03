import { Button, Input, Segmented, Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronRight, PencilLine, RefreshCw, Server, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { McpConfigScope } from '../../lib/pi';
import { openUrl } from '../../platform/runtime';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useMcpStatusStore, type McpServerStatus } from '../../stores/mcpStatusStore';
import { remoteTransportKind, transportOf, type McpConfig } from './mcpConfig';
import { getToolPerm, shortToolName, type Perm } from './mcpPolicy';
import { mcpStatusColor, mcpStatusText, resolveMcpStatus, type McpRuntimeStatus } from './mcpPresentation';

type AuthLabel = 'none' | 'oauth' | 'provider';

interface McpServerCardProps {
  name: string;
  config: McpConfig;
  enabled: boolean;
  detail?: boolean;
  scope?: McpConfigScope;
  cachedTools?: string[];
  runtimeStatus?: McpRuntimeStatus;
  runtimeToolNames?: string[];
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
  onPermChangeMany?: (fullNames: string[], perm: Perm) => void;
  onOpenRules?: (fullName: string) => void;
}

const PERM_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '需审批', value: 'needs_approval' },
  { label: '禁用', value: 'disabled' },
];

/** 工具多于这个数时才给筛选框。 */
const TOOL_FILTER_THRESHOLD = 8;

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
      /* 撑满详情栏剩余高度，把连接配置压到底部；overflow 必须可见，否则最小高度会算成 0。 */
      display: flex;
      flex: 1 1 0px;
      flex-direction: column;
      overflow: visible;
    }
  `,
  card: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 15px 18px;
  `,
  detailHeader: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-block: 4px 18px;
  `,
  identity: css`
    display: flex;
    flex: 1;
    align-items: center;
    gap: 11px;
    min-width: 0;
  `,
  serverIcon: css`
    display: inline-flex;
    flex: 0 0 38px;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    border-radius: 9px;
    color: ${cssVar.colorPrimary};
    background: ${cssVar.colorPrimaryBg};
  `,
  identityCopy: css`
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  `,
  detailName: css`
    font-size: 19px;
    font-weight: 500;
    overflow-wrap: anywhere;
  `,
  metadata: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;

    > span + span::before { content: '·'; margin-inline-end: 6px; }
  `,
  detailStatus: css`
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
  `,
  detailActions: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding-block-end: 16px;
  `,
  switchLabel: css`
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-inline-end: 6px;
    color: ${cssVar.colorText};
    font-size: 13px;
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
    font-size: 14px;
    color: ${cssVar.colorText};
  `,
  pill: css`
    padding: 1px 8px;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextSecondary};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    text-transform: uppercase;
  `,
  authLabel: css`
    padding: 1px 8px;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  grow: css`
    flex: 1;
    min-width: 0;
  `,
  status: css`
    font-size: 12px;
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
      padding: 14px 0;
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
    font-size: 12px;
  `,
  bulk: css`
    display: inline-flex;
    align-items: center;
    gap: 2px;
  `,
  toolList: css`
    &[data-server-enabled='false'] { opacity: 0.55; }

    /* 只有工具列表在详情里滚动；矮窗口保底 120px，再矮才让整栏滚动。 */
    [data-detail='true'] > & {
      flex: 1 1 0px;
      min-height: 120px;
      overflow-y: auto;
    }
  `,
  filter: css`
    margin-block-end: 6px;
  `,
  toolRow: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding-block: 6px;

    @container mcp-server-detail (max-width: 440px) {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
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
    font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  hint: css`
    padding: 8px 0;
    font-size: 13px;
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
    font-size: 13px;
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
  name, config, enabled, detail = false, scope, cachedTools = [], runtimeStatus, runtimeToolNames, loginUrl, exposure, auth,
  probing = false, probeError, policyRaw = {},
  onToggle, onEdit, onDelete, onReload, onPermChange, onPermChangeMany, onOpenRules,
}: McpServerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [filter, setFilter] = useState('');
  const published = usePublishedServer(name);
  const tools = runtimeToolNames ?? published?.toolNames ?? cachedTools;
  const url = loginUrl ?? published?.loginUrl;
  const shownExposure = exposure ?? published?.exposure ?? configExposure(config);
  const shownAuth = auth ?? published?.auth ?? configAuth(config);
  const status = resolveMcpStatus(runtimeStatus ?? published?.status, url);
  const statusInput = { enabled, probing, probeError, count: tools.length, status };
  const color = mcpStatusColor(statusInput);
  const statusText = mcpStatusText(statusInput);
  const authLabel = authText(shownAuth);
  const reloadHint = detail ? '点上方「重载」刷新连接与工具列表' : '点右侧「重载」刷新连接与工具列表';
  const emptyHint = !enabled ? '启用后可加载工具。'
    : status === 'connected' ? '暂无可用工具'
    : status === 'connecting' ? '正在连接服务器…'
    : status === 'needs-login' ? '登录后可加载工具。'
    : probeError ? `连接失败：${probeError}` : reloadHint;
  const needle = filter.trim().toLowerCase();
  const shownTools = needle ? tools.filter((full) => shortToolName(full).toLowerCase().includes(needle)) : tools;
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
    <button type="button" className={styles.iconbtn} title="删除服务器" aria-label={`删除 ${name}`} data-testid={`mcp-delete-${name}`} onClick={onDelete}>
      <Trash2 size={16} />
    </button>
  </>;
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
                {shownExposure ? <span>{shownExposure}</span> : null}
                {authLabel ? <span>{authLabel}</span> : null}
                {scope ? <span>{scopeText(scope)}</span> : null}
              </div>
            </div>
          </div>
          <span className={styles.detailStatus} style={{ color }} data-testid={`mcp-status-${name}`}>
            <span className={styles.dot} style={{ background: color }} aria-hidden="true" />
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
        <span className={styles.dot} style={{ background: color }} />
        <span className={styles.name}>{name}</span>
        <span className={styles.pill}>{transportOf(config)}</span>
        {shownExposure ? <span className={styles.pill}>{shownExposure}</span> : null}
        {authLabel ? <span className={styles.authLabel}>{authLabel}</span> : null}
        {scope ? <span className={styles.pill}>{scope === 'global' ? '全局' : scope === 'project' ? '项目' : '应用'}</span> : null}
        <span className={styles.grow} />
        <span className={styles.status} style={{ color }}>{statusText}</span>
        <span className={styles.ops}>{compactOperations}</span>
      </div>
      )}
      {status === 'needs-login' && url ? (
        <div className={styles.loginRow} data-testid={`mcp-login-${name}`}>
          <span className={styles.loginText} title={url}>
            {openFailed ? '无法打开浏览器，请复制链接登录' : '需要在浏览器中登录'} <span>· {urlHost(url)}</span>
          </span>
          <Button size="small" type="primary" autoInsertSpace={false} onClick={openLogin}>登录</Button>
          <Button size="small" onClick={copyLogin}>复制链接</Button>
        </div>
      ) : null}
      {expanded || detail ? (
        <div className={styles.tools} data-detail={detail}>
          {detail ? (
            <div className={styles.toolHeading}>
              <span>工具权限{tools.length > 0 ? ` · ${tools.length}` : ''}</span>
              {tools.length > 1 && onPermChangeMany ? (
                <span className={styles.bulk}>
                  全部设为
                  {PERM_OPTIONS.map((option) => (
                    <Button key={option.value} size="small" type="link" autoInsertSpace={false} data-testid={`mcp-perm-all-${option.value}`} onClick={() => onPermChangeMany(tools, option.value as Perm)}>
                      {option.label}
                    </Button>
                  ))}
                </span>
              ) : null}
            </div>
          ) : null}
          {detail && !enabled && tools.length > 0 ? <div className={styles.hint} data-testid={`mcp-disabled-hint-${name}`}>服务器已停用，权限在启用后生效。</div> : null}
          {detail && tools.length > TOOL_FILTER_THRESHOLD ? (
            <Input
              allowClear
              size="small"
              className={styles.filter}
              placeholder="筛选工具"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              data-testid={`mcp-tool-filter-${name}`}
            />
          ) : null}
          <div className={styles.toolList} data-server-enabled={enabled} data-testid={`mcp-tool-list-${name}`}>
            {tools.length === 0 ? (
              <div className={styles.hint}>{emptyHint}</div>
            ) : shownTools.length === 0 ? (
              <div className={styles.hint}>没有匹配的工具</div>
            ) : (
              shownTools.map((full) => (
                <div key={full} className={styles.toolRow} data-testid={`mcp-tool-${full}`}>
                  <span className={styles.toolName} title={full}>{shortToolName(full)}</span>
                  <Segmented
                    size="small"
                    className={styles.permission}
                    value={getToolPerm(policyRaw, full)}
                    options={PERM_OPTIONS}
                    onChange={(v) => onPermChange?.(full, v as Perm)}
                    data-testid={`mcp-perm-${full}`}
                  />
                  <button
                    type="button"
                    className={styles.iconbtn}
                    title="参数规则"
                    aria-label={`${shortToolName(full)} 参数规则`}
                    data-testid={`mcp-rules-${full}`}
                    onClick={() => onOpenRules?.(full)}
                  >
                    <SlidersHorizontal size={15} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
