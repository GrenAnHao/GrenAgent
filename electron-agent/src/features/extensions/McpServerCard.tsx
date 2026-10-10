import { Segmented, Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronRight, PencilLine, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { McpConfigScope } from '../../lib/pi';
import { openUrl } from '../../platform/runtime';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useMcpStatusStore, type McpServerStatus } from '../../stores/mcpStatusStore';
import { transportOf, type McpConfig } from './mcpConfig';
import { getToolPerm, shortToolName, type Perm } from './mcpPolicy';

type RuntimeStatus = 'connecting' | 'connected' | 'failed' | 'needs-login';
type AuthLabel = 'none' | 'oauth' | 'provider';

interface McpServerCardProps {
  name: string;
  config: McpConfig;
  enabled: boolean;
  scope?: McpConfigScope;
  cachedTools?: string[];
  runtimeStatus?: RuntimeStatus;
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
  onOpenRules?: (fullName: string) => void;
}

const PERM_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '需审批', value: 'needs_approval' },
  { label: '禁用', value: 'disabled' },
];

function statusText(probing: boolean, probeError: string | undefined, count: number, runtimeStatus?: RuntimeStatus): string {
  if (runtimeStatus === 'needs-login') return '需要登录';
  if (runtimeStatus === 'connecting') return '连接中…';
  if (runtimeStatus === 'failed') return '连接失败';
  if (runtimeStatus === 'connected') return count > 0 ? `${count} 工具` : '已连接';
  if (probing) return '探测中…';
  if (probeError) return '连接失败';
  if (count > 0) return `${count} 工具`;
  return '未探测';
}

function statusColor(probing: boolean, probeError: string | undefined, count: number, runtimeStatus?: RuntimeStatus): string {
  if (runtimeStatus === 'needs-login' || runtimeStatus === 'connecting') return cssVar.colorWarning;
  if (runtimeStatus === 'failed') return cssVar.colorError;
  if (runtimeStatus === 'connected') return cssVar.colorSuccess;
  if (probing) return cssVar.colorWarning;
  if (probeError) return cssVar.colorError;
  if (count > 0) return cssVar.colorSuccess;
  return cssVar.colorTextQuaternary;
}

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    margin-block-end: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    overflow: hidden;
  `,
  card: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 15px 18px;
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
  `,
  toolRow: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding-block: 8px;
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
    align-items: center;
    gap: 8px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    padding: 10px 18px;
  `,
  loginUrl: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  loginBtn: css`
    flex: 0 0 auto;
    padding: 4px 12px;
    border: none;
    border-radius: 6px;
    background: ${cssVar.colorPrimary};
    color: ${cssVar.colorBgContainer};
    font-size: 13px;
    cursor: pointer;
  `,
  copyBtn: css`
    flex: 0 0 auto;
    padding: 4px 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 6px;
    background: transparent;
    color: ${cssVar.colorText};
    font-size: 13px;
    cursor: pointer;
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

function resolveStatus(raw: RuntimeStatus | undefined, loginUrl: string | undefined): RuntimeStatus | undefined {
  if (raw === 'needs-login') return 'needs-login';
  if (loginUrl && raw && raw !== 'connected') return 'needs-login';
  return raw;
}

function authText(auth: AuthLabel | undefined): string | null {
  if (auth === 'oauth') return 'OAuth';
  if (auth === 'provider') return '供应商登录';
  return null;
}

export function McpServerCard({
  name, config, enabled, scope, cachedTools = [], runtimeStatus, runtimeToolNames, loginUrl, exposure, auth,
  probing = false, probeError, policyRaw = {},
  onToggle, onEdit, onDelete, onReload, onPermChange, onOpenRules,
}: McpServerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copyVisible, setCopyVisible] = useState(false);
  const published = usePublishedServer(name);
  const tools = runtimeToolNames ?? published?.toolNames ?? cachedTools;
  const url = loginUrl ?? published?.loginUrl;
  const shownExposure = exposure ?? published?.exposure ?? configExposure(config);
  const shownAuth = auth ?? published?.auth ?? configAuth(config);
  const status = resolveStatus(runtimeStatus ?? published?.status, url);
  const color = statusColor(probing, probeError, tools.length, status);
  const authLabel = authText(shownAuth);

  const openLogin = () => {
    if (!url) return;
    void openUrl(url).then(
      () => setCopyVisible(false),
      () => setCopyVisible(true),
    );
  };
  const copyLogin = () => {
    if (!url || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(url).catch(() => {});
  };
  return (
    <div className={styles.wrap} data-testid={`mcp-server-${name}`}>
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
        <span className={styles.status} style={{ color }}>{statusText(probing, probeError, tools.length, status)}</span>
        <span className={styles.ops}>
          {status === 'needs-login' && url ? (
            <button type="button" className={styles.loginBtn} onClick={openLogin}>登录</button>
          ) : null}
          <button
            type="button"
            className={styles.iconbtn}
            title="重载"
            data-testid={`mcp-reload-${name}`}
            disabled={!enabled || probing || status === 'connecting'}
            onClick={onReload}
          >
            <RefreshCw size={15} className={probing ? styles.spin : undefined} />
          </button>
          <Switch checked={enabled} onChange={onToggle} data-testid={`mcp-toggle-${name}`} />
          <button type="button" className={styles.iconbtn} data-testid={`mcp-edit-${name}`} onClick={onEdit}>
            <PencilLine size={16} />
          </button>
          <button type="button" className={styles.iconbtn} data-testid={`mcp-delete-${name}`} onClick={onDelete}>
            <Trash2 size={16} />
          </button>
        </span>
      </div>
      {status === 'needs-login' && url ? (
        <div className={styles.loginRow}>
          <span className={styles.loginUrl}>{url}</span>
          {copyVisible ? (
            <button type="button" className={styles.copyBtn} onClick={copyLogin}>复制</button>
          ) : null}
        </div>
      ) : null}
      {expanded ? (
        <div className={styles.tools}>
          {tools.length === 0 ? (
            <div className={styles.hint}>{probeError ? `连接失败：${probeError}` : '点右侧「重载」刷新连接与工具列表'}</div>
          ) : (
            tools.map((full) => (
              <div key={full} className={styles.toolRow} data-testid={`mcp-tool-${full}`}>
                <span className={styles.toolName} title={full}>{shortToolName(full)}</span>
                <Segmented
                  value={getToolPerm(policyRaw, full)}
                  options={PERM_OPTIONS}
                  onChange={(v) => onPermChange?.(full, v as Perm)}
                  data-testid={`mcp-perm-${full}`}
                />
                <button
                  type="button"
                  className={styles.iconbtn}
                  title="参数规则"
                  data-testid={`mcp-rules-${full}`}
                  onClick={() => onOpenRules?.(full)}
                >
                  <SlidersHorizontal size={15} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
