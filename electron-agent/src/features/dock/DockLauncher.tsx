import { Icon } from '@lobehub/ui';
import { useDroppable } from '@dnd-kit/core';
import { cx } from 'antd-style';
import { useSessionStore } from '../../store/session';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import type { DockRegion } from '../../stores/dockStore';
import { launcherKindIcon } from './dockKindIcon';
import { dockTabStyles } from './dockTabStyles';
import { launcherItems } from './launcherItems';
import { openLauncherTab } from './openLauncherTab';

interface DockLauncherProps {
  region: DockRegion;
}

export function DockLauncher({ region }: DockLauncherProps) {
  const { workspace } = useAgentStoreContext();
  const worksDir = useSessionStore((s) => s.worksDir);
  const items = launcherItems({ cwd: workspace, worksDir, workspace });
  const { setNodeRef } = useDroppable({ id: `dock:${region}` });
  const compact = region === 'bottom';

  return (
    <div
      ref={setNodeRef}
      className={cx(dockTabStyles.launcher, compact && dockTabStyles.launcherCompact)}
      data-testid={`dock-launcher-${region}`}
    >
      {compact ? null : (
        <div className={dockTabStyles.launcherHeading}>
          <p className={dockTabStyles.launcherTitle}>打开标签页</p>
          <p className={dockTabStyles.launcherHint}>选择要在侧边面板中打开的标签。</p>
        </div>
      )}
      <div className={dockTabStyles.launcherCards}>
        {items.map((item) => (
          <button
            key={item.kind}
            type="button"
            className={dockTabStyles.launcherCard}
            disabled={item.disabled}
            title={item.shortcut}
            aria-label={`${item.label} ${item.shortcut}`}
            data-testid={`dock-launcher-${item.kind}`}
            onClick={() => openLauncherTab({ region, kind: item.kind, workspace })}
          >
            <Icon icon={launcherKindIcon(item.kind)} size={20} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
