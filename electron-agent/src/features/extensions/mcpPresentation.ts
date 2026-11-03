import { cssVar } from 'antd-style';

export type McpRuntimeStatus = 'connecting' | 'connected' | 'failed' | 'needs-login';

export interface McpStatusInput {
  enabled: boolean;
  probing: boolean;
  probeError?: string;
  count: number;
  status?: McpRuntimeStatus;
}

export function resolveMcpStatus(raw: McpRuntimeStatus | undefined, loginUrl: string | undefined): McpRuntimeStatus | undefined {
  if (raw === 'needs-login') return 'needs-login';
  if (loginUrl && raw && raw !== 'connected') return 'needs-login';
  return raw;
}

/** 目录和详情共用同一份状态文字，避免两处写法不同。 */
export function mcpStatusText({ enabled, probing, probeError, count, status }: McpStatusInput): string {
  if (!enabled) return '未启用';
  if (status === 'needs-login') return '需要登录';
  if (status === 'connecting') return '连接中…';
  if (status === 'failed') return '连接失败';
  if (status === 'connected') return count > 0 ? `已连接 · ${count} 工具` : '已连接';
  if (probing) return '探测中…';
  if (probeError) return '连接失败';
  if (count > 0) return `缓存 · ${count} 工具`;
  return '未探测';
}

export function mcpStatusColor({ enabled, probing, probeError, count, status }: McpStatusInput): string {
  if (!enabled) return cssVar.colorTextTertiary;
  if (status === 'needs-login' || status === 'connecting') return cssVar.colorWarning;
  if (status === 'failed') return cssVar.colorError;
  if (status === 'connected') return cssVar.colorSuccess;
  if (probing) return cssVar.colorWarning;
  if (probeError) return cssVar.colorError;
  if (count > 0) return cssVar.colorSuccess;
  return cssVar.colorTextQuaternary;
}
