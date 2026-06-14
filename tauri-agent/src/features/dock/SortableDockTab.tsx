import { Icon } from '@lobehub/ui';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cx } from 'antd-style';
import { Globe, X } from 'lucide-react';
import { dockTabStyles, type DotTone } from './dockTabStyles';
import type { DockTab } from '../../stores/dockStore';

interface SortableDockTabProps {
  tab: DockTab;
  active: boolean;
  tone: DotTone;
  onActivate: () => void;
  onClose: () => void;
}

function toneClass(tone: DotTone): string {
  return cx(
    dockTabStyles.statusDot,
    tone === 'success' && dockTabStyles.toneSuccess,
    tone === 'warning' && dockTabStyles.toneWarning,
    tone === 'error' && dockTabStyles.toneError,
  );
}

export function SortableDockTab({ tab, active, tone, onActivate, onClose }: SortableDockTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });

  return (
    <div
      ref={setNodeRef}
      className={cx(dockTabStyles.tab, active && dockTabStyles.tabActive)}
      style={{ opacity: isDragging ? 0.4 : undefined, transform: CSS.Transform.toString(transform), transition }}
      onClick={onActivate}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      data-testid={`dock-tab-${tab.id}`}
    >
      {tab.kind === 'page' ? (
        <Icon icon={Globe} size={12} style={{ flex: 'none' }} />
      ) : (
        <span className={toneClass(tone)} />
      )}
      <span className={dockTabStyles.tabTitle}>{tab.title}</span>
      {tab.closable ? (
        <button
          type="button"
          className={dockTabStyles.tabClose}
          title="关闭"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X size={12} />
        </button>
      ) : (
        <span className={dockTabStyles.tabCloseSpacer} />
      )}
    </div>
  );
}
