import { Segmented, Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronRight, PencilLine, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { transportOf, type McpConfig } from './mcpConfig';
import { getToolPerm, shortToolName, type Perm } from './mcpPolicy';

interface McpServerCardProps {
  name: string;
  config: McpConfig;
  enabled: boolean;
  cachedTools?: string[];
  probing?: boolean;
  probeError?: string;
  policyRaw?: Record<string, unknown>;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onProbe?: () => void;
  onPermChange?: (fullName: string, perm: Perm) => void;
  onOpenRules?: (fullName: string) => void;
}

const PERM_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '需审批', value: 'needs_approval' },
  { label: '禁用', value: 'disabled' },
];

function statusText(probing: boolean, probeError: string | undefined, count: number): string {
  if (probing) return '探测中…';
  if (probeError) return '连接失败';
  if (count > 0) return `${count} 工具`;
  return '未探测';
}

function statusColor(probing: boolean, probeError: string | undefined, count: number): string {
  if (probing) return cssVar.colorWarning;
  if (probeError) return cssVar.colorError;
  if (count > 0) return cssVar.colorSuccess;
  return cssVar.colorTextQuaternary;
}

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    margin-block-end: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    overflow: hidden;
  `,
  card: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 14px;
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
    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  pill: css`
    padding: 1px 8px;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextSecondary};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    text-transform: uppercase;
  `,
  grow: css`
    flex: 1;
    min-width: 0;
  `,
  status: css`
    font-size: 11px;
  `,
  ops: css`
    display: flex;
    align-items: center;
    gap: 12px;
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
    padding: 6px 14px 10px;
  `,
  toolRow: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding-block: 6px;
  `,
  toolName: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  hint: css`
    padding: 8px 0;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

export function McpServerCard({
  name, config, enabled, cachedTools = [], probing = false, probeError, policyRaw = {},
  onToggle, onEdit, onDelete, onProbe, onPermChange, onOpenRules,
}: McpServerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const color = statusColor(probing, probeError, cachedTools.length);
  return (
    <div className={styles.wrap} data-testid={`mcp-server-${name}`}>
      <div className={`${styles.card} ${enabled ? '' : styles.disabled}`}>
        <button
          type="button"
          className={styles.expandBtn}
          data-testid={`mcp-expand-${name}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <span className={styles.dot} style={{ background: color }} />
        <span className={styles.name}>{name}</span>
        <span className={styles.pill}>{transportOf(config)}</span>
        <span className={styles.grow} />
        <span className={styles.status} style={{ color }}>{statusText(probing, probeError, cachedTools.length)}</span>
        <span className={styles.ops}>
          <button
            type="button"
            className={styles.iconbtn}
            title="测试连接"
            data-testid={`mcp-probe-${name}`}
            disabled={probing}
            onClick={onProbe}
          >
            <RefreshCw size={14} className={probing ? styles.spin : undefined} />
          </button>
          <Switch size="small" checked={enabled} onChange={onToggle} data-testid={`mcp-toggle-${name}`} />
          <button type="button" className={styles.iconbtn} data-testid={`mcp-edit-${name}`} onClick={onEdit}>
            <PencilLine size={15} />
          </button>
          <button type="button" className={styles.iconbtn} data-testid={`mcp-delete-${name}`} onClick={onDelete}>
            <Trash2 size={15} />
          </button>
        </span>
      </div>
      {expanded ? (
        <div className={styles.tools}>
          {cachedTools.length === 0 ? (
            <div className={styles.hint}>{probeError ? `连接失败：${probeError}` : '点右侧「测试连接」获取工具列表'}</div>
          ) : (
            cachedTools.map((full) => (
              <div key={full} className={styles.toolRow} data-testid={`mcp-tool-${full}`}>
                <span className={styles.toolName} title={full}>{shortToolName(full)}</span>
                <Segmented
                  size="small"
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
                  <SlidersHorizontal size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
