import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Check, Loader2, Square, X } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { convStyles } from './convTokens';

export type ConvStatus = 'running' | 'done' | 'error';

const COLOR: Record<ConvStatus, string> = {
  running: cssVar.colorInfo,
  done: cssVar.colorSuccess,
  error: cssVar.colorError,
};

const styles = createStaticStyles(({ css }) => ({
  // 运行可停止：默认显示 spinner，父 .conv-strip:hover 时切到红色停止方块。
  // display 放在类里（非行内），否则行内 display 优先级更高、hover 覆盖不掉。
  spinner: css`
    display: inline-flex;

    .conv-strip:hover & {
      display: none;
    }
  `,
  stop: css`
    display: none;
    color: ${cssVar.colorError};
    cursor: pointer;

    .conv-strip:hover & {
      display: inline-flex;
    }
  `,
}));

/** 行首状态图标；运行且可停止时，父行 hover 切换为红色停止键。 */
export const StatusGlyph = memo(function StatusGlyph({
  status,
  onStop,
}: {
  status: ConvStatus;
  onStop?: (e: MouseEvent) => void;
}) {
  if (status === 'running' && onStop) {
    return (
      <span className={convStyles.lead} data-status="running">
        <span className={styles.spinner} style={{ color: COLOR.running }}>
          <Icon icon={Loader2} size={13} spin />
        </span>
        <span
          className={styles.stop}
          title="停止子代理"
          onClick={(e) => {
            e.stopPropagation();
            onStop(e);
          }}
        >
          <Icon icon={Square} size={12} fill={cssVar.colorError} />
        </span>
      </span>
    );
  }
  const icon = status === 'running' ? Loader2 : status === 'error' ? X : Check;
  return (
    <span className={convStyles.lead} data-status={status} style={{ color: COLOR[status] }}>
      <Icon icon={icon} size={13} spin={status === 'running'} />
    </span>
  );
});
