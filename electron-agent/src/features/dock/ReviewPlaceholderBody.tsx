import { dockTabStyles } from './dockTabStyles';

export function ReviewPlaceholderBody(_props?: { tab?: unknown; active?: boolean }) {
  return (
    <div className={dockTabStyles.empty} data-testid="review-placeholder">
      审查尚未接入。本期仅占位。
    </div>
  );
}
