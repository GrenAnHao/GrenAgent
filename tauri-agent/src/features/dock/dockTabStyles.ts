import { createStaticStyles, cssVar, useTheme } from 'antd-style';
import { HEADER_HEIGHT } from '../../components/PanelHeader';
import type { DockTab, SubAgentLogPayload, TerminalPayload } from '../../stores/dockStore';

export type DotTone = 'neutral' | 'success' | 'warning' | 'error';
type AppTheme = ReturnType<typeof useTheme>;

export const dockTabStyles = createStaticStyles(({ css }) => ({
  container: css`
    height: 100%;
    min-height: 0;
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: ${HEADER_HEIGHT}px;
    padding: 0 8px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgElevated};
  `,
  tabs: css`
    display: flex;
    flex: 1;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  `,
  actions: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
  `,
  tab: css`
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 180px;
    height: 28px;
    padding: 0 4px 0 12px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    cursor: grab;
    user-select: none;
    touch-action: none;
    outline: none;

    &:active {
      cursor: grabbing;
    }

    &:focus,
    &:focus-visible {
      outline: none;
    }

    &:hover {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }
  `,
  tabActive: css`
    border-color: ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFill};
    color: ${cssVar.colorText};
  `,
  tabTitle: css`
    overflow: hidden;
    flex: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  tabClose: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillSecondary};
      color: ${cssVar.colorText};
    }
  `,
  tabCloseSpacer: css`
    width: 4px;
    flex: none;
  `,
  statusDot: css`
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: ${cssVar.colorTextQuaternary};
  `,
  toneSuccess: css`
    background: ${cssVar.colorSuccess};
  `,
  toneWarning: css`
    background: ${cssVar.colorWarning};
  `,
  toneError: css`
    background: ${cssVar.colorError};
  `,
  body: css`
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: ${cssVar.colorBgContainer};
  `,
  bodyItem: css`
    position: absolute;
    inset: 0;
    flex-direction: column;
    overflow: hidden;
  `,
  terminalHost: css`
    height: 100%;
    padding: 8px;

    .xterm {
      height: 100%;
    }
  `,
  empty: css`
    display: flex;
    align-items: center;
    flex: 1;
    padding: 12px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

/** tab → 状态点色调。终端 running=绿、subagent running=黄（语义不同，分 kind 处理）。 */
export function resolveTone(tab: DockTab, subAgentStatus?: 'running' | 'done' | 'error'): DotTone {
  if (tab.kind === 'terminal') {
    const s = (tab.payload as TerminalPayload).status;
    if (s === 'running') return 'success';
    if (s === 'starting') return 'warning';
    if (s === 'error' || s === 'exited') return 'error';
    return 'neutral';
  }
  if (tab.kind === 'subagent') {
    if (subAgentStatus === 'done') return 'success';
    if (subAgentStatus === 'running') return 'warning';
    if (subAgentStatus === 'error') return 'error';
    return 'neutral';
  }
  if (tab.kind === 'subagentLog') {
    const s = (tab.payload as SubAgentLogPayload).status;
    if (s === 'done') return 'success';
    if (s === 'running') return 'warning';
    if (s === 'error') return 'error';
    return 'neutral';
  }
  return 'neutral';
}

/** DragOverlay portal 到 body 后脱离主题容器，需用解析后的实色。 */
export function toneColor(theme: AppTheme, tone: DotTone): string {
  switch (tone) {
    case 'success':
      return theme.colorSuccess;
    case 'warning':
      return theme.colorWarning;
    case 'error':
      return theme.colorError;
    default:
      return theme.colorTextQuaternary;
  }
}
