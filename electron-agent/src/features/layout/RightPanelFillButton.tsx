import { ActionIcon } from '@lobehub/ui';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useLayoutStore } from '../../stores/layoutStore';

/** 右面板展开后的占满/还原。占满时盖住中间内容区，左侧会话列表能留下就留下。 */
export function RightPanelFillButton() {
  const fill = useLayoutStore((s) => s.rightPanelFill);
  const toggleRightPanelFill = useLayoutStore((s) => s.toggleRightPanelFill);
  const label = fill ? '还原面板' : '占满界面';
  return (
    <span title={label}>
      <ActionIcon
        icon={fill ? Minimize2 : Maximize2}
        size="small"
        title={label}
        aria-label={label}
        onClick={toggleRightPanelFill}
      />
    </span>
  );
}
