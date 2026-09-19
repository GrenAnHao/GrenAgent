import { useState } from 'react';
import { ActionIcon, Icon, Popover } from '@lobehub/ui';
import { Plus } from 'lucide-react';
import { useSessionStore } from '../../store/session';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import type { DockRegion } from '../../stores/dockStore';
import { launcherKindIcon } from './dockKindIcon';
import { dockTabStyles } from './dockTabStyles';
import { launcherItems } from './launcherItems';
import { openLauncherTab } from './openLauncherTab';

interface DockStripAddMenuProps {
  region: DockRegion;
}

export function DockStripAddMenu({ region }: DockStripAddMenuProps) {
  const { workspace } = useAgentStoreContext();
  const worksDir = useSessionStore((s) => s.worksDir);
  const items = launcherItems({ cwd: workspace, worksDir, workspace });
  const [open, setOpen] = useState(false);

  return (
    <Popover
      arrow={false}
      content={
        <div className={dockTabStyles.menuPanel} data-testid={`dock-add-menu-${region}`}>
          {items.map((item) => (
            <button
              key={item.kind}
              type="button"
              className={dockTabStyles.menuRow}
              disabled={item.disabled}
              data-testid={`dock-add-${item.kind}`}
              onClick={() => {
                openLauncherTab({ region, kind: item.kind, workspace });
                setOpen(false);
              }}
            >
              <Icon icon={launcherKindIcon(item.kind)} size={14} />
              <span className={dockTabStyles.menuLabel}>{item.label}</span>
              <span className={dockTabStyles.menuMeta}>{item.shortcut}</span>
            </button>
          ))}
        </div>
      }
      open={open}
      placement="bottomLeft"
      trigger="click"
      styles={{ content: { padding: 0 } }}
      onOpenChange={setOpen}
    >
      <span title="新建标签">
        <ActionIcon icon={Plus} size="small" title="新建标签" aria-label="新建标签" />
      </span>
    </Popover>
  );
}
