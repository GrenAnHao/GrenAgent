import { cssVar } from 'antd-style';

export type McpRuntimeStatus = 'connecting' | 'connected' | 'failed' | 'stopped' | 'needs-login';

export interface McpStatusInput {
  enabled: boolean;
  probing: boolean;
  probeError?: string;
  error?: string;
  cached?: boolean;
  count: number;
  status?: McpRuntimeStatus;
}

export function resolveMcpStatus(raw: McpRuntimeStatus | undefined, loginUrl: string | undefined): McpRuntimeStatus | undefined {
  if (raw === 'needs-login') return 'needs-login';
  if (loginUrl && raw && raw !== 'connected') return 'needs-login';
  return raw;
}

/** 目录和详情共用同一份状态文字，避免两处写法不同。 */
export function mcpStatusText({ enabled, probing, probeError, count, status, error, cached }: McpStatusInput): string {
  if (!enabled) return '未启用';
  if (status === 'stopped') return '已终止连接';
  if (status === 'needs-login') return '需要登录';
  if (status === 'connecting') return '连接中…';
  if (status === 'failed') return failureText(error);
  if (status === 'connected') return count > 0 ? `已连接 · ${count} 工具` : '已连接';
  if (probing) return '探测中…';
  if (probeError) return failureText(probeError);
  if (count > 0 || cached) return `仅缓存 · ${count} 工具`;
  return '未探测';
}

function failureText(message?: string) {
  const tag = /ECONNREFUSED/i.test(message ?? '') ? '连接被拒绝' : /timeout|timed out|超时/i.test(message ?? '') ? '超时'
    : /ENOENT/i.test(message ?? '') ? '找不到命令' : /401|403/.test(message ?? '') ? '鉴权失败' : '';
  return tag ? `连接失败 · ${tag}` : '连接失败';
}

/** 目录和详情的状态文字统一使用次级色；只有点的颜色区分连接状态。 */
export function mcpStatusDotColor({ enabled, probing, probeError, count, status }: McpStatusInput): string {
  if (!enabled) return cssVar.colorTextTertiary;
  if (status === 'needs-login' || status === 'connecting') return cssVar.colorWarning;
  if (status === 'failed') return cssVar.colorError;
  if (status === 'connected') return 'var(--gren-status-dot)';
  if (probing) return cssVar.colorWarning;
  if (probeError) return cssVar.colorError;
  if (count > 0) return cssVar.colorTextSecondary;
  return cssVar.colorTextQuaternary;
}
