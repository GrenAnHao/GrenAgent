import { dockTabStyles } from './dockTabStyles';
import type { DockBodyProps } from './TabBodyRenderer';

export function ReviewPlaceholderBody(_props: DockBodyProps) {
  return (
    <div className={dockTabStyles.empty} data-testid="review-placeholder">
      审查尚未接入。本期仅占位。
    </div>
  );
}
