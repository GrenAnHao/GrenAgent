import { memo } from 'react';
import { ActionIcon } from '@lobehub/ui';
import { PanelBottom, PanelRightOpen } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader';
import { useLayoutStore, selectRightPanelVisible } from '../../stores/layoutStore';
import { usePlanModeStore } from '../../stores/planModeStore';
import { SubAgentMenuButton } from '../subagents/SubAgentMenuButton';
import { WorkspaceTabs } from '../workspace/WorkspaceTabs';

/** 主题与面板开关，与聊天区解耦订阅。 */
export const MainHeaderActions = memo(function MainHeaderActions() {
  const terminalOpen = useLayoutStore((s) => s.terminalOpen);
  const toggleTerminal = useLayoutStore((s) => s.toggleTerminal);
  const rightPanelVisible = useLayoutStore(selectRightPanelVisible);
  const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);

  return (
    <>
      <SubAgentMenuButton />
      <ActionIcon
        icon={PanelBottom}
        active={terminalOpen}
        size="small"
        title="底栏"
        aria-label="底栏"
        onClick={toggleTerminal}
      />
      {!rightPanelVisible && (
        <ActionIcon icon={PanelRightOpen} size="small" title="Panel" onClick={toggleRightPanel} />
      )}
    </>
  );
});

/** 规划/执行模式徽章，仅订阅 plan-mode 状态文本（由 sidecar setStatus 推送）。 */
const PlanModeBadge = memo(function PlanModeBadge() {
  const status = usePlanModeStore((s) => s.status);
  if (!status) return null;
  return (
    <span
      data-testid="plan-mode-badge"
      style={{
        fontSize: 12,
        padding: '2px 8px',
        borderRadius: 4,
        background: 'var(--gren-accent-soft, rgba(120,140,255,0.15))',
        color: 'var(--gren-fg, inherit)',
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  );
});

export const MainColumnHeader = memo(function MainColumnHeader() {
  return (
    <PanelHeader
      left={
        <>
          <WorkspaceTabs />
          <PlanModeBadge />
        </>
      }
      actions={
        <>
          <MainHeaderActions />
        </>
      }
    />
  );
});
